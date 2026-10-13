import { randomUUID } from 'node:crypto';
import type {
  DeltaEvent, PlanProject, PlanStall, PlanTask, ProviderId, ProviderLimits, ServerFrame, Snapshot, TaskSize,
} from '../../shared/protocol.ts';
import { MAX_FIELD_CHARS } from '../../shared/protocol.ts';
import type { PlanFrame } from '../ceoPort.ts';
import { effortFor, modelFor } from './analyses.ts';
import type { Launch, WorkOrder } from './fleet.ts';
import type { JobEnd } from './jobs.ts';
import { visibleProse } from './outcome.ts';
import { countsOf, createPlanStore, docOf, findTask, MAX_RESERVE_STOPS, openQuestionsOf } from './plan.ts';
import type { Plan, PlanResult, PlanStore, ReadAnswer, TaskReport } from './plan.ts';
import {
  MEETING_SYSTEM, openingPrompt, parseMeetingOutcome, pendingAttachments, restartPrompt, turnPrompt,
  withdrawnNames, wrapUpPrompt,
} from './planning.ts';
import type { MeetingContext } from './planning.ts';
import { effectiveGit, parsePlanReport, planAnswer, planRetry, planTask } from './planWork.ts';
import { shareByWindow } from './quota.ts';
import type { CallEnd, ConverseOptions, ReplyChannel } from './runner.ts';
import { humanSessions, nextLaunch, reserveBreach } from './scheduler.ts';
import type { LiveSessionRef } from './scheduler.ts';
import { planLimits, weigh } from './spend.ts';
import type { ClosedSession } from '../state/history.ts';

/**
 * The planning desk: the meeting, the plan, and what launches from it.
 *
 * One entry per frame, one reply per frame. Every change ends the same way:
 * the plan is saved, everyone gets a `plan` delta (counts, status, nothing
 * that a redaction guard would stop), and whoever asked gets the whole
 * document back with the reason of a refusal, if there was one. The document
 * goes to the asker and not to everyone for the same reason an outcome does:
 * briefings are thousands of characters, and the delta channel carries
 * metadata.
 *
 * A turn of the meeting is the one thing here that costs a model: it goes
 * through the chair's runner, in a session that is resumed turn after turn.
 * What the chair answers is read once, from the block, into the store -- the
 * minutes and the plan -- so the meeting can be picked up from the disk if
 * that session is ever gone.
 *
 * Launching costs no model: the scheduler is a rule, the order is a prompt
 * the plan already holds, and the fleet starts the process through the same
 * gates a proposal goes through.
 */

/**
 * How long an attempt may run before it is cut, by the size the chair gave it.
 *
 * Time is not a brake on spending -- the quota is -- it catches a worker
 * that never ends. A large task is allowed an hour; the proposal's worker
 * keeps its twenty minutes.
 */
export const SIZE_CEILING_MS: Record<TaskSize, number> = {
  small: 15 * 60_000,
  medium: 30 * 60_000,
  large: 60 * 60_000,
};

/**
 * What a size costs against the median attempt: a small task half, a large
 * one double. Coarse on purpose -- the chair's size is a guess, and a finer
 * scale would only look more precise.
 */
export const SIZE_FACTOR: Record<TaskSize, number> = { small: 0.5, medium: 1, large: 2 };

/** How far back closed sessions teach the price of a task, before any attempt has. */
const LEARN_DAYS = 7;

/**
 * A worker seen `waiting` in the registry for this long is stopped.
 *
 * With `--permission-prompts none` a Claude worker should never wait; a
 * Codex one can, on `request_user_input`. Either way nobody is there to
 * answer, and the transcript holds the question: the attempt ends as a
 * question for you, and your answer resumes that very session.
 */
export const WAIT_GRACE_MS = 30_000;
/** The reason the fleet stamps on an attempt stopped for waiting: the desk reads it back. */
export const STOPPED_WAITING = 'stopped: it was waiting for an answer';
/**
 * The reason an attempt stopped by a pause carries.
 *
 * Pausing stops the workers too. It used to stop only the launches, and a
 * pause pressed while three workers were emptying the 5h window changed
 * nothing on screen but a word: in the user's words, "I paused it but it
 * didn't work". The task goes back in the queue with its session, and
 * resuming picks it up where it was.
 */
export const STOPPED_PAUSED = 'stopped: the plan was paused';
/** The start of the reason an attempt stopped at the reserve carries; the window follows. */
export const STOPPED_RESERVE = 'stopped at the reserve';

/**
 * An attempt we stopped for the quota or a pause: not a failure of the task,
 * which goes back in the queue. The store makes one exception, for a task the
 * reserve stops `MAX_RESERVE_STOPS` times in a row.
 */
export function requeued(reason: string): boolean {
  return reason === STOPPED_PAUSED || reason.startsWith(STOPPED_RESERVE);
}

/** What the task shows when the worker asked in its transcript and not in a block. */
export const GENERIC_QUESTION = 'The worker stopped to ask something it could not settle from the briefing; '
  + 'its transcript holds the question. Answer here and the same session resumes with it.';

/** The pause you pressed, as the stall says it: known, so never a desktop notice. */
export const PAUSED_BY_YOU = 'paused by you: resume to go on';

/**
 * How long a plan must wait before a wait is worth a notice. A question or a
 * failure is said at once; a wait is often the next tick's business -- a
 * session of yours that goes quiet, a window that resets -- and a notice for
 * every one of them would teach you to ignore the notices.
 */
export const STALL_NOTICE_MS = 2 * 60_000;

function names(list: readonly string[]): string {
  return [...new Set(list)].join(', ');
}

/**
 * Why an approved plan is not moving, or null while it moves or has nothing
 * left to do.
 *
 * One rule for the HUD's warning and the desktop notice. What only you can
 * unblock comes first -- a worker asking, commands to allow, a failure, a
 * pause -- and applies even while other projects run, because that project
 * waits for you whatever the others do. A wait of the scheduler (the
 * reserve, a session of yours, the spending gate) is a stall only when
 * nothing runs: behind a running task it is just a queue.
 */
export function stallOf(plan: Pick<Plan, 'status' | 'projects'>, next: string | null): PlanStall | null {
  if (plan.status !== 'approved' && plan.status !== 'paused') return null;
  const asking: string[] = [];
  const needing: string[] = [];
  const failed: string[] = [];
  let queued = 0;
  let running = 0;
  for (const p of plan.projects) {
    for (const t of p.tasks) {
      if (t.status === 'question') (t.needs.length > 0 ? needing : asking).push(p.name);
      else if (t.status === 'failed') failed.push(p.name);
      else if (t.status === 'queued') queued += 1;
      else if (t.status === 'running') running += 1;
    }
  }
  const you: string[] = [];
  if (needing.length > 0) you.push(`${names(needing)}: commands to allow`);
  if (asking.length > 0) you.push(`${names(asking)}: a worker asks you`);
  if (failed.length > 0) you.push(`${names(failed)}: a task failed, retry or skip it`);
  if (plan.status === 'paused' && queued > 0) you.push(next?.startsWith('paused') ? next : 'paused: resume to go on');
  if (you.length > 0) return { needsYou: true, text: clip(you.join('; '), MAX_FIELD_CHARS) };
  if (plan.status === 'approved' && running === 0 && queued > 0 && next) {
    return { needsYou: false, text: clip(`waiting: ${next}`, MAX_FIELD_CHARS) };
  }
  return null;
}

/**
 * A stall as one kind, whatever its numbers: "5h at 78%" and "5h at 79%"
 * are the same wait, and a notice per point would be one every tick.
 */
export function stallKey(stall: PlanStall): string {
  return stall.text.replace(/\d+/g, '#');
}

/** The middle value: a median, so one huge session does not decide the price. */
export function median(values: readonly number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
}

export interface PlanDeskOptions {
  stateDir: string;
  providers: readonly ProviderId[];
  /** The middle rung of the Claude ladder, `--ceo-model`. */
  model: string;
  codexModel: string | null;
  snapshot: () => Snapshot;
  cwdOf: (projectId: string) => string | undefined;
  /**
   * One turn with a CEO, in its own conversation.
   *
   * Injected and not a runner: the desk must not know how a process is
   * started, and a test must be able to answer with a block of its own.
   */
  converse: (
    provider: ProviderId,
    prompt: string,
    o: ConverseOptions & { reply: ReplyChannel },
  ) => Promise<CallEnd>;
  /** The fleet's `launch`, injected for the same reason. */
  launch: (order: WorkOrder) => Launch;
  /** The fleet's `stop`, for a worker found waiting on a prompt nobody will answer. */
  stop: (jobId: string, reason: string) => boolean;
  /** Stop the chair's call in flight: starting over does not wait for an answer nobody wants. */
  stopChair: (provider: ProviderId, reason: string) => void;
  /** The ledger's gate, bound to the limits of now. */
  blockedReason: (provider: ProviderId, now: number) => string | null;
  /**
   * The fleets billed by the token: the reserve and the headroom read no
   * window for them, and the chair is told so. Absent means none.
   */
  metered?: readonly ProviderId[];
  /** Mark a job as asking you: the badge pulses, Reports says so. */
  askJob: (jobId: string) => void;
  /** Weighted tokens burned in a window: the denominator that prices a task. */
  weightedSince: (provider: ProviderId, since: number, now: number) => number;
  /** Closed sessions of a fleet: the price of a task before any attempt has taught it. */
  closedSessions: (provider: ProviderId, from: number, to: number) => readonly ClosedSession[];
  broadcast: (events: DeltaEvent[]) => void;
  /**
   * A desktop notice: the plan stopped and you may not be looking. Optional:
   * without it the warning is the HUD's alone.
   */
  notify?: (title: string, text: string) => void;
  /** Injected clock, as everywhere: a test must not wait for the wall. */
  now?: () => number;
}

export interface PlanDesk {
  handle(frame: PlanFrame, reply: (frame: ServerFrame) => void): void;
  /** The plan as a fact of the world, for `states()` and after every change. */
  event(): DeltaEvent;
  plan(): Plan;
  /** The fleet's second guardian: may this order start now? */
  authorized(order: WorkOrder): string | null;
  /**
   * Whether this provider has reached the reserve, read against the plan's
   * setting: the fleet holds it for the work that starts outside the plan.
   */
  breach(provider: ProviderId, at: number): string | null;
  /** The worker's session, as soon as the tool prints it. */
  onSession(taskId: string, sessionId: string): void;
  /** An attempt ended: the task moves, and the next one may start. */
  onJobEnd(taskId: string, jobId: string, out: JobEnd): void;
  /** Ask the scheduler for the next task and start it. Returns why not, or null. */
  launchNext(): string | null;
  /**
   * Hold the reserve against what runs now: a fleet over the line is stopped
   * and its tasks wait in the queue until the window has room. Called by
   * every tick and by every fresh reading of the quota, which a running
   * worker brings with its own responses.
   */
  guard(): void;
  /**
   * The scheduler's beat: launch what can launch, until it says wait.
   *
   * Called every `--ceo-every` and whenever something that could free a slot
   * happens -- an attempt ends, you approve, resume, answer, retry or skip.
   * Never on its own calls a model.
   */
  tick(): void;
  /** What the next attempt of a task is expected to cost, in points per window. */
  expected(provider: ProviderId, size: TaskSize): Readonly<Record<string, number>> | null;
  close(): void;
}

function clip(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap) : text;
}

/** The answers a prompt built from this plan carries, as they are now. */
function answersIn(plan: Plan): ReadAnswer[] {
  const out: ReadAnswer[] = [];
  for (const q of plan.questions) if (q.answer !== null) out.push({ id: q.id, text: q.text, answer: q.answer });
  return out;
}

export function createPlanDesk(opts: PlanDeskOptions): PlanDesk {
  const now = opts.now ?? (() => Date.now());
  const metered = opts.metered ?? [];
  /** The windows this desk's work can burn: see `planLimits`. */
  const limits = (): readonly ProviderLimits[] => planLimits(opts.snapshot().limits, metered);
  const store: PlanStore = createPlanStore(opts.stateDir, {
    providers: opts.providers, codexModel: opts.codexModel,
  });
  /** Why the scheduler is not launching anything right now. */
  let next: string | null = null;
  /** The chair is answering: the panel shows it, and a second turn waits. */
  let thinking = false;
  /** The stall being watched for a notice: its kind, since when, and whether it was said. */
  let watched: { key: string; since: number; said: boolean } | null = null;
  /** Attempts the reserve has told to stop and that have not ended yet, by job id. */
  const halting = new Set<string>();

  const event = (): DeltaEvent => {
    const plan = store.get();
    const counts = countsOf(plan);
    return {
      t: 'plan',
      at: now(),
      id: plan.id,
      rev: plan.rev,
      status: plan.status,
      chair: plan.chair,
      counts,
      questions: openQuestionsOf(plan),
      asks: counts.question,
      // Clipped at the source: the guard's counter must stay at zero.
      next: next === null ? null : clip(next, MAX_FIELD_CHARS),
      stall: stallOf(plan, next),
      meeting: thinking ? 'thinking' : 'idle',
    };
  };

  /**
   * A project's branch as the world knows it now: where a push goes. `null`
   * is a project not under git (or on a detached HEAD, where a push has no
   * branch to go to either). Read at every use and never stored: a checkout
   * moves it, and a stale branch would push to the wrong place.
   */
  const branchOf = (projectId: string): string | null =>
    opts.snapshot().projects.find((p) => p.id === projectId)?.branch ?? null;

  /** Live sessions as the scheduler sees them: one list for launching and for warning. */
  const liveSessions = (): LiveSessionRef[] => opts.snapshot().sessions.map((s) => ({
    projectId: s.projectId, provider: s.provider, spawnedByCeo: s.spawnedByCeo,
    status: s.status, lastActivityAt: s.lastActivityAt,
  }));

  const doc = (refused: string | null): ServerFrame => {
    const plan = store.get();
    const t = now();
    const live = liveSessions();
    const branches: Record<string, string | null> = {};
    const active: Record<string, number> = {};
    for (const p of plan.projects) {
      branches[p.projectId] = branchOf(p.projectId);
      active[p.projectId] = humanSessions(live, p.projectId, t);
    }
    return { t: 'plan.doc', at: t, plan: docOf(plan, { branches, active }), refused };
  };

  const changed = (): void => {
    store.save();
    opts.broadcast([event()]);
  };

  /** A change went through, or not: either way the asker sees the plan as it is. */
  const settle = (out: PlanResult, reply: (frame: ServerFrame) => void): void => {
    if (out.ok) changed();
    reply(doc(out.ok ? null : out.reason));
  };

  /** What the chair sees of the world: names to use, code to read, quota to respect. */
  const context = (): MeetingContext => {
    const snap = opts.snapshot();
    // "Live" as the scheduler will read it: a session of yours that is doing
    // something, not a terminal left open since yesterday.
    const busy = new Set<string>();
    for (const s of snap.sessions) {
      if (s.spawnedByCeo === null && s.status !== 'idle') busy.add(s.projectId);
    }
    return {
      projects: snap.projects.filter((p) => !p.disabled).map((p) => ({
        name: p.name,
        providers: p.providers,
        branch: p.branch,
        commits: p.commits,
        root: p.exists ? (opts.cwdOf(p.id) ?? null) : null,
        live: busy.has(p.id),
      })),
      limits: limits(),
      providers: opts.providers,
      metered,
      codexModel: opts.codexModel,
      now: now(),
    };
  };

  /**
   * A name the chair wrote, to a project of the world. Never guessed.
   *
   * Only a name that is ONE project's: two folders called `app` used to send
   * the task -- push ticked by default -- to whichever came first. A shared
   * name resolves to nothing, and renaming one of them in the city fixes it.
   */
  const resolve = (name: string): { projectId: string; name: string } | null => {
    const hits = opts.snapshot().projects.filter((x) => !x.disabled && x.name === name);
    return hits.length === 1 ? { projectId: hits[0]!.id, name: hits[0]!.name } : null;
  };

  /** The chair's answer, into the record: prose to the minutes, block to the plan. */
  const absorb = (full: string): void => {
    const t = now();
    const prose = visibleProse(full).trim();
    if (prose) store.noteCeo(prose, t);
    const parsed = parseMeetingOutcome(full);
    if (parsed) {
      const out = store.applyOutcome(parsed, resolve, t);
      if (!out.ok) store.noteSystem(`the chair's plan was not applied: ${out.reason}`, t);
    } else if (full.trim()) {
      store.noteSystem('the chair answered without a plan block: the plan did not change', t);
    }
  };

  /**
   * A turn that ran left its prompt in the session, answered or not: the
   * files it carried are the chair's now. One refused before it started
   * carried nothing.
   */
  const reached = (end: CallEnd): boolean => end.failed === null || end.cause === 'stopped';

  /**
   * A turn with no answer says so in the minutes. The first turn of a real
   * meeting read twenty files and was stopped by the per-call brake: the
   * panel said "No answer." and the minutes said nothing, so the next line
   * of the meeting was written without knowing why.
   */
  const noteFailure = (end: CallEnd): void => {
    if (end.failed === null) return;
    const why = clip(end.failed, 160);
    const text = end.cause === 'stopped' ? `the chair's turn was stopped: ${why}`
      : end.cause === 'refused' ? `the chair's turn did not start: ${why}`
        : `the chair did not answer: ${why}`;
    store.noteSystem(text, now());
  };

  /**
   * One turn of the meeting.
   *
   * The first turn opens a conversation with an id of ours; later turns
   * resume it. If the resume fails -- the session was deleted, or the tool
   * refused it -- the meeting starts over ONCE from the minutes, in a fresh
   * session: what was decided is on disk, and the chair is told so. A turn
   * we stopped, or one that never started, is not a lost session: the
   * meeting keeps it, and the minutes say why there is no answer.
   */
  const turn = async (said: string, reply: (frame: ServerFrame) => void): Promise<void> => {
    thinking = true;
    opts.broadcast([event()]);
    const plan = store.get();
    /*
     * Starting over during a turn makes a new plan under it: whatever the
     * stopped call brings back -- its session, its prose, its failure --
     * belongs to the old one, and written into the new it would be a
     * meeting that does not start from zero.
     */
    const live = (): boolean => store.get().id === plan.id;
    const provider = plan.chair;
    try {
      const model = modelFor(provider, plan.depth, opts.model, opts.codexModel);
      const effort = effortFor(provider, plan.depth);
      // One turn, one end. A wrap-up after a stop is the same turn, and the
      // runner's "done" in between left the panel on "No answer." with the
      // send button live while the chair was still answering.
      const stream: ReplyChannel = (delta) => {
        if (!live() || !delta) return;
        reply({ t: 'ceo.stream', at: now(), provider, surface: 'plan', delta, done: false });
      };
      const fresh = (): ConverseOptions['session'] => ({
        resume: null, fresh: provider === 'claude' ? randomUUID() : null,
      });
      const base = {
        model, effort, system: MEETING_SYSTEM, reply: stream,
        onSession: (id: string) => { if (live()) store.setSession(id); },
        onText: (full: string) => { if (live()) absorb(full); },
      };

      /**
       * Stopped while reading -- by the brake, by silence, by the ceiling --
       * the chair gets ONE more call in the same session, to answer with what
       * it read. Not after a start over (`live` is false), not after a call
       * that never ran, and never twice: a second stop is the answer.
       */
      const wrapUp = async (end: CallEnd): Promise<void> => {
        noteFailure(end);
        const session = store.get().session;
        if (end.cause !== 'stopped' || !session) return;
        // The note first, on screen: the wrap-up takes a while too.
        changed();
        const last = await opts.converse(provider, wrapUpPrompt(clip(end.failed ?? 'stopped', 160)), {
          ...base, session: { resume: session, fresh: null },
        });
        if (live()) noteFailure(last);
      };

      if (plan.session) {
        const news = { ids: pendingAttachments(plan).map((a) => a.id), gone: withdrawnNames(plan) };
        const answers = answersIn(plan);
        const end = await opts.converse(provider, turnPrompt(plan, said), {
          ...base, session: { resume: plan.session, fresh: null },
        });
        if (!live()) return;
        if (reached(end)) {
          store.delivered(news.ids, news.gone, now());
          store.readAnswers(answers, now());
        }
        if (!end.failed) return;
        if (end.cause) {
          await wrapUp(end);
          return;
        }
        // The old session is gone: not a failure of the meeting, a restart.
        store.setSession(null);
        store.noteSystem(`the chair's session could not be resumed (${clip(end.failed, 80)}): the meeting restarts from the minutes`, now());
      }
      const current = store.get();
      const restart = current.minutes.some((m) => m.role === 'ceo');
      const prompt = restart
        ? restartPrompt(current, context(), said)
        : openingPrompt(current, context());
      const answers = answersIn(current);
      const end = await opts.converse(provider, prompt, { ...base, session: fresh() });
      if (!live()) return;
      if (reached(end)) {
        store.delivered(current.attachments.map((a) => a.id), current.withdrawn, now());
        store.readAnswers(answers, now());
      }
      if (end.failed) await wrapUp(end);
    } finally {
      thinking = false;
      if (live()) reply({ t: 'ceo.stream', at: now(), provider, surface: 'plan', delta: '', done: true });
      changed();
    }
  };

  /* ───────────────────────── launching ───────────────────────── */

  /** The order for the next attempt of a task: the prompt depends on what came before. */
  const orderFor = (plan: Plan, project: PlanProject, task: PlanTask): WorkOrder => {
    const attempt = task.attempts + 1;
    // A session to resume exists only after a first attempt, and only while
    // the tool still has it; the fleet reports a refused resume as a failure,
    // and the retry after that starts fresh with the whole briefing.
    const resume = task.attempts > 0 ? task.sessionId : null;
    const branch = branchOf(project.projectId);
    const ceilingMs = SIZE_CEILING_MS[task.size] ?? SIZE_CEILING_MS.medium;
    // The worker is told the limit it is cut at: the same number, in minutes.
    const limitMinutes = Math.round(ceilingMs / 60_000);
    const prompt = resume
      ? (task.answer !== null && task.question !== null ? planAnswer(task, limitMinutes) : planRetry(task, limitMinutes))
      : planTask({ task, project, minutes: plan.minutes, branch, commands: plan.commands[project.projectId] ?? [], limitMinutes });
    return {
      id: `${task.id}:${attempt}`,
      provider: task.provider,
      projectId: project.projectId,
      projectName: project.name,
      kind: 'plan',
      summary: task.title,
      task: prompt,
      model: task.model,
      effort: task.effort,
      allowed: effectiveGit(project.git, branch),
      commands: plan.commands[project.projectId] ?? [],
      resume,
      ceilingMs,
      origin: { planId: plan.id, taskId: task.id, attempt },
    };
  };

  /** The reason changed: everyone hears it once, not once per tick. */
  const explain = (why: string | null): string | null => {
    if (why !== next) {
      next = why;
      opts.broadcast([event()]);
    }
    return why;
  };

  /**
   * The price of the next attempt, learned and never listed.
   *
   * First from the plan's own finished attempts of that fleet (the median of
   * their weighted tokens), then from your closed sessions of the last week;
   * scaled by the size the chair gave the task, and turned into points of
   * each window by the same arithmetic that prices a CEO call. `null` when
   * nothing has been measured: the scheduler then counts ten points and lets
   * one such task run alone, so the first one teaches the next.
   */
  const expected = (provider: ProviderId, size: TaskSize): Readonly<Record<string, number>> | null => {
    const t = now();
    const plan = store.get();
    const learned: number[] = [];
    for (const p of plan.projects) {
      for (const task of p.tasks) {
        if (task.provider === provider && task.learned !== null) learned.push(task.learned);
      }
    }
    let weighted = median(learned);
    if (weighted === null) {
      const rows = opts.closedSessions(provider, t - LEARN_DAYS * 86_400_000, t);
      weighted = median(rows.map((s) => weigh(s.tokens)));
    }
    if (weighted === null) return null;
    return shareByWindow(
      weighted * (SIZE_FACTOR[size] ?? 1), provider, limits(), opts.weightedSince, t,
    );
  };

  const launchNext = (): string | null => {
    const plan = store.get();
    const t = now();
    const decision = nextLaunch({
      plan,
      now: t,
      limits: limits(),
      live: liveSessions(),
      blockedReason: (p) => opts.blockedReason(p, t),
      expected,
    });
    if ('wait' in decision) return explain(decision.wait);
    const order = orderFor(plan, decision.project, decision.launch);
    const launch = opts.launch(order);
    if (!launch.ok) return explain(launch.reason);
    const out = store.launched(decision.launch.id, order.id, t);
    next = out.ok ? null : out.reason;
    changed();
    return next;
  };

  /** A running attempt whose session sits on a prompt: stopped, so it can become a question. */
  const stopWaiting = (): void => {
    const t = now();
    const plan = store.get();
    const sessions = opts.snapshot().sessions;
    for (const p of plan.projects) {
      for (const task of p.tasks) {
        if (task.status !== 'running' || !task.sessionId || !task.jobId) continue;
        const s = sessions.find((x) => x.id === task.sessionId);
        if (!s || s.status !== 'waiting' || t - s.statusSince < WAIT_GRACE_MS) continue;
        opts.stop(task.jobId, STOPPED_WAITING);
      }
    }
  };

  /** Stop every running attempt, with the reason their end will carry. */
  const stopRunning = (reason: string): number => {
    let stopped = 0;
    for (const p of store.get().projects) {
      for (const task of p.tasks) {
        if (task.status !== 'running' || !task.jobId) continue;
        if (opts.stop(task.jobId, reason)) stopped += 1;
      }
    }
    return stopped;
  };

  /**
   * The reserve, held against what runs: a fleet over the line is stopped,
   * and its tasks go back in the queue with their sessions.
   *
   * The plan is NOT paused. It used to be: a plan left to run stayed paused
   * after the window had reset, until a click, and the other fleet -- whose
   * windows had room -- was held with it (the user's call, 2026-10-12). The
   * headroom rule already holds a queued task while the window is over the
   * line and launches it when there is room again, so the same rule brings
   * these back, on the session they were in. What keeps a task that does not
   * fit from coming back at every reset is the count: `MAX_RESERVE_STOPS`.
   */
  const guard = (): void => {
    const plan = store.get();
    const t = now();
    const fleets = new Set<ProviderId>();
    for (const p of plan.projects) for (const task of p.tasks) if (task.status === 'running') fleets.add(task.provider);
    for (const provider of fleets) {
      const breach = reserveBreach(plan, provider, limits(), t);
      if (!breach) continue;
      // Once per attempt: the workers take a moment to die, and every tick
      // until then finds them still running. A second note in the minutes
      // for the same stop would read as a second stop.
      let stopped = 0;
      for (const p of plan.projects) {
        for (const task of p.tasks) {
          if (task.status !== 'running' || task.provider !== provider || !task.jobId) continue;
          if (halting.has(task.jobId)) continue;
          if (!opts.stop(task.jobId, `${STOPPED_RESERVE} (${breach})`)) continue;
          halting.add(task.jobId);
          stopped += 1;
        }
      }
      if (stopped === 0) continue;
      store.noteSystem(
        `the reserve stopped the ${provider} tasks: ${breach}. They go back in the queue and start again on their own `
        + `when the window has room; one stopped ${MAX_RESERVE_STOPS} times in a row waits for you.`,
        t,
      );
      changed();
    }
  };

  /**
   * Say a stall on the desktop, once per kind. Needing you is said at once;
   * a wait only once it has lasted `STALL_NOTICE_MS`. The pause you pressed
   * is never said: you know.
   */
  const watchStall = (): void => {
    const stall = stallOf(store.get(), next);
    if (!stall || stall.text === PAUSED_BY_YOU) { watched = null; return; }
    const t = now();
    const key = stallKey(stall);
    if (!watched || watched.key !== key) watched = { key, since: t, said: false };
    if (watched.said || !opts.notify) return;
    if (!stall.needsYou && t - watched.since < STALL_NOTICE_MS) return;
    watched.said = true;
    opts.notify(stall.needsYou ? 'Plan blocked: it needs you' : 'Plan waiting', stall.text);
  };

  const tick = (): void => {
    // Before the status check: a paused plan can still have a worker dying,
    // and the reserve is held against whatever runs.
    guard();
    if (store.get().status === 'approved') {
      stopWaiting();
      // One launch per call of the rule, at most `parallel` per tick: the rule
      // re-reads the plan each time, so the second call sees the first launch.
      for (let i = 0; i < MAX_PARALLEL_PER_TICK; i++) {
        if (launchNext() !== null) break;
      }
    }
    watchStall();
  };

  /** A change that may free a slot: the rule runs right after, not at the next tick. */
  const settleAndTick = (out: PlanResult, reply: (frame: ServerFrame) => void): void => {
    settle(out, reply);
    if (out.ok) tick();
  };

  return {
    handle(frame, reply) {
      const t = now();
      switch (frame.t) {
        case 'plan.read':
          reply(doc(null));
          return;
        case 'plan.say': {
          if (thinking) {
            reply(doc('the chair is still answering'));
            return;
          }
          const out = store.say(frame.text, t);
          settle(out, reply);
          if (!out.ok) return;
          void turn(frame.text, reply);
          return;
        }
        case 'plan.attach':
          settle(store.attach(frame.name, frame.text, t), reply);
          return;
        case 'plan.detach':
          settle(store.detach(frame.id, t), reply);
          return;
        case 'plan.set': {
          // The panel shows no commit or push for a project not under git;
          // a patch that asks for them anyway is refused here too.
          const p = frame.patch;
          if (p.kind === 'git' && (p.rules.commit || p.rules.push) && branchOf(p.projectId) === null) {
            reply(doc('no git versioning for this project: nothing to commit or push'));
            return;
          }
          settle(store.set(p, t), reply);
          return;
        }
        case 'plan.approve':
          settleAndTick(store.approve(t), reply);
          return;
        case 'plan.pause': {
          const out = store.pause(t);
          // The workers stop with the launches: their tasks come back to the
          // queue when each process ends (`onJobEnd`).
          if (out.ok) {
            stopRunning(STOPPED_PAUSED);
            next = PAUSED_BY_YOU;
          }
          settle(out, reply);
          return;
        }
        case 'plan.resume':
          settleAndTick(store.resume(t), reply);
          return;
        case 'plan.launch': {
          const why = launchNext();
          reply(doc(why));
          return;
        }
        case 'plan.answer':
          settleAndTick(store.answer(frame.taskId, frame.text, t), reply);
          return;
        case 'plan.allow':
          settleAndTick(store.allow(frame.taskId, t), reply);
          return;
        case 'plan.retry':
          settleAndTick(store.retry(frame.taskId, t), reply);
          return;
        case 'plan.skip':
          settleAndTick(store.skip(frame.taskId, t), reply);
          return;
        case 'plan.reset': {
          // Start over does not wait for the chair: you asked for a clean
          // table, and "still answering" left you waiting on an answer to a
          // meeting you were throwing away. Only a worker stops it, in the
          // store: it is working on a repository and must end somewhere.
          const chair = store.get().chair;
          const out = store.reset(t);
          if (out.ok && thinking) opts.stopChair(chair, 'the meeting was started over');
          settle(out, reply);
          return;
        }
        default:
          reply(doc('unknown request'));
      }
    },

    event,

    plan: () => store.get(),

    breach(provider, at) {
      return reserveBreach(store.get(), provider, limits(), at);
    },

    authorized(order) {
      const plan = store.get();
      if (order.origin.planId !== plan.id) return 'the order belongs to another plan';
      if (plan.status !== 'approved') return `the plan is ${plan.status}`;
      const found = findTask(plan, order.origin.taskId);
      if (!found) return 'no such task in the plan';
      if (found.task.status !== 'queued') return `the task is ${found.task.status}`;
      if (order.origin.attempt !== found.task.attempts + 1) return 'the attempt number is stale';
      return null;
    },

    onSession(taskId, sessionId) {
      store.attachSession(taskId, sessionId, now());
      store.save();
    },

    onJobEnd(taskId, jobId, out) {
      const t = now();
      halting.delete(jobId);
      const report = out.ok ? parsePlanReport(out.outcome) : null;
      // Stopped by us for waiting: a question, with the generic text -- the
      // real one is in its transcript, and the session that holds it is the
      // one your answer resumes.
      const waited = !out.ok && out.reason === STOPPED_WAITING;
      // Stopped by a pause or at the reserve: the task did not fail, we took
      // the slot back. It waits in the queue with its session.
      const back = !out.ok && requeued(out.reason);
      // A clean exit with an answer and no block is done: the outcome is in
      // Reports either way. A block that says failed carries its own why.
      const status: TaskReport['status'] = waited ? 'question' : back ? 'queued'
        : !out.ok ? 'failed' : (report?.status ?? 'done');
      const reason = !out.ok && !waited ? out.reason
        : status === 'failed' ? (report?.did ?? 'the worker reported a failure')
        : '';
      const res = store.finished(taskId, {
        status,
        did: report?.did ?? null,
        question: waited ? GENERIC_QUESTION : (report?.question ?? null),
        needs: waited ? [] : (report?.needs ?? []),
        reason,
        learned: out.weighted ?? null,
        byReserve: back && out.reason.startsWith(STOPPED_RESERVE),
      }, t);
      const ended = res.ok ? findTask(res.plan, taskId)?.task : undefined;
      if (ended?.status === 'question') opts.askJob(jobId);
      // Sent back to the queue and found failed: the store counted one stop at
      // the reserve too many. It is said in the minutes, next to the stops.
      if (back && ended?.status === 'failed') {
        store.noteSystem(`"${ended.title}" was stopped at the reserve ${MAX_RESERVE_STOPS} times in a row: it does not start again on its own. Retry resumes its session, skip drops it.`, t);
      }
      changed();
      // A slot just freed: the next task starts now, not at the next tick.
      tick();
    },

    launchNext,

    guard,

    tick,

    expected,

    close() {
      store.save();
    },
  };
}

/** Launches one tick may make: the parallel cap is four, and the rule stops earlier anyway. */
const MAX_PARALLEL_PER_TICK = 4;
