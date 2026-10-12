import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Effort, GitRules, ProviderId, RateWindow, Snapshot } from '../../shared/protocol.ts';
import { allowedToolsFor, codexResumeSandboxFor, codexSandboxFor, disallowedToolsFor, OUTSIDE_SANDBOX_DENIED, sandboxFor } from './allow.ts';
import { humanSessions } from './scheduler.ts';
import type { JobEnd } from './jobs.ts';
import type { PlanRef } from './jobs.ts';
import type { Proposal } from './proposals.ts';
import { freshReviewTask, reviewTask } from './review.ts';
import { CallMeter, consumeLine } from './runner.ts';
import type { SpendLedger } from './spend.ts';
import { weigh } from './spend.ts';
import { workTask } from './work.ts';

/**
 * The dedicated sessions: the only place a process that WORKS starts from.
 *
 * There is a single road, and this file is the narrow point: accepted proposal
 * -> dedicated session -> mast rising on the HQ. There is no branch in which
 * the server executes by itself, because there would then be a second silent
 * path to keep an eye on, and the proposals registry would stop being the
 * complete account of what was done on your behalf.
 *
 * Four gates, in this order, and each answers with a REASON:
 *
 *  1. executive mode must be on -- it is by default, `--no-execute` turns it
 *     off. It is the real gate, and it belongs to the server: not an
 *     instruction inside a prompt, which a model can ignore.
 *  2. the proposal must be `accepted` -- `proposals.ts` guarantees it, and it
 *     is checked again here because an invariant with a single guardian is not
 *     an invariant.
 *  3. it must say WHAT to work on, and that project must exist on disk.
 *  4. the quota must hold. A tool born to watch over consumption cannot be the
 *     first to burn it without looking.
 *
 * The cache rule that binds `runner.ts` does NOT apply here, on purpose: the
 * analyst always runs in the same neutral folder so its preamble does not
 * change, whereas a worker must run INSIDE the project -- that is where the
 * work is, and the CLAUDE.md that guides it. They are two processes with two
 * purposes, not the same process used in two ways.
 *
 * A planned task comes in as a `WorkOrder` and goes through `launch`: the
 * same gates, with the proposal's `accepted` replaced by an authorizer the
 * desk injects (the plan approved, the task queued), plus one gate the plan
 * added for everyone -- never two workers on the same repository. The
 * order also carries what the proposal never had: a model of its own, what
 * the worker may run, and a session to resume.
 */

/** Beyond this, the job has run away: it gets cut. */
const HARD_TIMEOUT_MS = 20 * 60_000;
/**
 * A worker that has said nothing for this long is stuck, not thinking.
 *
 * Five minutes and not the runner's three: a worker runs tests and installs,
 * which print nothing to us for a while. Before this the only brake was the
 * twenty-minute kill, and a worker blocked on a prompt nobody would answer
 * sat there for all of them.
 */
const WORKER_SILENCE_MS = 5 * 60_000;

/** A planned task, ready to run: everything the gates and the command need. */
export interface WorkOrder {
  /** The job id: `<taskId>:<attempt>`. */
  id: string;
  provider: ProviderId;
  projectId: string;
  projectName: string;
  kind: string;
  summary: string;
  /** The prompt on stdin, whole. */
  task: string;
  model: string | null;
  effort: Effort | null;
  allowed: GitRules;
  /** The project's test commands, as permission patterns: allowed besides the common runners. */
  commands: readonly string[];
  /** A session of a previous attempt to resume, or null for a fresh one. */
  resume: string | null;
  ceilingMs: number | null;
  origin: PlanRef;
}

export interface FleetOptions {
  model: string;
  /** Your Codex model, when declared. Never a Claude alias: that fails the spawn. */
  codexModel?: string | null;
  ledger: SpendLedger;
  /** Executive mode: on by default, off with --no-execute. When off, no process ever starts. */
  execute: boolean;
  snapshot: () => Snapshot;
  cwdOf: (projectId: string) => string | undefined;
  /**
   * Whether a work order may start now, or why not.
   *
   * The second guardian of the plan's invariant, as `status === 'accepted'`
   * is the proposal's: the desk checks before it asks, and the fleet asks
   * again through this, against the stores and not against the order.
   */
  authorized?: (order: WorkOrder) => string | null;
  /**
   * Whether a window of this provider has reached the plan's reserve, and how.
   *
   * The reserve used to hold only for planned tasks: a worker started from an
   * accepted proposal, and every second opinion, ran outside it. Now they do
   * not start past it, and `guardReserve` stops them on it.
   */
  reserveBreach?: (provider: ProviderId, now: number) => string | null;
  /**
   * The life of a job, towards its ledger.
   *
   * Before this the fleet invented a SESSION to make the mast appear, and
   * that session died with the process: the outcome -- the only thing you had
   * accepted for -- did not outlive whoever produced it. A job is a different
   * thing from a session, and has a ledger of its own.
   */
  onStart: (job: JobStart) => void;
  onProgress: (ref: JobRef, toolCalls: number) => void;
  onAdopt: (ref: JobRef, sessionId: string) => void;
  /** The session id the tool itself printed, before any registry saw it. */
  onSession?: (ref: JobRef, sessionId: string) => void;
  /**
   * The quota, as a worker's own responses carry it.
   *
   * A worker is the one thing that burns the quota while nobody types, and
   * so the one thing the status line never sees doing it: its readings are
   * what lets the reserve hold during a run and not only before it.
   */
  onQuota?: (provider: ProviderId, windows: RateWindow[]) => void;
  onEnd: (ref: JobRef, out: JobEnd) => void;
  /**
   * How a process is started. Injected, like the clock and the `stats`.
   *
   * Without it, only the part of this file that REFUSES could be tested: every
   * test of the real launch would have started a model for real. It is the
   * branch in which the server opens a process on your behalf -- the one that
   * deserves more tests, not fewer.
   */
  spawn?: typeof spawn;
  /** The silence clock, injected so a test does not wait five minutes. */
  silenceMs?: number;
}

export interface Launch {
  ok: boolean;
  /** The job started. It has the same id as the proposal that generated it. */
  jobId: string | null;
  /** Why not. Empty when `ok`. */
  reason: string;
}

/**
 * What kind of process.
 *
 * `work` does what you accepted; `review` asks whoever works on that project
 * whether the advice holds, resuming their session with a fork. They are two
 * processes with two purposes and two sets of permissions: the first can
 * write in the project, the second cannot.
 */
export type JobKind = 'work' | 'review';

/**
 * Which process, inside which job.
 *
 * The id is the JOB's -- that is, the proposal's -- and it is the same for
 * both parts: a single mast, because a single decision. The `kind` says which
 * of the two whatever arrives is attached to.
 */
export interface JobRef {
  id: string;
  kind: JobKind;
}

/** A job that begins, for whoever keeps its ledger. */
export interface JobStart extends JobRef {
  /** The proposal behind it, or null for a planned task. */
  proposal: Proposal | null;
  /** The work order behind it, or null for a proposal's job. */
  order: WorkOrder | null;
  at: number;
  /** The resumed session, for a review. `null` for the real job. */
  reviewOf: string | null;
}

export interface Fleet {
  start(proposal: Proposal): Launch;
  /** A planned task. Same gates as `start`, with the authorizer in place of the proposal's status. */
  launch(order: WorkOrder): Launch;
  /**
   * The second opinion, from the session the advice is about.
   *
   * It starts on its own when a proposal is accepted: asking and then having
   * to remember to also ask the opinion of whoever works there would mean
   * never asking it.
   */
  review(proposal: Proposal, sessionId: string): Launch;
  /**
   * "Is this process mine?" -- and if it is, the placeholder steps aside.
   *
   * A `claude -p` registers in the live-sessions registry exactly like an
   * interactive session: `~/.claude/sessions/<pid>.json`, with
   * `kind: interactive`. Codex does the same in its own way. So the worker we
   * open is DISCOVERED as a normal session of the project, and for a while the
   * very same effort showed up twice: the badge on the tower and the mast on
   * the HQ.
   *
   * The discovered one wins, not ours: it carries the real tokens read from
   * the transcript, while the placeholder can only count calls. If the CEOs'
   * consumption did not enter the accounts like everything else, the tool
   * born to measure would be blind precisely to what it does by itself.
   */
  adopt(pid: number, sessionId: string): ProviderId | null;
  /** How many are working right now. */
  running(): number;
  /** Stop one process, with the reason its end will carry. */
  stop(ref: JobRef, reason: string): boolean;
  /**
   * Stop the work started outside the plan -- proposal workers, second
   * opinions -- of a provider whose window has reached the reserve. The
   * plan's own tasks are the desk's: it stops them and puts them back in
   * the queue, where they wait for the window to have room.
   */
  guardReserve(now: number): void;
  stopAll(): void;
}

interface Running {
  child: ChildProcess;
  /** Which process, inside which job. */
  ref: JobRef;
  provider: ProviderId;
  projectId: string | null;
  /** A task of the plan: the desk holds the reserve for those. */
  planned: boolean;
  /** The real process. `0` if the spawn never gave one. */
  pid: number;
  /** The registry has already surfaced the real session: asked only once. */
  adopted: boolean;
  toolCalls: number;
  killer: NodeJS.Timeout;
  silence: NodeJS.Timeout | null;
  /** Why it was stopped, when it was: `close` reports this, not the signal. */
  stoppedFor: string | null;
}

export function createFleet(opts: FleetOptions): Fleet {
  /**
   * The live processes.
   *
   * Key `id:kind` and not `id`: the two parts of a job are two processes and
   * must be able to run together. With the id alone, the review would have
   * evicted the job from the registry and its closing would have closed the
   * wrong one.
   */
  const jobs = new Map<string, Running>();
  const key = (ref: JobRef): string => `${ref.id}:${ref.kind}`;

  const no = (reason: string): Launch => ({ ok: false, jobId: null, reason });

  /** The one worker a repository may host. */
  function workerOn(projectId: string | null): Running | null {
    if (!projectId) return null;
    for (const j of jobs.values()) {
      if (j.ref.kind === 'work' && j.projectId === projectId) return j;
    }
    return null;
  }

  /**
   * Why a worker may not go where you are working, or null.
   *
   * The scheduler's rule, and the fleet's too: both were meant to guard it,
   * and only the scheduler did. An accepted proposal started at once even
   * in a repository with your session open on it.
   */
  function yoursOn(projectId: string, name: string | null, now: number): string | null {
    const n = humanSessions(opts.snapshot().sessions, projectId, now);
    if (n === 0) return null;
    return `you have ${n === 1 ? 'a session' : `${n} sessions`} active on ${name ?? 'that project'}: close it, or wait for it to go quiet`;
  }

  function reserveOf(provider: ProviderId, now: number): string | null {
    const breach = opts.reserveBreach?.(provider, now) ?? null;
    return breach ? `the reserve: ${breach}` : null;
  }

  /**
   * The command of a REVIEW. Two forms, for two different things.
   *
   * WITH a session: `--fork-session` (Claude) and `exec fork` (Codex) resume
   * its context under a NEW id. It is the difference between asking and
   * butting in -- the reviewer knows everything whoever worked knew, which is
   * exactly what the CEO cannot know, while the live session receives
   * nothing, does not lose its turn and does not notice. The invariant "no
   * writes towards live sessions" stays intact to the letter: we do not go
   * in, we restart from where it was.
   *
   * WITHOUT: a new session in the project folder. It does not know why the
   * work was done that way -- that context exists nowhere if nobody is
   * active -- but it knows how the repository is made, and that is enough to
   * verify the PREMISES of a proposal: the numbers, the git state, the
   * constraints written in the project. It is not a theoretical fallback: the
   * CEO proposed "review 20 commits" on a repo with 72, and a `git log` was
   * enough to refute it.
   *
   * The two are not confused on screen, because they do not carry the same
   * weight: `reviewFresh` tells them apart from the registry onwards.
   */
  function reviewCommand(
    provider: ProviderId, cwd: string, sessionId: string,
  ): { bin: string; args: string[] } {
    if (provider === 'codex') {
      // The prompt comes from stdin as for everything else: `-` is the placeholder.
      // `exec fork` takes no `-s`: the sandbox goes in as a config override,
      // the way the chair's resumed turn is held read-only. Without it a
      // second opinion ran with whatever sandbox your Codex config sets.
      return sessionId
        ? { bin: 'codex', args: ['exec', 'fork', sessionId, '-c', 'sandbox_mode="read-only"', '-', '--cd', cwd] }
        : { bin: 'codex', args: ['exec', '-s', 'read-only', '--skip-git-repo-check', '-C', cwd, '-'] };
    }
    return {
      bin: 'claude',
      args: [
        '-p', '--output-format', 'stream-json', '--verbose',
        // With a session, theirs is resumed; without, a new one is opened here.
        ...(sessionId ? ['--resume', sessionId, '--fork-session'] : []),
        /*
         * A review does NOT touch anything: it is an opinion.
         *
         * `plan` and not `acceptEdits`: the real job can write in the project
         * because that is what you asked of it, a review cannot. Asking for a
         * judgement and receiving changes in return would be the opposite of
         * what was asked.
         */
        '--permission-mode', 'plan',
        '--disable-slash-commands',
        // An opinion needs no MCP server, and plan mode does not hold them.
        '--strict-mcp-config',
      ],
    };
  }

  /** What a worker is allowed, as an order. */
  interface Hand {
    model: string | null;
    effort: Effort | null;
    allowed: GitRules | null;
    commands: readonly string[];
    resume: string | null;
  }

  /**
   * A proposal's worker: the fence of a planned task, with commit and push off.
   *
   * It used to run with no list at all -- `acceptEdits`, and the shell
   * whatever the installation allowed, which on a machine with no rules is
   * everything (twelve commands on the audit of 13 September). A proposal is
   * a sentence you accepted from a card, not a plan whose git boxes you
   * ticked: it may edit and run the tests, it does not commit or push, and
   * what is not allowed fails at once instead of passing.
   */
  const PROPOSAL: Hand = {
    model: null, effort: null, allowed: { commit: false, push: false }, commands: [], resume: null,
  };

  function command(provider: ProviderId, cwd: string, hand: Hand): { bin: string; args: string[] } {
    if (provider === 'codex') {
      const model = hand.model ?? opts.codexModel ?? null;
      const effort = hand.effort ? ['-c', `model_reasoning_effort="${hand.effort}"`] : [];
      if (hand.resume) {
        return {
          bin: 'codex',
          args: [
            'exec', 'resume', hand.resume, '--json',
            ...(model ? ['-m', model] : []),
            ...effort,
            ...codexResumeSandboxFor(hand.allowed ?? { commit: false, push: false }),
            '--skip-git-repo-check',
            '-',
          ],
        };
      }
      return {
        bin: 'codex',
        args: [
          'exec', '--json',
          // Only a declared Codex model is passed: a Claude alias fails the
          // spawn, and it is what used to travel here.
          ...(model ? ['-m', model] : []),
          ...effort,
          // It writes, but only inside the folder it runs in.
          ...(hand.allowed ? codexSandboxFor(hand.allowed) : ['-s', 'workspace-write']),
          '--skip-git-repo-check',
          '-C', cwd,
          '-',
        ],
      };
    }
    const allowed = hand.allowed ? allowedToolsFor(hand.allowed, hand.commands) : [];
    const denied = hand.allowed ? [...disallowedToolsFor(hand.allowed), ...OUTSIDE_SANDBOX_DENIED] : [];
    return {
      bin: 'claude',
      args: [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--model', hand.model ?? opts.model,
        /*
         * It works as you would, and it pays to know how free its hand is.
         *
         * `acceptEdits` accepts writes by itself. Everything else is NOT denied
         * just because it is in `-p`: the installation's permission rules
         * decide, and where there are none the worker acts. Measured on the
         * worker of the audit of 13 September 2026 (`157fc912`, 26 calls):
         * TWELVE Bash commands that succeeded, and no allow-list to explain
         * them -- this project has no `.claude/` folder and
         * `~/.claude/settings.json` does not name Bash.
         *
         * Not even the folder is a boundary. Of its three writes, one was a
         * script in `/tmp` and TWO were outside the project, in
         * `~/.claude/projects/<slug>/memory/`: it wrote itself a memory note
         * and indexed it. They are the only lines of that audit that changed
         * anything for the following sessions, and it put them there itself:
         * accepting a proposal means this too.
         *
         * Here the flag says one thing only, and it is what we do not do:
         * `--dangerously-skip-permissions` would give a process started by a
         * model even what the rules would deny. For a boundary tighter than
         * this the road is `--disallowed-tools`, which saves no cost (the
         * tools stay defined) and serves exactly to prevent acting -- and
         * every worker carries it now: a planned order from its git rules, a
         * proposal's with commit and push off (`PROPOSAL`).
         */
        '--permission-mode', 'acceptEdits',
        '--disable-slash-commands',
        ...(hand.allowed ? [
          // Nobody answers a prompt here: what is not allowed fails at once,
          // and the worker says so, instead of sitting on a question for the
          // twenty minutes of the hard kill.
          '--permission-prompts', 'none',
          // The boundary the allow-list could not be: see `sandboxFor`.
          '--settings', JSON.stringify(sandboxFor(hand.allowed)),
          // No MCP server of yours: it runs outside the sandbox.
          '--strict-mcp-config',
          ...(hand.resume ? ['--resume', hand.resume] : []),
          ...(allowed.length > 0 ? ['--allowedTools', ...allowed] : []),
          ...(denied.length > 0 ? ['--disallowedTools', ...denied] : []),
        ] : []),
      ],
    };
  }

  /** What to start, already decided: the gates come before, in the caller. */
  interface Spec {
    jobId: string;
    proposal: Proposal | null;
    order: WorkOrder | null;
    provider: ProviderId;
    projectId: string | null;
    kind: JobKind;
    reviewOf: string | null;
    cwd: string;
    now: number;
    task: string;
    bin: string;
    args: string[];
    ceilingMs: number;
  }

  /**
   * The body shared by the job and the review.
   *
   * Just one because everything after the gates is identical: counting the
   * calls, reading the final answer from the result line, closing the job
   * saying how it went. Two copies would be two places to fix the same bug
   * in, and over time one of the two would not get fixed.
   */
  function launchProcess(spec: Spec): Launch {
    let child: ChildProcess;
    try {
      child = (opts.spawn ?? spawn)(spec.bin, spec.args, {
        cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return no(`cannot start ${spec.bin}: ${String((err as Error)?.message)}`);
    }

    const ref: JobRef = { id: spec.jobId, kind: spec.kind };
    const job: Running = {
      child,
      ref,
      provider: spec.provider,
      projectId: spec.projectId,
      planned: spec.order !== null,
      pid: child.pid ?? 0,
      adopted: false,
      toolCalls: 0,
      killer: setTimeout(
        () => halt(job, `still working after ${Math.round(spec.ceilingMs / 60_000)} min`),
        spec.ceilingMs,
      ),
      silence: null,
      stoppedFor: null,
    };
    const silenceMs = opts.silenceMs ?? WORKER_SILENCE_MS;
    const quiet = (): NodeJS.Timeout => setTimeout(
      () => halt(job, `went quiet for ${Math.round(silenceMs / 60_000) || 1} min`),
      silenceMs,
    );
    job.silence = quiet();
    jobs.set(key(ref), job);
    opts.onStart({
      id: ref.id, kind: ref.kind, proposal: spec.proposal, order: spec.order,
      at: spec.now, reviewOf: spec.reviewOf,
    });

    let carry = '';
    let costUsd = 0;
    let outcome = '';
    let named = false;
    const meter = new CallMeter();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (job.silence) clearTimeout(job.silence);
      job.silence = job.stoppedFor === null ? quiet() : null;
      carry += chunk;
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';
      let grew = 0;
      for (const line of lines) {
        const seen = countWork(line);
        grew += seen.toolCalls;
        if (seen.costUsd !== null) costUsd = seen.costUsd;
        // The final answer is on the same line we read the price from. Until
        // now we discarded it two characters away from where it was needed:
        // you accepted a piece of advice and nobody ever saw the outcome.
        if (seen.outcome !== null) outcome = seen.outcome;
        // The same reader the analyst uses: tokens, and the session id the
        // tool prints before any registry has seen the process.
        const piece = consumeLine(line);
        meter.add(piece);
        if (piece.quota) opts.onQuota?.(spec.provider, piece.quota);
        if (piece.sessionId && !named) {
          named = true;
          opts.onSession?.(ref, piece.sessionId);
        }
      }
      if (grew === 0) return;
      job.toolCalls += grew;
      // The mast grows with the work done: it is the visible proof that
      // something is running on your behalf, and the only one that does not
      // require opening a panel to see it.
      opts.onProgress(job.ref, job.toolCalls);
    });

    const clocks = (): void => {
      clearTimeout(job.killer);
      if (job.silence) clearTimeout(job.silence);
      job.silence = null;
    };

    /*
     * The mast does NOT go away here. The process is dead, the job is not: it
     * stays on stage with its check mark until you close it. That is why a
     * job ledger exists separate from the sessions registry -- the outcome is
     * born the instant the process ends, and if its representation died with
     * it you would never read it.
     */
    child.on('error', (err) => {
      clocks();
      jobs.delete(key(ref));
      opts.onEnd(job.ref, {
        ok: false, outcome, costUsd,
        reason: String((err as Error)?.message ?? 'the process failed'),
        at: Date.now(), weighted: weigh(meter.usage),
      });
    });

    child.on('close', (code, signal) => {
      clocks();
      jobs.delete(key(ref));
      const weighted = weigh(meter.usage);
      opts.ledger.record(spec.provider, costUsd, spec.now, weighted);
      // A clean exit without an answer line is not a success: there is no
      // outcome, which is the only thing the job had started for.
      const ok = code === 0 && signal === null && outcome.length > 0 && job.stoppedFor === null;
      const reason = ok ? ''
        : job.stoppedFor !== null ? job.stoppedFor
        : signal !== null ? `stopped by ${signal}`
        : code !== 0 ? `exited with code ${String(code)}`
        : 'it produced no answer';
      opts.onEnd(job.ref, { ok, outcome, costUsd, reason, at: Date.now(), weighted });
    });

    child.stdin?.end(spec.task, 'utf8');
    return { ok: true, jobId: ref.id, reason: '' };
  }

  /** Kill a process and remember why: `close` will say this, not the signal. */
  function halt(job: Running, reason: string): void {
    if (job.stoppedFor !== null) return;
    job.stoppedFor = reason;
    if (job.silence) clearTimeout(job.silence);
    job.silence = null;
    job.child.kill('SIGTERM');
  }

  return {
    start(proposal) {
      // 1 · the server's gate, not a line in a prompt
      if (!opts.execute) return no('executive mode is off: restart without --no-execute');
      // 2 · the second guardian of the same invariant
      if (proposal.status !== 'accepted') return no(`the proposal is ${proposal.status}`);
      if (jobs.has(key({ id: proposal.id, kind: 'work' }))) return no('already running');
      // 3 · on what, and where
      if (!proposal.task) return no('the proposal carries no task to hand over');
      if (!proposal.projectId) return no('the proposal names no project');
      const cwd = opts.cwdOf(proposal.projectId);
      if (!cwd) return no('that project is not on disk');
      // One session per repository: the plan's rule, and now everyone's.
      const busy = workerOn(proposal.projectId);
      if (busy) return no(`another worker is on ${proposal.projectName ?? 'that project'} (${busy.ref.id})`);
      const now = Date.now();
      const yours = yoursOn(proposal.projectId, proposal.projectName, now);
      if (yours) return no(yours);
      // 4 · the quota, and the reserve you keep for yourself
      const blocked = opts.ledger.blockedReason(proposal.provider, opts.snapshot().limits, now)
        ?? reserveOf(proposal.provider, now);
      if (blocked) return no(blocked);

      return launchProcess({
        jobId: proposal.id, proposal, order: null, provider: proposal.provider,
        projectId: proposal.projectId, kind: 'work', reviewOf: null, cwd, now,
        // The task wrapped in its contract: inside is `proposal.task` first
        // and intact, plus the request for a one-line report. The
        // `!proposal.task` gate sits ABOVE, so the wrapper cannot make a task
        // that is not there look present.
        task: workTask(proposal), ...command(proposal.provider, cwd, PROPOSAL),
        ceilingMs: HARD_TIMEOUT_MS,
      });
    },

    launch(order) {
      if (!opts.execute) return no('executive mode is off: restart without --no-execute');
      // The second guardian: against the stores, not against the order.
      const denied = opts.authorized ? opts.authorized(order) : 'no authorizer: a planned task cannot start';
      if (denied) return no(denied);
      if (jobs.has(key({ id: order.id, kind: 'work' }))) return no('already running');
      if (!order.task.trim()) return no('the order carries no task to hand over');
      const cwd = opts.cwdOf(order.projectId);
      if (!cwd) return no('that project is not on disk');
      const busy = workerOn(order.projectId);
      if (busy) return no(`another worker is on ${order.projectName} (${busy.ref.id})`);
      const now = Date.now();
      const yours = yoursOn(order.projectId, order.projectName, now);
      if (yours) return no(yours);
      const blocked = opts.ledger.blockedReason(order.provider, opts.snapshot().limits, now);
      if (blocked) return no(blocked);

      return launchProcess({
        jobId: order.id, proposal: null, order, provider: order.provider,
        projectId: order.projectId, kind: 'work', reviewOf: null, cwd, now,
        task: order.task,
        ...command(order.provider, cwd, {
          model: order.model, effort: order.effort, allowed: order.allowed, commands: order.commands,
          resume: order.resume,
        }),
        ceilingMs: order.ceilingMs ?? HARD_TIMEOUT_MS,
      });
    },

    review(proposal, sessionId) {
      // The same gates, in the same order. Checked again and not skipped
      // because this is still a path a process starts from, and a path with
      // fewer guards than its twin is the path that will be used to get it
      // wrong.
      if (!opts.execute) return no('executive mode is off: restart without --no-execute');
      if (proposal.status !== 'accepted') return no(`the proposal is ${proposal.status}`);
      if (jobs.has(key({ id: proposal.id, kind: 'review' }))) return no('already running');
      if (!proposal.projectId) return no('the proposal names no project');
      const cwd = opts.cwdOf(proposal.projectId);
      if (!cwd) return no('that project is not on disk');
      const now = Date.now();
      const blocked = opts.ledger.blockedReason(proposal.provider, opts.snapshot().limits, now)
        ?? reserveOf(proposal.provider, now);
      if (blocked) return no(blocked);

      return launchProcess({
        jobId: proposal.id, proposal, order: null, provider: proposal.provider,
        projectId: proposal.projectId, kind: 'review', reviewOf: sessionId, cwd, now,
        task: sessionId ? reviewTask(proposal) : freshReviewTask(proposal),
        ...reviewCommand(proposal.provider, cwd, sessionId),
        ceilingMs: HARD_TIMEOUT_MS,
      });
    },

    adopt(pid, sessionId) {
      if (!Number.isInteger(pid) || pid <= 1) return null;
      for (const job of jobs.values()) {
        if (job.pid !== pid) continue;
        // The thread between the job and the session doing it: it is what
        // lets the lightning bolt on the mast tell about the running session
        // the way a building's badge would.
        if (!job.adopted) {
          job.adopted = true;
          opts.onAdopt(job.ref, sessionId);
        }
        return job.provider;
      }
      return null;
    },

    running: () => jobs.size,

    stop(ref, reason) {
      const job = jobs.get(key(ref));
      if (!job) return false;
      halt(job, reason);
      return true;
    },

    guardReserve(now) {
      for (const job of jobs.values()) {
        if (job.planned) continue;
        const breach = reserveOf(job.provider, now);
        if (breach) halt(job, `stopped by ${breach}`);
      }
    },

    stopAll() {
      for (const job of jobs.values()) {
        clearTimeout(job.killer);
        if (job.silence) clearTimeout(job.silence);
        job.child.kill('SIGTERM');
      }
      jobs.clear();
    },
  };
}

/**
 * How much work a line of output carries, and how much it cost.
 *
 * Defensive like the transcript parser and for the same reason: the format
 * belongs to a program we do not control. A line that cannot be understood
 * counts as zero, and the mast simply does not grow.
 */
function countWork(line: string): Seen {
  const none: Seen = { toolCalls: 0, costUsd: null, outcome: null };
  const trimmed = line.trim();
  if (!trimmed) return none;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return none;
  }

  const type = obj['type'];
  if (type === 'result') {
    const cost = obj['total_cost_usd'];
    const text = obj['result'];
    return {
      toolCalls: 0,
      costUsd: typeof cost === 'number' ? cost : null,
      outcome: typeof text === 'string' && text.length > 0 ? text : null,
    };
  }
  if (type === 'assistant') {
    const message = obj['message'] as { content?: unknown } | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return none;
    let n = 0;
    for (const block of content) {
      if ((block as { type?: unknown })?.type === 'tool_use') n++;
    }
    return { toolCalls: n, costUsd: null, outcome: null };
  }
  // Codex: every completed item that is a tool call; and its final message,
  // which is the outcome -- before, only Claude's `result` line was read, and
  // a Codex worker always ended "with no answer".
  if (type === 'item.completed' || type === 'item_completed') {
    const item = obj['item'] as { type?: unknown; text?: unknown } | undefined;
    const kind = item?.type;
    const isTool = kind === 'command_execution' || kind === 'file_change' || kind === 'mcp_tool_call';
    const said = (kind === 'agent_message' || kind === 'AgentMessage') && typeof item?.text === 'string' && item.text.length > 0
      ? item.text : null;
    return { toolCalls: isTool ? 1 : 0, costUsd: null, outcome: said };
  }
  return none;
}

/** What a line carried: work, price, or the answer. */
interface Seen {
  toolCalls: number;
  costUsd: number | null;
  /** The final answer. `null` on every line that is not the result. */
  outcome: string | null;
}
