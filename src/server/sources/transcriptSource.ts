import * as fs from 'node:fs';
import * as path from 'node:path';
import { Tailer } from '../watch/tailer.ts';
import { assertReadable, slugFor } from '../paths.ts';
import type { PathPolicy } from '../paths.ts';
import { parseLine } from '../parse/records.ts';
import type { ParseStats, Record_ } from '../parse/records.ts';
import { project, createContext, assertSafe, clampUnsafe } from '../parse/redact.ts';
import type { RedactContext, RedactOptions } from '../parse/redact.ts';
import type { DeltaEvent } from '../../shared/protocol.ts';

/** fs.watch lowers the latency; the poll is the safety net. */
const POLL_MS = 400;
const WATCH_DEBOUNCE_MS = 30;

/**
 * Does that record belong to this session, or to the session it was forked
 * from?
 *
 * `--fork-session` does not open an empty file: it copies the parent's
 * transcript into the new session's file and rewrites EVERY record with the
 * new `sessionId`. Nothing is left inside that tells the inherited history
 * apart from the work just done, except time. A record written before the
 * session existed is not its own, and summing it doubles a session already
 * counted under the other id.
 *
 * This is not a lab case: the CEOs' second opinion is always born from a
 * fork, so without this filter every accepted proposal inflated the
 * project's history. Measured on a real fork: 980 inherited lines out of
 * 1001, and a row in `history.json` declaring 257 tool calls and 222k output
 * tokens for ONE call actually made. It also inflated the denominator of
 * `ceo/quota.ts`, which is the worst direction to be wrong in: a bigger W
 * makes every call look like a smaller slice of the window, and the brake
 * tightens less.
 *
 * The boundary is sharp and needs no tolerance: measured, the registry's
 * `startedAt` precedes by 534 ms the first record the session actually
 * writes, while the last inherited record sits thirteen hours earlier.
 *
 * Two exceptions, and they are the two lines that do not report an activity:
 *  - `cost_state` is the session's OWN final tally, and its `timestamp` is
 *    the declared start instead of the line's moment: comparing it with
 *    `startedAt` would throw away precisely the complete numbers we want.
 *  - `title` carries no timestamp: it is the session's name, not an event.
 */
export function inherited(rec: Record_, startedAt: number): boolean {
  if (rec.kind === 'cost_state' || rec.kind === 'title') return false;
  return rec.timestamp < startedAt;
}

interface Attached {
  tailer: Tailer;
  watcher: fs.FSWatcher | null;
  poll: NodeJS.Timeout;
  debounce: NodeJS.Timeout | null;
  ctx: RedactContext;
}

/**
 * Follows the transcripts of the live sessions.
 *
 * A file is attached for tailing from its TAIL: transcripts reach tens of MB
 * and re-reading them whole at every startup would stall everything. Every
 * line goes through the defensive parser and then through the single
 * redaction point: there is no other road to the client.
 */
export class TranscriptSource {
  #claudeDir: string;
  #policy: PathPolicy;
  #warmupBytes: number;
  #stats: ParseStats;
  #emit: (events: DeltaEvent[]) => void;
  #devAssert: boolean;
  #attached = new Map<string, Attached>();

  constructor(opts: {
    claudeDir: string;
    policy: PathPolicy;
    warmupBytes: number;
    stats: ParseStats;
    devAssert: boolean;
    emit: (events: DeltaEvent[]) => void;
  }) {
    this.#claudeDir = opts.claudeDir;
    this.#policy = opts.policy;
    this.#warmupBytes = opts.warmupBytes;
    this.#stats = opts.stats;
    this.#devAssert = opts.devAssert;
    this.#emit = opts.emit;
  }

  /**
   * Reconciles: attaches the new sessions, detaches the vanished ones.
   *
   * `startedAt` comes from the registry and not from the file: it is what
   * makes it possible to recognize the history inherited from a fork (see
   * `inherited`).
   */
  sync(
    sessions: readonly { sessionId: string; cwd: string; startedAt: number }[],
    optsFor: (cwd: string) => RedactOptions,
  ): void {
    const alive = new Set(sessions.map((s) => s.sessionId));
    for (const [id, attached] of this.#attached) {
      if (alive.has(id)) continue;
      this.#detach(id, attached);
    }
    for (const session of sessions) {
      if (this.#attached.has(session.sessionId)) continue;
      void this.#attach(session.sessionId, session.cwd, session.startedAt, optsFor(session.cwd));
    }
  }

  async #attach(sessionId: string, cwd: string, startedAt: number, opts: RedactOptions): Promise<void> {
    const file = path.join(this.#claudeDir, 'projects', slugFor(cwd), `${sessionId}.jsonl`);
    try {
      assertReadable(file, this.#policy);
    } catch {
      return; // outside the allow-list: it is not opened, period
    }
    if (!fs.existsSync(file)) return;

    const ctx = createContext();
    const onLine = (line: string): void => {
      const rec = parseLine(line, this.#stats);
      if (!rec) return;
      // Another session's history is not this one's activity: it is counted
      // and left out, before redaction and before the model.
      if (inherited(rec, startedAt)) {
        this.#stats.inheritedLines++;
        return;
      }
      let events: DeltaEvent[];
      try {
        events = project(rec, ctx, opts);
      } catch {
        // An unexpected line must not stop the tail of the whole session.
        this.#stats.badLines++;
        return;
      }
      if (events.length === 0) return;
      if (this.#devAssert) {
        for (const ev of events) assertSafe(ev);
      } else {
        // Outside development the guard cannot throw -- it would kill the
        // session's tail -- but it must still hold: it truncates and counts.
        for (const ev of events) this.#stats.redactionClamps += clampUnsafe(ev);
      }
      this.#emit(events);
    };

    const tailer = new Tailer(file, this.#warmupBytes, onLine);
    try {
      await tailer.open();
    } catch {
      return;
    }

    const attached: Attached = {
      tailer,
      watcher: null,
      poll: setInterval(() => void tailer.pump(), POLL_MS),
      debounce: null,
      ctx,
    };
    attached.poll.unref?.();

    try {
      attached.watcher = fs.watch(file, { persistent: false }, () => {
        if (attached.debounce) clearTimeout(attached.debounce);
        attached.debounce = setTimeout(() => void tailer.pump(), WATCH_DEBOUNCE_MS);
        attached.debounce.unref?.();
      });
      attached.watcher.on('error', () => {
        attached.watcher?.close();
        attached.watcher = null; // the poll remains: we lose latency, not events
      });
    } catch {
      attached.watcher = null;
    }

    this.#attached.set(sessionId, attached);
  }

  /**
   * Detaches from a session that is gone.
   *
   * One last `pump()` BEFORE closing, and it is not generic caution: the last
   * lines a session writes are its final tally (`cost-state`), and right
   * after that it vanishes from the registry. Closing on the spot lost
   * precisely the line carrying the session's complete numbers -- the only
   * time they are written, and never re-read because a closed transcript is
   * not kept open. Sometimes the watcher won the race and sometimes not.
   */
  #detach(sessionId: string, attached: Attached): void {
    clearInterval(attached.poll);
    if (attached.debounce) clearTimeout(attached.debounce);
    attached.watcher?.close();
    void attached.tailer.pump().finally(() => void attached.tailer.close());
    this.#attached.delete(sessionId);
  }

  stop(): void {
    for (const [id, attached] of this.#attached) this.#detach(id, attached);
  }

  get attachedCount(): number {
    return this.#attached.size;
  }
}
