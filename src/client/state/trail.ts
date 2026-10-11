import type { DeltaEvent, TargetRef, ToolCategory } from '../../shared/protocol.ts';

/** The target reduced to one word: it is already a derived scalar, not content. */
export function targetLabel(target: TargetRef | null): string | null {
  if (!target) return null;
  switch (target.kind) {
    case 'file': return target.path;
    case 'cmd': return target.bin;
    case 'agent': return target.agentType;
    case 'skill': return target.name;
    case 'peer': return target.name;
  }
}

/** A finished step: what the session did, and how it went. */
export interface Step {
  /** The call's id: it is what stitches `tool.end` back to its `tool.start`. */
  id: string;
  /** When it BEGAN. The end is found by adding the duration. */
  at: number;
  cat: ToolCategory;
  tool: string;
  target: string | null;
  /**
   * How long it took, when that is meaningful to say.
   *
   * `null` for an asynchronous launch: there `tool.end` arrives an instant
   * after `tool.start` while the subagent is still working, and printing its
   * milliseconds would mean calling the hand-off time a "duration".
   */
  durationMs: number | null;
  ok: boolean;
  /** Lines changed, when the step touched a file. */
  changed: number;
}

/** How many steps are remembered per session. */
export const STEPS_PER_SESSION = 10;

/**
 * Cap on calls still open.
 *
 * A `tool.start` without its `tool.end` really does happen -- a session
 * killed halfway through its work leaves one behind -- and without a cap it
 * would stay in memory for the whole life of the page.
 */
const MAX_PENDING = 256;

/**
 * What a session has just done.
 *
 * The city says WHO is working, the speech bubble says THE STEP under way:
 * neither says how it got there. This is the sequence, and it lives in the
 * client because the events already all pass through it -- no new source,
 * and nothing new that has to go through redaction.
 *
 * Only FINISHED steps are here: the one under way is already told by the
 * panel's `doing` row, with its stopwatch, and repeating it down here would
 * make it read as two things done instead of one.
 */
export class Trail {
  /** Per session, most recent first. */
  #steps = new Map<string, Step[]>();
  /** By call id, waiting for their own `tool.end`. */
  #pending = new Map<string, { sessionId: string; step: Step }>();

  /** The latest steps of this session, most recent first. */
  of(sessionId: string): readonly Step[] {
    return this.#steps.get(sessionId) ?? [];
  }

  /** Starts over from the snapshot: the events the server keeps in its ring. */
  reset(events: readonly DeltaEvent[]): void {
    this.#steps.clear();
    this.#pending.clear();
    for (const ev of events) this.apply(ev);
  }

  apply(ev: DeltaEvent): void {
    switch (ev.t) {
      case 'tool.start': {
        // A subagent's calls do NOT go in here: there are dozens for every
        // delegation, and they would drown the steps of the session that
        // asked for them. The delegation shows up all the same -- it is the
        // `Delegating` row of its launch.
        if (ev.agentId !== null) return;
        if (this.#pending.size >= MAX_PENDING) {
          const oldest = this.#pending.keys().next();
          if (!oldest.done) this.#pending.delete(oldest.value);
        }
        this.#pending.set(ev.id, {
          sessionId: ev.sessionId,
          step: {
            id: ev.id, at: ev.at, cat: ev.cat, tool: ev.name,
            target: targetLabel(ev.target), durationMs: null, ok: true, changed: 0,
          },
        });
        return;
      }

      case 'tool.end': {
        const open = this.#pending.get(ev.id);
        // There is no telling what an end without its start describes:
        // `orphan` says exactly that, and inventing a step to make it show
        // up would be worse than not showing it.
        if (!open) return;
        this.#pending.delete(ev.id);
        const step: Step = {
          ...open.step,
          durationMs: ev.asyncLaunch ? null : ev.durationMs,
          ok: ev.ok,
          changed: Math.max(0, ev.changed),
        };
        const list = this.#steps.get(open.sessionId) ?? [];
        list.unshift(step);
        if (list.length > STEPS_PER_SESSION) list.length = STEPS_PER_SESSION;
        this.#steps.set(open.sessionId, list);
        return;
      }

      case 'session.remove':
        this.forget(ev.id);
        return;

      default:
        return;
    }
  }

  /** The session is gone: its trail goes with it. */
  forget(sessionId: string): void {
    this.#steps.delete(sessionId);
    for (const [id, open] of this.#pending) {
      if (open.sessionId === sessionId) this.#pending.delete(id);
    }
  }
}
