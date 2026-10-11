import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AnalysisKind, CeoDepth, CeoState, DeltaEvent, ProviderId, RateWindow, Snapshot,
} from '../../shared/protocol.ts';
import type { HistoryDigest } from '../state/history.ts';
import { analysisOf, contractFor, DEPTHS, effortFor, modelFor } from './analyses.ts';
import { buildBrief, HISTORY_DAYS } from './brief.ts';
import type { BriefNote } from './brief.ts';
import type { ProjectRoot } from './brief.ts';
import { OUTCOME_FENCE, parseOutcome } from './outcome.ts';
import type { CeoOutcome } from './outcome.ts';
import { quotaShare, formatShare } from './quota.ts';
import type { QuotaShare } from './quota.ts';
import { weigh } from './spend.ts';
import type { CallUsage, SpendLedger } from './spend.ts';

/**
 * The process that answers: `claude -p` or `codex exec`.
 *
 * One of the two places in the program that start a process talking to the
 * outside; the other is `fleet.ts`, for workers and second opinions. The
 * per-call cap (`--ceo-max-call`) holds only here: the fleet's processes are
 * full sessions, held by the reserve and by their time ceilings instead. A
 * third place that spawns would be held by nothing.
 *
 * Three rules come from measurements, not opinions:
 *
 *  1. THE COMMAND LINE NEVER CHANGES. Tried: changing the system prompt
 *     between two calls, `cache_read` went from 18531 to 0 and the cost went
 *     up. Everything that varies -- brief and question -- goes in the user
 *     message, which travels on stdin.
 *  2. THE WORKING DIRECTORY DOES NOT CHANGE EITHER. Run inside a project, the
 *     CLI would pick up its CLAUDE.md and the preamble would change with every
 *     question, with the same effect on the cache. We run in a dedicated,
 *     neutral folder.
 *  3. DO NOT TRY TO SAVE BY DENYING TOOLS. Tried: `--disallowed-tools` leaves
 *     all 54 tools defined in the preamble, so it does not remove a single
 *     token. It serves to stop the CEO from acting, not to make it cheaper.
 *
 * Rule 1 has one reading that matters now that the CEO can read code: the
 * perimeter goes on the command line as `--add-dir`, and it is recomputed on
 * every call. That does not break rule 1, it obeys it -- the flags stay byte
 * for byte identical as long as your set of live projects does, which is the
 * steady state. Pinning the list at construction would be the worse trade: a
 * project you disabled an hour ago would stay readable for the rest of the run.
 *
 * The planning meeting (`converse`) is a fourth kind of call, with its own
 * system prompt, and it is the one place where the command line moves on
 * purpose: `--session-id` on the first turn, `--resume <id>` after. It obeys
 * rule 1 the way the three depths do -- three models are three caches -- and
 * inside the meeting the argv changes only by the id, which names the SAME
 * conversation; its cache lives in that conversation, and the CLI records the
 * system prompt on the first turn and reuses it on every resume. Re-sending
 * the whole meeting through the analyst path instead would pay the code the
 * chair read again on every turn.
 */

/**
 * Time decides when a process is STUCK, not when it has worked too much.
 *
 * Three minutes used to be the whole call, and before the per-call brake it
 * was the only brake there was. Measured on a `structure` analysis at
 * `standard`: it read files across six repositories for three minutes, one
 * event every 1 to 43 seconds, and was killed at 180s without a line of text
 * -- 194k weighted tokens paid for "No answer.". How much work is too much is
 * now the brake's call, in money; time only catches silence, plus a ceiling
 * for the day both of them miss something.
 */
const SILENCE_MS = 180_000;
const CEILING_MS = 10 * 60_000;
/** A longer reason does not fit on a plate: it is a message, not a log. */
const MAX_REASON = 120;

/**
 * Who the CEO is, said once.
 *
 * In the system prompt and not in the brief because the system prompt is the
 * part that must NEVER change: it is what keeps the cache standing.
 */
const SYSTEM_PROMPT = [
  'You are one of the two CEOs of Towerglow, an observatory of agentic coding sessions.',
  'You receive a snapshot of the world state and a question from the user.',
  'Answer ONLY from what the snapshot shows. If a number is not there, say so instead of estimating it.',
  'You are an analyst: count, compare, point at what is being wasted. No preamble, no courtesy lists.',
  // At the end and not in the middle, and repeated: measured on a real call,
  // with the instruction buried halfway the model answered in Italian anyway.
  // The product speaks English, and a CEO's answer is product.
  'Answer in English, short, with numbers wherever there are any.',
  'Write the answer in English even if the question, the data or any other',
  'instruction is in another language. This is not negotiable.',
].join(' ');

/** What a finished call produced, whether or not it honoured the contract. */
export interface CeoResult {
  analysis: AnalysisKind | null;
  depth: CeoDepth;
  /** The model that actually answered: it depends on the rung. */
  model: string | null;
  outcome: CeoOutcome | null;
  costUsd: number;
  /**
   * What it cost as a percentage of your subscription rate.
   *
   * It is the measure that counts on a subscription, where you do not pay per
   * token: the dollars of `costUsd` are a list-price equivalent, this is a
   * real quota being consumed. `null` when there is not enough history to
   * derive it, instead of a made-up number.
   */
  share: QuotaShare | null;
  /** False when the call produced no text at all: nothing worth stamping a report on. */
  hadText: boolean;
}

export interface CeoRunnerOptions {
  provider: ProviderId;
  /** The middle rung of the ladder: `--ceo-model`, normally `sonnet`. */
  model: string;
  /** The Codex model, when you declared one. `null` = its own. */
  codexModel: string | null;
  stateDir: string;
  ledger: SpendLedger;
  snapshot: () => Snapshot;
  /** The repositories this call may read. Asked for on every call, on purpose. */
  perimeter: () => readonly ProjectRoot[];
  /** Two periods compared: history arrives already folded, never as a series. */
  history: (days: number) => HistoryDigest;
  /** What this CEO already knows. One line per thing known, never a text. */
  memory: () => readonly BriefNote[];
  /** The weighted tokens burned in a window: the denominator of the quota. */
  weightedSince: (provider: ProviderId, since: number, now: number) => number;
  /** A state change to send to everyone: it is a fact of the world. */
  onState: (event: Extract<DeltaEvent, { t: 'ceo' }>) => void;
  /** An analysis that finished. The desk turns it into `report` and `proposal`. */
  onResult: (result: CeoResult) => void;
  /** The quota as the CLI read it on this call's own responses: see `readQuota`. */
  onQuota?: (windows: RateWindow[]) => void;
  /** How a process is started. Injected, as in `fleet.ts`: tests never launch a model. */
  spawn?: typeof spawn;
  /** The two clocks, injected so a test does not wait ten minutes. */
  silenceMs?: number;
  ceilingMs?: number;
}

/** What one line of CLI output carries. */
export interface Piece {
  text: string;
  costUsd: number | null;
  /** True when the line comes from the model at work, not from the CLI starting up. */
  fromModel: boolean;
  /** Usage with no identity (Codex turns): added up. */
  usage: CallUsage | null;
  /** Usage of one Claude message, repeated on every block of it. */
  message: { id: string; usage: CallUsage } | null;
  /** Thinking tokens the CLI estimates while they stream. */
  thinking: number;
  /** The whole call, from `result`: it beats every estimate. */
  total: CallUsage | null;
  /**
   * The session or thread this call runs in, when the line names it.
   *
   * Claude says it on `system/init` and on `result`; Codex on `thread.started`.
   * It is what a later turn resumes, so a meeting can go on where it stopped.
   */
  sessionId: string | null;
  /** The quota windows a `rate_limit_event` carries, when this line is one. */
  quota: RateWindow[] | null;
}

const NOTHING: Piece = {
  text: '', costUsd: null, fromModel: false, usage: null, message: null, thinking: 0, total: null,
  sessionId: null, quota: null,
};

/** The windows a Claude `rate_limit_event` names, as the status line names them. */
const QUOTA_WINDOWS: Record<string, { label: string; minutes: number; model: string | null }> = {
  five_hour: { label: '5h', minutes: 300, model: null },
  seven_day: { label: '7d', minutes: 10_080, model: null },
  seven_day_opus: { label: '7d', minutes: 10_080, model: 'opus' },
  seven_day_sonnet: { label: '7d', minutes: 10_080, model: 'sonnet' },
};

function quotaWindow(key: string, utilization: unknown, resetsAt: unknown): RateWindow | null {
  const known = QUOTA_WINDOWS[key];
  if (!known || typeof utilization !== 'number' || !Number.isFinite(utilization)) return null;
  return {
    label: known.label,
    // A fraction, where the status line gives a percentage. Above 1 is
    // overage: the bar is full either way.
    usedPercent: Math.max(0, Math.min(100, utilization * 100)),
    windowMinutes: known.minutes,
    model: known.model,
    // Epoch seconds, like the status line's `resets_at`.
    resetsAt: typeof resetsAt === 'number' && resetsAt > 0 ? resetsAt * 1000 : null,
  };
}

/**
 * The quota, read from the call itself.
 *
 * Claude Code in stream-json prints a `rate_limit_event` whenever the limits
 * its responses carry change: `unifiedWindows` holds the 5h and the 7d as
 * fractions, and the top level names the window that binds. It is the only
 * reading that moves while nobody is typing -- the status line draws only in
 * an interactive session. Measured on the field (2026-09-18): three workers
 * emptied the 5h window in seventeen minutes, and the last reading the server
 * had was from 21:20, at 5%, taken before they started.
 */
export function readQuota(info: unknown): RateWindow[] | null {
  if (!info || typeof info !== 'object') return null;
  const o = info as Record<string, unknown>;
  const out: RateWindow[] = [];
  const unified = o['unifiedWindows'];
  if (unified && typeof unified === 'object') {
    for (const [key, raw] of Object.entries(unified as Record<string, unknown>)) {
      const w = raw as { utilization?: unknown; resetsAt?: unknown } | null;
      const win = w ? quotaWindow(key, w.utilization, w.resetsAt) : null;
      if (win) out.push(win);
    }
  }
  // Without the per-window map, the one window the event is about.
  if (out.length === 0 && typeof o['rateLimitType'] === 'string') {
    const win = quotaWindow(o['rateLimitType'], o['utilization'], o['resetsAt']);
    if (win) out.push(win);
  }
  return out.length > 0 ? out : null;
}

/**
 * Which conversation a call belongs to.
 *
 * `fresh` is an id WE mint (`--session-id`), so it is known before the
 * process starts and nothing has to be parsed to remember it; `resume` is one
 * a previous turn left. Both null is the analyst's ordinary call, which has no
 * past and wants none.
 */
export interface Session {
  resume: string | null;
  fresh: string | null;
}

const NO_SESSION: Session = { resume: null, fresh: null };

/** What a turn of a conversation needs beyond the prompt. */
export interface ConverseOptions {
  model: string | null;
  effort: string | null;
  session: Session;
  /** The system prompt of this conversation. Claude only; Codex reads its role in the prompt. */
  system: string;
  /** The id the CLI reports, as soon as it does. */
  onSession: (id: string) => void;
  /** The whole answer, once: the caller reads the block out of it. */
  onText: (full: string) => void;
}

/** How a call ended, for a caller that must decide what to do next. */
export interface CallEnd {
  text: string;
  /** Why it produced nothing, or null when it answered. */
  failed: string | null;
  /**
   * Who ended a failed call. `refused`: it never started (the quota gate, a
   * call already running). `stopped`: we killed it (the brake, silence, the
   * ceiling) after it ran, so its prompt is in the session. Absent: the
   * tool's own error, the only one that can mean a session it will not
   * resume -- the meeting restarted from the minutes on ANY failure, and a
   * turn stopped by the brake would have paid for a second one.
   */
  cause?: 'refused' | 'stopped';
}

/**
 * The tokens of one call, while it runs.
 *
 * `stream-json` splits every reply into one event per block -- thinking, each
 * tool_use, the text -- and repeats the SAME usage on each, with the
 * `output_tokens` of the moment the message started. Measured: two turns
 * declared 1 and 2 output tokens on a call whose `result` counted 282, and
 * the three blocks of the first turn carried identical input and cache.
 * Adding them up counted the context once per block: the structure analysis
 * killed at 180s went into the ledger at 485k weighted tokens, and its
 * transcript declares 194k. The world parser learned the same lesson
 * (`claim(requestId)` in `parse/tools.ts`); this one had not.
 *
 * So: a message's input is taken once, the output comes from the thinking
 * estimates the CLI itself sends, and once `result` arrives it is the only
 * number that counts.
 */
export class CallMeter {
  #messages = new Map<string, CallUsage>();
  #loose: CallUsage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  #thinking = 0;
  #total: CallUsage | null = null;

  add(piece: Piece): void {
    if (piece.total) this.#total = piece.total;
    this.#thinking += piece.thinking;
    if (piece.usage) {
      this.#loose.in += piece.usage.in;
      this.#loose.out += piece.usage.out;
      this.#loose.cacheRead += piece.usage.cacheRead;
      this.#loose.cacheWrite += piece.usage.cacheWrite;
    }
    if (piece.message) {
      const { id, usage } = piece.message;
      const seen = this.#messages.get(id);
      // Field by field the larger: the same usage repeated does not grow.
      this.#messages.set(id, seen ? {
        in: Math.max(seen.in, usage.in),
        out: Math.max(seen.out, usage.out),
        cacheRead: Math.max(seen.cacheRead, usage.cacheRead),
        cacheWrite: Math.max(seen.cacheWrite, usage.cacheWrite),
      } : { ...usage });
    }
  }

  get usage(): CallUsage {
    if (this.#total) return this.#total;
    const sum = { ...this.#loose, out: this.#loose.out + this.#thinking };
    for (const u of this.#messages.values()) {
      sum.in += u.in;
      sum.out += u.out;
      sum.cacheRead += u.cacheRead;
      sum.cacheWrite += u.cacheWrite;
    }
    return sum;
  }
}

/** Where the pieces of an answer go. It changes with every question. */
export type ReplyChannel = (delta: string, done: boolean) => void;

function clip(text: string): string {
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text;
}

export class CeoRunner {
  #opts: CeoRunnerOptions;
  #state: CeoState = 'idle';
  #child: ChildProcess | null = null;
  /** Stops the call in flight with a reason, as the brake does. Null between calls. */
  #halt: ((reason: string) => void) | null = null;
  #cwd: string;
  /**
   * Who is listening to the answer.
   *
   * Re-attached on every question instead of being fixed at construction: the
   * answer goes to WHOEVER ASKED, not to a broadcast. Two windows open on the
   * same world must not read each other's conversations.
   */
  #reply: ReplyChannel = () => {};

  constructor(opts: CeoRunnerOptions) {
    this.#opts = opts;
    this.#cwd = path.join(opts.stateDir, 'ceo', opts.provider);
    try {
      fs.mkdirSync(this.#cwd, { recursive: true, mode: 0o700 });
    } catch {
      // If it cannot be created, the spawn will fail with a clear message of its own.
    }
  }

  setReplyChannel(reply: ReplyChannel): void {
    this.#reply = reply;
  }

  get state(): CeoState {
    return this.#state;
  }

  get busy(): boolean {
    return this.#child !== null;
  }

  #setState(state: CeoState, reason: string | null = null): void {
    this.#state = state;
    this.#opts.onState({
      t: 'ceo',
      at: Date.now(),
      provider: this.#opts.provider,
      state,
      target: null,
      reason: reason === null ? null : clip(reason),
    });
  }

  /**
   * One question. Returns when the answer is finished.
   *
   * Never throws: a CEO that blows up must not take the server down with it.
   * Every failure becomes an `error` state with the reason written out,
   * because a silent CEO is indistinguishable from a broken one.
   *
   * `analysis` decides what the brief carries, never what the model is allowed
   * to do: the tools it holds are the same for all five, so a mislabelled
   * question costs a worse brief and nothing else.
   */
  async ask(
    question: string,
    analysis: AnalysisKind | null = null,
    // `fast` and not `standard`: it is the rung we start on, and a parameter's
    // default must be the same one the interface picks, or two paths to the
    // same question would cost differently.
    depth: CeoDepth = 'fast',
    /*
     * A different contract, and the raw text to whoever asked for it.
     *
     * It touches NEITHER the command line NOR the working directory: only the
     * message on stdin varies, which is the one thing that can change without
     * zeroing the prompt cache -- measured, and that is where the rule comes
     * from.
     *
     * `contract` REPLACES the standard one instead of adding a second one:
     * two specifications of the same fenced block, in the same question, are
     * a sure way to get a block that honours neither. `onText` exists because
     * `CeoResult` does not carry the text, and without it the desk would have
     * to keep a "the next answer is a judgement" state -- which, with two
     * questions in flight, would say the wrong thing.
     */
    extra: { contract?: string; onText?: (full: string) => void } = {},
  ): Promise<void> {
    if (this.#child) {
      this.#reply('Already answering a question.', true);
      return;
    }

    const now = Date.now();
    const snapshot = this.#opts.snapshot();

    // The gate, BEFORE spending anything at all.
    const blocked = this.#opts.ledger.blockedReason(this.#opts.provider, snapshot.limits, now);
    if (blocked) {
      this.#setState('off', blocked);
      this.#reply(`Stopped: ${blocked}.`, true);
      return;
    }

    const chosen = analysisOf(analysis);
    const rung = DEPTHS[depth];
    const model = modelFor(this.#opts.provider, depth, this.#opts.model, this.#opts.codexModel);
    const effort = effortFor(this.#opts.provider, depth);
    // The perimeter always reaches the command line; it reaches the BRIEF only
    // where it can be used. Listing repositories to a question about token
    // waste would only invite reads that answer nothing and are paid for.
    // At `deep` it is declared anyway: you asked to go to the bottom of it,
    // and reading the code is what that means.
    const perimeter = this.#opts.perimeter();
    const brief = buildBrief(snapshot, {
      provider: this.#opts.provider,
      now,
      perimeter: chosen?.code || rung.code ? perimeter : [],
      history: this.#opts.history(HISTORY_DAYS),
      memory: this.#opts.memory(),
      budget: rung.briefChars,
      maxSessions: rung.sessions,
    });
    const asked = chosen ? `${chosen.question}\n\n${question}`.trim() : question;
    const prompt = `${brief}\n\n# Question\n${asked}\n\n${extra.contract ?? contractFor(depth)}\n`;

    this.#setState('starting');
    try {
      await this.#run(prompt, perimeter, analysis, depth, model, effort, now, extra.onText);
    } catch (err) {
      this.#setState('error', String((err as Error)?.message ?? 'unknown error'));
      this.#reply('', true);
    } finally {
      this.#child = null;
      if (this.#state !== 'error' && this.#state !== 'off') this.#setState('idle');
      this.#opts.ledger.save();
    }
  }

  /**
   * One turn of a conversation that remembers the previous ones.
   *
   * The planning meeting: no brief, because the chair has the whole meeting
   * in its own context, and no report, because the block it ends with is a
   * plan and not a list of proposals -- the caller reads it from `onText`.
   * The gate on quota is the same as for any question: a meeting is paid
   * with the same windows.
   */
  async converse(prompt: string, o: ConverseOptions): Promise<CallEnd> {
    if (this.#child) {
      this.#reply('Already answering a question.', true);
      return { text: '', failed: 'already answering a question', cause: 'refused' };
    }
    const now = Date.now();
    const blocked = this.#opts.ledger.blockedReason(this.#opts.provider, this.#opts.snapshot().limits, now);
    if (blocked) {
      this.#setState('off', blocked);
      this.#reply(`Stopped: ${blocked}.`, true);
      return { text: '', failed: blocked, cause: 'refused' };
    }
    if (o.session.fresh) o.onSession(o.session.fresh);

    this.#setState('starting');
    try {
      return await this.#run(
        prompt, this.#opts.perimeter(), null, 'standard', o.model, o.effort, now, o.onText,
        { system: o.system, session: o.session, onSession: o.onSession, report: false },
      );
    } catch (err) {
      const reason = String((err as Error)?.message ?? 'unknown error');
      this.#setState('error', reason);
      this.#reply('', true);
      return { text: '', failed: reason };
    } finally {
      this.#child = null;
      if (this.#state !== 'error' && this.#state !== 'off') this.#setState('idle');
      this.#opts.ledger.save();
    }
  }

  /**
   * Stops the call in flight, if there is one.
   *
   * Through the same door as the brake: a call you stopped is not an error.
   * A bare kill left the plate on "error: claude exited" after you started
   * the meeting over, which reads like the CEO had broken.
   */
  stop(reason = 'stopped'): void {
    if (this.#halt) this.#halt(reason);
    else this.#child?.kill('SIGTERM');
  }

  #command(
    perimeter: readonly ProjectRoot[],
    model: string | null,
    effort: string | null,
    system: string = SYSTEM_PROMPT,
    session: Session = NO_SESSION,
  ): { bin: string; args: string[] } {
    if (this.#opts.provider === 'codex') {
      if (session.resume) {
        // `resume` takes neither `-s` nor `-C`: the sandbox goes through the
        // config override, and the cwd is the one the process is spawned in.
        return {
          bin: 'codex',
          args: [
            'exec', 'resume', session.resume, '--json',
            ...(model ? ['-m', model] : []),
            ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
            '-c', 'sandbox_mode="read-only"',
            '--skip-git-repo-check',
            '-',
          ],
        };
      }
      return {
        bin: 'codex',
        args: [
          'exec', '--json',
          // Without a declared model no `-m` is passed: Codex uses its own.
          // Passing it a Claude alias -- which is what used to happen,
          // `-m sonnet` -- makes the spawn fail.
          ...(model ? ['-m', model] : []),
          // Depth, for Codex, is the reasoning effort on the same model: it
          // is its own scale, and a stable one -- unlike model names, which
          // belong to another vendor.
          ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
          // Read-only: in phase 2 the CEO answers, it does not act.
          // The read-only sandbox already lets it read the repositories, so
          // Codex needs no equivalent of --add-dir: what it must not do is
          // write, and that is exactly what this flag stops.
          '-s', 'read-only',
          '--skip-git-repo-check',
          '-C', this.#cwd,
          '-',
        ],
      };
    }
    const dirs: string[] = [];
    // One flag per directory rather than one variadic flag: a variadic option
    // would swallow whatever came after it, and the order of this array is not
    // something a future edit should have to remember.
    for (const r of perimeter) dirs.push('--add-dir', r.root);
    return {
      bin: 'claude',
      args: [
        '-p',
        '--output-format', 'stream-json',
        '--verbose', // stream-json requires it
        ...(model ? ['--model', model] : []),
        '--system-prompt', system,
        // It saves nothing (measured), but it prevents acting: in phase 2 the
        // CEO has nothing to execute, and what it cannot do it cannot get wrong.
        // Read, Glob and Grep survive on purpose: the structural analysis is
        // the one that needs the code, and reading is the whole of it.
        '--disallowed-tools',
        'Bash,Edit,Write,MultiEdit,NotebookEdit,Task,Agent,WebFetch,WebSearch,TodoWrite',
        '--disable-slash-commands',
        // No MCP server of yours either: the brief carries text that came from
        // outside (titles, recaps, file names), and a tool you once allowed in
        // your settings would be one an injected sentence could call.
        '--strict-mcp-config',
        // A conversation: the id is ours on the first turn, resumed after.
        ...(session.resume ? ['--resume', session.resume] : []),
        ...(session.fresh ? ['--session-id', session.fresh] : []),
        ...dirs,
      ],
    };
  }

  #run(
    prompt: string,
    perimeter: readonly ProjectRoot[],
    analysis: AnalysisKind | null,
    depth: CeoDepth,
    model: string | null,
    effort: string | null,
    startedAt: number,
    onText?: (full: string) => void,
    talk: { system: string; session: Session; onSession: (id: string) => void; report: boolean } | null = null,
  ): Promise<CallEnd> {
    const { bin, args } = this.#command(
      perimeter, model, effort, talk?.system, talk?.session,
    );

    return new Promise<CallEnd>((resolve) => {
      let child: ChildProcess;
      try {
        child = (this.#opts.spawn ?? spawn)(bin, args, { cwd: this.#cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        const reason = `cannot start ${bin}: ${String((err as Error)?.message)}`;
        this.#setState('error', reason);
        this.#reply('', true);
        resolve({ text: '', failed: reason });
        return;
      }
      this.#child = child;

      let carry = '';
      let full = '';
      let sent = 0;
      let costUsd = 0;
      let stderr = '';
      const meter = new CallMeter();
      let stopped = false;
      let failed: string | null = null;
      // An id we minted was announced before the spawn: the CLI repeating it
      // on `init` is confirmation, not news.
      let named = talk !== null && talk.session.fresh !== null;

      /**
       * Kill the call, and say why ONCE.
       *
       * Whoever stops it writes the reason, and `close` must not write another:
       * the exit that follows is the consequence of the kill, not news. Before
       * this, the timeout wrote "no answer within 180s" and `close` replaced it
       * with the first line of an empty stderr -- the panel said "error" and
       * nothing else.
       */
      const stop = (state: CeoState, reason: string): void => {
        if (stopped) return;
        stopped = true;
        failed = reason;
        child.kill('SIGTERM');
        this.#setState(state, reason);
      };
      this.#halt = (reason) => stop('idle', reason);

      const silenceMs = this.#opts.silenceMs ?? SILENCE_MS;
      const ceilingMs = this.#opts.ceilingMs ?? CEILING_MS;
      const quiet = (): ReturnType<typeof setTimeout> => setTimeout(
        () => stop('error', `no output for ${Math.round(silenceMs / 1000)}s, stopped`),
        silenceMs,
      );
      let silence = quiet();
      const ceiling = setTimeout(
        () => stop('error', `still working after ${Math.round(ceilingMs / 60_000)} min, stopped`),
        ceilingMs,
      );
      const clearClocks = (): void => {
        clearTimeout(silence);
        clearTimeout(ceiling);
      };

      /**
       * The brake on the call in flight.
       *
       * The other caps look at the past and decide whether to start. This is
       * the only one that watches the call while it runs, and it became
       * necessary when the CEO was allowed to read code: every file opened
       * goes back into the context and is re-sent on every turn, so a
       * structural analysis can multiply its own cost without ever doing
       * anything wrong. Before this, the only brake was the three-minute
       * timeout -- which arrives long after the fifty cents.
       */
      const brake = (): boolean => {
        if (stopped) return true;
        const weighted = weigh(meter.usage);
        const reason = this.#opts.ledger.runawayReason(this.#opts.provider, weighted);
        if (!reason) return false;
        const share = this.#share(weighted);
        stop('off', share ? `${reason} (${formatShare(share)})` : reason);
        return true;
      };

      /**
       * Send what a person should see, and only that.
       *
       * The outcome block is machine-facing: it belongs to the panel's cards,
       * not to the panel's text. While the fence has not appeared yet the tail
       * is held back, because a fence arrives split across chunks and half a
       * "```tower" already on screen can never be taken back.
       */
      const pump = (done: boolean): void => {
        const cut = full.indexOf(OUTCOME_FENCE);
        let visible = cut < 0 ? full : full.slice(0, cut);
        if (cut < 0 && !done) {
          visible = visible.slice(0, Math.max(0, visible.length - OUTCOME_FENCE.length));
        }
        if (visible.length > sent) {
          this.#reply(visible.slice(sent), false);
          sent = visible.length;
        }
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (!stopped) {
          clearTimeout(silence);
          silence = quiet();
        }
        carry += chunk;
        const lines = carry.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) {
          const piece = consumeLine(line);
          if (piece.text) full += piece.text;
          // A model reading files is already answering. Waiting for the first
          // line of text left the panel on "starting" for three minutes of
          // work, which reads exactly like a CEO that never started.
          if ((piece.text || piece.fromModel) && this.#state !== 'thinking' && !stopped) {
            this.#setState('thinking');
          }
          if (piece.costUsd !== null) costUsd = piece.costUsd;
          if (piece.quota) this.#opts.onQuota?.(piece.quota);
          // Once per call: the id does not change, and a caller that persists
          // it should not be asked to persist it on every line.
          if (piece.sessionId && talk && !named) {
            named = true;
            talk.onSession(piece.sessionId);
          }
          meter.add(piece);
        }
        pump(false);
        brake();
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        // Only the beginning: a whole stack does not help someone looking at a plate.
        if (stderr.length < 400) stderr += chunk;
      });

      child.on('error', (err) => {
        clearClocks();
        this.#halt = null;
        const reason = `${bin} did not start: ${err.message}`;
        this.#setState('error', reason);
        this.#reply('', true);
        resolve({ text: '', failed: reason });
      });

      child.on('close', (code, signal) => {
        clearClocks();
        this.#halt = null;
        // The last line may arrive without a trailing newline.
        if (carry.trim()) {
          const piece = consumeLine(carry);
          if (piece.text) full += piece.text;
          if (piece.costUsd !== null) costUsd = piece.costUsd;
          meter.add(piece);
        }
        pump(true);

        const weighted = weigh(meter.usage);
        this.#opts.ledger.record(this.#opts.provider, costUsd, startedAt, weighted);

        // `off` is not overwritten: the call stopped by the brake already has
        // its reason on screen, and a non-zero exit code is the CONSEQUENCE
        // of having killed it, not fresh news.
        if (code !== 0 && full.length === 0 && !stopped) {
          // `||` and not `??`: an empty stderr splits into [''], which is not
          // nullish, and became an empty reason.
          failed = stderr.trim().split('\n')[0] || `${bin} exited with ${code ?? signal ?? 'no code'}`;
          this.#setState('error', failed);
        }
        this.#reply('', true);
        // Before `onResult`: whoever asked for a judgement must be able to
        // put it on record in the same pass in which the report is posted,
        // or the panel would read a board without the verdict it has just
        // asked for.
        onText?.(full);
        // A conversation is not an analysis: its block is a plan, and pinning
        // a report titled "answer" on the board for every turn of a meeting
        // would be twenty reports about nothing.
        if (talk === null || talk.report) {
          this.#opts.onResult({
            analysis,
            depth,
            model,
            outcome: parseOutcome(full),
            costUsd,
            share: this.#share(weighted),
            hadText: full.trim().length > 0,
          });
        }
        resolve(stopped ? { text: full, failed, cause: 'stopped' } : { text: full, failed });
      });

      child.stdin?.end(prompt, 'utf8');
    });
  }

  /** How much it weighs on your subscription rate. `null` when there is no history to tell. */
  #share(weighted: number): QuotaShare | null {
    return quotaShare(
      weighted,
      this.#opts.provider,
      this.#opts.snapshot().limits,
      this.#opts.weightedSince,
      Date.now(),
    );
  }
}

/**
 * One line of CLI output, reduced to what we need.
 *
 * Defensive like the transcript parser, and for the same reason: the format
 * belongs to a program we do not control, and it will change. A line that
 * cannot be understood is ignored; a line that is not JSON is taken as text,
 * so even if the format changes entirely the answer still shows.
 *
 * Exported for the tests: the stream format is measured, and the measure is
 * what they pin.
 */
export function consumeLine(line: string): Piece {
  const trimmed = line.trim();
  if (!trimmed) return NOTHING;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { ...NOTHING, text: `${trimmed}\n` };
  }
  if (!obj || typeof obj !== 'object') return NOTHING;

  const type = obj['type'];
  // The conversation's id, wherever a line names it: Claude on `init` and
  // `result`, Codex on `thread.started`. Read once here so every branch below
  // carries it without knowing which tool wrote the line.
  const named = obj['session_id'] ?? obj['thread_id'];
  const sessionId = typeof named === 'string' && named.length > 0 ? named : null;

  // Claude: the text is in the assistant's blocks.
  if (type === 'assistant') {
    const message = obj['message'] as { id?: unknown; content?: unknown; usage?: unknown } | undefined;
    const usage = readUsage(message?.usage);
    // Without an id the repeats cannot be told apart: counted as they come,
    // which overcounts -- the brake stopping early, never late.
    const counted = usage && typeof message?.id === 'string'
      ? { message: { id: message.id, usage }, usage: null }
      : { message: null, usage };
    const content = message?.content;
    let text = '';
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: unknown; text?: unknown };
        if (b?.type === 'text' && typeof b.text === 'string') text += b.text;
      }
    }
    return { ...NOTHING, ...counted, text, fromModel: true, sessionId };
  }

  if (type === 'system' && obj['subtype'] === 'thinking_tokens') {
    const delta = obj['estimated_tokens_delta'];
    return {
      ...NOTHING,
      fromModel: true,
      thinking: typeof delta === 'number' && Number.isFinite(delta) && delta > 0 ? delta : 0,
      sessionId,
    };
  }

  if (type === 'rate_limit_event') {
    return { ...NOTHING, quota: readQuota(obj['rate_limit_info']), sessionId };
  }

  if (type === 'result') {
    const cost = obj['total_cost_usd'];
    return {
      ...NOTHING,
      costUsd: typeof cost === 'number' ? cost : null,
      total: readUsage(obj['usage']),
      sessionId,
    };
  }

  // Codex: the events carry the agent's message under other names.
  if (type === 'item.completed' || type === 'item_completed') {
    const item = obj['item'] as { type?: unknown; text?: unknown } | undefined;
    if (item && (item.type === 'agent_message' || item.type === 'AgentMessage')) {
      return { ...NOTHING, fromModel: true, text: typeof item.text === 'string' ? `${item.text}\n` : '', sessionId };
    }
    return { ...NOTHING, fromModel: true, sessionId };
  }

  // Any event that declares usage, whoever's format it is: the brake works
  // for the tool that says how much it is spending. One that does not say
  // is covered only by the timeout, and that should be known.
  const usage = readUsage(obj['usage']);
  return usage ? { ...NOTHING, usage, fromModel: true, sessionId } : { ...NOTHING, sessionId };
}

/**
 * The usage declared in a line, if there is any.
 *
 * Defensive like the rest of the parser: the field names belong to a program
 * we do not control. A shape that cannot be understood is `null`, and the
 * brake simply does not see that line -- it does not stop by mistake.
 */
function readUsage(raw: unknown): CallUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const n = (k: string): number => {
    const v = u[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  };
  const out: CallUsage = {
    in: n('input_tokens'),
    out: n('output_tokens'),
    cacheRead: n('cache_read_input_tokens'),
    cacheWrite: n('cache_creation_input_tokens'),
  };
  return out.in + out.out + out.cacheRead + out.cacheWrite > 0 ? out : null;
}
