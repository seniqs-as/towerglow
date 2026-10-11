import type { DeltaEvent } from './protocol.ts';

/**
 * Which git events stand on a project: a ring on its tower in the city, a
 * crate on its pile in the colony. One rule, on both sides of the wire.
 *
 * The towers used to show whatever git events reached the page: at startup
 * the server replays the tail of every reflog -- twenty-odd lines, weeks old
 * on a project nobody touched -- and a page left open across a restart got
 * that history again and again, with nothing to tell a line already shown
 * from a new one. Three restarts in a day, and every tower in the city wore
 * three copies of its old commits. A page opened after the start got none,
 * because the snapshot did not carry them: the same city looked different
 * depending on when you looked.
 *
 * Now a ring is a commit of the last hour, the same for every page: the
 * server keeps them in a ledger and sends it in the snapshot, and a page
 * rebuilds from it on every connection and lets them age out. An hour and not
 * a day (the user's call, 2026-10-08): a tower says what is happening now,
 * and with a day nearly every project you touched wore rings.
 */

export type GitEvent = Extract<DeltaEvent, { t: 'git' }>;

/** How long a commit stays on its tower: one hour. */
export const RING_WINDOW_MS = 60 * 60_000;

/** Rings shown per project, newest on top: beyond this, the tower would be a pole. */
export const MAX_RINGS = 12;

/** Whether an event marks history (switching branch does not) and is recent enough to show. */
export function ringWorthy(ev: GitEvent, now: number): boolean {
  return ev.kind !== 'checkout' && now - ev.at < RING_WINDOW_MS;
}

/** One reflog line: the same line replayed after a restart is the same ring, not a second one. */
export function ringKey(ev: GitEvent): string {
  return `${ev.projectId}|${ev.sha}|${ev.kind}|${ev.at}`;
}

/** The rings of every project: recent, each once, at most `MAX_RINGS` per project. */
export class RingLedger {
  #byProject = new Map<string, GitEvent[]>();
  #keys = new Set<string>();

  /** An event, live or replayed. True when it adds a ring that was not there. */
  accept(ev: GitEvent, now: number): boolean {
    if (!ringWorthy(ev, now)) return false;
    const key = ringKey(ev);
    if (this.#keys.has(key)) return false;
    const list = this.#byProject.get(ev.projectId) ?? [];
    list.push(ev);
    list.sort((a, b) => a.at - b.at);
    while (list.length > MAX_RINGS) this.#keys.delete(ringKey(list.shift()!));
    this.#byProject.set(ev.projectId, list);
    if (!list.includes(ev)) return false; // older than the twelve already there
    this.#keys.add(key);
    return true;
  }

  /** Start over from a list: what a page does with the snapshot. */
  reset(events: readonly GitEvent[], now: number): void {
    this.#byProject.clear();
    this.#keys.clear();
    for (const ev of events) this.accept(ev, now);
  }

  /** Let go of what is older than the window. True when something went. */
  prune(now: number): boolean {
    let changed = false;
    for (const [projectId, list] of this.#byProject) {
      const kept = list.filter((ev) => now - ev.at < RING_WINDOW_MS);
      if (kept.length === list.length) continue;
      changed = true;
      for (const ev of list) if (!kept.includes(ev)) this.#keys.delete(ringKey(ev));
      if (kept.length === 0) this.#byProject.delete(projectId);
      else this.#byProject.set(projectId, kept);
    }
    return changed;
  }

  /** Every project's rings, each project's oldest first. */
  all(): GitEvent[] {
    return [...this.#byProject.values()].flat();
  }
}
