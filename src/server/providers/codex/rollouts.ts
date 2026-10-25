import * as fs from 'node:fs';
import * as path from 'node:path';
import { Tailer } from '../../watch/tailer.ts';
import type { RateWindow, TokenTotals } from '../../../shared/protocol.ts';
import { assertReadable } from '../../paths.ts';
import type { PathPolicy } from '../../paths.ts';

/**
 * Discovery and tailing of Codex rollouts.
 *
 * The rollouts are the LIVE source: they are appended in real time while the
 * session works. The `threads` table of `state_5.sqlite` looked handier -- a
 * ready-made index -- but checked in the field it is a HISTORICAL index: after
 * a real prompt the rollout was already at 66 lines while `threads` still
 * held only a session from thirty-seven hours earlier.
 *
 * The first line (`session_meta`) carries `cwd` and `session_id`, so a few
 * hundred bytes are enough to attribute a session to its project.
 */

const RE_ROLLOUT = /^rollout-.+\.jsonl$/;
/** Beyond this size a line is not even parsed: tool payloads reach megabytes
 *  and they are 92% of a rollout's bytes. */
const MAX_LINE = 256 * 1024;
/**
 * The head of a compaction record. The record carries the whole replacement
 * history -- 60 KB to 2.5 MB across the 14 on this machine on 2026-10-14 --
 * so it is told by its first bytes, before the size guard, and never parsed.
 */
const RE_COMPACTED = /^\{"timestamp":"([^"]{1,40})",(?:"ordinal":\d+,)?"type":"compacted"/;

export interface RolloutMeta {
  file: string;
  sessionId: string;
  cwd: string;
  cliVersion: string | null;
  startedAtMs: number;
  mtimeMs: number;
  /**
   * Written by a subagent (the approvals guardian, a spawned agent), not by a
   * chat. Its `session_id` is the PARENT's, so it cannot be a session of its own.
   */
  subagent: boolean;
}

/** The lines we care about, already reduced to what is needed. */
export type RolloutEvent =
  | { kind: 'turn_started'; turnId: string; atMs: number }
  | { kind: 'ask_started'; callId: string; atMs: number }
  | { kind: 'ask_answered'; callId: string; atMs: number }
  | {
      kind: 'turn_completed'; turnId: string; atMs: number; durationMs: number;
      /** The turn ended refused at the usage limit (`usage_limit_exceeded`). */
      limited: boolean;
    }
  /** Interrupted by the user: the turn is over, with no work to report. */
  | { kind: 'turn_aborted'; turnId: string; atMs: number }
  | {
      kind: 'item'; itemType: string; itemId: string; atMs: number;
      /** When it started. Codex writes it on EVERY item, not only on tools. */
      startedAtMs: number | null;
      /** The turn the item belongs to, which may have ended long before it. */
      turnId: string | null;
      item: Record<string, unknown>;
    }
  /** The conversation was compacted: only when. */
  | { kind: 'compacted'; atMs: number }
  | { kind: 'tokens'; total: number; atMs: number; delta: TokenTotals }
  /** A turn's settings: `effort` is its `model_reasoning_effort`, when written. */
  | { kind: 'model'; model: string; effort: string | null }
  | {
      kind: 'limits'; windows: RateWindow[]; plan: string | null; atMs: number;
      /** Context window in use, 0-100: it travels in the same record. */
      contextPct: number | null;
    };

/**
 * The code of a turn refused at the account's usage limit. Measured: 17
 * `task_complete` records on this machine from 2026-09-17 to 2026-10-05 (9 in
 * chats, 8 in subagents' rollouts), every one with this code as a string.
 * Read as a key too, in case a version writes it as an object.
 */
const LIMIT_ERROR = 'usage_limit_exceeded';

/** Stopped at the usage limit: when, and when the limit resets if it is known. */
export interface LimitStop {
  atMs: number;
  resetsAt: number | null;
}

/**
 * Whether a chat is stopped at its usage limit, folded from its rollout's
 * events in order: one rule for the live provider and for the look at an
 * older rollout when the server starts (`readLimitStop`).
 *
 * The refusal names no reset that is not text, so the reset is the one of
 * the fullest window in the last reading before it: measured before each of
 * the 17 stops, the fullest window was at 93-100%.
 */
export class LimitWatch {
  stop: LimitStop | null = null;
  #windows: readonly RateWindow[] = [];

  see(ev: RolloutEvent): void {
    // The credit balance comes with no window: it says nothing of the reset.
    if (ev.kind === 'limits' && ev.windows.length > 0) this.#windows = ev.windows;
    // A turn that starts is you restarting it, refused again or not.
    else if (ev.kind === 'turn_started') this.stop = null;
    else if (ev.kind === 'turn_completed') {
      this.stop = ev.limited ? { atMs: ev.atMs, resetsAt: fullestReset(this.#windows) } : null;
    }
  }
}

function fullestReset(windows: readonly RateWindow[]): number | null {
  let fullest: RateWindow | null = null;
  for (const w of windows) if (!fullest || w.usedPercent > fullest.usedPercent) fullest = w;
  return fullest?.resetsAt ?? null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Reads ONLY the first line: that is where `session_meta` lives. */
export function readMeta(file: string, policy: PathPolicy): RolloutMeta | null {
  try {
    assertReadable(file, policy);
  } catch {
    return null;
  }
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    const len = Math.min(st.size, 64 * 1024);
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, 0);
    const text = buf.toString('utf8');
    const nl = text.indexOf('\n');
    if (nl < 0) return null;

    const rec = obj(JSON.parse(text.slice(0, nl)));
    if (!rec || rec['type'] !== 'session_meta') return null;
    const payload = obj(rec['payload']);
    if (!payload) return null;

    const sessionId = str(payload['session_id']);
    const cwd = str(payload['cwd']);
    if (!sessionId || !cwd) return null;

    const started = Date.parse(str(rec['timestamp']) ?? '');
    return {
      file,
      sessionId,
      cwd,
      cliVersion: str(payload['cli_version']),
      startedAtMs: Number.isFinite(started) ? started : st.mtimeMs,
      mtimeMs: st.mtimeMs,
      subagent: obj(payload['source'])?.['subagent'] !== undefined,
    };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The last quota usage written in a rollout, even an old one.
 *
 * The quota belongs to the ACCOUNT: it stays true even when the session that
 * reported it has been closed for hours. Without this, closing the terminal
 * would make a figure vanish from the scene that is in fact still valid --
 * and it would come back only at the next turn, which might never come.
 *
 * Only the last bytes are read: the most recent `token_count` is at the end.
 *
 * The last record that carries WINDOWS, not simply the last one that carries
 * `rate_limits`. Measured on 2026-09-20: Codex writes two of them in a row,
 * six tenths of a second apart -- `limit_id: "codex"` with the 5h and the 7d,
 * then `limit_id: "premium"` with `primary` and `secondary` null, which is the
 * credit balance and names no window. Reading backwards to the first match
 * found that one, so a server restarted after such a turn showed the tool with
 * no bars until Codex ran again.
 */
export function readLastLimits(
  file: string,
  policy: PathPolicy,
  tailBytes = 512 * 1024,
): Extract<RolloutEvent, { kind: 'limits' }> | null {
  try {
    assertReadable(file, policy);
  } catch {
    return null;
  }
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    const len = Math.min(st.size, tailBytes);
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    // The first line of the tail is almost always truncated: it is dropped.
    const lines = buf.toString('utf8').split('\n').slice(1);
    // The one without windows is kept aside: it still carries the plan, and it
    // is the answer only if no record of this tail names a window.
    let fallback: Extract<RolloutEvent, { kind: 'limits' }> | null = null;
    let found: Extract<RolloutEvent, { kind: 'limits' }> | null = null;
    // The plan from the last record that NAMES one. Measured on 2026-10-08:
    // halfway through one session Codex 0.154 went from "plan_type": "plus" to
    // null, in every record after. Taking the plan from the record with the
    // windows read null and the row lost its plan; null is "not said", not
    // "no plan".
    let plan: string | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes('rate_limits')) continue;
      const ev = parseRolloutLine(line);
      if (ev?.kind !== 'limits') continue;
      plan ??= ev.plan;
      if (!found && ev.windows.length > 0) found = ev;
      fallback ??= ev;
      if (found && plan) break;
    }
    const best = found ?? fallback;
    return best ? { ...best, plan: best.plan ?? plan } : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The plan the last of these rollouts to name one wrote, newest first.
 *
 * Since Codex stopped naming the plan in its records, the newest rollout may
 * say nothing at all: the plan is looked for in the ones before it, a few
 * tails at most. What Codex last wrote is shown, never guessed -- and never
 * read from `auth.json`, which holds it and stays off the allow-list.
 */
/**
 * A rollout that ends stopped at the usage limit, from its last bytes.
 *
 * For a chat stopped before the server started, in a rollout older than the
 * live window: discovery does not open those, and the chat would be off
 * stage with nothing on its tower to say it has to be restarted. The tail
 * is enough: the stop is the rollout's last turn, and the reading that names
 * its reset sits a fraction of a second before it.
 */
export function readLimitStop(file: string, policy: PathPolicy, tailBytes = 256 * 1024): LimitStop | null {
  try {
    assertReadable(file, policy);
  } catch {
    return null;
  }
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    const len = Math.min(st.size, tailBytes);
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    // The first line of the tail is almost always truncated: it is dropped.
    const lines = buf.toString('utf8').split('\n');
    const watch = new LimitWatch();
    for (const line of len < st.size ? lines.slice(1) : lines) {
      const ev = parseRolloutLine(line);
      if (ev) watch.see(ev);
    }
    return watch.stop;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export function readLastPlan(files: readonly string[], policy: PathPolicy, maxFiles = 20): string | null {
  for (const file of files.slice(0, maxFiles)) {
    const plan = readLastLimits(file, policy)?.plan ?? null;
    if (plan) return plan;
  }
  return null;
}

/**
 * The freshest quota reading that names a window among these rollouts,
 * newest first.
 *
 * The newest rollout is not always the one that holds it. Measured on
 * 2026-10-13: a session that had handed its work to subagents left a rollout
 * with no `rate_limits` record in its tail, while its subagents' rollouts,
 * written half an hour earlier, carried the 5h at 99% and the 7d at 15%. The
 * server had read those live; restarted, it looked at the newest rollout
 * alone, and the CODEX row came back with its plan and no bars until Codex
 * ran again. The plan was already looked for in the rollouts before
 * (`readLastPlan`); the windows were not.
 *
 * The latest by its own timestamp, not the first found: a rollout written to
 * more recently can hold an older reading in its tail.
 */
export function readLastWindows(
  files: readonly string[],
  policy: PathPolicy,
  maxFiles = 20,
): Extract<RolloutEvent, { kind: 'limits' }> | null {
  let best: Extract<RolloutEvent, { kind: 'limits' }> | null = null;
  for (const file of files.slice(0, maxFiles)) {
    const ev = readLastLimits(file, policy);
    if (!ev || ev.windows.length === 0) continue;
    if (!best || ev.atMs > best.atMs) best = ev;
  }
  return best;
}

/** The most recently written rollout, however old it is. */
export function newestRollout(codexDir: string, policy: PathPolicy): RolloutMeta | null {
  const all = discoverRollouts(codexDir, policy, 0);
  let best: RolloutMeta | null = null;
  for (const m of all) if (!best || m.mtimeMs > best.mtimeMs) best = m;
  return best;
}

/** Recently modified rollouts: these are the sessions that may be alive. */
export function discoverRollouts(codexDir: string, policy: PathPolicy, sinceMs: number): RolloutMeta[] {
  const root = path.join(codexDir, 'sessions');
  const out: RolloutMeta[] = [];

  // The tree is YYYY/MM/DD: three levels, so the scan stays tiny.
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) walk(full, depth + 1);
        continue;
      }
      if (!RE_ROLLOUT.test(entry.name)) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.mtimeMs < sinceMs) continue;
      const meta = readMeta(full, policy);
      if (meta) out.push({ ...meta, mtimeMs: st.mtimeMs });
    }
  };

  walk(root, 0);
  return out;
}

/**
 * Translates a rollout line into what we need, discarding everything else.
 * Never throws: the format is internal to Codex and changes between versions.
 */
export function parseRolloutLine(line: string): RolloutEvent | null {
  const compacted = RE_COMPACTED.exec(line.slice(0, 120));
  if (compacted) {
    const atMs = Date.parse(compacted[1]!);
    return Number.isFinite(atMs) ? { kind: 'compacted', atMs } : null;
  }
  // Defense even before parsing: a huge line is a tool output.
  if (line.length > MAX_LINE) return null;

  let rec: Record<string, unknown> | null;
  try {
    rec = obj(JSON.parse(line));
  } catch {
    return null;
  }
  if (!rec) return null;

  const atMs = Date.parse(str(rec['timestamp']) ?? '') || Date.now();
  const type = str(rec['type']);
  const payload = obj(rec['payload']);
  if (!type || !payload) return null;

  if (type === 'turn_context') {
    const model = str(payload['model']);
    return model ? { kind: 'model', model, effort: str(payload['effort']) } : null;
  }

  // Codex asks the user through a dedicated function_call. The call/response
  // pair is the only way, on disk, to know whether a session is stopped
  // waiting for YOU rather than simply at rest.
  if (type === 'response_item') {
    const kind = str(payload['type']);
    const callId = str(payload['call_id']);
    if (!callId) return null;
    if (kind === 'function_call' && str(payload['name']) === 'request_user_input_async') {
      return { kind: 'ask_started', callId, atMs };
    }
    if (kind === 'function_call_output') {
      return { kind: 'ask_answered', callId, atMs };
    }
    return null;
  }

  if (type === 'token_usage_record') {
    const thread = obj(payload['thread_token_usage']);
    const total = typeof thread?.['total_tokens'] === 'number' ? thread['total_tokens'] : 0;
    // `usage` is the consumption of THIS response, so it is already a delta
    // and can be summed; `thread_token_usage` is instead the running total,
    // and summing it would multiply the count by the number of records.
    return { kind: 'tokens', total, atMs, delta: totalsFrom(obj(payload['usage'])) };
  }

  if (type !== 'event_msg') return null;
  const kind = str(payload['type']);

  if (kind === 'task_started') {
    return { kind: 'turn_started', turnId: str(payload['turn_id']) ?? '', atMs };
  }
  if (kind === 'task_complete') {
    const duration = typeof payload['duration_ms'] === 'number' ? payload['duration_ms'] : 0;
    // Only the error's code: its message ("You've hit your usage limit ...
    // try again at Oct 6th, 2026 12:44 AM") is text, and stays here.
    const info = obj(payload['error'])?.['codex_error_info'];
    const limited = info === LIMIT_ERROR || obj(info)?.[LIMIT_ERROR] !== undefined;
    return { kind: 'turn_completed', turnId: str(payload['turn_id']) ?? '', atMs, durationMs: duration, limited };
  }
  // Esc in Codex writes this instead of `task_complete`: unread, the turn
  // stayed open and the session read as working until it left the stage.
  if (kind === 'turn_aborted') {
    return { kind: 'turn_aborted', turnId: str(payload['turn_id']) ?? '', atMs };
  }
  // Quota usage travels together with the token count, not in a record of
  // its own: it is the only place on disk where Codex writes it.
  if (kind === 'token_count') {
    // The same record also carries the model's window and how much of it the
    // LAST request used: it is the context occupancy right now, not a sum.
    // If it is there, it comes before the quotas.
    const info = obj(payload['info']);
    const window = typeof info?.['model_context_window'] === 'number' ? info['model_context_window'] : 0;
    const last = obj(info?.['last_token_usage']);
    const input = typeof last?.['input_tokens'] === 'number' ? last['input_tokens'] : null;
    const contextPct = window > 0 && input !== null
      ? Math.max(0, Math.min(100, (100 * input) / window))
      : null;

    const limits = obj(payload['rate_limits']);
    if (!limits) return contextPct === null ? null : { kind: 'limits', windows: [], plan: null, atMs, contextPct };
    // `individual_limit` exists in the schema and has always turned out null
    // on real data: it is read anyway, so the day it shows up it would be
    // displayed instead of being discarded without anyone knowing.
    const windows: RateWindow[] = [];
    for (const key of ['primary', 'secondary', 'individual_limit']) {
      const w = windowFrom(obj(limits[key]));
      if (w) windows.push(w);
    }
    if (windows.length === 0 && contextPct === null) return null;
    const plan = typeof limits['plan_type'] === 'string' ? limits['plan_type'] : null;
    return { kind: 'limits', windows, plan, atMs, contextPct };
  }

  if (kind === 'item_completed') {
    const item = obj(payload['item']);
    const itemType = str(item?.['type']);
    const itemId = str(item?.['id']);
    if (!item || !itemType || !itemId) return null;
    const completed = typeof payload['completed_at_ms'] === 'number' ? payload['completed_at_ms'] : atMs;
    const started = typeof payload['started_at_ms'] === 'number' ? payload['started_at_ms'] : null;
    return { kind: 'item', itemType, itemId, atMs: completed, startedAtMs: started, turnId: str(payload['turn_id']), item };
  }
  return null;
}

/**
 * From Codex's `usage` to the common totals.
 *
 * Watch out for `input_tokens`: here it INCLUDES the part served from cache,
 * whereas in Claude Code's format it excludes it. Without the subtraction the
 * same token would be counted twice, once as new and once as cache.
 */
function totalsFrom(u: Record<string, unknown> | null): TokenTotals {
  const n = (k: string): number => (typeof u?.[k] === 'number' ? (u[k] as number) : 0);
  const cacheRead = n('cached_input_tokens');
  const cacheWrite = n('cache_write_input_tokens');
  return {
    in: Math.max(0, n('input_tokens') - cacheRead - cacheWrite),
    out: n('output_tokens'),
    cacheRead,
    cacheWrite,
    thinking: n('reasoning_output_tokens'),
  };
}

/**
 * A rate-limit window, if there really is one.
 *
 * `resets_at` is in epoch SECONDS, like everything Codex writes about
 * absolute times: passing it through as is would place the reset in 1970.
 */
function windowFrom(w: Record<string, unknown> | null): RateWindow | null {
  if (!w) return null;
  const used = w['used_percent'];
  const minutes = w['window_minutes'];
  if (typeof used !== 'number' || typeof minutes !== 'number') return null;
  const resets = w['resets_at'];
  return {
    label: labelForMinutes(minutes),
    usedPercent: Math.max(0, Math.min(100, used)),
    windowMinutes: minutes,
    // Codex describes its windows only by width: none is tied to a model, and
    // inventing one here would state something the file does not say.
    model: null,
    resetsAt: typeof resets === 'number' && resets > 0 ? resets * 1000 : null,
  };
}

/** The window's width as a person would call it: `5h`, `7d`. */
export function labelForMinutes(minutes: number): string {
  if (minutes > 0 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes > 0 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export { Tailer };
