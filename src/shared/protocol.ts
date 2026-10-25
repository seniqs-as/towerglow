/**
 * The single contract between server and client.
 *
 * PRIVACY RULE: every field in here is METADATA. The delta channel never
 * carries prompt text, shell output or file contents: those only go through
 * the inspection channel (pull, opt-in with --inspect).
 * `assertSafe()` on the server side fails, in dev and in tests, any string
 * over MAX_FIELD_CHARS on a DeltaEvent.
 *
 * The only longer string is the `recap`, and it has its own cap declared
 * below: it is the only place where this file admits a paragraph, and
 * admitting it by name is the way to keep it from becoming a general crack.
 */

// v2: the buildings' position moves from `seed` to `slot` (frozen row).
// v3: `spawnedByCeo` says whether a CEO opened a session: it changes where it
//     is drawn -- a turret on the HQ instead of a window in its building.
// v4: the five analyses. `report` and `proposal` carry the provider that made
//     them, `ceo.say` and `meeting` carry which analysis was asked for.
// v5: `session.cost`, the closing statement a session leaves behind, and
//     `ProjectInfo.providers`, which says which tools have worked on a project.
// v6: `report` carries the share of quota a call burned -- on a subscription
//     that is the cost that exists; dollars are a list-price equivalent.
// v7: three depths. `ceo.say` and `meeting` say how deep to go, `report` says
//     how deep it went and with which model.
// v8 (additions, same version): `job.workState` tells the worker's own state
//     apart from the turret's, and `job.workDid` / `job.workFounded` carry what
//     the worker says it actually did. Not a bump: the version is bumped when an
//     OLD client would read something WRONG, not when it lacks fields it never
//     reads. Bumping closes every open tab with `version_mismatch`, which is a
//     real cost and must buy something.
// v8 (additions, same version): `effect.read` / `effect.board` / `effect.judge`
//     carry how a project moved after a job was applied. Same reasoning as
//     above: an old client never sends them and never receives them -- the
//     board is a reply to a request, not a fact broadcast to everyone -- so
//     there is nothing it could read wrong.
// v9: `ceo.stream` carries `surface` (board | effect | plan). An old client
//     would route a planning reply onto the board, which IS reading something
//     wrong. Adds the `plan.*` frames, `plan.doc` and the `plan` delta.
// v9 (additions, same version): `job.workWrote`, the documents a worker wrote,
//     and `job.watch` / `job.open` / `job.result`: the log of a finished job
//     and its documents, opened from Reports. An old client never sends the
//     requests and ignores the field.
// v9 (removals, same version): `project.pathHint`, `caps.hooks`, `caps.demo`,
//     `caps.inspect` and the `inspect` frames are gone. No client ever read or
//     sent them, so an old one misses nothing.
// v9 (additions, same version): `snapshot.rings`, the git events on the
//     towers. An old client ignores it and keeps drawing what it is sent live.
// v9 (additions, same version): `session.compactedAt`. An old client ignores
//     it and shows no caption.
// v9 (additions, same version): `session.limitStoppedAt` and
//     `session.limitResetsAt`. An old client ignores them and shows the
//     stopped session as done.
// v9 (additions, same version): `project.dirs`, the folders the size scan
//     went into. An old client ignores it; a new one shows a dash without it.
export const PROTOCOL_VERSION = 9;

/** Beyond this length, a string in a DeltaEvent is a redaction bug. */
export const MAX_FIELD_CHARS = 128;

/**
 * The cap for `recap` alone, the only field allowed a paragraph.
 *
 * Four hundred and not one hundred and twenty-eight because a recap cut in
 * half loses precisely the part that matters: across 72 real recaps measured,
 * the longest was 320 characters, and at 128 the "next step" always
 * disappeared. Four hundred sits above the observed maximum and stays very
 * far from a prompt or a shell output, which is what the guard exists to stop.
 */
export const MAX_RECAP_CHARS = 400;

/**
 * The cap on a proposal `summary`, the second field allowed a sentence.
 *
 * Two hundred and forty, not the four hundred of a recap: a proposal that needs
 * more than two lines to state is a report, and a report's prose never travels
 * on the delta channel at all. It streams on `ceo.stream`, which is a reply to
 * the client that asked and not a fact of the world. Declaring the cap by name
 * is what keeps this from becoming a general crack in the guard.
 */
export const MAX_SUMMARY_CHARS = 240;

/* ─────────────────────────── taxonomies ─────────────────────────── */

/** The tool that is working. Decides color and icon on screen. */
export type ProviderId = 'claude' | 'codex';

/**
 * How certain a session's status is.
 *
 * `reported`: the tool declares it (Claude Code's registry, or Codex's
 * app-server when the daemon is running). `inferred`: we deduce it from the
 * files, and the scene must say so instead of making the two look equally
 * certain.
 */
export type StatusConfidence = 'reported' | 'inferred';

export type ToolCategory =
  | 'read' | 'edit' | 'exec' | 'search' | 'net'
  | 'agent' | 'plan' | 'msg' | 'mcp' | 'other';

export type SessionStatus = 'busy' | 'idle' | 'waiting';
export type SessionKind = 'interactive' | 'background' | 'sdk' | 'unknown';
export type FileOp = 'read' | 'edit' | 'write';

/** Target of a tool call. Only derived scalars, never raw values. */
export type TargetRef =
  | { kind: 'file'; path: string; ext: string; dir: string; external: boolean }
  | { kind: 'cmd'; bin: string }
  | { kind: 'agent'; agentType: string }
  | { kind: 'skill'; name: string }
  | { kind: 'peer'; name: string };

export interface TokenTotals {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
}

/* ─────────────────────────── entities ─────────────────────────── */

/**
 * Where the size scan of a project's folder stops. Shared because the page has
 * to tell a count that ended from one that was cut: 20,000 is "20,000 or more".
 */
export const MAX_SCANNED_FILES = 20000;
/** How many folders deep the same scan goes. */
export const MAX_SCANNED_DEPTH = 10;

export interface ProjectInfo {
  id: string;        // sha256(cwd).slice(0,16)
  /** What it is called on screen: the basename, or the alias you gave it. */
  name: string;
  /** The real name, so an alias can be undone. */
  realName: string;
  /** Hidden from view: the building is not drawn, the slot stays reserved. */
  disabled: boolean;
  /** Place in the row, assigned once and frozen: the ONLY source of the position. */
  slot: number;
  exists: boolean;   // false = known project but no longer on disk -> building in ruins
  firstSeenAt: number;
  /** Last known activity. Orders the city: the most recent stand in the center. */
  lastActiveAt: number;
  /**
   * The project's file count: decides how tall the building is. A scan that
   * reached `MAX_SCANNED_FILES` stopped there, so the folder holds at least that.
   */
  size: number;
  /** The folders the same scan went into: hidden, dependency and build folders are skipped. */
  dirs: number;
  /** Subject of the last commit: it is what the sign shows instead of
   *  the session's handle. `null` if the project is not a repo. */
  lastCommit: string | null;
  branch: string | null;
  /** How many commits we have seen go by for this project. */
  commits: number;
  /**
   * Which tools have worked here, ever.
   *
   * Sticky: a provider that has touched this project stays in the list even
   * when its last session is gone, because the question it answers is "do I use
   * both tools here", not "am I using both right now". It is what decides
   * whether a board meeting is worth holding at all -- with no project in
   * common, two CEOs answering the same question are two bills for one answer.
   */
  providers: ProviderId[];
}

/**
 * One month of a project's work, as the tower's card shows it (the user's
 * request, 2026-10-24: what a project took, to show its funders).
 */
export interface WorkMonth {
  /** `YYYY-MM`: the month the sessions began in, as the history files them. */
  month: string;
  sessions: number;
  /** How many had their time read: fewer than `sessions` makes the hours a floor. */
  timed: number;
  tokens: TokenTotals;
  /** The agents' turns, summed across sessions. */
  aiMs: number;
  /** Yours, estimated from when you sent messages, shared with the other projects you had going. */
  operatorMs: number;
  /**
   * `aiMs` by the model and effort its turns ran on (the user's request,
   * 2026-10-25). Summing to less than `aiMs` is a part nobody recorded:
   * rows timed or months folded before models were read.
   */
  models: ModelTime[];
}

/**
 * The agents' time on one model at one effort.
 *
 * Both as the tool wrote them on the turn: Claude Code's `message.model` and
 * `effort` on every reply (from 2.1.281 on, all of them on disk on
 * 2026-10-25), Codex's `turn_context`. `effort` is `null` where the tool
 * wrote none.
 */
export interface ModelTime {
  model: string;
  effort: string | null;
  aiMs: number;
}

/** Adds `from` into `into`, one entry per model and effort. */
export function addModelTimes(into: ModelTime[], from: readonly ModelTime[]): void {
  for (const m of from) {
    const same = into.find((x) => x.model === m.model && x.effort === m.effort);
    if (same) same.aiMs += m.aiMs;
    else into.push({ model: m.model, effort: m.effort, aiMs: m.aiMs });
  }
}

/**
 * The longest stretch one message of yours can stand for, on a project's
 * card. Why ten minutes, and what it moves: `server/state/workMeter.ts`.
 * Shared because the card names it.
 */
export const OPERATOR_CAP_MS = 10 * 60_000;

export interface ProjectWork {
  /** Newest first, at most a year: the history keeps no more. */
  months: WorkMonth[];
  /** Sessions still open, counted up to now. */
  live: number;
}

export interface SessionInfo {
  id: string;                   // sessionId (UUID)
  projectId: string;
  pid: number;
  label: string;                // registry .name, e.g. "my-dashboard-7b": IT IS THE ADDRESS
  title: string | null;         // the turn's ai-title; null with --no-titles
  status: SessionStatus;
  waitingFor: string | null;
  kind: SessionKind;
  model: string | null;
  ccVersion: string;
  gitBranch: string | null;
  permissionMode: string | null;
  isCeo: boolean;
  /**
   * The CEO that opened this session, if you did not open it yourself.
   *
   * It changes WHERE the session is seen: a session of yours stands in its
   * project's building, one launched by a CEO is a turret on the HQ's roof.
   * The project stays the real one -- it tells what it is working on -- but
   * that is not where you look at it.
   */
  spawnedByCeo: ProviderId | null;
  provider: ProviderId;
  statusConfidence: StatusConfidence;
  startedAt: number;
  lastActivityAt: number;
  /**
   * Instant of the last status change: for a `busy` session it is when the
   * current run started, and it is the stopwatch shown on screen.
   */
  statusSince: number;
  tokens: TokenTotals;
  contextLeft: number | null;   // from total_tokens_reminder: it is the BUDGET, not the window
  /**
   * How much of the context window is occupied, from 0 to 100.
   *
   * It is not `contextLeft`, which counts the session's token budget. This is
   * the space in the model's window: when it reaches the end the session
   * compacts or stops. It comes from wherever the tool computes it -- the
   * statusline for Claude Code, the rollout for Codex -- and stays `null`
   * until anything is known about it, instead of faking a zero.
   */
  contextPct: number | null;
  /**
   * When the tool last compacted the session: the conversation replaced by
   * its own summary, on its own when the window fills up (or by `/compact`).
   *
   * Without it the only trace was `contextPct` dropping, and a fall from 97%
   * to 1% with no `/clear` read as a fault (the user's question, 2026-10-14).
   * The time only: Claude Code's `compact_boundary`, Codex's `compacted`
   * record. `null` when no compaction has been read in what the server read.
   */
  compactedAt: number | null;
  /**
   * When the session stopped at a usage limit, if it is stopped there now:
   * the API refused its turn for the account's usage, and nothing starts it
   * again when the limit resets -- an interactive session waits for you to
   * type (the user's request, 2026-10-16: show it on the project, so you know
   * it has to be restarted). Claude Code's refusal (`error: "rate_limit"`),
   * Codex's `task_complete` with `usage_limit_exceeded`. Back to `null` when
   * it goes on: a prompt, a reply the API served, a Codex turn that starts.
   */
  limitStoppedAt: number | null;
  /**
   * When that limit resets, if it is known: Claude Code writes it on the
   * refusal since 2.1.29x, for Codex it is the reset of its fullest window
   * at the stop. Past it the session can go on, but only once you restart it.
   */
  limitResetsAt: number | null;
  turns: number;
  toolCalls: number;
  /**
   * Duration of the LAST completed turn.
   *
   * It is not the time elapsed since it ended: that is derived from
   * `statusSince`, and confusing the two means saying that a task that took
   * ninety seconds took twenty-five minutes.
   */
  lastTurnMs: number | null;
  /** Sum of the durations of completed turns: how long it has worked in all. */
  turnsMs: number;
  /**
   * Time spent reasoning, summed.
   *
   * `null` when the tool does not measure it: Codex stamps every item with
   * `started_at_ms` and `completed_at_ms`, so reasoning is really timed;
   * Claude Code writes the thinking blocks without any time of their own, and
   * there the only measure of reasoning remains the token count. An estimated
   * value would be indistinguishable from a measured one: better nothing.
   */
  reasoningMs: number | null;
  /**
   * The summary the tool writes about itself: goal, status, next step.
   *
   * It is the only thing that says what is being done in WORDS, and we do not
   * deduce it: Claude Code writes it into the transcript on its own
   * (`away_summary`) roughly every fifteen minutes. The `title` does not
   * replace it -- that names the session and stays the same for hours -- nor
   * does `activityTool`, which says the gesture and not the why. `null` when
   * the tool has not written one yet, or with `--no-recap`.
   */
  recap: string | null;
  /**
   * When it was written.
   *
   * It must be shown next to the text: a recap from an hour ago describes work
   * that is probably already finished, and without its age it reads as if it
   * were from now. Same reason the limits carry their `at`.
   */
  recapAt: number | null;
  /**
   * The recap is not its own: it comes from another session of the same
   * project.
   *
   * `/clear` changes the sessionId while keeping the same terminal, and the
   * summary starts over from zero: instead of leaving the card silent for half
   * an hour, the last one written in the project is shown. It must be SAID on
   * screen, though, because it is the account of a conversation that no
   * longer exists.
   */
  recapInherited: boolean;
  /** Last tool started: it is the most direct way to say what it is doing. */
  activityTool: string | null;
  /** On what: a file, a binary, an agent type. Already redacted upstream. */
  activityTarget: string | null;
  agentsActive: number;
  deskIndex: number;            // desk occupied in its own building
}

export interface AgentInfo {
  id: string;                   // agentId
  sessionId: string;
  projectId: string;
  /**
   * Who lives in the window: a subagent at work, or a skill in use.
   *
   * They live differently. The subagent ends when it delivers; the skill
   * loads its instructions in an instant and then steers the rest of the
   * turn, so it stays lit until the turn closes.
   */
  kind: 'subagent' | 'skill';
  agentType: string | null;     // from tool_use.input.subagent_type
  /**
   * Id of its transcript, when it was launched async.
   *
   * `null` for a synchronous subagent, which ends with the call that started
   * it and does not need to be looked for.
   */
  agentId: string | null;
  model: string | null;
  startedAt: number;
  lastActivityAt: number;
  endedAt: number | null;
  toolCalls: number;
  tokens: TokenTotals;
  deskIndex: number;
}

export interface FileNode {
  id: string;         // fnv1a32(projectId + '\0' + path).toString(36)
  projectId: string;
  path: string;       // relative to the project's cwd
  ext: string;
  dir: string;        // first segment: 'src', 'test', '.' ...
  /** Floor and column of its window: assigned once and frozen. */
  floor: number;
  col: number;
  reads: number;
  writes: number;
  churn: number;      // cumulative changed lines
  firstSeenAt: number;
  lastTouchAt: number;
}

/* ─────────────────────────── delta ─────────────────────────── */

export type DeltaEvent =
  | { t: 'project.add'; project: ProjectInfo }
  | { t: 'project.remove'; id: string }
  | { t: 'session.add'; session: SessionInfo }
  | { t: 'session.update'; id: string; patch: Partial<SessionInfo>; at: number }
  | { t: 'session.remove'; id: string; at: number; reason: 'exit' | 'stale' }
  | { t: 'agent.add'; agent: AgentInfo }
  | { t: 'agent.update'; id: string; patch: Partial<AgentInfo>; at: number }
  | { t: 'agent.remove'; id: string; at: number; reason: 'stop' | 'idle' }
  | {
      t: 'tool.start'; id: string; sessionId: string; agentId: string | null;
      name: string; cat: ToolCategory; at: number; target: TargetRef | null;
    }
  | {
      t: 'tool.end'; id: string; sessionId: string; at: number;
      durationMs: number | null; ok: boolean; bytes: number; changed: number; orphan: boolean;
      /**
       * The tool returned immediately, leaving the work in progress.
       *
       * Applies to subagents launched async: `tool.end` arrives an instant
       * after `tool.start`, but the agent is still working. Without this
       * distinction its window would go dark as soon as it lit up. And to a
       * shell sent to the background, which keeps running after the call and
       * can outlive the turn too.
       */
      asyncLaunch: boolean;
      /**
       * Id of the launched subagent, when the call started one.
       *
       * Used to find its transcript again and know when it has really
       * finished: an async launch returns immediately, and without this the
       * only way to close the agent would be to guess.
       */
      spawnedAgentId: string | null;
    }
  | { t: 'tool.burst'; sessionId: string; cat: ToolCategory; count: number; at: number }
  | {
      t: 'file.touch'; projectId: string; sessionId: string; fileId: string;
      path: string; ext: string; dir: string; op: FileOp; changed: number; at: number;
      /** Assigned by the server on first appearance and then frozen. */
      floor: number; col: number;
    }
  | { t: 'file.evict'; projectId: string; fileId: string }
  | { t: 'prompt'; sessionId: string; promptId: string; at: number; chars: number; source: 'typed' | 'queued' }
  | { t: 'turn.end'; sessionId: string; at: number; durationMs: number; messageCount: number }
  | { t: 'usage'; sessionId: string; agentId: string | null; at: number; model: string; delta: TokenTotals }
  /**
   * The closing statement a session leaves behind.
   *
   * Claude Code writes it on the last lines of the transcript when a session
   * ends, and it is the only place where the numbers are COMPLETE: `usage`
   * events only cover what the tailer happened to read, which on a session
   * older than the warmup window is a fraction of it. Every field is a scalar
   * the tool itself declares, so nothing here is estimated.
   *
   * `at` is when the session STARTED, not when this line was written: it is the
   * day the work belongs to, and a session that runs past midnight would
   * otherwise land on the wrong one.
   */
  | {
      t: 'session.cost'; sessionId: string; at: number;
      costUsd: number;
      tokens: TokenTotals;
      /** The model that did most of the work, when more than one was used. */
      model: string | null;
      apiMs: number; toolMs: number; wallMs: number;
      linesAdded: number; linesRemoved: number;
    }
  | { t: 'context'; sessionId: string; at: number; tokensLeft: number }
  | { t: 'notice'; sessionId: string | null; at: number; code: NoticeCode }
  /* ── git ── */
  | {
      t: 'git'; projectId: string; at: number;
      kind: 'commit' | 'checkout' | 'merge' | 'rebase' | 'reset' | 'other';
      sha: string; branch: string | null; subject: string | null;
    }
  /* ── organization ── */
  | {
      t: 'ceo'; at: number; provider: ProviderId; state: CeoState;
      /** What it is working on, when it is working. */
      target: string | null;
      /**
       * Why it is in that state, when it needs saying.
       *
       * A CEO stopped out of caution -- quota nearly used up, budget exhausted
       * -- is indistinguishable from a broken CEO unless it says why. It lives
       * here and not in the logs because it is a message for you, not for
       * whoever reads a file.
       */
      reason: string | null;
    }
  | { t: 'peer'; at: number; from: string; to: string; status: PeerStatus }
  | {
      t: 'report'; id: string; at: number; provider: ProviderId;
      /** Which of the five produced it, or `null` for a question you typed. */
      analysis: AnalysisKind | null;
      title: string;
      /**
       * What the call cost, when the tool says so.
       *
       * Zero also means "not reported": `codex exec` prints no price. A zero
       * here is never proof that the call was free.
       */
      costUsd: number;
      /**
       * What it cost as a percentage of your subscription rate.
       *
       * It is the measure that counts on a subscription, where you do not pay
       * per token: `costUsd` is a list-price equivalent, this is real quota
       * being consumed. Derived from the ratio between your tokens and the
       * measured window, so it is a CAP -- the denominator counts only what
       * this tool has seen. `null` when there is no history to say it.
       */
      quotaPercent: number | null;
      /** On which window: `5h`, `7d`. `null` together with `quotaPercent`. */
      quotaWindow: string | null;
      /** At what depth it was asked: it is what explains the price. */
      depth: CeoDepth;
      /** The model that actually answered. It depends on the depth. */
      model: string | null;
    }
  | {
      t: 'proposal'; id: string; at: number; provider: ProviderId; kind: string;
      summary: string; status: ProposalStatus;
      /** The project its worker would run in, by name: the card says where before you say yes. */
      project: string | null;
      /**
       * The handle of the work, short on purpose.
       *
       * The task a dedicated session will actually receive does not fit in
       * `MAX_FIELD_CHARS` and does not belong here: it stays in the proposals
       * registry on the server, and only its handle crosses to the browser.
       */
      command: string | null;
      /**
       * Why it could not be executed, when that is how it went.
       *
       * An accepted proposal that does not start -- execute mode off, project
       * not on disk, quota used up -- is indistinguishable from an ignored
       * proposal unless it says why. Same reason as the `reason` on `ceo`, and
       * same place: a message for you, not for a log.
       */
      reason: string | null;
    }
  /**
   * A job started by accepting a proposal: the turret on the HQ.
   *
   * It is not a session, and that is intended. A session lives as long as its
   * process lives, and a job must outlive it: it has finished, produced an
   * outcome, and stays on screen until you close it. Until now the turret
   * disappeared along with the process and no trace of the outcome remained
   * anywhere -- you accepted a piece of advice and no longer knew how it went.
   */
  | {
      t: 'job'; id: string; at: number; provider: ProviderId;
      /** What kind of job: the same `kind` as the proposal it comes from. */
      kind: string;
      /** The title: the proposal's summary. Same cap, same name. */
      summary: string;
      projectId: string | null;
      projectName: string | null;
      /**
       * The TURRET's state, from its two parts.
       *
       * A job has two -- who does it and who judges it -- and a single
       * turret, because it is a single decision: yours. It runs as long as
       * either of the two runs; it fails only if the job fails, because a
       * missed review does not undo what you had accepted.
       */
      state: JobState;
      /**
       * The state of WHOEVER DID the job, distinct from the turret's.
       *
       * `state` is the aggregate, and on its own it is not enough for whoever
       * draws: it does not tell "still working" from "finished, and now
       * someone is judging it". Those are two different things for whoever is
       * watching -- in the second case the outcome EXISTS and can be read --
       * and without this field the panel kept it hidden until the review was
       * over, that is, exactly when you most wanted to read it.
       */
      workState: JobState;
      /**
       * The review comes from a NEW session, opened for the occasion.
       *
       * `null` until there is a review. It keeps two answers of different
       * weight from being read as the same thing: whoever was resumed with a
       * fork knows WHY the work was done that way, whoever opened just now has
       * only checked the premises against the repository -- useful, but a
       * different thing.
       */
      reviewFresh: boolean | null;
      /**
       * What the worker says it actually did. One line, its own.
       *
       * `null` until it has finished, and forever if its answer did not carry
       * the outcome block. It is on the delta channel -- unlike the two
       * texts, which are thousands of characters and are asked for -- because
       * it is the only way to show, next to what you ASKED, what was DONE:
       * before, the Reports row carried only the proposal's summary, that is,
       * the CEO's sentence, even when the worker had opened its answer by
       * contradicting it.
       */
      workDid: string | null;
      /**
       * The documents the worker wrote for you to read, as paths inside the
       * project: the plan of a "planning only" task, a study, a report.
       *
       * Empty until it has finished, and forever when its work was code. A
       * plan written into `docs/` used to be reachable only from the editor:
       * Reports carried the worker's last message ABOUT it, and the ledger
       * cannot hold a 47 KB document. Each path is a button (`job.open`), and
       * the server checks it again against the project folder before opening
       * anything. Short by construction: `MAX_FIELD_CHARS` each, at most a
       * handful, because they travel on the delta channel.
       */
      workWrote: string[];
      /**
       * The request stood up, according to whoever carried it out.
       *
       * `false` when it rested on something that is not true there. It is the
       * twin of `reviewHolds` and matters for the same reason -- it is the
       * information the CEO could not have -- with one important difference:
       * this one costs nothing extra, because it comes from whoever was doing
       * the job anyway. Measured: two jobs out of two reported it false.
       */
      workFounded: boolean | null;
      /**
       * The session doing it, when the registry has surfaced it.
       *
       * It is what lets the lightning bolt on the turret describe the session
       * in progress the way a building's badge would: the job and the session
       * are two different things, and this is the thread between them.
       */
      sessionId: string | null;
      /** The second opinion. `null` when it has not even started. */
      reviewState: JobState | null;
      /**
       * The advice holds, according to whoever works there.
       *
       * `null` until it is known. A `false` is the most valuable information a
       * job carries: it is the only one the CEO could not have, because of the
       * project it sees the numbers and not the reasons.
       */
      reviewHolds: boolean | null;
      /** Calls and cost of BOTH parts: one decision, one bill. */
      toolCalls: number;
      /** What it cost according to the tool. Zero also means "not said". */
      costUsd: number;
      /** When it finished. `null` while it works. */
      endedAt: number | null;
      /**
       * Why it went wrong, when it went wrong.
       *
       * The OUTCOME does not go through here: it is thousands of characters,
       * and the delta channel carries metadata. It is asked for with
       * `job.read` and goes back to whoever asked, like the answer to a
       * question.
       */
      reason: string | null;
      /**
       * You closed it: off the stage, into Reports.
       *
       * A flag and not a removal, because closing is not deleting. The turret
       * goes away, the outcome stays readable -- otherwise the cross would be
       * a button never to press.
       */
      dismissed: boolean;
      /** The worker stopped to ask you something: the badge pulses, Planning has the question. */
      asks: boolean;
      /** The planned task this attempt belongs to. `null` for a proposal's job. */
      plan: { taskId: string; attempt: number } | null;
    }
  | { t: 'limits'; limits: ProviderLimits }
  /**
   * The plan, as a fact of the world: status and counts, never the text.
   *
   * Enough for the HUD counter, the badges and a panel deciding whether to
   * pull the document again (`rev`). `next` says why nothing is launching
   * right now, so a scheduler at rest is never a silence.
   */
  | {
      t: 'plan'; at: number; id: string; rev: number; status: PlanStatus; chair: ProviderId;
      counts: Record<TaskStatus, number>;
      /** Meeting questions still without an answer. */
      questions: number;
      /** Tasks stopped on a question for you. */
      asks: number;
      next: string | null;
      /**
       * The plan is not moving and should be: a task asks you, one failed,
       * the plan is paused, or nothing runs and something waits. `null` while
       * it works or has nothing to do. Decided in one place (`stallOf` in
       * `ceo/planDesk.ts`) for the HUD's warning and the desktop notice.
       */
      stall: PlanStall | null;
      meeting: 'idle' | 'thinking';
    }
  /**
   * Board or Reports was started over: drop everything of it but `keep`.
   *
   * An event and not a reply: every open window holds the same cards, and a
   * clean table in one of them with the old rows in another would be two
   * boards. `keep` names what survived -- the jobs still running, which
   * cannot be erased while a process works for them -- so the client drops
   * by difference and never has to guess which rows were meant.
   */
  | { t: 'ceo.cleared'; at: number; what: 'board' | 'jobs'; keep: string[] };

/** Why an approved plan is not moving. `needsYou`: only you can unblock it. */
export interface PlanStall {
  needsYou: boolean;
  /** At most `MAX_FIELD_CHARS`: it travels on the delta channel. */
  text: string;
}

/**
 * The state of a job.
 *
 * `failed` and not "done with an error": a job that died halfway has not
 * produced the outcome you had accepted, and showing it with the same check
 * mark as a successful one would be a lie at a glance.
 */
export type JobState = 'running' | 'done' | 'failed';

export type NoticeCode = 'permission_needed' | 'idle' | 'error' | 'compact';
export type CeoState = 'off' | 'starting' | 'idle' | 'thinking' | 'asking' | 'waiting' | 'error';

/**
 * The five analyses a CEO can run.
 *
 * A closed set and not a free string: each one decides what the brief has to
 * carry -- only `structure` is worth the project code -- and a typo in a free
 * string would silently buy the most expensive brief for the cheapest question.
 */
export type AnalysisKind = 'sessions' | 'development' | 'tokens' | 'structure' | 'quota';

/**
 * How deep to answer.
 *
 * It is not a style preference: it decides the MODEL and how much brief is
 * paid for, and is therefore the biggest lever on the cost of a question.
 * Three steps and not a slider, because between "fast" and "in-depth" the
 * choice is discrete -- there is no such thing as 37% in-depth.
 */
export type CeoDepth = 'fast' | 'standard' | 'deep';
export type PeerStatus = 'sent' | 'delivered' | 'held' | 'refused';
export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'applied';

/**
 * Which panel a CEO reply belongs to.
 *
 * `ceo.stream` is one channel per provider and used to say nothing about the
 * question it answers; two panels already guessed by "who is waiting", and a
 * third claimant (the planning meeting) would have made the guess wrong once
 * a day. The server knows who asked, so it says so.
 */
export type CeoSurface = 'board' | 'effect' | 'plan';

/* ─────────────────────────── planning ─────────────────────────── */

/**
 * The life of a plan.
 *
 * `drafting` while the meeting has produced no task yet; `proposed` once the
 * CEO has laid tasks on the table; `approved` is your yes, and the only status
 * the scheduler launches from; `paused` stops launches without forgetting
 * anything, and the meeting can go on; `done` when every task is done or
 * skipped.
 */
export type PlanStatus = 'drafting' | 'proposed' | 'approved' | 'paused' | 'done';

/**
 * The life of one task.
 *
 * `question` is a worker that stopped to ask you something: the project waits
 * for your answer, and the answer resumes the same session. `failed` also
 * stops the project -- there is no automatic retry, because a task retried
 * blindly burns quota on the same wall twice.
 */
export type TaskStatus = 'queued' | 'running' | 'question' | 'done' | 'failed' | 'skipped';
export type TaskSize = 'small' | 'medium' | 'large';
/**
 * How hard a task's model thinks, on its own tool's scale. `null` is the
 * tool's default: nothing is passed, and the tool decides.
 *
 * It was Codex's lever only until 2026-10-13, when the user asked to choose
 * it for Claude too: a Claude task ran at whatever Claude Code defaults to,
 * and the plan had no way to say "think harder on this one".
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Claude Code's `--effort` levels, lightest first, as the CLI names them. */
export const CLAUDE_EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** The levels of Codex's `model_reasoning_effort` that are passed: its stable scale. */
export const CODEX_EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];

/** A fleet's scale. Shared because the panel's select and the server's validation must agree. */
export function effortsFor(provider: ProviderId): readonly Effort[] {
  return provider === 'codex' ? CODEX_EFFORTS : CLAUDE_EFFORTS;
}

/**
 * What a worker may do in a project: with git, and on the web. `push`
 * implies `commit`: normalised on write.
 *
 * There is no `tests`: a worker always runs the tests (decision of the user,
 * 2026-09-19: "the tests must always run, the checkbox is not even needed").
 * What it may run to do so is the plan's `commands`.
 */
export interface GitRules {
  commit: boolean;
  push: boolean;
  /**
   * The worker may search and read the web. Off unless you tick it, and
   * absent when off: a plan saved before the box existed means no.
   *
   * Asked by the user on 2026-10-13, after two studies of one plan could not
   * look anything up. It is a rule of yours like the two above, never the
   * chair's: a page a worker reads is text from outside, in a session that
   * may commit and push.
   */
  web?: boolean;
}

/**
 * A project's test commands: at most this many, each at most this long.
 * Shared because the panel's field and the server's check must agree.
 */
export const MAX_PROJECT_COMMANDS = 16;
export const MAX_COMMAND_CHARS = 120;

/**
 * The Claude Code models a task can be handed to, as the CLI names them.
 *
 * Aliases and not full names, because the aliases are what stays stable; in
 * cost order, which is what the chair is told. Shared because the panel's
 * select and the server's validation must agree on the list.
 */
export const CLAUDE_MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const;

/** Percent of a quota window that must stay free for urgent work of your own. */
export interface Reserve {
  '5h': number;
  '7d': number;
}

/* Caps shared with the client, which enforces them before sending: an
   attachment refused on the wire would be refused with no reason to show. */
export const MAX_ATTACHMENT_CHARS = 65_536;
export const MAX_ATTACHMENTS_TOTAL_CHARS = 262_144;
export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_NAME_CHARS = 80;
/** The typed to-dos, all turns appended. */
export const MAX_TODO_CHARS = 16_000;
/** One turn of the meeting, from you. */
export const MAX_SAY_CHARS = 8000;
/** What the CEO writes for a worker: complete, but not a novel. */
export const MAX_BRIEFING_CHARS = 4000;
export const MAX_QUESTION_CHARS = 2000;
export const MAX_ANSWER_CHARS = 2000;
/**
 * A line of the minutes holds a whole turn of yours. At 2000 a to-do list of
 * 2690 chars reached the chair whole but showed cut in the minutes, and read
 * as a message that had been truncated.
 */
export const MAX_MINUTE_CHARS = MAX_SAY_CHARS;
export const MAX_PLAN_TASKS = 60;

export interface AttachmentMeta {
  id: string;
  name: string;
  chars: number;
  addedAt: number;
  /** The chair has it. Until then it goes with your next message. */
  sent: boolean;
}

/** One line of the minutes: who said it, and what. */
export interface Minute {
  at: number;
  role: 'user' | 'ceo' | 'system';
  text: string;
}

export interface MeetingQuestion {
  id: string;
  text: string;
  answer: string | null;
  /**
   * The chair has read this answer, as it is now. Answers reach the workers
   * only through the briefings the chair rewrites, so a plan approved over
   * an unread answer launched briefings written without it.
   */
  seen: boolean;
}

export interface PlanTask {
  id: string;
  /** Becomes `job.summary` on the delta channel: same cap, same name. */
  title: string;
  /** Written by the CEO for the worker. Never on the delta channel. */
  briefing: string;
  provider: ProviderId;
  model: string | null;
  effort: Effort | null;
  size: TaskSize;
  /** You changed provider, model or effort by hand: a later CEO turn keeps them. */
  pinned: boolean;
  status: TaskStatus;
  question: string | null;
  answer: string | null;
  /**
   * Commands the worker was refused and stopped for, as permission patterns.
   * An answer in words cannot grant them -- measured on decsim2: "option A"
   * resumed the worker into the same refusals, three attempts in a row -- so
   * the panel offers them to allow, and the session resumes with them.
   */
  needs: string[];
  /** Launches so far. The job id of an attempt is `${id}:${attempts}`. */
  attempts: number;
  jobId: string | null;
  /** The worker's own session, kept to resume it after an answer. */
  sessionId: string | null;
  /** The worker's one line, copied here so it outlives the job registry. */
  did: string | null;
  /** Weighted tokens of the last finished attempt: what the next one is expected to cost. */
  learned: number | null;
  reason: string | null;
}

export interface PlanProject {
  projectId: string;
  name: string;
  /** 1 is first. The array is kept sorted by it. */
  priority: number;
  git: GitRules;
  tasks: PlanTask[];
}

/**
 * The plan as the panel reads it.
 *
 * Attachments come back as names and sizes: the browser sent the text and
 * still holds it, and after a reload names and sizes are what you need to
 * recognise them. Everything else is the plan itself, briefings included --
 * it travels as a reply to `plan.read`, never on the delta channel.
 */
export interface PlanDoc {
  id: string;
  /** Bumped on every change; the delta carries it so the panel knows to pull. */
  rev: number;
  status: PlanStatus;
  chair: ProviderId;
  createdAt: number;
  updatedAt: number;
  depth: CeoDepth;
  todo: string;
  attachments: AttachmentMeta[];
  minutes: Minute[];
  questions: MeetingQuestion[];
  /** The CEO's last block said the plan is ready. Advisory: you can approve anyway. */
  ready: boolean;
  reserve: Record<ProviderId, Reserve>;
  parallel: number;
  /** Ask a second opinion on every task, as for a proposal. Off: it doubles the cost. */
  review: boolean;
  projects: PlanProject[];
  /**
   * Each project's own tests and checks, by project id, as permission
   * patterns (`npm test`, `php tests/*`): what the chair read in the
   * repository, what you added, what you allowed when a worker asked. A
   * worker is told to run them, and they are allow rules for the few calls
   * its sandbox does not approve by itself. Kept by project and not inside
   * a plan project, so a new plan starts with them: a permission given once
   * is not asked for again.
   */
  commands: Record<string, string[]>;
  /**
   * Each plan project's branch, read from the world when the document is
   * sent: where "push" goes, and `null` when the project is not under git --
   * then no worker commits or pushes there, whatever its rules say.
   */
  branches: Record<string, string | null>;
  /**
   * Sessions of yours that hold each plan project right now, by the
   * scheduler's own rule (working, waiting on you, or moved in the last five
   * minutes). No worker starts where this is above zero: the panel warns
   * before you approve.
   */
  active: Record<string, number>;
}

/**
 * How the minutes record the answers you sent: one line of yours, so the
 * record keeps them after the chair's next block retires the questions.
 * Shared because the panel recognises it to say "your answers were sent".
 */
export const ANSWERS_MINUTE_PREFIX = 'Answers to the chair\'s questions:';

/** How long a session of yours holds its project after its last move. Why five: `ceo/scheduler.ts`. */
export const HUMAN_GRACE_MS = 5 * 60_000;

/** One structured change from the panel. A closed set: the server decides if it is legal now. */
export type PlanPatch =
  | { kind: 'order'; order: string[] }
  | { kind: 'reserve'; provider: ProviderId; window: '5h' | '7d'; percent: number }
  | { kind: 'parallel'; parallel: number }
  | { kind: 'review'; review: boolean }
  | { kind: 'git'; projectId: string; rules: GitRules }
  /** The whole list, as the panel now shows it: one added, or one removed. */
  | { kind: 'commands'; projectId: string; commands: string[] }
  | { kind: 'task'; taskId: string; provider?: ProviderId; model?: string | null; effort?: Effort | null }
  | { kind: 'question'; id: string; text: string }
  | { kind: 'depth'; depth: CeoDepth }
  | { kind: 'chair'; chair: ProviderId };

/**
 * The five figures a project is looked at through, before and after a job.
 *
 * A closed set and ALWAYS all five: choosing which to show after seeing the
 * data would be choosing the metric that proved you right. The type lives
 * here and not in `ceo/` because this file is shared and cannot name the
 * folder that `check:passive` deletes.
 *
 * `output` and `calls` have no direction, and that is why the direction is a
 * separate table: fewer calls per turn can mean more efficiency or less work
 * done, and more output share of the weight can mean the quota is finally
 * going into produced tokens instead of re-reading context.
 */
export type EffectMetricId = 'cost' | 'yield' | 'cache' | 'output' | 'calls';

/** All five, always in this order: it is also the order on screen. */
export const EFFECT_METRICS: readonly EffectMetricId[] = [
  'cost', 'yield', 'cache', 'output', 'calls',
];

/**
 * Which side is better, when there is a side.
 *
 * `output` and `calls` are `none` on purpose, and the type declares it
 * instead of leaving it to whoever draws: fewer calls per turn can mean more
 * efficiency or less work done, and more output share of the weight can mean
 * the quota is finally going into produced tokens instead of re-reading
 * context. Painting one of the two readings green would be choosing for the
 * reader. It lives here, and not in the CEO module, because server and
 * client must read it the same way: two tables diverge at the first tweak.
 */
export const EFFECT_DIRECTION: Record<EffectMetricId, 'lower' | 'higher' | 'none'> = {
  cost: 'lower',
  yield: 'lower',
  cache: 'higher',
  output: 'none',
  calls: 'none',
};

/** What a figure is called when it is named to the reader. */
export const EFFECT_LABELS: Record<EffectMetricId, string> = {
  cost: 'cost per session',
  yield: 'weighted tokens per line',
  cache: 'cache read',
  output: 'output share of weight',
  calls: 'tool calls per turn',
};

/**
 * Below this change no verdict is pronounced.
 *
 * The number is always shown; it is the WORD -- "better", "worse" -- that is
 * held back, because two periods of work are never identical and a "+3%" on
 * every figure would fill the screen with movements that change no decision.
 * The same threshold the brief has always used to decide what is worth saying.
 */
export const EFFECT_NOISE_PERCENT = 15;

/**
 * How many sessions are needed per side, per figure, before showing a number.
 *
 * It lives in the contract and not in the CEO module because the panel must
 * be able to say "two more needed" with the same number the server uses to
 * decide to stay silent: two constants for the same threshold diverge, and
 * what would diverge is the sentence that explains a silence.
 */
export const EFFECT_MIN_COHORT = 3;

/** One figure before and after, with the cohort each one comes from. */
export interface EffectPair {
  /** `null` when there were not enough sessions: it is not a zero. */
  before: number | null;
  after: number | null;
  beforeN: number;
  afterN: number;
}

/**
 * How a project went after a job you accepted.
 *
 * It does not travel on the delta channel, and not out of caution: it is
 * about fifteen scalars per job, and the `job` event goes out again on every
 * tool call of the worker. Putting them there would mean recomputing five
 * medians every time a turret grows by one step. It is asked for with
 * `effect.read` and goes back to whoever asked, exactly like an outcome.
 */
export interface EffectItem {
  jobId: string;
  at: number;
  provider: ProviderId;
  kind: string;
  summary: string;
  /** The worker's line, already in Reports: here it tells WHAT was done. */
  workDid: string | null;
  workFounded: boolean | null;
  reviewHolds: boolean | null;
  projectName: string | null;
  state: 'waiting' | 'read' | 'void';
  /** Why it can be read, or why not yet. In English: it is shown on screen. */
  reason: string;
  metrics: Record<EffectMetricId, EffectPair>;
  beforeSessions: number;
  afterSessions: number;
  need: number;
  needFor: EffectMetricId | null;
  /**
   * The cost as a percentage of the subscription rate, for both columns.
   *
   * It is converted at READ time and never at freeze time: the conversion
   * uses the current quota window, and a percentage frozen last week would be
   * in a different currency. Either both on the same window, or neither: two
   * percentages on different windows placed side by side would read as a
   * comparison.
   */
  quotaBefore: number | null;
  quotaAfter: number | null;
  quotaWindow: string | null;
  closedAt: number | null;
  closedBy: 'time' | 'job' | 'enough' | null;
  /**
   * When the window will close on its own.
   *
   * The SERVER computes it, since it knows when it starts -- the end of the
   * job, not the moment you accepted -- and how long it lasts. Recomputing it
   * in the panel would mean copying `FOLLOW_DAYS` and its anchor into it,
   * that is, two numbers to keep aligned by hand in order to write one line
   * of text.
   */
  closesAt: number | null;
  /** The CEO tried to refute itself. `null` until you asked it to. */
  judged: { attributed: boolean; why: string; at: number } | null;
}

/* ─────────────────────────── frames ─────────────────────────── */

/** An analysis as whoever has to choose it sees it: a name and its question. */
export interface AnalysisOffer {
  kind: AnalysisKind;
  /** The name on the button. */
  title: string;
  /** The text that is sent, word for word. */
  question: string;
}

export interface Caps {
  statusline: boolean;
  ceo: boolean;
  /**
   * Which CEOs really exist.
   *
   * It cannot be derived from `ceo: true`: the Codex CEO exists only if Codex
   * is installed. And it must live in the CAPS and not in an event, because a
   * client that connects to an already-running world would never see an event
   * broadcast at startup -- it happened, and the panel stayed empty without
   * saying why.
   */
  ceoProviders: readonly ProviderId[];
  /**
   * The question each analysis actually sends, exactly as written.
   *
   * It travels because the panel PUTS IT IN THE TEXT BOX when you press the
   * button: it is read before paying for it, and it can be changed. It comes
   * from here and not from a copy in the client for the usual reason -- the
   * sentence is the one the server sends to the model, and two copies of the
   * same sentence diverge at the first edit. Empty when there are no CEOs:
   * there is no panel either, and in the version without CEOs this field
   * stays an empty list.
   */
  analyses: readonly AnalysisOffer[];
  execute: boolean;   // execute mode
  redactPaths: boolean;
  commitText: boolean;
  titles: boolean;
  /** The summary the session writes about itself. Turned off with --no-recap. */
  recap: boolean;
  cmdNames: boolean;
  /** The server can bring a session's terminal to the foreground. */
  focus: boolean;
  /** The planning meeting exists: only with the CEO module loaded. */
  plan: boolean;
}

/**
 * A rate-limit window.
 *
 * The two windows do not share the reset instant -- the short one restarts
 * several times a day, the long one once a week -- so each carries its own,
 * instead of a single `resetsAt` that would be true for one of the two and
 * wrong for the other.
 */
export interface RateWindow {
  /** What it is called on screen: `5h`, `7d`, or whatever the tool declares. */
  label: string;
  /** How much of it you have consumed, from 0 to 100. */
  usedPercent: number;
  /** Span in minutes: 300 is five hours, 10080 a week. */
  windowMinutes: number;
  /**
   * The model this limit is tied to, when it declares one.
   *
   * A plan can count a specific model's hours separately -- and then two
   * windows have the same span and different percentages. Without this field
   * they would be two identical bars, one of which lies: the model's name is
   * the only thing that tells them apart.
   */
  model: string | null;
  /** When it restarts from zero, in milliseconds. */
  resetsAt: number | null;
}

/**
 * Limits apply to the ACCOUNT, not to the session: two sessions of the same
 * tool consume the same quota, so there is one state per provider and not
 * one per building.
 */
export interface ProviderLimits {
  provider: ProviderId;
  /** When we saw them: stale data must be said to be stale, not passed off as current. */
  at: number;
  /**
   * All the windows the tool declares, in the order they arrive.
   *
   * It is a LIST and not two fixed fields on purpose: today there are two for
   * both tools, but if a third showed up tomorrow -- per model, per plan, per
   * anything -- with two fixed fields it would be silently discarded, and
   * nobody would notice.
   */
  windows: RateWindow[];
  /** The plan, when the tool says it. `null` when it does not. */
  plan: string | null;
}

export interface Snapshot {
  at: number;
  /** Quota consumed per tool. Empty until anything is known. */
  limits: ProviderLimits[];
  projects: ProjectInfo[];
  sessions: SessionInfo[];
  agents: AgentInfo[];
  files: FileNode[];
  recent: DeltaEvent[];
  /**
   * The git events that stand on the towers: the last hour's, each once, at
   * most a dozen per project (`shared/rings.ts`). In the snapshot so that a
   * page opened at any moment rebuilds the same rings.
   */
  rings?: Extract<DeltaEvent, { t: 'git' }>[];
}

export type ServerFrame =
  | { t: 'hello'; v: number; serverTime: number; caps: Caps }
  | ({ t: 'snapshot' } & Snapshot)
  | { t: 'batch'; at: number; seq: number; events: DeltaEvent[] }
  | {
      t: 'stats'; at: number; lps: number; dropped: number; badLines: number;
      unknownTypes: Record<string, number>;
    }
  | {
      t: 'ceo.stream'; at: number; provider: ProviderId; delta: string; done: boolean;
      /** Which panel asked. The server knows; the client no longer guesses. */
      surface: CeoSurface;
    }
  | { t: 'focus.result'; sessionId: string; ok: boolean; reason: string | null }
  /**
   * A job's outcome, in full.
   *
   * It goes back to whoever asked and not to everyone, like a CEO's answer:
   * it is prose written by a model, and it neither fits nor belongs on the
   * delta channel. `truncated` says the ledger had already cut it.
   */
  | {
      t: 'job.outcome'; id: string; text: string; truncated: boolean;
      /** What whoever works there thinks of it. `null` when nobody asked them. */
      review: string | null; reviewTruncated: boolean;
    }
  /**
   * What came of `job.watch` or `job.open`: a window opened, or why not.
   *
   * To whoever clicked, like `focus.result`. `reason` is a sentence for the
   * button's tooltip, never a path.
   */
  | { t: 'job.result'; id: string; action: 'watch' | 'open'; ok: boolean; reason: string | null }
  /**
   * A proposal's task, in full, to whoever asked: what its worker will be told.
   *
   * The card used to show a summary and, on hover, 127 characters of a task
   * of up to a thousand that a model wrote -- after reading repositories
   * anyone may have written into. The rest ran unread on a yes.
   */
  | { t: 'proposal.task'; id: string; task: string | null; project: string | null }
  /**
   * How it went afterwards, for all jobs. To whoever asked.
   *
   * Like `job.outcome`: it is pulled, not pushed. The recomputation is lazy,
   * and this request is the gesture that triggers it.
   */
  | { t: 'effect.board'; at: number; items: EffectItem[] }
  /**
   * The whole plan, to whoever asked for it or just changed it.
   *
   * Pulled, like an outcome: briefings are thousands of characters and the
   * delta channel carries metadata. `refused` names the change that was not
   * legal in the plan's current state -- an `error` frame would read as a
   * dropped connection on screen.
   */
  | { t: 'plan.doc'; at: number; plan: PlanDoc; refused: string | null }
  | { t: 'reveal.result'; projectId: string; ok: boolean; reason: string | null }
  | { t: 'terminal.result'; projectId: string; ok: boolean; reason: string | null }
  /** A project's work, to whoever opened its card. `null`: no such project. */
  | { t: 'work.result'; projectId: string; work: ProjectWork | null }
  | { t: 'error'; code: 'version_mismatch' | 'unauthorized' | 'internal'; detail?: string };

export type ClientFrame =
  | { t: 'hello'; v: number }
  | { t: 'ping'; at: number }
  | { t: 'resync' }
  /**
   * Brings this session's terminal to the foreground. ONLY the id travels:
   * the server resolves the PID, so nothing arriving from the client can
   * reach a command. Accepted only if `caps.focus`.
   */
  | { t: 'focus'; sessionId: string }
  /** What to call a project on screen. `name: null` goes back to the real name. */
  | { t: 'project.alias'; projectId: string; name: string | null }
  /** Take it out of view or put it back. Deletes nothing: it is always reversible. */
  | { t: 'project.disabled'; projectId: string; disabled: boolean }
  /** Brings everything back into view: the way out of an accidental "hide". */
  | { t: 'project.showAll' }
  /**
   * Opens the project's folder in the file manager.
   *
   * It answers "what was this?" for a project idle for months, whose name
   * alone no longer says anything. As with `focus`, only the id travels: the
   * server resolves the path on its own model.
   */
  | { t: 'project.reveal'; projectId: string }
  /**
   * Opens a Terminal window in the project's folder: the click on a project
   * nobody works on, where the next session is one `claude` or `codex` away.
   * Only the id travels, as for `project.reveal`. Accepted only if `caps.focus`.
   */
  | { t: 'project.terminal'; projectId: string }
  /**
   * A project's tokens and hours, month by month: pulled when its card
   * opens, never pushed. Reading them can mean reading transcripts, and
   * nobody needs them until they look.
   */
  | { t: 'project.work'; projectId: string }
  /* ── organization: accepted only if caps.ceo ── */
  /**
   * A question to one CEO.
   *
   * `analysis` is not a shortcut for typing: it is what tells the server which
   * brief to build. A free question gets the cheap brief, because guessing that
   * it needs the project code would buy the expensive one every time.
   */
  | {
      t: 'ceo.say'; provider: ProviderId; text: string;
      analysis: AnalysisKind | null; depth: CeoDepth;
    }
  /** The same question to both fleets. Two answers, never one merged for you. */
  | {
      t: 'meeting'; kind: 'ceo' | 'lead' | 'plenary'; with: string[];
      topic: string; analysis: AnalysisKind | null; depth: CeoDepth;
    }
  | { t: 'proposal.decide'; id: string; accept: boolean }
  /** Let me read how it went. Only the id travels: the text stays on the server. */
  | { t: 'job.read'; id: string }
  /** The full task of a proposal: the card asks before it lets you accept. */
  | { t: 'proposal.read'; id: string }
  /**
   * I have seen it: remove the turret.
   *
   * Closes the job on screen, does not delete it -- the outcome stays in
   * Reports. It is the only way a finished turret goes away: disappearing on
   * its own would mean losing a result while you were looking elsewhere.
   */
  | { t: 'job.dismiss'; id: string }
  /**
   * Start Board or Reports over: the same two clicks as `plan.reset`.
   *
   * Board loses its reports and proposals, and a question being answered
   * there is stopped. Reports loses every job but those still running. What
   * goes is archived on disk, not deleted; what the CEOs remember stays.
   */
  | { t: 'board.reset' }
  | { t: 'jobs.reset' }
  /**
   * Erase ONE job from Reports, for good (no archive copy: the single
   * erasure is the point). A running job is refused. Everyone is told with a
   * `ceo.cleared` whose `keep` is every job that remains.
   */
  | { t: 'job.delete'; id: string }
  /**
   * Erase the outcome (the measure) of one job, or of every job. The jobs
   * stay in Reports; the Outcomes panel gets the board again.
   */
  | { t: 'effect.delete'; id: string }
  | { t: 'effects.reset' }
  /**
   * Open a window with everything the job's session did, read-only.
   *
   * The same window a click on a worker's astronaut opens, but reachable
   * after the session is over -- when the astronaut is back aboard and the
   * transcript is the only trace of a task that took an hour. Only the id
   * travels: session, folder and, if still alive, the pid come from the
   * server's own records. Accepted only if `caps.focus`.
   */
  | { t: 'job.watch'; id: string }
  /**
   * Open the `index`-th document the worker wrote (`job.workWrote`).
   *
   * An index and not a path: the path is the ledger's, and the server checks
   * it against the project folder before anything opens. Accepted only if
   * `caps.focus`.
   */
  | { t: 'job.open'; id: string; index: number }
  /** How it went afterwards. No id: the whole board, with a single recomputation. */
  | { t: 'effect.read' }
  /**
   * Ask the CEO to try to refute the attribution.
   *
   * It starts from a click and never on its own, because it costs a whole
   * preamble. The question it receives is not "did it work" -- to that the
   * zero-cost answer is yes -- but "what else explains these numbers".
   */
  | { t: 'effect.judge'; id: string }
  /* ── the planning meeting: accepted only if caps.plan ── */
  /** One turn of the meeting, from you. Text only: chair and depth are set with `plan.set`. */
  | { t: 'plan.say'; text: string }
  /**
   * A file you chose, read by the browser and sent as text.
   *
   * The server opens nothing: the allow-list stays as it is, and what the CEO
   * gets to read is exactly what you handed over.
   */
  | { t: 'plan.attach'; name: string; text: string }
  | { t: 'plan.detach'; id: string }
  | { t: 'plan.set'; patch: PlanPatch }
  | { t: 'plan.approve' }
  | { t: 'plan.pause' }
  | { t: 'plan.resume' }
  /** Launch the next task now, without waiting for the tick. */
  | { t: 'plan.launch' }
  | { t: 'plan.answer'; taskId: string; text: string }
  /** Allow the commands a worker stopped for, in its project, and resume it. */
  | { t: 'plan.allow'; taskId: string }
  | { t: 'plan.retry'; taskId: string }
  | { t: 'plan.skip'; taskId: string }
  | { t: 'plan.read' }
  /** Start over. The old plan is archived, not deleted. */
  | { t: 'plan.reset' };
