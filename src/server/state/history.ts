import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProviderId, StatusConfidence, TokenTotals, WorkMonth } from '../../shared/protocol.ts';
import { shareOperator } from './workMeter.ts';
import type { WorkTotals } from './workMeter.ts';

/**
 * What finished sessions leave behind, kept small on purpose.
 *
 * The world model is a photograph of NOW: it deletes a session when it exits,
 * evicts files at 512 per project and remembers 256 events. Four of the five
 * CEO analyses are historical questions, so without this file they are answered
 * from a snapshot that cannot see yesterday.
 *
 * Two rules keep it from becoming a log:
 *
 *  1. ONE ROW PER FINISHED SESSION, keyed by its id, and the row is REPLACED
 *     rather than added to. That is what makes it idempotent: the tailer
 *     re-reads the tail of every transcript at startup, so a ledger that
 *     accumulated would double every count on each restart.
 *  2. RESOLUTION DECAYS. Full rows for the last 30 days, then one aggregate per
 *     project per month, at most twelve. Nobody asks what happened on a Tuesday
 *     in April; they ask whether it is getting worse. Bounding it by shape
 *     instead of by a cap means it can never grow into the thing it measures.
 *
 * Nothing in here is text. It is the same promise the delta channel makes, kept
 * for a file that lives on disk between runs.
 */

const VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The relative weight of the four token kinds.
 *
 * Duplicated on purpose from `ceo/spend.ts`: that folder gets deleted --
 * that is how the observation-only version is derived -- and this file must
 * keep compiling without it. These are four constants that do not change, not
 * logic that can drift apart.
 */
function weigh(t: TokenTotals): number {
  return t.in + t.out * 5 + t.cacheWrite * 1.25 + t.cacheRead * 0.1;
}

/**
 * Full rows within this window; beyond it, they fold into monthly aggregates.
 *
 * Exported because the startup recovery must look back EXACTLY as far as the
 * row window: any further, and its data would end up in a monthly aggregate
 * built from a partial scan, which would state a wrong number instead of
 * staying silent.
 */
export const HISTORY_ROW_DAYS = 30;
const ROW_DAYS = HISTORY_ROW_DAYS;
/** A year of monthly history: past that, the comparison is no longer with you. */
const MAX_MONTHS = 12;
/**
 * Hard cap on rows.
 *
 * It serves one single, real case: a pathological day -- a script that opens
 * hundreds of sessions -- must not be able to bloat the file before the
 * monthly fold gets around to dealing with it.
 */
const MAX_ROWS = 2000;

export interface ClosedSession {
  id: string;
  projectId: string;
  provider: ProviderId;
  /** When the session STARTED: the day the work belongs to. */
  startedAt: number;
  /**
   * `reported` when the numbers come from the tool's final tally,
   * `inferred` when we counted them ourselves by watching the events go by.
   *
   * Same distinction as `SessionInfo.statusConfidence`, and for the same
   * reason: a Codex session leaves no final tally, and presenting its numbers
   * as equivalent to Claude Code's would be a convenient lie. Today only
   * Claude Code writes `cost-state`.
   */
  confidence: StatusConfidence;
  /**
   * Whether we watched it work, or only found its receipt.
   *
   * A different axis from `confidence`, and it really matters: the closing
   * tally carries cost, tokens and lines, but NOT turns or tool calls. A row
   * recovered at startup from an already-closed transcript therefore has
   * declared numbers and zeroed counters, and adding it to the others would
   * make it look as if work had collapsed. Whoever reads must be able to tell
   * the two apart.
   */
  watched: boolean;
  costUsd: number;
  tokens: TokenTotals;
  turns: number;
  toolCalls: number;
  apiMs: number;
  toolMs: number;
  wallMs: number;
  linesAdded: number;
  linesRemoved: number;
  /**
   * How long the AI worked and when you did, read from the transcript.
   *
   * Absent until it has been read, and on rows written before it existed:
   * a transcript Claude Code has since deleted can no longer give it, and
   * the card says the hours are a floor instead of reading zero.
   */
  work?: WorkTotals;
}

export interface PeriodTotals {
  sessions: number;
  turns: number;
  toolCalls: number;
  tokens: TokenTotals;
  costUsd: number;
  apiMs: number;
  toolMs: number;
  linesAdded: number;
  linesRemoved: number;
  /** How many of these sessions carry declared numbers rather than ones we counted. */
  reported: number;
  /** How many we watched work: turns and calls only count for those. */
  watched: number;
  /** The agents' turns, for the sessions whose time was read. */
  aiMs: number;
  /** Your time, already shared with the other projects you had going. */
  operatorMs: number;
  /** How many had their time read: the hours count only those. */
  timed: number;
}

export interface ProjectHistory {
  projectId: string;
  providers: ProviderId[];
  /** The latest period. */
  now: PeriodTotals;
  /** The one immediately before it, of the same length. */
  before: PeriodTotals;
}

export interface HistoryDigest {
  /** How many days each of the two periods covers. */
  days: number;
  byProject: ProjectHistory[];
}

export interface History {
  /** A finished session. By id: rewriting the same row doubles nothing. */
  record(row: ClosedSession): void;
  /** Updates an existing row without overwriting what is not known. */
  merge(id: string, patch: Partial<ClosedSession>): void;
  has(id: string): boolean;
  /** The tools that have worked here, never forgotten. */
  providersOf(projectId: string): ProviderId[];
  /** Two periods side by side: this is what the brief shows instead of a series. */
  digest(now: number, days: number): HistoryDigest;
  /**
   * A project's rows within a window, one by one.
   *
   * `digest` answers "is it getting worse", and for the brief that is the
   * right shape. This one answers "how much does a TYPICAL session cost",
   * which is a question about the distribution and cannot be derived from
   * two totals: an average of totals is decided by the biggest session, and
   * in here there is one at 433 dollars and 80 million weighted tokens
   * against a project median of around two.
   *
   * A floor like `weightedSince`, and for the same reason: it looks only at
   * `sessions`, never at the `folds`. Beyond `HISTORY_ROW_DAYS` the rows are
   * gone, so the caller must keep the window within that limit or it will get
   * a smaller cohort than the real one without anyone telling it.
   */
  between(projectId: string, from: number, to: number): ClosedSession[];
  /**
   * A project's work month by month, newest first: what its tower's card shows.
   *
   * `live` are the sessions still open, measured so far, of EVERY project:
   * your time with them overlaps your time with the others, and the share
   * is decided over all of them. One with a row (a resumed session) replaces it.
   */
  workOf(projectId: string, live: readonly LiveWork[]): WorkMonth[];
  /** Rows whose time has not been read yet: what the startup pass reads. */
  untimed(): ClosedSession[];
  /**
   * The weighted tokens burned by one tool over a time window.
   *
   * It is the DENOMINATOR that converts a call into a percentage of quota:
   * if in seven days you consumed W weighted tokens and the 7d window is at
   * 67%, then the whole window is worth W/0.67 -- and that number does not
   * come from any price list, it comes from you.
   *
   * It is a FLOOR, not a total: it counts only the sessions this tool has
   * seen close. Underestimating the denominator makes the percentage come out
   * higher than the truth, which for a brake is the right direction in which
   * to be wrong.
   */
  weightedSince(provider: ProviderId, since: number, now: number): number;
  rows(): number;
  save(): void;
}

/** A session still open, as far as it has been measured. */
export interface LiveWork {
  id: string;
  projectId: string;
  startedAt: number;
  tokens: TokenTotals;
  work: WorkTotals | null;
}

interface Fold {
  projectId: string;
  provider: ProviderId;
  /** `YYYY-MM`: the month's key, not a date. */
  month: string;
  totals: PeriodTotals;
}

interface HistoryFile {
  version: number;
  sessions: ClosedSession[];
  folds: Fold[];
}

function zero(): PeriodTotals {
  return {
    sessions: 0, turns: 0, toolCalls: 0,
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    costUsd: 0, apiMs: 0, toolMs: 0, linesAdded: 0, linesRemoved: 0,
    reported: 0, watched: 0, aiMs: 0, operatorMs: 0, timed: 0,
  };
}

/** `operatorMs` is the row's SHARE of your time, decided over every row at once. */
function add(into: PeriodTotals, row: ClosedSession, operatorMs: number): void {
  into.sessions += 1;
  into.turns += row.turns;
  into.toolCalls += row.toolCalls;
  into.tokens.in += row.tokens.in;
  into.tokens.out += row.tokens.out;
  into.tokens.cacheRead += row.tokens.cacheRead;
  into.tokens.cacheWrite += row.tokens.cacheWrite;
  into.tokens.thinking += row.tokens.thinking;
  into.costUsd += row.costUsd;
  into.apiMs += row.apiMs;
  into.toolMs += row.toolMs;
  into.linesAdded += row.linesAdded;
  into.linesRemoved += row.linesRemoved;
  if (row.confidence === 'reported') into.reported += 1;
  if (row.watched) into.watched += 1;
  if (row.work) {
    into.aiMs += row.work.aiMs;
    into.operatorMs += operatorMs;
    into.timed += 1;
  }
}

/** Each row's share of your time: see `shareOperator`. */
function sharesOf(rows: Iterable<{ id: string; projectId: string; work?: WorkTotals | null }>): Map<string, number> {
  const owners = [];
  for (const r of rows) if (r.work) owners.push({ id: r.id, projectId: r.projectId, spans: r.work.operator });
  return shareOperator(owners);
}

function isWork(v: unknown): v is WorkTotals {
  const w = v as WorkTotals | null;
  return !!w && typeof w.aiMs === 'number' && Number.isFinite(w.aiMs)
    && Array.isArray(w.operator) && w.operator.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function monthOf(at: number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isRow(v: unknown): v is ClosedSession {
  const r = v as ClosedSession | null;
  return !!r && typeof r.id === 'string' && typeof r.projectId === 'string'
    && typeof r.startedAt === 'number' && Number.isFinite(r.startedAt)
    && !!r.tokens && typeof r.tokens.in === 'number';
}

export function createHistory(stateDir: string): History {
  const file = path.join(stateDir, 'history.json');
  const sessions = new Map<string, ClosedSession>();
  const folds = new Map<string, Fold>();
  let dirty = false;

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as HistoryFile;
    if (raw && raw.version === VERSION) {
      for (const row of raw.sessions ?? []) {
        if (!isRow(row)) continue;
        // A malformed one is dropped, not trusted: the row is read again.
        if (row.work !== undefined && !isWork(row.work)) delete row.work;
        sessions.set(row.id, row);
      }
      for (const f of raw.folds ?? []) {
        if (f && typeof f.month === 'string' && f.totals) {
          // Months folded before the hours existed have none: zero hours
          // over zero timed sessions, which the card reads as unknown.
          f.totals = { ...zero(), ...f.totals };
          folds.set(`${f.projectId}|${f.provider}|${f.month}`, f);
        }
      }
    }
  } catch {
    // No history: start from zero, which is the case every first time.
  }

  /**
   * The fold: from rows to months.
   *
   * It happens here and not on save because a folded row must not be able
   * to come back. The cut is on the session's START DATE, so folding the
   * same month twice is impossible: the rows that fed it are no longer
   * there.
   */
  function fold(now: number): void {
    const cutoff = now - ROW_DAYS * DAY_MS;
    const old = [...sessions.values()].filter((r) => r.startedAt < cutoff);
    // The hard cap only bites if folding is not enough: the oldest rows still
    // inside the window are sacrificed, never the most recent ones.
    const overflow = sessions.size - old.length - MAX_ROWS;
    if (overflow > 0) {
      const rest = [...sessions.values()]
        .filter((r) => r.startedAt >= cutoff)
        .sort((a, b) => a.startedAt - b.startedAt)
        .slice(0, overflow);
      old.push(...rest);
    }
    if (old.length === 0) return;

    // Decided over EVERY row, the ones staying included: a folded session
    // shared its minutes with ones that are not folded yet.
    const shares = sharesOf(sessions.values());
    for (const row of old) {
      const month = monthOf(row.startedAt);
      const key = `${row.projectId}|${row.provider}|${month}`;
      let f = folds.get(key);
      if (!f) {
        f = { projectId: row.projectId, provider: row.provider, month, totals: zero() };
        folds.set(key, f);
      }
      add(f.totals, row, shares.get(row.id) ?? 0);
      sessions.delete(row.id);
    }

    // More than a year of months compares against nothing: drop the oldest.
    const months = [...new Set([...folds.values()].map((f) => f.month))].sort();
    if (months.length > MAX_MONTHS) {
      const drop = new Set(months.slice(0, months.length - MAX_MONTHS));
      for (const [key, f] of folds) if (drop.has(f.month)) folds.delete(key);
    }
    dirty = true;
  }

  return {
    record(row) {
      sessions.set(row.id, row);
      dirty = true;
      fold(Date.now());
    },

    merge(id, patch) {
      const existing = sessions.get(id);
      if (!existing) return;
      sessions.set(id, { ...existing, ...patch });
      dirty = true;
    },

    has: (id) => sessions.has(id),

    providersOf(projectId) {
      const out = new Set<ProviderId>();
      for (const r of sessions.values()) if (r.projectId === projectId) out.add(r.provider);
      for (const f of folds.values()) if (f.projectId === projectId) out.add(f.provider);
      return [...out];
    },

    digest(now, days) {
      const span = days * DAY_MS;
      const byProject = new Map<string, ProjectHistory>();
      const shares = sharesOf(sessions.values());

      for (const r of sessions.values()) {
        const age = now - r.startedAt;
        if (age < 0 || age >= span * 2) continue;
        let p = byProject.get(r.projectId);
        if (!p) {
          p = { projectId: r.projectId, providers: [], now: zero(), before: zero() };
          byProject.set(r.projectId, p);
        }
        add(age < span ? p.now : p.before, r, shares.get(r.id) ?? 0);
        if (!p.providers.includes(r.provider)) p.providers.push(r.provider);
      }

      // Whoever did nothing in the recent period goes to the bottom: the
      // comparison that matters is with what is moving right now.
      const list = [...byProject.values()].sort(
        (a, b) => b.now.toolCalls - a.now.toolCalls || b.before.toolCalls - a.before.toolCalls,
      );
      return { days, byProject: list };
    },

    between(projectId, from, to) {
      const out: ClosedSession[] = [];
      for (const r of sessions.values()) {
        if (r.projectId !== projectId) continue;
        // Right end EXCLUDED: the "before" window ends at the instant the job
        // starts, and that instant belongs to the after.
        if (r.startedAt < from || r.startedAt >= to) continue;
        // Copies: the reader computes medians, and must not be able to rewrite
        // history from under whoever holds it. `tokens` separately, or it
        // would be shared.
        out.push({
          ...r,
          tokens: { ...r.tokens },
          ...(r.work ? { work: { aiMs: r.work.aiMs, operator: [...r.work.operator] } } : {}),
        });
      }
      return out.sort((a, b) => a.startedAt - b.startedAt);
    },

    workOf(projectId, live) {
      const liveIds = new Set(live.map((l) => l.id));
      const rows = [...sessions.values()].filter((r) => !liveIds.has(r.id));
      const shares = sharesOf([...rows, ...live]);
      const months = new Map<string, WorkMonth>();
      const monthFor = (key: string): WorkMonth => {
        let m = months.get(key);
        if (!m) {
          m = {
            month: key, sessions: 0, timed: 0,
            tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
            aiMs: 0, operatorMs: 0,
          };
          months.set(key, m);
        }
        return m;
      };
      const addTokens = (m: WorkMonth, t: TokenTotals): void => {
        m.tokens.in += t.in;
        m.tokens.out += t.out;
        m.tokens.cacheRead += t.cacheRead;
        m.tokens.cacheWrite += t.cacheWrite;
        m.tokens.thinking += t.thinking;
      };

      for (const f of folds.values()) {
        if (f.projectId !== projectId) continue;
        const m = monthFor(f.month);
        m.sessions += f.totals.sessions;
        m.timed += f.totals.timed;
        addTokens(m, f.totals.tokens);
        m.aiMs += f.totals.aiMs;
        m.operatorMs += f.totals.operatorMs;
      }
      const one = (r: { id: string; projectId: string; startedAt: number; tokens: TokenTotals; work?: WorkTotals | null }): void => {
        if (r.projectId !== projectId) return;
        const m = monthFor(monthOf(r.startedAt));
        m.sessions += 1;
        addTokens(m, r.tokens);
        if (r.work) {
          m.timed += 1;
          m.aiMs += r.work.aiMs;
          m.operatorMs += shares.get(r.id) ?? 0;
        }
      };
      for (const r of rows) one(r);
      for (const l of live) one(l);

      return [...months.values()].sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
    },

    untimed: () => [...sessions.values()].filter((r) => !r.work).map((r) => ({ ...r, tokens: { ...r.tokens } })),

    weightedSince(provider, since, now) {
      let total = 0;
      for (const r of sessions.values()) {
        if (r.provider !== provider) continue;
        if (r.startedAt < since || r.startedAt > now) continue;
        total += weigh(r.tokens);
      }
      return total;
    },

    rows: () => sessions.size,

    save() {
      if (!dirty) return;
      try {
        fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        const payload: HistoryFile = {
          version: VERSION,
          sessions: [...sessions.values()],
          folds: [...folds.values()],
        };
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload) + '\n', { mode: 0o600 });
        fs.renameSync(tmp, file);
        dirty = false;
      } catch {
        // Failing to save does not stop the tool: history is lost between one
        // restart and the next, and everything else keeps working.
      }
    },
  };
}
