/**
 * The jumps to a terminal still on their way.
 *
 * A click on a badge takes one and a half to two and a half seconds to bring
 * a window forward -- measured on 2026-09-29: the process table half a
 * second, Terminal's AppleScript a second just to list its tabs, then the
 * activation -- and for all that time the badge said nothing. The click
 * looked lost, so it was clicked again, and the second jump queued behind
 * the first. Now the badge says the jump is under way, and a second click on
 * the same session while it is does nothing.
 *
 * A jump whose answer never comes (a socket that dropped, a server
 * restarted) stops counting after `PENDING_MAX_MS`: a badge must never stay
 * stuck spinning, nor refuse clicks for good.
 */
export const PENDING_MAX_MS = 12_000;

export class PendingFocus {
  #since = new Map<string, number>();

  /** True if the jump may start: none is already under way for this session. */
  begin(sessionId: string, now: number): boolean {
    const at = this.#since.get(sessionId);
    if (at !== undefined && now - at < PENDING_MAX_MS) return false;
    this.#since.set(sessionId, now);
    return true;
  }

  /** The answer came. */
  end(sessionId: string): void {
    this.#since.delete(sessionId);
  }
}
