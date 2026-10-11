import type { TargetRef, ToolCategory } from '../../shared/protocol.ts';

export interface PendingTool {
  name: string;
  cat: ToolCategory;
  /** Already extracted and redacted at the start: more reliable than rummaging
   *  in the result, which is polymorphic and for `Read` has no path. */
  target: TargetRef | null;
  startedAt: number;
  sessionId: string;
  agentId: string | null;
}

const TTL_MS = 10 * 60_000;
const MAX_PENDING = 512;

/**
 * Pairs a tool call with its result.
 *
 * A tool's duration is NOT recorded anywhere: it must be computed as the
 * difference between the timestamp of the `assistant` record that emits the
 * `tool_use` and that of the `user` record carrying the `tool_result` with
 * the same id.
 *
 * The map has a TTL and a cap because a tool_result may never arrive (session
 * closed halfway, tool interrupted) and without limits it would grow forever.
 */
export class ToolPairing {
  #pending = new Map<string, PendingTool>();

  start(toolUseId: string, pending: PendingTool): void {
    if (this.#pending.size >= MAX_PENDING) this.#evictOldest();
    this.#pending.set(toolUseId, pending);
  }

  /** Returns null if we don't know the start: it happens when attaching to a session halfway. */
  finish(toolUseId: string): PendingTool | null {
    const found = this.#pending.get(toolUseId);
    if (!found) return null;
    this.#pending.delete(toolUseId);
    return found;
  }

  sweep(now: number): void {
    for (const [id, p] of this.#pending) {
      if (now - p.startedAt > TTL_MS) this.#pending.delete(id);
    }
  }

  #evictOldest(): void {
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [id, p] of this.#pending) {
      if (p.startedAt < oldestAt) {
        oldestAt = p.startedAt;
        oldestId = id;
      }
    }
    if (oldestId) this.#pending.delete(oldestId);
  }

  get size(): number {
    return this.#pending.size;
  }
}

/**
 * Deduplicates token usage by `requestId`.
 *
 * A single API response is split across several `assistant` lines, one per
 * content block, all with the SAME requestId and the same `usage` object
 * repeated identically. Summing line by line overestimates by 2-4 times.
 */
export class UsageDedup {
  #seen = new Set<string>();
  #order: string[] = [];
  #cap: number;

  constructor(cap = 4096) {
    this.#cap = cap;
  }

  /** true if this requestId had never been counted. */
  claim(requestId: string | null): boolean {
    if (!requestId) return false;
    if (this.#seen.has(requestId)) return false;
    this.#seen.add(requestId);
    this.#order.push(requestId);
    if (this.#order.length > this.#cap) {
      const evicted = this.#order.shift();
      if (evicted) this.#seen.delete(evicted);
    }
    return true;
  }
}
