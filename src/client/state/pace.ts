/**
 * How fast work is happening on each project: tool calls in the last minute.
 *
 * The kerb's running light goes round faster the busier a project is. A
 * session's own `toolCalls` is a lifetime total and says nothing about now;
 * a sliding window over the calls themselves does. Kept per project, because
 * the kerb is the project's.
 *
 * Only instants are stored, pruned as they age out, so a colony left open for
 * a day holds a minute of history, not a day of it.
 */
export const PACE_WINDOW_MS = 60_000;

export class Pace {
  #hits = new Map<string, number[]>();

  /** A tool call started on `key` at epoch-ms `at`. */
  hit(key: string, at: number): void {
    if (!Number.isFinite(at)) return;
    let list = this.#hits.get(key);
    if (!list) {
      list = [];
      this.#hits.set(key, list);
    }
    // Events arrive in order almost always; one out of order only needs to
    // sit in the right place for the prune below to stay a prefix cut.
    let i = list.length;
    while (i > 0 && list[i - 1]! > at) i--;
    list.splice(i, 0, at);
  }

  /** Calls on `key` inside the window ending at `now`. */
  perMinute(key: string, now: number): number {
    const list = this.#hits.get(key);
    if (!list) return 0;
    const from = now - PACE_WINDOW_MS;
    let drop = 0;
    while (drop < list.length && list[drop]! <= from) drop++;
    if (drop) list.splice(0, drop);
    if (!list.length) {
      this.#hits.delete(key);
      return 0;
    }
    // A call stamped in the future (clock skew with the server) still counts:
    // it happened, just not by our clock.
    return list.length;
  }

  forget(key: string): void {
    this.#hits.delete(key);
  }
}

/**
 * The fastest the kerb light may run, in radians a second: a lap in about
 * two and a half seconds. The first tuning allowed 6 (a lap a second) and a
 * busy project's kerb read as a spinner rather than as a pace.
 */
export const CHASE_MAX = 2.4;

/**
 * How fast the kerb light runs, in radians a second, for a pace.
 *
 * Logarithmic: the difference between one call a minute and ten is worth
 * seeing, the one between sixty and ninety is not, and a linear speed would
 * turn a busy project's kerb into a strobe. A quiet session still moves it,
 * slowly: a lap in about twenty seconds.
 */
export function chaseSpeed(perMinute: number): number {
  const n = Number.isFinite(perMinute) && perMinute > 0 ? perMinute : 0;
  return Math.min(CHASE_MAX, 0.3 + 0.3 * Math.log2(1 + n));
}
