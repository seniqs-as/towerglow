import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DeltaEvent, RateWindow } from '../../shared/protocol.ts';
import { mergeWindows } from '../../shared/limits.ts';

/**
 * Reads what the statusline bridge drops.
 *
 * The file that arrives is rich -- working directory, model, cost, cache,
 * version -- but here ONLY the consumed quota is taken from it, built field by
 * field as everywhere else in the project. The rest is not even touched: it is
 * the same principle as redaction, applied to a different source.
 */

const POLL_MS = 4000;

/** The name of a per-session copy: the id, and nothing else. */
const RE_SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;

/** Beyond this age a session copy is considered abandoned. */
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60_000;

/**
 * The numerals Claude Code uses to name the windows. Today there are two keys,
 * `five_hour` and `seven_day`, but the name describes them in full: reading it
 * instead of listing them means a third window -- per model, per plan, per
 * anything -- would show up on its own the day it existed, instead of being
 * silently discarded.
 */
const NUMERALS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirty: 30, sixty: 60,
};

const UNIT_MINUTES: Record<string, number> = {
  minute: 1, minutes: 1,
  hour: 60, hours: 60,
  day: 1440, days: 1440,
  week: 10080, weeks: 10080,
  month: 43200, months: 43200,
};

/**
 * From `five_hour` to 300 minutes, and from `seven_day_opus` to 10080 with
 * `opus` set aside: that is exactly the case of a limit tied to a model, which
 * shows up without having to touch this file the day the plan declares one.
 *
 * The qualifier comes out as a FIELD and not glued to the label because those
 * two windows have the same span: on screen `7d` and `7d` are two
 * indistinguishable bars, and whoever reads must be able to see which of the
 * two belongs to the model without guessing it from the percentage.
 */
function parseWindowKey(key: string): { minutes: number; label: string; model: string | null } | null {
  const parts = key.split('_');
  if (parts.length < 2) return null;
  const count = NUMERALS[parts[0]!] ?? (/^\d+$/.test(parts[0]!) ? Number(parts[0]) : null);
  const unit = UNIT_MINUTES[parts[1]!];
  if (count === null || unit === undefined) return null;

  const minutes = count * unit;
  const qualifier = parts.slice(2).join(' ');
  const label = minutes % 1440 === 0 ? `${minutes / 1440}d`
    : minutes % 60 === 0 ? `${minutes / 60}h`
    : `${minutes}m`;
  return { minutes, label, model: qualifier || null };
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * A window from the statusline JSON.
 *
 * `resets_at` arrives in epoch seconds, as for Codex: passing it through as
 * is would put the reset in 1970.
 */
function windowFrom(raw: unknown, key: string): RateWindow | null {
  const w = obj(raw);
  if (!w) return null;
  const used = w['used_percentage'] ?? w['usedPercentage'];
  if (typeof used !== 'number') return null;
  const parsed = parseWindowKey(key);
  if (!parsed) return null;
  const resets = w['resets_at'] ?? w['resetsAt'];
  return {
    label: parsed.label,
    usedPercent: Math.max(0, Math.min(100, used)),
    windowMinutes: parsed.minutes,
    model: parsed.model,
    resetsAt: typeof resets === 'number' && resets > 0 ? resets * 1000 : null,
  };
}

/** A quota reading, and when the bridge wrote it. */
interface Reading {
  at: number;
  windows: RateWindow[];
}

/** The quota windows in a payload, or none if it carries no quota. */
function windowsOf(payload: Record<string, unknown> | null): RateWindow[] {
  const limits = obj(payload?.['rate_limits']);
  if (!limits) return [];
  const windows: RateWindow[] = [];
  for (const [key, value] of Object.entries(limits)) {
    const w = windowFrom(value, key);
    if (w) windows.push(w);
  }
  // From shortest to longest: that is the order in which the rope tightens.
  // At equal span the general limit comes before a model's: it is the one
  // that applies to everything, the other is a special case of it.
  windows.sort((a, b) => a.windowMinutes - b.windowMinutes || Number(a.model !== null) - Number(b.model !== null));
  return windows;
}


export interface StatuslineReaderOptions {
  file: string;
  /**
   * The folder with one copy per session. The context window is read from
   * here, since it belongs to each session: `file` only tells the last one
   * that responded.
   */
  sessionsDir: string;
  /**
   * The subscription plan, which is NOT in this payload and comes from
   * elsewhere. It must be repeated on every event: the receiver replaces the
   * provider's entire state, so omitting it would erase it on every update.
   */
  plan: string | null;
  emit: (events: DeltaEvent[]) => void;
}

/**
 * Watches the bridge's file and projects the consumed quota.
 *
 * `fs.watch` provides the latency, the poll is the safety net: on macOS the
 * former loses events, and a quota that silently stops updating would be
 * worse than a missing one, because it would still look good.
 */
export class StatuslineReader {
  #opts: StatuslineReaderOptions;
  #watcher: fs.FSWatcher | null = null;
  #timer: NodeJS.Timeout | null = null;
  #lastMtime = 0;
  /** Last modification seen for each session copy: only what changes is re-read. */
  #seenSessions = new Map<string, number>();
  /** When the last emitted reading was written: an older one never replaces it. */
  #quotaAt = 0;

  constructor(opts: StatuslineReaderOptions) {
    this.#opts = opts;
  }

  start(): void {
    this.#read();
    this.#timer = setInterval(() => this.#read(), POLL_MS);
    this.#timer.unref?.();
    try {
      // Watch the DIRECTORY: the file is replaced with a rename, and a watcher
      // on the file would follow the old inode without seeing anything again.
      this.#watcher = fs.watch(path.dirname(this.#opts.file), () => this.#read());
    } catch {
      // The directory does not exist yet: the poll remains, and will find it on its own.
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#watcher?.close();
    this.#watcher = null;
  }

  /**
   * The context window of every Claude Code session.
   *
   * ONLY `context_window.used_percentage` is taken, which Claude Code itself
   * computes with the right window size -- two hundred thousand or a million,
   * depending on the model. Deriving it ourselves from the tokens would mean
   * guessing that size.
   *
   * Returns every quota among the copies that changed: the quota belongs to
   * the account, so any session's reading is a reading of it, and which parts
   * of it survive is decided in one place, by `#read`.
   */
  #readSessions(): Reading[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.#opts.sessionsDir);
    } catch {
      return []; // the bridge has not written anything yet
    }
    const now = Date.now();
    const out: Reading[] = [];
    for (const name of names) {
      const m = RE_SESSION_FILE.exec(name);
      if (!m) continue;
      const file = path.join(this.#opts.sessionsDir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      // A copy untouched for days belongs to a closed session: the folder is
      // ours, and without pruning it would grow by one file for every session
      // ever opened on the machine.
      if (now - stat.mtimeMs > PRUNE_AFTER_MS) {
        try {
          fs.unlinkSync(file);
        } catch {
          // already gone
        }
        this.#seenSessions.delete(name);
        continue;
      }
      if (this.#seenSessions.get(name) === stat.mtimeMs) continue;
      this.#seenSessions.set(name, stat.mtimeMs);

      let payload: Record<string, unknown> | null;
      try {
        payload = obj(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch {
        continue; // half-written: the next pass will find it complete
      }
      const windows = windowsOf(payload);
      if (windows.length > 0) out.push({ at: stat.mtimeMs, windows });
      const used = obj(payload?.['context_window'])?.['used_percentage'];
      if (typeof used !== 'number') continue;
      this.#opts.emit([
        {
          t: 'session.update',
          id: m[1]!,
          at: stat.mtimeMs,
          patch: { contextPct: Math.max(0, Math.min(100, used)) },
        },
      ]);
    }
    return out;
  }

  /**
   * The quota is what the readings that carry one say, not what latest.json
   * says. A session draws its status line as soon as it opens, before its first
   * API call, and that payload has no `rate_limits`. Measured on the field: two
   * sessions opened and left unused at 12:54 and 12:55 were the last to write
   * latest.json, and the Claude row showed the plan with no bars for over an
   * hour, while a copy from 12:52 with both windows sat in the sessions folder.
   *
   * Among themselves the readings are laid one over the other, oldest first,
   * and never from before what has already been published: each session names
   * only the windows of its own last response -- one has `five_hour` and
   * `seven_day`, one just opened has only `seven_day` -- so taking the newest
   * alone would throw away a window the pass had in its hands.
   */
  #read(): void {
    const sessions = this.#readSessions();
    const latest = this.#readLatest();
    const fresh = [...sessions, ...(latest ? [latest] : [])]
      .filter((r) => r.at > this.#quotaAt)
      .sort((a, b) => a.at - b.at);
    if (fresh.length === 0) return;
    let windows: RateWindow[] = [];
    for (const r of fresh) windows = mergeWindows(windows, r.windows);
    this.#quotaAt = fresh[fresh.length - 1]!.at;
    this.#opts.emit([
      {
        t: 'limits',
        limits: { provider: 'claude', at: this.#quotaAt, windows, plan: this.#opts.plan },
      },
    ]);
  }

  #readLatest(): Reading | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.#opts.file);
    } catch {
      return null;
    }
    if (stat.mtimeMs === this.#lastMtime) return null;
    this.#lastMtime = stat.mtimeMs;

    let payload: Record<string, unknown> | null;
    try {
      payload = obj(JSON.parse(fs.readFileSync(this.#opts.file, 'utf8')));
    } catch {
      return null; // half-written: the next pass will find it complete
    }
    const windows = windowsOf(payload);
    return windows.length > 0 ? { at: stat.mtimeMs, windows } : null;
  }
}
