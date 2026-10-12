import * as os from 'node:os';
import type {
  AnalysisKind, CeoDepth, DeltaEvent, EffectItem, EffectPair, ProviderId, RateWindow, ServerFrame,
} from '../../shared/protocol.ts';
import { MAX_FIELD_CHARS } from '../../shared/protocol.ts';
import type { CeoDesk, CeoDeskOptions } from '../ceoPort.ts';
import { ANALYSES, analysisOf } from './analyses.ts';
import { createEffects, FOLLOW_DAYS, METRICS } from './effect.ts';
import type { EffectReading } from './effect.ts';
import { judgeTask, parseJudgement } from './judge.ts';
import { quotaShare } from './quota.ts';
import { perimeterOf } from './brief.ts';
import { createFleet } from './fleet.ts';
import type { JobRef } from './fleet.ts';
import { costOf, createJobStore, expiredOnStage, stateOf, toolCallsOf } from './jobs.ts';
import type { Job } from './jobs.ts';
import { createCeoMemory } from './memory.ts';
import { createPlanDesk } from './planDesk.ts';
import { precedentOf, rebuildJobNotes, recallJob } from './recall.ts';
import { parseVerdict } from './review.ts';
import type { Verdict } from './review.ts';
import { createProposalStore } from './proposals.ts';
import type { Proposal } from './proposals.ts';
import { CeoRunner } from './runner.ts';
import type { CeoResult } from './runner.ts';
import { parseWorkReport } from './work.ts';
import { createSpendLedger } from './spend.ts';

/**
 * The ONLY door into the CEO section.
 *
 * Everything under `src/server/ceo/` is reached from here, and `cli.ts`
 * imports this file dynamically only when `--ceo` is on. That is what makes
 * it possible to derive two projects from a single tree: the observe-only
 * version is obtained by DELETING this folder, and nothing else stops
 * compiling. `npm run check:passive` verifies it, because a promise like that
 * holds only as long as someone checks it.
 *
 * The HQ constants in `shared/layout.ts` stay out on purpose: they are zoning,
 * not CEO functionality. If they disappeared, the order of the lots would
 * change, and switching from one version to the other would rearrange the
 * city before your eyes.
 */

/**
 * How much of the board a connecting client is caught up on.
 *
 * The board is memory, not a registry: it dies with the process, and the
 * persisted one arrives in phase 4 together with the decisions that make it
 * worth keeping. Twenty-four is a screenful, and a screenful is what a client
 * that has just connected can actually read.
 */
const BOARD_MAX = 24;

/**
 * The block asked of a judgement, in place of the proposals one.
 *
 * It replaces, it does not add: two specs of the same fence in the same
 * question are a sure way to get a block that honours neither. Proposals are
 * still allowed, because "this did not work, try X instead" is the most useful
 * thing this mechanism can produce.
 */
const JUDGE_CONTRACT = [
  'The block above is the whole contract for your reply. Everything before it is',
  'the report the user reads, so do not repeat the block in prose.',
].join('\n');

let seq = 0;

/** Unique and short: fits in `MAX_FIELD_CHARS` with plenty of room. */
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

/** From a proposal in the registry to a plate in the panel. The full task does not pass. */
function proposalEvent(p: Proposal, reason: string | null = null): DeltaEvent {
  return {
    t: 'proposal',
    id: p.id,
    at: p.at,
    provider: p.provider,
    kind: p.kind,
    summary: p.summary,
    status: p.status,
    // Only the start of the task: enough to read what would launch. The full
    // text stays in the registry, server side, and does not cross the channel.
    command: p.task === null ? null : p.task.slice(0, MAX_FIELD_CHARS - 1),
    project: p.projectName === null ? null : p.projectName.slice(0, MAX_FIELD_CHARS - 1),
    reason,
  };
}

export function createCeoDesk(opts: CeoDeskOptions): CeoDesk {
  const ledger = createSpendLedger(opts.stateDir, opts.caps);
  const runners = new Map<ProviderId, CeoRunner>();
  const proposals = createProposalStore(opts.stateDir);
  const jobs = createJobStore(opts.stateDir);
  const memory = createCeoMemory(opts.stateDir);
  /**
   * The planning meeting and its plan.
   *
   * Its own desk, next to the analyst's: the plan is a record with a life of
   * its own, and this file is the door, not the room.
   */
  const planDesk = createPlanDesk({
    stateDir: opts.stateDir,
    providers: opts.providers,
    model: opts.model,
    codexModel: opts.codexModel,
    snapshot: opts.snapshot,
    cwdOf: opts.cwdOf,
    // The chair's turn goes through its runner, like any question: same
    // process, same gates, same brake. The runners are built further down;
    // the map is read when a turn is asked, never before.
    converse: (provider, prompt, o) => {
      const runner = runners.get(provider);
      if (!runner) {
        o.reply(`No ${provider} CEO here.`, true);
        return Promise.resolve({ text: '', failed: `no ${provider} CEO here`, cause: 'refused' as const });
      }
      runner.setReplyChannel(o.reply);
      return runner.converse(prompt, o);
    },
    stopChair: (provider, reason) => runners.get(provider)?.stop(reason),
    // The fleet is built further down; an order is launched much later.
    launch: (order) => fleet.launch(order),
    stop: (jobId, reason) => fleet.stop({ id: jobId, kind: 'work' }, reason),
    blockedReason: (provider, now) => ledger.blockedReason(provider, opts.snapshot().limits, now),
    ...(opts.caps.metered ? { metered: opts.caps.metered } : {}),
    askJob: (jobId) => postJob(jobs.ask(jobId)),
    weightedSince: opts.weightedSince,
    closedSessions: opts.closedSessions,
    broadcast: opts.broadcast,
    ...(opts.notify ? { notify: opts.notify } : {}),
  });

  /**
   * How it went AFTERWARDS.
   *
   * It has no timer and never will: it is recomputed when the panel asks and
   * when a brief is built, that is, only behind a gesture of yours. An
   * interval here would be the only code path in the project that moves on
   * its own, and on top of that to go and check whether it was right.
   */
  const effects = createEffects({
    jobs,
    projectSessions: opts.projectSessions,
    remember: (job, text) => {
      memory.note({
        at: Date.now(), provider: job.provider, kind: 'effect',
        project: job.projectName, text, key: `effect:${job.id}`,
      });
      memory.save();
    },
  });
  // The job registry is the source of what the CEO remembers about jobs: see
  // `recall.ts`. Rebuilt at every start, so a corrected job is corrected here.
  rebuildJobNotes(memory, jobs.list());
  memory.save();

  /**
   * A job as the city sees it: one mast, two parts.
   *
   * The outcome does NOT go through here, neither the job's nor the review's:
   * they are thousands of characters and the delta channel carries metadata.
   * Over there goes just enough to draw the mast and to say whether the advice
   * holds; the two texts are requested together with `job.read`.
   */
  const jobEvent = (j: Job): DeltaEvent => ({
    t: 'job', id: j.id, at: j.at, provider: j.provider, kind: j.kind,
    summary: j.summary, projectId: j.projectId, projectName: j.projectName,
    state: stateOf(j),
    // The state of whoever DID the job, next to the mast's: it is what lets
    // the panel show an outcome that exists while a review is still
    // running.
    workState: j.work.state,
    // The JOB's session: it is the one the lightning bolt tells about. The
    // reviewer has its own session, but what matters about it is the verdict,
    // not the progress.
    sessionId: j.work.sessionId,
    reviewState: j.review?.state ?? null,
    reviewHolds: j.reviewHolds,
    reviewFresh: j.reviewFresh,
    // The line of whoever worked, next to the verdict of whoever judged: it is
    // the only way to read what was DONE next to what had been asked, without
    // opening a five-thousand-character outcome.
    workDid: j.workDid,
    workWrote: j.workWrote,
    workFounded: j.workFounded,
    toolCalls: toolCallsOf(j),
    costUsd: costOf(j),
    endedAt: stateOf(j) === 'running' ? null : (j.work.endedAt ?? j.review?.endedAt ?? null),
    reason: j.work.reason || j.review?.reason || null,
    dismissed: j.dismissed,
    asks: j.asks,
    plan: j.plan ? { taskId: j.plan.taskId, attempt: j.plan.attempt } : null,
  });

  /** The job changed: tell everyone, and put it in writing. */
  const postJob = (j: Job | undefined, persist = true): void => {
    if (!j) return;
    if (persist) jobs.save();
    opts.broadcast([jobEvent(j)]);
  };

  /**
   * Masts finished more than five minutes ago close by themselves.
   *
   * It also runs once at STARTUP, and that is not a detail: after a restart
   * the jobs come back from disk with yesterday's end, and without this pass
   * they would stay on stage forever -- the city would open with the previous
   * session's check marks on the roof.
   *
   * One interval and not a timer per job: N timers are N ways to forget to
   * clear one, and precision is of no use here. `unref` because a live timer
   * keeps node alive, and this is no reason to stay.
   */
  const sweep = (): void => {
    const now = Date.now();
    for (const j of jobs.onStage()) {
      if (!expiredOnStage(j, now)) continue;
      postJob(jobs.dismiss(j.id));
    }
  };
  sweep();
  /**
   * A reading from one of our own processes: into the server's limits first,
   * then the reserve is checked against it at once -- a worker crossing the
   * line is stopped on the reading that says so, not up to a tick later.
   */
  const noteQuota = (provider: ProviderId, windows: RateWindow[]): void => {
    opts.noteQuota?.(provider, windows);
    planDesk.guard();
    fleet.guardReserve(Date.now());
  };

  /*
   * The same interval beats the scheduler: the one thing in this module that
   * moves on its own. Not at startup, on purpose: the first beat waits a full
   * period, so the registry has been read and a session of yours on a
   * project is known before a worker could be sent there.
   */
  const sweeper = setInterval(() => {
    sweep();
    planDesk.tick();
    fleet.guardReserve(Date.now());
  }, opts.tickMs ?? 30_000);
  sweeper.unref?.();

  const fleet = createFleet({
    model: opts.model,
    codexModel: opts.codexModel,
    ledger,
    execute: opts.execute,
    snapshot: opts.snapshot,
    cwdOf: opts.cwdOf,
    // The plan's second guardian: the desk checks before it asks, the fleet
    // asks again here, against the plan on disk.
    authorized: (order) => planDesk.authorized(order),
    reserveBreach: (provider, at) => planDesk.breach(provider, at),
    onStart: (job) => postJob(
      // A single mast: the review hooks onto the job it judges instead of
      // opening one of its own. Two masts for a single yes would say that
      // you accepted two things.
      job.kind === 'review'
        // An empty `reviewOf` means there was nobody to resume and a new
        // session was opened: it is the only difference, and it must be recorded.
        ? jobs.openReview(job.id, job.reviewOf === null || job.reviewOf === '')
        : job.order
          ? jobs.add({
              id: job.id,
              at: job.at,
              provider: job.order.provider,
              kind: job.order.kind,
              summary: job.order.summary,
              projectId: job.order.projectId,
              projectName: job.order.projectName,
              plan: job.order.origin,
            })
          : jobs.add({
              id: job.id,
              at: job.at,
              provider: job.proposal!.provider,
              kind: job.proposal!.kind,
              summary: job.proposal!.summary,
              projectId: job.proposal!.projectId,
              projectName: job.proposal!.projectName,
            }),
    ),
    // The tool prints its session id before any registry sees the process:
    // the job gets it now, and a planned task keeps it to resume later.
    onSession: (ref, sessionId) => {
      const j = jobs.attach(ref.id, ref.kind, sessionId);
      postJob(j, false);
      if (ref.kind === 'work' && j?.plan) planDesk.onSession(j.plan.taskId, sessionId);
    },
    /*
     * Growth is not written to disk at every tool call: that is dozens of
     * writes for a number that is of no use at the next start. What must be
     * saved is the end, and it is saved there.
     */
    onProgress: (ref, toolCalls) => postJob(jobs.progress(ref.id, ref.kind, toolCalls), false),
    onQuota: (provider, windows) => noteQuota(provider, windows),
    onAdopt: (ref, sessionId) => postJob(jobs.attach(ref.id, ref.kind, sessionId), false),
    onEnd: (ref, out) => {
      // Two parts, two contracts, the same fence: the verdict from whoever
      // judges, the line from whoever did the work.
      const verdict = ref.kind === 'review' ? parseVerdict(out.outcome) : null;
      const report = ref.kind === 'work' ? parseWorkReport(out.outcome) : null;
      // Before `finish`, so the single event that goes out already carries
      // everything: the worker's line and the end of the process are the same
      // news to whoever is watching, and sending them in two goes would make
      // the line flicker.
      if (report) jobs.report(ref.id, report.did, report.founded, report.wrote);
      const j = jobs.finish(ref.id, ref.kind, out, verdict?.holds ?? null);
      // A planned attempt moves its task: done, failed, or a question for you.
      if (ref.kind === 'work' && j?.plan) {
        planDesk.onJobEnd(j.plan.taskId, ref.id, out);
        /*
         * The second opinion, only if the plan asks for it.
         *
         * Off by default: it doubles the cost of every task, and with no
         * session of yours on the project -- the scheduler keeps workers away
         * from those -- it would nearly always be the weaker fresh check. The
         * fleet's review takes a proposal; a planned task is dressed as one,
         * accepted, with the briefing as its task.
         */
        if (out.ok && planDesk.plan().review) {
          const plan = planDesk.plan();
          const task = plan.projects.flatMap((p) => p.tasks).find((x) => x.id === j.plan?.taskId);
          if (task) {
            const dressed: Proposal = {
              id: ref.id, at: j.at, provider: j.provider, kind: 'plan', summary: task.title,
              projectId: j.projectId, projectName: j.projectName, task: task.briefing || task.title,
              status: 'accepted', decidedAt: j.at, sessionId: null,
            };
            fleet.review(dressed, sessionToAsk(dressed) ?? '');
          }
        }
      }
      /*
       * The snapshot of how the project was BEFORE, taken now.
       *
       * Now and not when you look at it: in thirty days the rows that make it
       * up are gone, and a "before" rebuilt from fewer rows would be a
       * different before. The window looks back to when you accepted, so the
       * worker that has just finished does not get into it.
       */
      if (ref.kind === 'work' && j) effects.freeze(j, Date.now());
      remember(ref, j, verdict);
      postJob(j);
    },
  });

  /**
   * Whom to ask for the second opinion on a proposal.
   *
   * The most recent session of that project, from the same tool, that was not
   * opened by the CEOs -- otherwise one of its own workers would be asked to
   * judge its own advice, which is the CEO talking to itself. It comes from
   * the server's model and never from the client: from the browser comes a
   * proposal id, the rest is resolved by whoever knows it.
   */
  function sessionToAsk(proposal: Proposal): string | null {
    if (!proposal.projectId) return null;
    let best: { id: string; at: number } | null = null;
    for (const s of opts.snapshot().sessions) {
      if (s.projectId !== proposal.projectId) continue;
      if (s.provider !== proposal.provider) continue;
      if (s.spawnedByCeo !== null) continue;
      if (!best || s.lastActivityAt > best.at) best = { id: s.id, at: s.lastActivityAt };
    }
    return best?.id ?? null;
  }

  /**
   * What the CEO keeps of a finished job.
   *
   * One line, never the text. The outcome of a measured audit was about five
   * thousand characters, against a six-thousand brief: pasting it would evict
   * everything else and make the cost of every question grow with use, which
   * is the thing `brief.ts` exists to prevent. The minutes are in Reports,
   * where you read them; the title goes here.
   */
  function remember(ref: JobRef, job: Job | undefined, verdict: Verdict | null): void {
    if (!job) return;
    // The lines themselves, and why they say what they say, are in `recall.ts`:
    // the same function rebuilds them at every start.
    recallJob(memory, job, ref.kind === 'review' ? verdict : null);
    memory.save();
  }
  /**
   * From a reading to a line on the wire.
   *
   * The quota percentage is computed HERE, not at freezing time: the
   * conversion uses the current window, and a percentage taken last week
   * would be in another currency. And it is shown only if the two columns
   * fall on the same window -- `quotaShare` keeps the most consumed one,
   * which can change between two calls, and two percentages on different
   * windows side by side would read as a comparison.
   */
  const itemOf = (job: Job, r: EffectReading | null): EffectItem => {
    const metrics = {} as Record<(typeof METRICS)[number], EffectPair>;
    for (const id of METRICS) {
      metrics[id] = {
        before: r?.baseline.side[id].value ?? null,
        after: r?.after[id].value ?? null,
        beforeN: r?.baseline.side[id].n ?? 0,
        afterN: r?.after[id].n ?? 0,
      };
    }

    const limits = opts.snapshot().limits;
    const now = Date.now();
    const shareOf = (w: number | null): { percent: number; label: string } | null => (
      w === null ? null : quotaShare(w, job.provider, limits, opts.weightedSince, now)
    );
    const b = shareOf(metrics.cost.before);
    const a = shareOf(metrics.cost.after);
    const same = b !== null && a !== null && b.label === a.label;

    return {
      jobId: job.id,
      at: job.at,
      provider: job.provider,
      kind: job.kind,
      summary: job.summary,
      workDid: job.workDid,
      workFounded: job.workFounded,
      reviewHolds: job.reviewHolds,
      projectName: job.projectName,
      state: r?.state ?? 'void',
      reason: r?.reason ?? (job.effect?.voided || 'nothing to measure here'),
      metrics,
      beforeSessions: r?.baseline.sessions ?? 0,
      afterSessions: r?.afterSessions ?? 0,
      need: r?.need ?? 0,
      needFor: r?.needFor ?? null,
      quotaBefore: same ? b.percent : null,
      quotaAfter: same ? a.percent : null,
      quotaWindow: same ? b.label : null,
      closedAt: r?.closedAt ?? null,
      closesAt: r === null ? null : (job.work.endedAt ?? job.at) + FOLLOW_DAYS * 86_400_000,
      closedBy: r?.closedBy ?? null,
      judged: job.effect?.verdict
        ? {
            attributed: job.effect.verdict.attributed,
            why: job.effect.verdict.why,
            at: job.effect.verdict.at,
          }
        : null,
    };
  };

  /** The reports produced so far, oldest first. The proposals live in the registry. */
  const board: DeltaEvent[] = [];

  /**
   * The CEOs answering a question asked in Board, right now.
   *
   * The runner is shared: the same CEO chairs the planning meeting and
   * answers a judgement in Effect. Starting Board over stops only a question
   * asked there -- killing the chair's turn because you cleared another panel
   * would start over the wrong thing.
   */
  const boardAsks = new Set<ProviderId>();
  /** Stopped by a start over: what they end with is not pinned up. */
  const discarded = new Set<ProviderId>();

  const post = (events: DeltaEvent[]): void => {
    if (events.length === 0) return;
    for (const ev of events) {
      // Only reports live in memory: a proposal has a registry of its own,
      // because it is a decision and decisions outlive the process.
      if (ev.t === 'report') board.push(ev);
    }
    if (board.length > BOARD_MAX) board.splice(0, board.length - BOARD_MAX);
    opts.broadcast(events);
  };

  /**
   * From a finished call to what the city sees.
   *
   * A report is pinned up even when the model ignored the block: the analysis
   * still happened and still cost quota, and a call that vanishes because its
   * last fifty characters were malformed is the kind of silence that makes a
   * spending cap impossible to trust. The title is then OURS -- the name of the
   * analysis -- and never a sentence invented on the model's behalf.
   */
  const publish = (provider: ProviderId, result: CeoResult): void => {
    if (!result.hadText) return;
    // An answer stopped by a start over still ends, with whatever it had
    // written: pinned up now, it would put a report back on the table you
    // just cleared.
    if (discarded.has(provider)) return;
    const at = Date.now();
    const events: DeltaEvent[] = [{
      t: 'report',
      id: nextId('r'),
      at,
      provider,
      analysis: result.analysis,
      title: result.outcome?.title ?? analysisOf(result.analysis)?.title ?? 'answer',
      costUsd: result.costUsd,
      quotaPercent: result.share?.percent ?? null,
      quotaWindow: result.share?.label ?? null,
      depth: result.depth,
      model: result.model,
    }];
    // The project name is resolved HERE, where the world is at hand. A name
    // that matches nothing does not become an invented id: it stays `null`, and
    // the proposal will be refused when it is executed, with its reason.
    const snapshot = opts.snapshot();
    for (const p of result.outcome?.proposals ?? []) {
      const project = p.project === null
        ? undefined
        : snapshot.projects.find((x) => !x.disabled && x.name === p.project);
      const stored = proposals.add({
        id: nextId('p'),
        at,
        provider,
        kind: p.kind,
        summary: p.summary,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        task: p.command,
      });
      // A new proposal on a project that was just worked on says so on its
      // card: see `precedentOf`.
      events.push(proposalEvent(stored, precedentOf(stored, jobs.list())));
    }
    proposals.save();
    post(events);
  };

  for (const provider of opts.providers) {
    runners.set(
      provider,
      new CeoRunner({
        provider,
        model: opts.model,
        codexModel: opts.codexModel,
        stateDir: opts.stateDir,
        ledger,
        snapshot: opts.snapshot,
        perimeter: () => perimeterOf(opts.snapshot(), opts.cwdOf, { home: os.homedir(), state: opts.stateDir }),
        history: (days) => opts.history(days),
        /*
         * The brief goes through the measure: it is the gesture that makes it
         * recompute.
         *
         * Here and not in a section of its own: the measure enters as a NOTE,
         * inside the tightest cap and on a single line. A section of its own
         * would be a second place where the same number grows with the brief,
         * and the brief has a cap precisely so the cost of every question does
         * not grow.
         */
        memory: () => {
          effects.refresh(Date.now());
          return memory.list(provider);
        },
        weightedSince: opts.weightedSince,
        metered: opts.caps.metered?.includes(provider) ?? false,
        onState: (ev) => opts.broadcast([ev]),
        onResult: (result) => publish(provider, result),
        onQuota: (windows) => noteQuota(provider, windows),
      }),
    );
  }

  const ask = (
    provider: ProviderId,
    text: string,
    analysis: AnalysisKind | null,
    depth: CeoDepth,
    reply: (frame: ServerFrame) => void,
  ): void => {
    const runner = runners.get(provider);
    if (!runner) {
      reply({
        t: 'ceo.stream', at: Date.now(), provider, surface: 'board',
        delta: `No ${provider} CEO here.`, done: true,
      });
      return;
    }

    // The reply channel is for THIS question: it is hooked now, so two
    // windows open on the same world do not read each other's answers.
    runner.setReplyChannel((delta, done) => {
      reply({ t: 'ceo.stream', at: Date.now(), provider, surface: 'board', delta, done });
    });

    // A busy runner refuses the question on its own; then it is not ours to
    // track, and the call in flight -- maybe the chair's -- is not either.
    const mine = !runner.busy;
    if (mine) boardAsks.add(provider);
    void runner.ask(text, analysis, depth).finally(() => {
      if (!mine) return;
      boardAsks.delete(provider);
      discarded.delete(provider);
    });
  };

  return {
    // The five, as they were already written: the panel puts them in the text
    // box and you read the question before paying for it. The `question` that
    // goes out and the one you see are the same piece of text, not two copies.
    analyses: ANALYSES.map((a) => ({ kind: a.kind, title: a.title, question: a.question })),

    ask,

    meeting(providers, topic, analysis, depth, reply) {
      // Whoever is actually there answers. A provider that is not installed is
      // silently absent from the table, exactly as it is silently absent from
      // the city -- and an empty guest list means everyone, because a meeting
      // called with nobody named is a meeting of the whole board.
      const named = providers.filter((p): p is ProviderId => runners.has(p as ProviderId));
      const table = named.length > 0 ? named : [...runners.keys()];
      for (const provider of table) ask(provider, topic, analysis, depth, reply);
    },

    /**
     * You accept or you reject.
     *
     * Two distinct steps, in this order: first the state machine decides
     * whether the transition is legal, THEN we try to execute. Swapping them
     * would mean being able to start a process for a proposal already rejected
     * or already launched, and the guarantee "nothing runs without your yes"
     * would depend on the caller instead of on this place.
     */
    decide(id, accept, reply) {
      const now = Date.now();

      // A no to a yes that never started: the proposal is withdrawn. See
      // `withdraw` for why this is not a second `decide`.
      if (!accept && proposals.get(id)?.status === 'accepted') {
        const out = proposals.withdraw(id, now);
        proposals.save();
        if (!out.ok || !out.proposal) {
          reply({ t: 'error', code: 'internal', detail: out.reason });
          return;
        }
        memory.note({
          at: now, provider: out.proposal.provider, kind: 'rejected',
          project: out.proposal.projectName,
          text: `you accepted this, then withdrew it before it started: ${out.proposal.summary}`,
        });
        memory.save();
        opts.broadcast([proposalEvent(out.proposal)]);
        return;
      }

      const decision = proposals.decide(id, accept, now);
      proposals.save();
      if (!decision.ok || !decision.proposal) {
        if (decision.proposal) opts.broadcast([proposalEvent(decision.proposal, decision.reason)]);
        else reply({ t: 'error', code: 'internal', detail: decision.reason });
        return;
      }

      const accepted = decision.proposal;
      if (!accept) {
        // A no is data, and until now it was lost. The CEO did not know it had
        // proposed anything, let alone that you had said no.
        memory.note({
          at: now, provider: accepted.provider, kind: 'rejected',
          project: accepted.projectName,
          text: `you turned this down: ${accepted.summary}`,
        });
        memory.save();
        opts.broadcast([proposalEvent(accepted)]);
        return;
      }

      const launch = fleet.start(accepted);
      if (!launch.ok || !launch.jobId) {
        // It stays `accepted` and says why it did not launch: under
        // `--no-execute` this is the NORMAL outcome, not a fault.
        opts.broadcast([proposalEvent(accepted, launch.reason)]);
        return;
      }

      const applied = proposals.markApplied(id, launch.jobId, now);
      proposals.save();
      opts.broadcast([proposalEvent(applied.proposal ?? accepted, null)]);

      /*
       * The second opinion starts on its own.
       *
       * On its own and not behind another button: having to remember to also
       * ask the opinion of whoever works there would mean never asking it. The
       * SERVER picks the session from its own model, like `cwdOf` -- from the
       * browser comes a proposal id and nothing else.
       *
       * If it does not start it is not a fault and nobody is told: the real job
       * has started, and it is what you had accepted. No session on that
       * project only means there is nobody to ask.
       */
      /*
       * The review ALWAYS starts, and the session that gives it changes the
       * question.
       *
       * With someone active on that project, theirs is resumed: it knows why
       * the work was done that way. With nobody, a new session is opened in
       * there, which does not know and must not make it up -- it verifies the
       * premises, which is a different thing and costs a fraction of a fork.
       * Before, in that case, nothing started: work on a project happens in
       * shifts, and a proposal accepted in the evening found nobody.
       */
      fleet.review(accepted, sessionToAsk(accepted) ?? '');
    },

    adopt: (pid, sessionId) => fleet.adopt(pid, sessionId),

    effects(reply) {
      const now = Date.now();
      // The request IS the gesture that makes it recompute: no timer in here.
      effects.refresh(now);
      // A snapshot taken now is worth something only if it outlives the
      // process: that is the whole point of freezing, and without this line it
      // would be lost at the first restart, which is exactly when the rows of
      // back then start to go missing.
      jobs.save();
      const items = effects.board(now)
        // A job with nothing to measure does not take a row: the board belongs
        // to the jobs something can be said about, even if it is just "wait".
        .filter(({ job }) => job.effect !== null)
        .map(({ job, reading }) => itemOf(job, reading))
        .sort((x, y) => y.at - x.at);
      reply({ t: 'effect.board', at: now, items });
    },

    /**
     * Ask the CEO to try to prove itself wrong.
     *
     * It goes through the runner and not the fleet: the fleet opens processes
     * that WORK inside a project, this is a question, and the analyst runs in
     * its neutral folder with the usual command line. The numbers travel in the
     * message on stdin, which is the only thing that can vary without
     * resetting the cache.
     *
     * `standard` and not `fast`: a cheap model, asked to falsify its own
     * advice, comes out with approval -- and that is exactly the answer this
     * question exists not to get.
     */
    judge(id, reply) {
      const job = jobs.get(id);
      const runner = job ? runners.get(job.provider) : undefined;
      if (!job || !runner) return;

      const now = Date.now();
      effects.refresh(now);
      const found = effects.board(now).find((x) => x.job.id === id);
      const reading = found?.reading ?? null;
      if (!reading || reading.state !== 'read') {
        // Nothing to judge is not an error: it is the gate holding.
        reply({
          t: 'ceo.stream', at: now, provider: job.provider, surface: 'effect',
          delta: 'Nothing to judge yet: the numbers are not readable.', done: true,
        });
        return;
      }

      runner.setReplyChannel((delta, done) => {
        reply({ t: 'ceo.stream', at: Date.now(), provider: job.provider, surface: 'effect', delta, done });
      });
      void runner.ask(judgeTask(job, reading), null, 'standard', {
        contract: JUDGE_CONTRACT,
        onText: (full) => {
          const verdict = parseJudgement(full, Date.now());
          // Without a readable block nothing is attributed to anyone: the
          // prose stays where it arrived, and the minutes are not made up.
          if (!verdict) return;
          jobs.setVerdict(id, verdict);
          jobs.save();
          /*
           * What goes into memory is THE JUDGEMENT, not the bare measure.
           *
           * "-38%" on its own comes back in the brief and the CEO reasons on
           * it as on a success of its own; "the drop is explained by shorter
           * tasks" is the note that stops it from proposing the same thing to
           * you again tomorrow on the same numbers.
           *
           * And it goes there IN PLACE of the measure, under the same key:
           * `effectNote` writes the verdict once the job has one, and the
           * refresh is what writes it.
           */
          effects.refresh(Date.now());
        },
      });
    },

    /** The full outcome, to whoever asked for it. It never goes through the delta channel. */
    readProposal(id, reply) {
      const p = proposals.get(id);
      if (!p) return;
      reply({ t: 'proposal.task', id, task: p.task, project: p.projectName });
    },

    read(id, reply) {
      const j = jobs.get(id);
      if (!j) return;
      // Both texts together: the outcome and what whoever works there thinks
      // of it are the same answer to the same question, and reading them in
      // two distant places would mean not reading the second.
      reply({
        t: 'job.outcome', id,
        text: j.work.outcome, truncated: j.work.truncated,
        review: j.review?.outcome ?? null,
        reviewTruncated: j.review?.truncated ?? false,
      });
    },

    /** The traces of a job, for the window that opens on them. Never the path of the project. */
    locate(id) {
      const j = jobs.get(id);
      if (!j) return null;
      return { provider: j.provider, sessionId: j.work.sessionId, projectId: j.projectId, wrote: j.workWrote };
    },

    dismiss(id) {
      const j = jobs.dismiss(id);
      if (!j || !j.dismissed) return;
      postJob(j);
    },

    /**
     * Board, from zero: the same gesture as the plan's start over.
     *
     * It does not wait for a CEO that is answering there, for the plan's
     * reason: you asked for a clean table, and the answer was going onto the
     * one you are throwing away. What the CEOs remember stays -- rejections
     * and past work are what keeps them from proposing the same thing again,
     * and they are not on the board.
     */
    resetBoard() {
      const now = Date.now();
      for (const provider of boardAsks) {
        const runner = runners.get(provider);
        if (!runner) continue;
        discarded.add(provider);
        // Its last pieces would land on a desk just wiped: nobody is waiting
        // for them. The plate is freed by the state event the stop sends.
        runner.setReplyChannel(() => {});
        runner.stop('the board was started over');
      }
      proposals.clear(now);
      proposals.save();
      board.length = 0;
      opts.broadcast([{ t: 'ceo.cleared', at: now, what: 'board', keep: [] }]);
    },

    /**
     * Reports, from zero. The running jobs stay, see `JobStore.clear`.
     *
     * The notes the CEOs keep about the jobs stay too, as they do when the
     * ledger prunes its oldest: a clean archive is not a CEO that forgets
     * having done the work last week.
     */
    resetJobs() {
      const now = Date.now();
      const keep = jobs.clear(now);
      jobs.save();
      opts.broadcast([{ t: 'ceo.cleared', at: now, what: 'jobs', keep }]);
    },

    plan: (frame, reply) => planDesk.handle(frame, reply),

    states() {
      const out: DeltaEvent[] = [];
      for (const [provider, runner] of runners) {
        out.push({
          t: 'ceo', at: Date.now(), provider,
          state: runner.state, target: null, reason: null,
        });
      }
      out.push(...board);
      // Proposals from the registry and not from memory: after a restart a
      // proposal still waiting for an answer must still be there.
      for (const p of proposals.list()) {
        out.push(proposalEvent(p, p.status === 'pending' ? precedentOf(p, jobs.list()) : null));
      }
      // ALL the jobs, not only those on stage: `dismissed` decides whether the
      // mast appears, but Reports must also be able to show the ones already
      // closed. An outcome that vanishes when the page reloads is not an archive.
      for (const j of jobs.list()) out.push(jobEvent(j));
      // The plan too: a client that connects to a running world must find
      // the counter and the status where it left them.
      out.push(planDesk.event());
      return out;
    },

    close() {
      clearInterval(sweeper);
      for (const runner of runners.values()) runner.stop();
      fleet.stopAll();
      proposals.save();
      jobs.save();
      memory.save();
      ledger.save();
      planDesk.close();
    },
  };
}
