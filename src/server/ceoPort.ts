import type {
  AnalysisKind, AnalysisOffer, CeoDepth, ClientFrame, DeltaEvent, ProviderId, RateWindow, ServerFrame,
  Snapshot,
} from '../shared/protocol.ts';
import {
  MAX_ANSWER_CHARS, MAX_ATTACHMENT_CHARS, MAX_ATTACHMENT_NAME_CHARS, MAX_COMMAND_CHARS,
  MAX_PROJECT_COMMANDS, MAX_SAY_CHARS,
} from '../shared/protocol.ts';
import type { ClosedSession, HistoryDigest } from './state/history.ts';

/**
 * The contract between the server and the CEO section: the wall socket.
 *
 * It lives OUTSIDE `ceo/` on purpose, and that is the only reason this file
 * exists instead of being a few lines inside `ceo/index.ts`. `cli.ts` must be
 * able to name these types without the module existing, or the
 * observation-only version would not compile.
 *
 * And making the import dynamic is not enough: TypeScript still resolves
 * `import('./ceo/index.ts')` if the path is a string literal, even in
 * expression position. That is why `cli.ts` composes the path at runtime and
 * takes the types from here -- verified by `npm run check:passive`, which
 * really deletes the folder and recompiles.
 *
 * In the passive repository the socket stays and nothing is plugged into it.
 */

/**
 * The frames of the planning meeting, as one type.
 *
 * `cli.ts` hands them to the desk with one call instead of one branch per
 * frame: fourteen branches in the dispatcher would be fourteen places to
 * forget the `if (!ceoDesk)` guard.
 */
export type PlanFrame = Extract<ClientFrame, { t: `plan.${string}` }>;

export function isPlanFrame(frame: ClientFrame): frame is PlanFrame {
  return frame.t.startsWith('plan.');
}

/**
 * The declared caps, applied on the way in.
 *
 * Here and not inside `ceo/`, next to the dispatcher that already cuts
 * `ceo.say` at 2000: the client enforces the same caps first, so a cut here
 * means a client that lied, and it must not reach a prompt or the disk.
 */
export function clipPlanFrame(frame: PlanFrame): PlanFrame {
  switch (frame.t) {
    case 'plan.say':
      // One over the cap, as for an attachment: the store refuses it with the
      // number. Cut here, a long to-do list reached the chair without its tail
      // and nobody was told.
      return { t: 'plan.say', text: frame.text.slice(0, MAX_SAY_CHARS + 1) };
    case 'plan.attach':
      return {
        t: 'plan.attach',
        name: frame.name.slice(0, MAX_ATTACHMENT_NAME_CHARS),
        text: frame.text.slice(0, MAX_ATTACHMENT_CHARS + 1),
      };
    case 'plan.answer':
      // One over, as for a message: the store refuses it with the number.
      return { t: 'plan.answer', taskId: frame.taskId, text: frame.text.slice(0, MAX_ANSWER_CHARS + 1) };
    case 'plan.set':
      if (frame.patch.kind === 'question') {
        return { t: 'plan.set', patch: { ...frame.patch, text: frame.patch.text.slice(0, MAX_ANSWER_CHARS + 1) } };
      }
      if (frame.patch.kind === 'commands') {
        // One over, both ways: the store refuses the list or the command with the number.
        const list = Array.isArray(frame.patch.commands) ? frame.patch.commands : [];
        return {
          t: 'plan.set',
          patch: {
            ...frame.patch,
            commands: list.slice(0, MAX_PROJECT_COMMANDS + 1).map((c) => String(c).slice(0, MAX_COMMAND_CHARS + 1)),
          },
        };
      }
      return frame;
    default:
      return frame;
  }
}

/** The three spending caps. Only one is in currency, and it is the one that matters least. */
export interface CeoCaps {
  /** Quota percentage past which nothing starts: the real limit. */
  quotaMaxPercent: number;
  /** Sliding 24-hour window, for API keys only: with a quota reading the quota is the cap. */
  budgetUsd: number;
  /** Cap on a single call: the call that runs away, not the day's spend. */
  maxCallUsd: number;
}

export interface CeoDeskOptions {
  providers: readonly ProviderId[];
  /** The middle rung of the model ladder. `--ceo-model`, normally `sonnet`. */
  model: string;
  /**
   * The Codex model, if you declared one.
   *
   * `null` means "its own": Codex model names belong to another vendor, and
   * guessing one makes the spawn fail instead of costing a little more.
   */
  codexModel: string | null;
  stateDir: string;
  caps: CeoCaps;
  snapshot: () => Snapshot;
  /**
   * The real path of a project, for the CEO and for nobody else.
   *
   * It comes from the world model, exactly like the PID behind `focus`: an id
   * crosses from the client, a path never does. The browser channel keeps its
   * own -- stricter -- rules, and this is the second consumer of the same
   * model, not a second way into the first one.
   */
  cwdOf: (projectId: string) => string | undefined;
  /**
   * Two periods compared, not a series.
   *
   * The brief must NEVER paste a chronology: it grows with use, and with it
   * the cost of every single question. Two endpoints and a direction say "it
   * is getting worse" with thirty fewer lines.
   */
  history: (days: number) => HistoryDigest;
  /**
   * A project's rows, one by one.
   *
   * Not `history(days)`: that carries two totals compared, and it is the
   * right shape for the brief -- but a per-session median cannot be derived
   * from a total, and a mean would be decided by the biggest session.
   *
   * A function and not the `History` object: handing over the registry would
   * also give the deletable folder `record`, `merge` and `save`, i.e.
   * permission to WRITE into the history. Read-only is the boundary.
   */
  projectSessions: (
    projectId: string, from: number, to: number,
  ) => readonly ClosedSession[];
  /**
   * The weighted tokens burned in a window.
   *
   * It is the denominator by which a call becomes a percentage of your
   * subscription rate: the only unit that means anything on a subscription.
   */
  weightedSince: (provider: ProviderId, since: number, now: number) => number;
  /**
   * A quota reading from a CEO's own process -- a worker, a chair's turn.
   *
   * The server folds it into the same limits the status line feeds, so the
   * bars, the gates and the reserve all read it. Optional: without it the
   * desk still works, on the status line alone.
   */
  noteQuota?: (provider: ProviderId, windows: RateWindow[]) => void;
  /**
   * Executive mode. When off, an accepted proposal stays accepted.
   *
   * The refusal belongs to the SERVER and not to an instruction inside a
   * prompt: a model can ignore a sentence, not a process that is never
   * started.
   */
  execute: boolean;
  /** A fact of the world: every client sees it. */
  broadcast: (events: DeltaEvent[]) => void;
  /**
   * A desktop notice, for a plan that stopped while you were not looking.
   * Absent outside macOS and with `--no-notify`: the HUD's warning stays.
   */
  notify?: (title: string, text: string) => void;
  /**
   * The scheduler's beat, `--ceo-every`. `null` is the default of 30 s.
   *
   * The one clock in this module that moves on its own. It launches tasks of
   * a plan you approved and nothing else: no tick ever calls a model.
   */
  tickMs: number | null;
  /**
   * Closed sessions of one fleet, rows one by one.
   *
   * Read-only like `projectSessions`, and for the same reason. It is what
   * prices a planned task before any attempt has run: the median of what your
   * own sessions burned, not a list price.
   */
  closedSessions: (provider: ProviderId, from: number, to: number) => readonly ClosedSession[];
}

/** A job's traces, for the window that opens on them. See `CeoDesk.locate`. */
export interface JobWhereabouts {
  provider: ProviderId;
  /** The worker's session, once the registry surfaced it. */
  sessionId: string | null;
  projectId: string | null;
  /** The documents it wrote, as paths inside the project: the ledger's list, in its order. */
  wrote: readonly string[];
}

export interface CeoDesk {
  /**
   * The analyses that exist, each with its full question.
   *
   * The module declares them, and from here they end up in the `caps`: the
   * panel writes into the text box the sentence you will pay for, instead of
   * a paraphrase of it. Without the module the list does not exist and the
   * caps carry it empty.
   */
  readonly analyses: readonly AnalysisOffer[];
  /** A question to a CEO. The answer goes back to whoever asked, not to everyone. */
  ask(
    provider: ProviderId,
    text: string,
    analysis: AnalysisKind | null,
    depth: CeoDepth,
    reply: (frame: ServerFrame) => void,
  ): void;
  /**
   * The same question to both fleets.
   *
   * Two answers and two sets of proposals, never one merged for you. Merging
   * would take a third call -- another full preamble, measured at about five
   * cents -- to turn two positions into one that neither CEO actually holds.
   * Where they disagree, the disagreement is the finding.
   */
  meeting(
    providers: readonly ProviderId[],
    topic: string,
    analysis: AnalysisKind | null,
    depth: CeoDepth,
    reply: (frame: ServerFrame) => void,
  ): void;
  /**
   * You accept or reject a proposal.
   *
   * Accepting it, unless `--no-execute`, starts a dedicated session and its
   * turret rises. The reason for a refusal goes back to whoever decided: a
   * proposal that cannot be carried out must say why.
   */
  decide(id: string, accept: boolean, reply: (frame: ServerFrame) => void): void;
  /**
   * Is the process that just appeared in a registry a worker opened by a CEO?
   *
   * The world model needs it so as not to draw the same effort twice: a
   * `claude -p` enrols in the registry of live sessions like any other
   * session, so the session we open is also DISCOVERED. By answering, the
   * desk recognises its own and withdraws its placeholder.
   */
  adopt(pid: number, sessionId: string): ProviderId | null;
  /** A job's outcome, in full, to whoever asked for it. */
  read(id: string, reply: (frame: ServerFrame) => void): void;
  /** A proposal's task, in full, to whoever asked for it: what a yes would start. */
  readProposal(id: string, reply: (frame: ServerFrame) => void): void;
  /**
   * Where a job's traces are: its session, its project, the documents it wrote.
   *
   * What `cli.ts` needs to open the log of a job that is over, or a file the
   * worker left for you, and nothing else -- the outcome stays behind `read`.
   * The path of the project is not here: it comes from the world model, like
   * the pid behind `focus`, so the ledger never holds a path.
   */
  locate(id: string): JobWhereabouts | null;
  /**
   * How it went AFTERWARDS, for every job. To whoever asked.
   *
   * The request is also the gesture that makes the measurements recompute:
   * there is no timer, and there must not be one. The loop used to close at
   * "the job is done"; this is the piece that says whether it helped.
   */
  effects(reply: (frame: ServerFrame) => void): void;
  /**
   * Ask the CEO to try to disprove the attribution.
   *
   * It costs a preamble, so it starts only from a click of yours. And the
   * question it receives asks it to BREAK the link, not to confirm it: to
   * "did it work?" the zero-cost answer is yes, and it is worth nothing --
   * the same reason the reviewer is asked for objections and not approval.
   */
  judge(id: string, reply: (frame: ServerFrame) => void): void;
  /**
   * Seen it: take the turret down.
   *
   * It does not delete the job -- it stays in Reports, and that is what makes
   * the other way out acceptable too: five minutes after the end the turret
   * closes by itself. This one is so you do not have to wait them out, when
   * you have already seen.
   */
  dismiss(id: string): void;
  /**
   * Start Board over: its reports and proposals go, archived, and a question
   * being answered there is stopped and its answer thrown away. Everyone is
   * told with a `ceo.cleared` delta.
   */
  resetBoard(): void;
  /** Start Reports over: every job but the running ones goes, archived. */
  resetJobs(): void;
  /**
   * The planning meeting and its plan, one entry for every frame of it.
   *
   * The reply goes to whoever asked -- the whole plan, or why a change was
   * refused -- and the fact that the plan changed goes to everyone as a
   * `plan` delta with counts and nothing else.
   */
  plan(frame: PlanFrame, reply: (frame: ServerFrame) => void): void;
  /**
   * The initial states, to send to a client that connects.
   *
   * Reports and proposals ride along: they are not part of the world model, so
   * a client that connects to a running world would otherwise find an empty
   * board with no way to tell it from a board with nothing on it.
   */
  states(): DeltaEvent[];
  close(): void;
}

/** What `ceo/index.ts` must export. */
export interface CeoModule {
  createCeoDesk(opts: CeoDeskOptions): CeoDesk;
}
