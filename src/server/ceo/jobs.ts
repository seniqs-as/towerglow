import * as fs from 'node:fs';
import * as path from 'node:path';
import { MAX_SUMMARY_CHARS } from '../../shared/protocol.ts';
import type { JobState, ProviderId } from '../../shared/protocol.ts';
import type { EffectRecord, EffectReading, EffectVerdict } from './effect.ts';
import { archive } from './proposals.ts';

/**
 * The job ledger: what you accepted, and how it went.
 *
 * ```
 * running ──► done     ──► (dismissed: leaves the stage, stays in Reports)
 *         └─► failed   ──► same
 * ```
 *
 * A job is NOT a session, and that is the distinction that holds up
 * everything else. A session lives as long as its process; a job must outlive
 * it, because the thing you care about -- how it went -- exists only after
 * the process has died. As long as the mast was a session, it vanished
 * together with the process and nobody ever saw the outcome: you accepted a
 * piece of advice and could no longer tell how it went.
 *
 * A job has TWO PARTS and a single mast. On accepting, whoever does the job
 * starts and, next to it, whoever judges it -- the session that works on that
 * project, resumed with a fork. They are two processes because they do two
 * different things, but they are a single decision: yours. Two masts for a
 * single yes would say that you accepted two things, and the outcome and the
 * review would be read in two distant places instead of next to each other,
 * where they are needed.
 *
 * A finished mast stays on stage for `KEEP_ON_STAGE_MS` and then closes by
 * itself. The earlier rule was "until you close it", and it came from a fair
 * fear: vanishing after N seconds would mean losing a result while you were
 * looking elsewhere. But that fear spoke of a time when the outcome existed
 * nowhere. Today `dismissed` means "off the stage, INSIDE Reports", and there
 * the outcome stays on disk with the line of whoever produced it. What the
 * wait protects now is the moment you notice -- five minutes to see the check
 * mark appear -- not the result, which no longer goes away.
 */

const VERSION = 2;

/**
 * How many are kept.
 *
 * Fifty and not "all": Reports is the memory of what you had done, not an
 * archive. And fifty is fewer than the two hundred proposals for a physical
 * reason -- every job carries its whole outcome with it, while a proposal
 * weighs one sentence.
 */
const MAX_KEPT = 50;

/**
 * How much outcome is kept, per part.
 *
 * Measured: the answer of a real audit was ~5,000 characters. Twenty thousand
 * is roomy for a long answer and tight enough that fifty rows stay a
 * one-megabyte file, not a twenty-megabyte one. Beyond that, it is cut and
 * says so: `truncated` exists because a text that ends halfway without
 * warning looks like a model that got interrupted.
 */
export const MAX_OUTCOME_CHARS = 20_000;

/** Which of the two parts of a job. */
export type JobPartKind = 'work' | 'review';

/** A part: a process, its outcome, and how it ended. */
export interface JobPart {
  state: JobState;
  /** The session doing it. Arrives when the registry surfaces it. */
  sessionId: string | null;
  toolCalls: number;
  costUsd: number;
  /** The full outcome. It NEVER crosses the delta channel: it is requested. */
  outcome: string;
  truncated: boolean;
  /** Why it went wrong. Empty when it did not go wrong. */
  reason: string;
  endedAt: number | null;
  /**
   * Weighted tokens the process burned, when the tool declared them.
   *
   * Zero also means "not said": `codex exec` prints none. It is what a
   * planned task's next attempt is expected to cost, and the only number the
   * scheduler's headroom rule can learn from.
   */
  weighted: number;
}

/** Where a planned attempt belongs. Same shape on the delta channel, plus the plan id here. */
export interface PlanRef {
  planId: string;
  taskId: string;
  attempt: number;
}

export interface Job {
  id: string;
  at: number;
  provider: ProviderId;
  kind: string;
  summary: string;
  projectId: string | null;
  projectName: string | null;
  /** What you accepted. */
  work: JobPart;
  /**
   * The second opinion. `null` until it starts, and forever if it does not.
   *
   * It may not start without that being a fault: no session on that project
   * only means there is nobody to ask.
   */
  review: JobPart | null;
  /**
   * The advice holds, according to whoever works there.
   *
   * `null` until it is known -- review not started, not finished, or finished
   * without a readable verdict. A `false` is the most valuable information
   * this ledger holds: it is the only one the CEO could not have.
   */
  reviewHolds: boolean | null;
  /**
   * The review comes from a NEW session, not from whoever was working there.
   *
   * `null` until it starts. The difference is not a technical detail: whoever
   * was resumed with a fork knows why the work was done that way, whoever
   * opened just now only knows how the repository is made and has verified the
   * premises. The two answers do not carry the same weight, and reading them
   * as the same thing -- "the session agrees" for a five-minute newcomer --
   * would be the convenient lie. That is why the distinction starts here, in
   * the ledger.
   */
  reviewFresh: boolean | null;
  /**
   * What the worker says it did. One line, its own.
   *
   * `null` until it has finished, and forever if the answer did not carry the
   * outcome block. It sits on the job and not inside `work` for the same
   * reason as `reviewHolds`: it is something KNOWN about that job, derived
   * from the text, and not a counter of the process.
   */
  workDid: string | null;
  /**
   * The documents the worker wrote for you, as paths inside the project.
   *
   * Next to `workDid` and for the same reason: known about the job, read from
   * its block. It is what lets Reports open the plan of a "planning only"
   * task instead of the worker's message about it. Additive, like `plan`.
   */
  workWrote: string[];
  /**
   * The request stood up, according to whoever carried it out.
   *
   * The twin of `reviewHolds`, and it costs nothing: it comes from whoever
   * was working anyway, while the review costs a fork. Measured: two jobs out
   * of two reported it false, and without this field that fact lived only
   * inside the CEO's memory -- that is, nowhere you would read.
   */
  workFounded: boolean | null;
  /** You closed it: off the stage, inside Reports. */
  dismissed: boolean;
  /**
   * How it went AFTERWARDS.
   *
   * `null` for a failed job, for one without a project, and for every job
   * written before this field existed -- and it is for this last case that
   * `VERSION` is not touched: `createJobStore` discards the whole ledger if
   * the number does not match, and the jobs you already have on disk would
   * vanish from Reports. It gets bumped when an old reader would read something
   * WRONG, not when it lacks a field it does not read.
   *
   * The type lives in `effect.ts`, where the model of the measure is; here is
   * only the place where it is kept, as `JobEnd` lives here and not in the
   * fleet.
   */
  effect: EffectRecord | null;
  /**
   * The planned task this job is an attempt of. `null` for a proposal's job.
   *
   * Additive, like `effect`: a registry written before it existed loads with
   * null, and `VERSION` stays where it is for the reason written above it.
   */
  plan: PlanRef | null;
  /** The worker stopped to ask you something. Its question is on the plan; here is the flag. */
  asks: boolean;
  /**
   * You erased this job's outcome (the measure), and it must not come back.
   *
   * `effect: null` alone means "not frozen yet", and the next refresh would
   * freeze it again from the history. Additive: a ledger written before it
   * existed loads as false.
   */
  effectCleared: boolean;
}

export type NewJob = Pick<Job, 'id' | 'at' | 'provider' | 'kind' | 'summary' | 'projectId' | 'projectName'>
  & { plan?: PlanRef | null };

/**
 * How a part ended: what the ledger needs to know to write the row. Defined
 * here and not in the fleet because it is the job's model, and a type with two
 * definitions is a type with two truths.
 */
export interface JobEnd {
  ok: boolean;
  /** The final answer, whole. The ledger cuts it, not whoever produces it. */
  outcome: string;
  costUsd: number;
  /** Why it went wrong. Empty when it did not go wrong. */
  reason: string;
  at: number;
  /** Weighted tokens, when declared. Optional: the review fork and old callers do not count them. */
  weighted?: number;
}

export interface JobStore {
  add(j: NewJob): Job;
  get(id: string): Job | undefined;
  /** All of them, oldest first. Including the closed ones: Reports wants them. */
  list(): Job[];
  /** Those still on stage: one mast each. */
  onStage(): Job[];
  /**
   * The second opinion has started: from here on the job has two parts.
   *
   * `fresh` says whether a new session was opened instead of resuming the one
   * that was working there -- it is the difference between "I know why" and
   * "I verified".
   */
  openReview(id: string, fresh: boolean): Job | undefined;
  progress(id: string, part: JobPartKind, toolCalls: number): Job | undefined;
  attach(id: string, part: JobPartKind, sessionId: string): Job | undefined;
  /**
   * The line the worker left in its outcome block.
   *
   * Separate from `finish` on purpose: that one receives how the PROCESS went
   * (exit code, cost, outcome), this one what whoever worked UNDERSTOOD. Two
   * different sources, and cramming them into the same argument would have
   * made parsing a block look like a property of the process.
   */
  report(id: string, did: string, founded: boolean, wrote?: readonly string[]): Job | undefined;
  finish(id: string, part: JobPartKind, out: JobEnd, holds?: boolean | null): Job | undefined;
  /**
   * The snapshot of how the project was before. It is taken ONCE.
   *
   * The second call does not overwrite, and it is not caution: at thirty days
   * the rows that produced it vanish from the history registry, and a baseline
   * retaken from a poorer set would say the "before" has changed. A before
   * that changes is not a before.
   */
  freeze(id: string, record: EffectRecord): Job | undefined;
  /** The window has closed: from here on the reading is no longer recomputed. */
  settle(id: string, reading: EffectReading): Job | undefined;
  /** The CEO tried to prove itself wrong, and here is how it went. */
  setVerdict(id: string, verdict: EffectVerdict): Job | undefined;
  /** The worker stopped with a question for you. */
  ask(id: string): Job | undefined;
  dismiss(id: string): Job | undefined;
  /**
   * Reports started over: every job goes but the running ones.
   *
   * A running job stays because a process still works for it: erased, its
   * end would land on nothing, and the outcome you are waiting for with it.
   * The rest is written to `archive/` first. Returns the ids that stayed.
   */
  clear(now: number): string[];
  /**
   * Erase one job for good. A running job is refused (a process works for
   * it); so is an id the ledger does not hold -- the id is only ever a map
   * key, never a path. Returns whether something went.
   */
  remove(id: string): boolean;
  /** Erase the measure of one job, keeping the job. Marks it so it is not retaken. */
  clearEffect(id: string): Job | undefined;
  /** Erase every measure. Returns the ids of the jobs that had one. */
  clearEffects(): string[];
  save(): void;
}

interface JobsFile {
  version: number;
  jobs: Job[];
}

const STATES = new Set<JobState>(['running', 'done', 'failed']);

function part(): JobPart {
  return {
    state: 'running', sessionId: null, toolCalls: 0, costUsd: 0,
    outcome: '', truncated: false, reason: '', endedAt: null, weighted: 0,
  };
}

function isPart(v: unknown): v is JobPart {
  const p = v as JobPart | null;
  return !!p && STATES.has(p.state) && typeof p.outcome === 'string';
}

function isJob(v: unknown): v is Job {
  const j = v as Job | null;
  return !!j && typeof j.id === 'string' && typeof j.summary === 'string' && isPart(j.work);
}

/**
 * The mast's state, from its parts.
 *
 * It runs as long as EITHER of the two runs: there is still a process working
 * for that decision, and putting up the check mark while it runs would mean
 * changing the text under the eyes of whoever is reading it.
 *
 * It fails only if the JOB fails. A review that does not start or that dies
 * is a footnote: what you had accepted was done, and painting the mast red
 * for a missing review would say the opposite.
 */
export function stateOf(job: Job): JobState {
  if (job.work.state === 'running') return 'running';
  if (job.review && job.review.state === 'running') return 'running';
  return job.work.state;
}

/**
 * How long a finished mast stays on stage.
 *
 * Five minutes: the time to notice it when you look back, not the time to
 * read the outcome -- that is read in Reports, where it stays. A higher cap
 * would fill the pads around the ship with old check marks, and the seven
 * pads (`TURRET_SLOTS`) are few: a mast that does not go away is one fewer
 * place for the job of right now.
 */
export const KEEP_ON_STAGE_MS = 5 * 60_000;

/**
 * The job finished long enough ago: its mast can close.
 *
 * It looks at the MOST RECENT end of the two parts, not at the job's: if the
 * review finished later, the five minutes start from there -- otherwise a
 * slow review would make the mast vanish the instant the verdict arrives,
 * which is the thing you were waiting for.
 *
 * A pure function, because it is the rule: the timer that consults it lives in
 * the desk.
 */
export function expiredOnStage(job: Job, now: number): boolean {
  if (job.dismissed || stateOf(job) === 'running') return false;
  const ended = Math.max(job.work.endedAt ?? 0, job.review?.endedAt ?? 0);
  // Without a known end nothing closes: better one mast too many than one
  // that vanishes because of a missing field.
  if (ended <= 0) return false;
  return now - ended >= KEEP_ON_STAGE_MS;
}

/** All the work done for that decision: it is the mast's height. */
export function toolCallsOf(job: Job): number {
  return job.work.toolCalls + (job.review?.toolCalls ?? 0);
}

/** Everything that decision cost, review included. */
export function costOf(job: Job): number {
  return job.work.costUsd + (job.review?.costUsd ?? 0);
}

/**
 * How a note in the CEO's memory names the job it is about: "your audit of
 * 2026-09-13".
 *
 * Every line about one job carries the same name -- what the worker did, what
 * the session objected, how the project went after -- so the three read as one
 * story. Without it, "after that work: cost per session +382%" was a number
 * about nothing in particular, and the CEO read it as a trend of the project.
 * The kind comes from a model, one word by contract: clipped all the same,
 * because a note is two hundred characters and the name must not eat them.
 */
export function jobLabel(job: Pick<Job, 'kind' | 'at'>): string {
  const kind = job.kind.trim().slice(0, 24) || 'job';
  return `your ${kind} of ${new Date(job.at).toISOString().slice(0, 10)}`;
}

export function createJobStore(stateDir: string): JobStore {
  const dir = path.join(stateDir, 'ceo');
  const file = path.join(dir, 'jobs.json');
  const byId = new Map<string, Job>();
  let dirty = false;

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as JobsFile;
    if (raw && raw.version === VERSION) {
      for (const j of raw.jobs ?? []) {
        if (!isJob(j)) continue;
        /*
         * A part that shows as running at startup is not: the process doing it
         * died with the previous server. Reopening it as running would give a
         * mast that grows for a process that does not exist, and the wait for
         * an outcome that will never arrive.
         */
        const stale = (p: JobPart | null): JobPart | null => {
          if (!p) return p;
          const counted = { ...p, weighted: p.weighted ?? 0 };
          if (p.state !== 'running') return counted;
          dirty = true;
          return {
            ...counted, state: 'failed', endedAt: p.endedAt ?? j.at,
            reason: p.reason || 'the server stopped while it was working',
          };
        };
        byId.set(j.id, {
          ...j,
          work: stale(j.work)!,
          review: stale(j.review ?? null),
          // Additive fields: a ledger written before they existed must not
          // propagate `undefined` all the way to the delta channel, where it
          // would vanish from the JSON and the client would read a missing
          // field instead of a null.
          workDid: j.workDid ?? null,
          workWrote: Array.isArray(j.workWrote) ? j.workWrote.filter((p) => typeof p === 'string') : [],
          workFounded: j.workFounded ?? null,
          reviewFresh: j.reviewFresh ?? null,
          effect: j.effect ?? null,
          plan: j.plan ?? null,
          asks: j.asks === true,
          effectCleared: j.effectCleared === true,
        });
      }
    }
  } catch {
    // No ledger: first time, or an unreadable file. Start from scratch.
  }

  /** The oldest already closed go first; a running one never goes. */
  function prune(): void {
    if (byId.size <= MAX_KEPT) return;
    const over = [...byId.values()]
      .filter((j) => stateOf(j) !== 'running')
      .sort((a, b) => a.at - b.at);
    for (const j of over) {
      if (byId.size <= MAX_KEPT) break;
      byId.delete(j.id);
    }
    dirty = true;
  }

  function patchPart(
    id: string, which: JobPartKind, over: Partial<JobPart>, top: Partial<Job> = {},
  ): Job | undefined {
    const j = byId.get(id);
    if (!j) return undefined;
    const current = which === 'work' ? j.work : j.review;
    if (!current) return j;
    const next: Job = { ...j, ...top, [which]: { ...current, ...over } };
    byId.set(id, next);
    dirty = true;
    return next;
  }

  return {
    add(j) {
      const full: Job = {
        ...j,
        summary: j.summary.slice(0, MAX_SUMMARY_CHARS),
        work: part(),
        review: null,
        reviewHolds: null,
        reviewFresh: null,
        workDid: null,
        workWrote: [],
        workFounded: null,
        dismissed: false,
        effect: null,
        plan: j.plan ?? null,
        asks: false,
        effectCleared: false,
      };
      byId.set(full.id, full);
      dirty = true;
      prune();
      return full;
    },

    get: (id) => byId.get(id),

    list: () => [...byId.values()].sort((a, b) => a.at - b.at),

    onStage: () => [...byId.values()].filter((j) => !j.dismissed).sort((a, b) => a.at - b.at),

    openReview(id, fresh) {
      const j = byId.get(id);
      // Idempotent: a single mast for the two parts, and the review starts
      // once per decision -- `decide` is the only path that opens it.
      if (!j || j.review) return j;
      const next: Job = { ...j, review: part(), reviewFresh: fresh };
      byId.set(id, next);
      dirty = true;
      return next;
    },

    progress: (id, which, toolCalls) => patchPart(id, which, { toolCalls }),

    attach: (id, which, sessionId) => patchPart(id, which, { sessionId }),

    report(id, did, founded, wrote = []) {
      const j = byId.get(id);
      if (!j) return undefined;
      const next: Job = { ...j, workDid: did.slice(0, MAX_SUMMARY_CHARS), workFounded: founded, workWrote: [...wrote] };
      byId.set(id, next);
      dirty = true;
      return next;
    },

    freeze(id, record) {
      const j = byId.get(id);
      if (!j) return undefined;
      // The first one wins. Retaking the snapshot from a set of rows that has
      // thinned out in the meantime -- history keeps thirty days -- would say
      // the "before" has changed, and a before that changes is not a before.
      // Same rule as `finish`, where the first closing wins.
      if (j.effect || j.effectCleared) return j;
      const next: Job = { ...j, effect: record };
      byId.set(id, next);
      dirty = true;
      return next;
    },

    settle(id, reading) {
      const j = byId.get(id);
      if (!j || !j.effect) return undefined;
      const next: Job = { ...j, effect: { ...j.effect, settled: reading } };
      byId.set(id, next);
      dirty = true;
      return next;
    },

    setVerdict(id, verdict) {
      const j = byId.get(id);
      if (!j || !j.effect) return undefined;
      // This one is rewritten: a second opinion on the same measure is
      // legitimate, and what counts is the last one you asked for.
      const next: Job = { ...j, effect: { ...j.effect, verdict } };
      byId.set(id, next);
      dirty = true;
      return next;
    },

    ask(id) {
      const j = byId.get(id);
      if (!j) return undefined;
      const next: Job = { ...j, asks: true };
      byId.set(id, next);
      dirty = true;
      return next;
    },

    finish(id, which, out, holds = null) {
      const j = byId.get(id);
      if (!j) return undefined;
      const current = which === 'work' ? j.work : j.review;
      if (!current) return j;
      // Already finished: the second closing does not overwrite the first.
      // `error` and `close` can both arrive, and what was learned first wins,
      // which is also what told the truth about why.
      if (current.state !== 'running') return j;
      const text = out.outcome.slice(0, MAX_OUTCOME_CHARS);
      return patchPart(
        id, which,
        {
          state: out.ok ? 'done' : 'failed',
          endedAt: out.at,
          outcome: text,
          truncated: out.outcome.length > text.length,
          costUsd: out.costUsd,
          reason: out.reason,
          weighted: Number.isFinite(out.weighted) && (out.weighted ?? 0) > 0 ? (out.weighted as number) : 0,
        },
        which === 'review' ? { reviewHolds: holds } : {},
      );
    },

    dismiss(id) {
      const j = byId.get(id);
      if (!j) return undefined;
      // A running job is not closed on screen: it would be a process running
      // with nothing left to tell about it.
      if (stateOf(j) === 'running') return j;
      const next: Job = { ...j, dismissed: true };
      byId.set(id, next);
      dirty = true;
      return next;
    },

    clear(now) {
      const gone = [...byId.values()].filter((j) => stateOf(j) !== 'running');
      if (gone.length > 0) {
        archive(dir, `jobs-${now}.json`, { version: VERSION, jobs: gone });
        for (const j of gone) byId.delete(j.id);
        dirty = true;
      }
      return [...byId.keys()];
    },

    remove(id) {
      const j = byId.get(id);
      if (!j || stateOf(j) === 'running') return false;
      byId.delete(id);
      dirty = true;
      return true;
    },

    clearEffect(id) {
      const j = byId.get(id);
      if (!j || stateOf(j) === 'running') return undefined;
      const next: Job = { ...j, effect: null, effectCleared: true };
      byId.set(id, next);
      dirty = true;
      return next;
    },

    clearEffects() {
      const cleared: string[] = [];
      for (const j of [...byId.values()]) {
        if (!j.effect || stateOf(j) === 'running') continue;
        byId.set(j.id, { ...j, effect: null, effectCleared: true });
        cleared.push(j.id);
      }
      if (cleared.length > 0) dirty = true;
      return cleared;
    },

    save() {
      if (!dirty) return;
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const payload: JobsFile = { version: VERSION, jobs: [...byId.values()] };
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(tmp, file);
        dirty = false;
      } catch {
        // Being unable to save does not stop the tool: what is lost is the
        // memory of outcomes between one restart and the next, not the running
        // work.
      }
    },
  };
}
