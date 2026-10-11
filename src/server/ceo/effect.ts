import { EFFECT_LABELS, EFFECT_METRICS, EFFECT_MIN_COHORT } from '../../shared/protocol.ts';
import type { EffectMetricId, ProviderId } from '../../shared/protocol.ts';
import { HISTORY_ROW_DAYS } from '../state/history.ts';
import type { ClosedSession } from '../state/history.ts';
import { cacheHitOf, moved } from './brief.ts';
import { jobLabel } from './jobs.ts';
import type { Job, JobStore } from './jobs.ts';
import { weigh } from './spend.ts';

/**
 * How it went AFTER you accepted a piece of advice.
 *
 * Today the loop closes at "the job is done". But a job carried through and a
 * job that improved something are two different facts, and until now only
 * the first was recorded: the CEO's memory knows what was done, never whether
 * it helped, and at the next question it proposes again blindly.
 *
 * The measurement lives in here. But measuring is the easy part: almost all of
 * this file exists to keep it from lying, because TWO SESSIONS ARE NOT AN
 * EXPERIMENT. Nobody holds anything constant, the sessions after are not
 * redoing the work of the sessions before, and the second opinion on a real
 * job already wrote it by itself: "this is a build session on the tool, which
 * does not have the shape of the sessions that average is made of".
 *
 * Hence the rules, each one paid for with a case observed on disk:
 *
 *  - MEDIANS OF PER-SESSION RATIOS, never ratios of sums. In `history.json`
 *    there is a session of 433 dollars and 616 million tokens of cache read
 *    alone: in a ratio of sums it rules on its own, and that is that.
 *  - A GATE PER METRIC. The five figures have different eligibility
 *    predicates, so on the same handful of rows they form cohorts of
 *    different sizes. A single gate on the whole reading would give `null` to
 *    everything forever.
 *  - NOT ALL OF THEM HAVE A DIRECTION. `output` and `calls` are shown without
 *    a tone: colouring them would be inventing a judgement (see `DIRECTION`).
 *  - ZERO IS READ ONLY WHERE IT IS DECLARED. An `inferred` row has its lines of
 *    code at zero by construction, not because nothing was written.
 */

/* ───────────────────────────── thresholds ───────────────────────────── */

/**
 * How many sessions are needed per side, PER METRIC.
 *
 * Three and not two: with two the median is the mean of two numbers, and a
 * single out-of-scale value shifts it entirely -- which is exactly what the
 * median was supposed to protect against.
 *
 * Three and not five, and that is a measurement, not a taste: on 14 September
 * 2026, on the two real jobs on disk, the "after" cohorts were of 2 and 0
 * sessions. At five none of the five figures would ever have become readable,
 * and a gate that never opens protects nothing: it is a feature that does not
 * exist.
 */
export const MIN_COHORT = EFFECT_MIN_COHORT;

/**
 * How far back it looks, and how far forward.
 *
 * The two numbers are not independent of `HISTORY_ROW_DAYS`, which is 30:
 * past that limit rows are folded into monthly aggregates and vanish from
 * `between`. 14 + 14 = 28 leaves two days of margin, i.e. it guarantees that
 * for the whole life of an open window BOTH sides are still on disk. If they
 * ever grew, the first to break would be the "before" side, and it would
 * break silently.
 */
export const BASELINE_DAYS = 14;
export const FOLLOW_DAYS = 14;

/** Past this the cohort no longer improves: it is closed and put on record. */
export const COHORT_MAX = 12;

/**
 * Which way is better, when there is a way.
 *
 * `output` and `calls` are `none` on purpose. Fewer calls per turn can mean
 * more efficiency or less work done; more output over weight can mean the
 * quota is finally going into produced tokens instead of re-reading context,
 * or that the model is rambling. Nobody knows, and painting one of the two
 * readings green would be choosing for the reader.
 */
export { EFFECT_DIRECTION as DIRECTION } from '../../shared/protocol.ts';

/** All five, always in the same order: it is also the on-screen order. */
export const METRICS = EFFECT_METRICS;

/* ───────────────────────────── types ───────────────────────────── */

/** A median and the cohort it comes from. `value: null` = under the gate. */
export interface EffectMetric {
  value: number | null;
  n: number;
}

/** One side of the comparison: before, or after. */
export type EffectSide = Record<EffectMetricId, EffectMetric>;

/**
 * How it was before. Taken once and NEVER recomputed.
 *
 * It is not caution, it is necessity: at thirty days the rows that produced
 * it vanish from the registry, and a measurement that changes retroactively
 * is not a measurement. Same reason a building's `slot` is assigned once and
 * saved.
 */
export interface EffectBaseline {
  /** When it was taken. */
  at: number;
  projectId: string;
  provider: ProviderId;
  /**
   * The window looked at backwards, right end EXCLUDED.
   *
   * `to` is `job.at` -- the instant you accepted -- and not the end of the
   * job. That is what keeps the worker and the reviewer out BY CONSTRUCTION,
   * without depending on their ids: they start later. It really is needed,
   * because the worker of the 13 September audit shows up as started 434 ms
   * BEFORE `job.at`, and cutting at the end of the job would have counted it
   * among its own "before" sessions.
   */
  from: number;
  to: number;
  /** How many non-CEO sessions there were in all: the cohorts' denominator. */
  sessions: number;
  side: EffectSide;
}

/** Why there is nothing at all to measure. Empty when there is. */
export type EffectVoid =
  | 'the work failed'
  | 'the work names no project'
  | 'nothing landed in the repository'
  | 'the sessions from before it are no longer on disk';

/** The CEO tried to disprove itself. */
export interface EffectVerdict {
  at: number;
  /**
   * `true` ONLY if the CEO could not find another explanation.
   *
   * The opposite direction from `holds` and `founded`, and it is not an
   * oversight: there, a missing field is a model that did not answer, and the
   * neutral assumption is "it holds". Here the zero-cost answer is "yes, it's
   * my doing", and a forgotten field must not be able to count as a merit.
   */
  attributed: boolean;
  /** One line: what really explains the movement. It is what goes into memory. */
  why: string;
}

/** What is kept inside the `Job`. */
export interface EffectRecord {
  baseline: EffectBaseline | null;
  /** Empty as long as there is something to measure. */
  voided: EffectVoid | '';
  /** The final reading, written when the window closes. Before that, `null`. */
  settled: EffectReading | null;
  verdict: EffectVerdict | null;
}

/** The result of the computation. Not persisted while the window is open. */
export interface EffectReading {
  state: 'waiting' | 'read' | 'void';
  /** In English: it is text that is shown. */
  reason: string;
  baseline: EffectBaseline;
  after: EffectSide;
  afterSessions: number;
  /** How many sessions the thinnest metric still lacks. Zero when we are there. */
  need: number;
  /** Which metric is the thinnest: it is the one named in the message. */
  needFor: EffectMetricId | null;
  closedAt: number | null;
  closedBy: 'time' | 'job' | 'enough' | null;
}

/* ─────────────────────────── arithmetic ─────────────────────────── */

/**
 * The median, or `null` if there is nothing to take the median of.
 *
 * Median and not mean because the mean of this set of numbers is the biggest
 * session: among the real rows there is one with 616 million tokens of cache
 * read against a project median of two million.
 */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * The figure of ONE session for ONE metric, or `null` if that row does not carry it.
 *
 * The `null` is never a disguised zero: a session that did not touch code
 * has neither an infinite yield nor a zero yield, it simply has none, and it
 * must be kept out of the median instead of inside it with a fake value.
 */
export function valueOf(row: ClosedSession, id: EffectMetricId): number | null {
  const w = weigh(row.tokens);
  switch (id) {
    case 'cost':
      return w > 0 ? w : null;
    case 'yield': {
      const lines = row.linesAdded + row.linesRemoved;
      // Codex never declares landed lines, and neither does an `inferred` row:
      // for them this figure does not exist, and not existing is the right
      // answer.
      return lines > 0 && w > 0 ? w / lines : null;
    }
    case 'cache':
      return cacheHitOf(row.tokens);
    case 'output':
      // The WEIGHT as denominator and not `in + out`: the question is where
      // the quota ends up, and the quota is measured in weighted tokens. On a
      // real session of 21.8 million weighted, output is worth 10%; with
      // `out/(in+out)` it would come out at 92%, which is just as true and
      // useless. `thinking` is not added: the API already counts it inside
      // `out`.
      return w > 0 ? ((row.tokens.out * 5) / w) * 100 : null;
    case 'calls':
      // The only one that requires `watched`. The closing tally carries
      // neither turns nor calls, so every row recovered from disk has
      // `turns: 0` -- and it is the same reason `historyLine` compares calls
      // only when both periods were observed.
      return row.watched && row.turns > 0 ? row.toolCalls / row.turns : null;
    default:
      return null;
  }
}

/** The five medians of a group of rows, each with its own gate. */
export function sideOf(rows: readonly ClosedSession[]): EffectSide {
  const side = {} as EffectSide;
  for (const id of METRICS) {
    const xs: number[] = [];
    for (const r of rows) {
      const v = valueOf(r, id);
      if (v !== null) xs.push(v);
    }
    // Under the gate `n` is kept and the number thrown away: how many are
    // missing is information, a number computed on two rows is a lie.
    side[id] = xs.length >= MIN_COHORT
      ? { value: median(xs), n: xs.length }
      : { value: null, n: xs.length };
  }
  return side;
}

/**
 * The rows admitted into a cohort.
 *
 * Four filters, in this order:
 *
 *  1. SAME TOOL. That is the CEO being judged, the conversion into quota is
 *     per provider, and mixing the token economics of two tools in a single
 *     median would be the convenient lie.
 *  2. NOT OPENED BY THE CEOs. On the "before" side it is redundant -- the
 *     boundary at `job.at` already takes care of it -- and it is kept anyway:
 *     an invariant with a single guardian is not an invariant, and `adopt`
 *     can fail, leaving `work.sessionId` at `null`.
 *  3. NOT EMPTY. In the registry there is a row with every token at zero: it
 *     is not a session that cost zero, it is a session nothing is known
 *     about, and it would drag to zero every median it entered.
 *  4. CAP. The most recent ones, up to `COHORT_MAX`.
 */
export function cohort(
  rows: readonly ClosedSession[],
  provider: ProviderId,
  ceoSessions: ReadonlySet<string>,
): ClosedSession[] {
  const kept = rows.filter((r) => (
    r.provider === provider
    && !ceoSessions.has(r.id)
    && weigh(r.tokens) > 0
  ));
  return kept.slice(-COHORT_MAX);
}

/**
 * How many sessions the metric closest to becoming readable still lacks.
 *
 * Not "the thinnest": the CLOSEST. Saying "one more for cost" is a promise
 * that comes true; saying "three more for calls per turn", when those depend
 * on being observed and not on the count, would be a wait that might never
 * end.
 */
export function shortfall(side: EffectSide): { need: number; needFor: EffectMetricId | null } {
  let best: { need: number; needFor: EffectMetricId } | null = null;
  for (const id of METRICS) {
    const m = side[id];
    if (m.value !== null) continue;
    const need = MIN_COHORT - m.n;
    if (!best || need < best.need) best = { need, needFor: id };
  }
  return best ?? { need: 0, needFor: null };
}

/**
 * How many figures are readable on BOTH sides.
 *
 * One is enough for there to be something to say, and there is no need to
 * demand them all: `calls` depends on having been watching and not on the
 * number of sessions, so on a project full of rows recovered from disk it
 * would never open -- and waiting for it would mean never reading the other
 * four either.
 */
export function readable(before: EffectSide, after: EffectSide): EffectMetricId[] {
  return METRICS.filter((id) => before[id].value !== null && after[id].value !== null);
}

/* ────────────────────────── the life cycle ────────────────────────── */

/** What a figure is called: from the contract, which shares it with the panel. */
const LABELS = EFFECT_LABELS;

export interface EffectDeps {
  jobs: JobStore;
  projectSessions: (
    projectId: string, from: number, to: number,
  ) => readonly ClosedSession[];
  /**
   * The one line in memory about how the project went after `job`.
   *
   * Called again only when the line changes -- a bigger cohort, a window that
   * closes, a verdict -- and the memory keys it by job, so each call replaces
   * the last one instead of adding to it.
   */
  remember: (job: Job, text: string) => void;
}

export interface Effects {
  /** The job is done: the snapshot of how it was before is taken. */
  freeze(job: Job, now: number): void;
  /**
   * Recomputes the open readings, and puts the closed ones on record.
   *
   * Lazy and without a timer: a GESTURE calls it -- the panel opening, or a
   * brief being built. An interval in here would be the only code path in the
   * project that moves without you having done anything.
   */
  refresh(now: number): void;
  /** The readings of every job, for whoever asks for them. */
  board(now: number): { job: Job; reading: EffectReading | null }[];
}

/** The ids of the sessions the CEOs opened themselves: they are not your work. */
function ceoSessionsOf(jobs: JobStore): Set<string> {
  const out = new Set<string>();
  for (const j of jobs.list()) {
    if (j.work.sessionId) out.add(j.work.sessionId);
    if (j.review?.sessionId) out.add(j.review.sessionId);
  }
  return out;
}

/** The nearest applied job that touches the same project after `after`. */
function nextJobOn(jobs: JobStore, projectId: string, id: string, after: number): number | null {
  let best: number | null = null;
  for (const j of jobs.list()) {
    if (j.id === id || j.projectId !== projectId) continue;
    if (j.at <= after) continue;
    if (best === null || j.at < best) best = j.at;
  }
  return best;
}

export function createEffects(deps: EffectDeps): Effects {
  /**
   * The line each job last got in memory, so an unchanged one is not written
   * again at every question. It lives only as long as the process: after a
   * restart the first refresh writes every line once more, and the keyed
   * memory turns that into nothing where the text has not changed.
   */
  const noted = new Map<string, string>();

  function freeze(job: Job, now: number): void {
    if (job.effect) return;

    /*
     * Late is late, and it is said instead of taking a bad snapshot.
     *
     * It is needed for the jobs already on disk when this measurement arrived
     * -- and for those the server saw finish while it was off. The snapshot
     * looks back `BASELINE_DAYS`, and the history keeps whole rows for
     * `HISTORY_ROW_DAYS`: beyond the difference between the two, the
     * "before" is already partly buried in the monthly aggregates, and a
     * baseline built on the few rows left would say the project cost less
     * than it did -- because the ones that vanish are the oldest, not the
     * least representative.
     */
    const reach = (HISTORY_ROW_DAYS - BASELINE_DAYS) * 24 * 60 * 60 * 1000;
    if (now - job.at > reach) {
      deps.jobs.freeze(job.id, {
        baseline: null,
        voided: 'the sessions from before it are no longer on disk',
        settled: null,
        verdict: null,
      });
      return;
    }

    const voided: EffectVoid | '' = job.work.state === 'failed'
      ? 'the work failed'
      : job.projectId === null
        ? 'the work names no project'
        : '';
    if (voided !== '' || job.projectId === null) {
      deps.jobs.freeze(job.id, { baseline: null, voided: voided || 'the work failed', settled: null, verdict: null });
      return;
    }

    /*
     * The window ends at `job.at`, the instant you accepted, and not at the
     * end of the job. That is what keeps the worker and the reviewer out BY
     * CONSTRUCTION: they start later. It really is needed -- measured, the
     * audit's worker shows up as started 434 ms before `job.at`, so cutting
     * at the end of the job would have counted it among its own "before"
     * sessions.
     */
    const from = job.at - BASELINE_DAYS * 24 * 60 * 60 * 1000;
    const rows = cohort(
      deps.projectSessions(job.projectId, from, job.at),
      job.provider,
      ceoSessionsOf(deps.jobs),
    );

    deps.jobs.freeze(job.id, {
      baseline: {
        at: now,
        projectId: job.projectId,
        provider: job.provider,
        from,
        to: job.at,
        sessions: rows.length,
        side: sideOf(rows),
      },
      voided: '',
      settled: null,
      verdict: null,
    });
  }

  function read(job: Job, now: number): EffectReading | null {
    const rec = job.effect;
    if (!rec || !rec.baseline) return null;
    // Frozen: from here on it is never recomputed. At thirty days the rows
    // that produced it vanish, and a reading that kept redoing itself would
    // become progressively false without saying so.
    if (rec.settled) return rec.settled;

    const base = rec.baseline;
    const start = job.work.endedAt ?? job.at;
    const deadline = start + FOLLOW_DAYS * 24 * 60 * 60 * 1000;
    const next = nextJobOn(deps.jobs, base.projectId, job.id, start);
    // A second job TRUNCATES the window, it does not void it: if the cohort
    // was already full the measurement holds, and it belongs to the job that
    // came first.
    const to = Math.min(now, deadline, next ?? Number.POSITIVE_INFINITY);

    const all = deps.projectSessions(base.projectId, start, to);
    const rows = cohort(all, base.provider, ceoSessionsOf(deps.jobs));
    const after = sideOf(rows);
    const ok = readable(base.side, after);
    const gap = shortfall(after);

    const closedBy: EffectReading['closedBy'] = now >= deadline
      ? 'time'
      : next !== null && next <= now
        ? 'job'
        : rows.length >= COHORT_MAX
          ? 'enough'
          : null;

    /*
     * The zero of landed lines is read ONLY where it is declared.
     *
     * The row of a `claude -p` worker is born `inferred` -- the world model
     * does not count lines, and `costSeed` does not promote a row it already
     * knows -- so it has `linesAdded: 0` by construction. Measured: all three
     * workers on disk are like that, and one of them had really written
     * something. Saying "it left nothing" would be a lie built on a field
     * nobody filled in.
     */
    const mine = job.work.sessionId;
    const worker = mine === null ? undefined : all.find((r) => r.id === mine);
    const noReceipt = worker !== undefined && worker.confidence !== 'reported';
    const nothingLanded = worker !== undefined
      && worker.confidence === 'reported'
      && worker.linesAdded + worker.linesRemoved === 0;

    const state: EffectReading['state'] = nothingLanded
      ? 'void'
      : ok.length > 0 ? 'read' : 'waiting';

    const reason = nothingLanded
      ? 'nothing landed in the repository: the sessions after cannot have felt it'
      : ok.length > 0
        ? `${ok.length} of ${METRICS.length} figures readable over ${rows.length} sessions`
          + (noReceipt ? ' -- the worker left no receipt, so what it wrote is unknown' : '')
        : gap.needFor === null
          ? 'no sessions yet'
          : `${gap.need} more session${gap.need === 1 ? '' : 's'} for ${LABELS[gap.needFor]}`;

    return {
      state,
      reason,
      baseline: base,
      after,
      afterSessions: rows.length,
      need: gap.need,
      needFor: gap.needFor,
      closedAt: closedBy === null ? null : to,
      closedBy,
    };
  }

  return {
    freeze,

    refresh(now) {
      for (const job of deps.jobs.list()) {
        // Whoever finished and has no snapshot yet gets one now: it is the
        // road by which jobs accepted before this measurement existed come on
        // stage, as long as the history of that time is still readable.
        if (!job.effect && job.work.state !== 'running') freeze(job, now);
        const r = read(job, now);
        if (!r) continue;
        // Settled readings too: their line is rebuilt after a restart like any
        // other, because the memory no longer keeps lines that are not keyed.
        const line = effectNote(job, r);
        if (line !== null && noted.get(job.id) !== line) {
          noted.set(job.id, line);
          deps.remember(job, line);
        }
        // Closed: it goes on record and is never touched again.
        if (!job.effect?.settled && r.closedBy !== null) deps.jobs.settle(job.id, r);
      }
    },

    board(now) {
      return deps.jobs.list().map((job) => ({ job, reading: read(job, now) }));
    },
  };
}

/**
 * The line that goes into the CEO's memory. Two hundred characters, cohort
 * included.
 *
 * The cohort ALWAYS travels next to the percentage, and it is not pedantry: a
 * note that just said "-38%" comes back in the brief, and the CEO reasons on
 * it as on a success of its own measured over who knows how many sessions. It
 * is the same failure `work.ts` documents -- the CEO's sentence sent back to
 * the CEO.
 *
 * The line names its job, and says when the window is still open: a reading
 * over three sessions is the least stable one the gate lets through, and it is
 * the one the CEO turned into a proposal. Once the job has been judged, the
 * judgement IS the line and the numbers leave memory -- "measured, but not
 * mine" next to the bare "+382%" still left the number there to be read.
 * `null` while there is nothing readable to say.
 */
export function effectNote(job: Job, r: EffectReading): string | null {
  const name = jobLabel(job);
  const verdict = job.effect?.verdict ?? null;
  if (verdict) {
    return verdict.attributed
      ? `after ${name}, measured, and I could not explain it away: ${verdict.why}`
      : `after ${name}, measured, but not mine: ${verdict.why}`;
  }
  if (r.state !== 'read') return null;

  const bits: string[] = [];
  for (const id of METRICS) {
    const b = r.baseline.side[id].value;
    const a = r.after[id].value;
    if (b === null || a === null) continue;
    const m = moved(a, b);
    if (m) bits.push(`${LABELS[id]} ${m}`);
  }
  const over = `over ${r.afterSessions} session${r.afterSessions === 1 ? '' : 's'}`;
  const open = r.closedBy === null ? ' (still measuring)' : '';
  return bits.length === 0
    ? `after ${name}${open} nothing moved, ${over}`
    : `after ${name}${open}: ${bits.join(', ')}, ${over}`;
}
