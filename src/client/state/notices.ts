import type { DeltaEvent, NoticeCode } from '../../shared/protocol.ts';

/**
 * The last notice of every session, held for a while.
 *
 * A notice is an instant; the astronaut's state is read every frame. Without
 * a hold an error would flash for one frame and vanish, which is worse than
 * not showing it at all. The hold ends early when the session visibly moves
 * on: a new tool call or a turn starting means whatever fell over has been
 * dealt with.
 */
export const NOTICE_HOLD_MS = 60_000;

export class Notices {
  #last = new Map<string, { code: NoticeCode; at: number }>();

  /** Returns true when something changed and the scene should re-read. */
  apply(ev: DeltaEvent): boolean {
    switch (ev.t) {
      case 'notice':
        // A notice for no session in particular has no astronaut to wear it.
        if (ev.sessionId === null) return false;
        this.#last.set(ev.sessionId, { code: ev.code, at: ev.at });
        return true;
      case 'tool.start':
        return this.#clear(ev.sessionId);
      case 'session.update':
        return ev.patch.status === 'busy' ? this.#clear(ev.id) : false;
      case 'session.remove':
        return this.#last.delete(ev.id);
      default:
        return false;
    }
  }

  of(sessionId: string, now: number): NoticeCode | null {
    const n = this.#last.get(sessionId);
    if (!n) return null;
    if (now - n.at > NOTICE_HOLD_MS) {
      this.#last.delete(sessionId);
      return null;
    }
    return n.code;
  }

  #clear(sessionId: string): boolean {
    return this.#last.delete(sessionId);
  }
}
