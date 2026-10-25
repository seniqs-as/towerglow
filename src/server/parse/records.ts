import type { TokenTotals } from '../../shared/protocol.ts';

/**
 * Defensive narrowing of a transcript line.
 *
 * The JSONL format is internal to Claude Code and changes between versions:
 * the documentation says so explicitly. So nothing here EVER throws. A
 * malformed line, a never-seen type or a field with the wrong shape produce
 * `null` and a counter, and the rest of the world keeps working.
 */

export interface ToolUseBlock {
  id: string;
  name: string;
  input: unknown;
}

export interface AssistantRecord {
  kind: 'assistant';
  uuid: string | null;
  sessionId: string;
  agentId: string | null;
  timestamp: number;
  requestId: string | null;
  model: string | null;
  /** The effort the reply ran at (`low` ... `max`): written on every reply from 2.1.281 on. */
  effort: string | null;
  toolUses: ToolUseBlock[];
  usage: unknown;
  thinking: boolean;
}

export interface ToolResultRecord {
  kind: 'tool_result';
  sessionId: string;
  agentId: string | null;
  timestamp: number;
  toolUseId: string;
  isError: boolean;
  result: unknown;
}

export interface PromptRecord {
  kind: 'prompt';
  sessionId: string;
  timestamp: number;
  promptId: string;
  chars: number;
  source: 'typed' | 'queued';
}

/** The delivery of a subagent launched in the background: it is its end. */
export interface AgentDoneRecord {
  kind: 'agent_done';
  sessionId: string;
  timestamp: number;
  /** The `Task` call that had started it: it is its identifier. */
  toolUseId: string | null;
  /**
   * The task's id, which for a subagent is the `agentId` its launch
   * returned. A subagent that notifies a second time carries only this one.
   */
  taskId: string | null;
}

export interface TurnEndRecord {
  kind: 'turn_end';
  sessionId: string;
  timestamp: number;
  durationMs: number;
  messageCount: number;
}

export interface ContextRecord {
  kind: 'context';
  sessionId: string;
  timestamp: number;
  tokensLeft: number;
}

/**
 * The session stopped at a usage limit: the API refused the turn, and Claude
 * Code wrote the refusal as the session's reply (`isApiErrorMessage`, with
 * `error: "rate_limit"` -- "You've hit your session limit · resets 11:40am").
 * Nothing starts it again when the limit resets: it waits for you.
 */
export interface LimitRecord {
  kind: 'limit';
  sessionId: string;
  timestamp: number;
  /** When the limit resets, in ms, as the record declares it; `null` when it does not. */
  resetsAt: number | null;
}

/** Claude Code compacted the conversation: `compact_boundary`. Only its time. */
export interface CompactRecord {
  kind: 'compact';
  sessionId: string;
  timestamp: number;
}

export interface TitleRecord {
  kind: 'title';
  sessionId: string;
  title: string;
}

/**
 * The summary the session writes about itself: goal, state, next step.
 *
 * Claude Code calls it `away_summary` -- it exists to say what happened while
 * you weren't looking -- and rewrites it roughly every fifteen minutes. It is
 * the only record in the transcript that says in words what is being done.
 */
export interface RecapRecord {
  kind: 'recap';
  sessionId: string;
  timestamp: number;
  recap: string;
}

/**
 * The final tally Claude Code writes when a session ends.
 *
 * It sits in the last lines of the transcript -- measured: 29 files out of 36,
 * always less than three lines from the end -- and it is the only place where
 * a session's numbers are COMPLETE. `usage` events cover only what the tailer
 * actually read, and on a session older than the warmup window they are a
 * fraction of the total.
 *
 * Until yesterday this line ended up in `unknownTypes`: it was read, counted as
 * unknown and thrown away. There is nothing new to open to get it.
 */
export interface CostStateRecord {
  kind: 'cost_state';
  sessionId: string;
  /** The session's start: the day the work is attributed to. */
  timestamp: number;
  costUsd: number;
  tokens: TokenTotals;
  /** The model that did the most work, when there is more than one. */
  model: string | null;
  apiMs: number;
  toolMs: number;
  wallMs: number;
  linesAdded: number;
  linesRemoved: number;
}

export type Record_ =
  | AssistantRecord | ToolResultRecord | PromptRecord
  | TurnEndRecord | AgentDoneRecord | ContextRecord | CompactRecord | TitleRecord | RecapRecord
  | CostStateRecord | LimitRecord;

export interface ParseStats {
  badLines: number;
  unknownTypes: Record<string, number>;
  /**
   * Strings truncated by the redaction guard when it runs in production.
   *
   * It must stay 0 forever: any other value is a redaction bug that has
   * already happened, not an operating condition to tolerate.
   */
  redactionClamps: number;
  /**
   * Lines rejected because they were written before the session started.
   *
   * A `--fork-session` does not open an empty file: it copies the parent's
   * transcript and rewrites it with its own id. The tailer of a new session
   * therefore finds in its file the history of another one -- already counted
   * under the other id -- and summing it means doubling it. Measured on a real
   * fork: 980 inherited lines out of 1001, and a row in `history.json` that
   * declared 257 tool calls for ONE actually made.
   *
   * Unlike `redactionClamps` this counter does not have to stay 0: it tells how
   * much inherited content we rejected, and it is high precisely when the
   * filter is doing its job.
   */
  inheritedLines: number;
}

/** The call's id inside the delivery notification. Nothing else is read from it. */
const RE_TASK_TOOL_USE = /<tool-use-id>(toolu_[A-Za-z0-9_-]{4,64})<\/tool-use-id>/;
/**
 * The task's id, in the shape of a launch's `agentId` (`spawnedAgentId` in
 * `redact.ts`). Measured on tower_defense on 2026-10-15 (2.1.300): only the
 * first notification of a subagent names the call, the later ones of the
 * same agent only the task.
 */
const RE_TASK_ID = /<task-id>([0-9a-f]{8,40})<\/task-id>/i;
/**
 * A subagent that stopped with background work of its own still running: a
 * `completed` notification that is not its end. The outcome closes the
 * summary, `Agent "<description>" <outcome>`, as the Agent tool's own
 * description lists them; the same task notifies again when it resumes.
 * Read as an end, it closed a subagent still waiting on an hour of tests,
 * and the tower showed "done" (2026-10-15).
 */
const RE_STILL_WAITING = /<summary>[^<]*" is waiting on its own background work<\/summary>/;

/**
 * A task notification, reduced to the ids of what it ended. `null` for one
 * that ends nothing: a subagent that is only waiting, or no id at all.
 */
function deliveryOf(text: string, sessionId: string, timestamp: number): AgentDoneRecord | null {
  if (RE_STILL_WAITING.test(text)) return null;
  const toolUseId = RE_TASK_TOOL_USE.exec(text)?.[1] ?? null;
  const taskId = RE_TASK_ID.exec(text)?.[1] ?? null;
  if (toolUseId === null && taskId === null) return null;
  return { kind: 'agent_done', sessionId, timestamp, toolUseId, taskId };
}

/**
 * The API errors that stop a session on its account's usage, by the `error`
 * Claude Code writes on the refusal. `rate_limit` is measured: 61 refusals on
 * this machine from 2.1.273 to 2.1.301 (38 in a session's own turn), every
 * one "You've hit your session limit". `billing_error` is the API key's
 * version of the same stop (credit balance too low), from the error names the
 * SDK declares: never seen here. `server_error` and `invalid_request` stop a
 * turn too, but not on credit.
 */
const LIMIT_ERRORS = new Set(['rate_limit', 'billing_error']);

/**
 * When a refused turn's limit resets, from the numbers the refusal carries.
 * Since 2.1.29x it names the window and its reset in seconds
 * (`apiErrorParams.rate_limit_info.resetsAt`); before, only the text did, and
 * the text is not read.
 */
function resetOf(raw: Record<string, unknown>): number | null {
  const info = obj(obj(raw['apiErrorParams'])?.['rate_limit_info']) ?? obj(raw['quotaLimits']);
  const secs = info?.['resetsAt'];
  return typeof secs === 'number' && Number.isFinite(secs) && secs > 1e9 ? Math.round(secs * 1000) : null;
}

export function createStats(): ParseStats {
  return { badLines: 0, unknownTypes: {}, redactionClamps: 0, inheritedLines: 0 };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function timeOf(raw: Record<string, unknown>): number {
  const t = Date.parse(String(raw['timestamp'] ?? ''));
  // An unreadable timestamp must not throw the record away: better "now"
  // than losing the event.
  return Number.isFinite(t) ? t : Date.now();
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * The closing tally, reduced to scalars.
 *
 * Tokens are summed across ALL the session's models, but the name that stays
 * is that of the model that did the most work: a session touches haiku for
 * the title and opus for the rest, and calling it "haiku" because it is the
 * last one seen would be worse than saying nothing.
 *
 * Per-model `webSearchRequests` and `costUSD` are left out: the total cost is
 * already there one line above, and summing the two would count it twice.
 */
function costState(raw: Record<string, unknown>): CostStateRecord | null {
  const sessionId = str(raw['sessionId']);
  if (!sessionId) return null;

  const tokens: TokenTotals = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
  let model: string | null = null;
  let best = 0;

  const usage = obj(raw['modelUsage']);
  for (const [name, value] of Object.entries(usage ?? {})) {
    const u = obj(value);
    if (!u) continue;
    const inTok = num(u['inputTokens']);
    const outTok = num(u['outputTokens']);
    tokens.in += inTok;
    tokens.out += outTok;
    tokens.cacheRead += num(u['cacheReadInputTokens']);
    tokens.cacheWrite += num(u['cacheCreationInputTokens']);
    tokens.thinking += num(u['thinkingTokens']);
    if (inTok + outTok > best) {
      best = inTok + outTok;
      model = name;
    }
  }

  const startTime = num(raw['startTime']);
  return {
    kind: 'cost_state',
    sessionId,
    timestamp: startTime > 0 ? startTime : Date.now(),
    costUsd: num(raw['totalCostUSD']),
    tokens,
    model,
    apiMs: num(raw['totalAPIDuration']),
    toolMs: num(raw['totalToolDuration']),
    wallMs: num(raw['totalDuration']),
    linesAdded: num(raw['totalLinesAdded']),
    linesRemoved: num(raw['totalLinesRemoved']),
  };
}

/** Attachment subtypes that are not even looked at: see redact.ts. */
const ATTACHMENT_DENY = new Set([
  'prompt_snapshot', 'instructions', 'session_context', 'environment',
  'queued_command', 'skill_listing', 'agent_listing_delta', 'deferred_tools_record',
  'deferred_tools_delta', 'plan_mode', 'plan_mode_exit', 'prompt_snapshot',
]);

export function parseLine(line: string, stats: ParseStats): Record_ | null {
  let raw: Record<string, unknown> | null;
  try {
    raw = obj(JSON.parse(line));
  } catch {
    stats.badLines++;
    return null;
  }
  if (!raw) {
    stats.badLines++;
    return null;
  }

  // Always `sessionId`: `session_id` exists too, inconsistent and sometimes null.
  const sessionId = str(raw['sessionId']);
  const type = str(raw['type']);
  if (!type) return null;

  const agentId = str(raw['agentId']);

  switch (type) {
    case 'assistant': {
      if (!sessionId) return null;
      // The session's own turn only: a subagent refused inside it is not the
      // session stopping, and its refusal comes back to the session anyway.
      if (raw['isApiErrorMessage'] === true && LIMIT_ERRORS.has(String(raw['error']))) {
        if (raw['isSidechain'] === true || agentId) return null;
        return { kind: 'limit', sessionId, timestamp: timeOf(raw), resetsAt: resetOf(raw) };
      }
      const message = obj(raw['message']);
      if (!message) return null;
      const content = Array.isArray(message['content']) ? message['content'] : [];

      const toolUses: ToolUseBlock[] = [];
      let thinking = false;
      for (const block of content) {
        const b = obj(block);
        if (!b) continue;
        if (b['type'] === 'thinking') thinking = true;
        if (b['type'] !== 'tool_use') continue;
        const id = str(b['id']);
        const name = str(b['name']);
        if (!id || !name) continue;
        toolUses.push({ id, name, input: b['input'] });
      }

      return {
        kind: 'assistant',
        uuid: str(raw['uuid']),
        sessionId,
        agentId,
        timestamp: timeOf(raw),
        requestId: str(raw['requestId']),
        model: str(message['model']),
        effort: str(raw['effort']),
        toolUses,
        usage: message['usage'],
        thinking,
      };
    }

    // A subagent's delivery arrives FIRST in the queue and only later, when
    // the session consumes it, as a message. The two points show up with
    // different record types -- verified on two real sessions: in one it was
    // already a message, in the other it had been queued for twenty minutes.
    // Recognizing only one means leaving windows lit after the work is done.
    case 'queue-operation': {
      if (!sessionId || raw['operation'] !== 'enqueue') return null;
      const content = raw['content'];
      return typeof content === 'string' ? deliveryOf(content, sessionId, timeOf(raw)) : null;
    }

    case 'user': {
      if (!sessionId) return null;
      const message = obj(raw['message']);
      if (!message) return null;
      const content = message['content'];

      // The delivery of a subagent launched in the background.
      //
      // It is the only announcement of its END: verified on a real session,
      // the turn had closed minutes earlier while three agents were still at
      // work, and their conclusion arrived only here. From the content --
      // which is the agent's report, that is, text -- we take ONLY the id of
      // the call that had started it, and of the task. One that ends nothing
      // is not a prompt either: nobody typed it, and as one it landed the
      // prompt's lander on the deck.
      if (obj(raw['origin'])?.['kind'] === 'task-notification') {
        return deliveryOf(typeof content === 'string' ? content : '', sessionId, timeOf(raw));
      }

      // A tool_result arrives as an array with a tool_result block.
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = obj(block);
          if (!b || b['type'] !== 'tool_result') continue;
          const toolUseId = str(b['tool_use_id']);
          if (!toolUseId) continue;
          return {
            kind: 'tool_result',
            sessionId,
            agentId,
            timestamp: timeOf(raw),
            toolUseId,
            isError: b['is_error'] === true,
            result: raw['toolUseResult'],
          };
        }
        return null;
      }

      // Claude Code also writes as `user` what nobody typed: a subagent's
      // report handed back (`origin.kind: "peer"`, measured on 2026-10-15),
      // and the `isMeta` notes it adds around a turn -- a command's caveat, an
      // image's size, a usage limit. As prompts they turned the astronaut
      // back toward the ship and landed the lander for a message you never
      // sent. A record without an origin stays a prompt: older versions and
      // `claude -p` write none.
      const origin = str(obj(raw['origin'])?.['kind']);
      if (raw['isMeta'] === true || (origin !== null && origin !== 'human')) return null;

      // Otherwise it is a human prompt. Only the LENGTH is kept, never the text.
      if (typeof content === 'string') {
        const promptId = str(raw['promptId']) ?? str(raw['uuid']) ?? 'p';
        const source = raw['promptSource'] === 'queued' ? 'queued' : 'typed';
        return {
          kind: 'prompt',
          sessionId,
          timestamp: timeOf(raw),
          promptId,
          chars: content.length,
          source,
        };
      }
      return null;
    }

    case 'system': {
      if (!sessionId) return null;
      if (raw['subtype'] === 'away_summary') {
        const recap = str(raw['content']);
        return recap ? { kind: 'recap', sessionId, timestamp: timeOf(raw), recap } : null;
      }
      // The session's own conversation, not a subagent's inside it.
      if (raw['subtype'] === 'compact_boundary') {
        return raw['isSidechain'] === true ? null : { kind: 'compact', sessionId, timestamp: timeOf(raw) };
      }
      if (raw['subtype'] !== 'turn_duration') return null;
      const durationMs = typeof raw['durationMs'] === 'number' ? raw['durationMs'] : 0;
      const messageCount = typeof raw['messageCount'] === 'number' ? raw['messageCount'] : 0;
      return { kind: 'turn_end', sessionId, timestamp: timeOf(raw), durationMs, messageCount };
    }

    case 'attachment': {
      if (!sessionId) return null;
      const attachment = obj(raw['attachment']);
      const subtype = str(attachment?.['type']) ?? str(raw['subtype']);
      if (!subtype || ATTACHMENT_DENY.has(subtype)) return null;

      // The only attachment we care about: the remaining context. ONLY the
      // number is extracted, with a regex, without keeping the text.
      if (subtype === 'total_tokens_reminder') {
        const text = typeof attachment?.['text'] === 'string' ? attachment['text'] : '';
        const m = /(\d+)\s+tokens?\s+left/i.exec(text);
        if (!m) return null;
        return { kind: 'context', sessionId, timestamp: timeOf(raw), tokensLeft: Number(m[1]) };
      }
      return null;
    }

    case 'ai-title': {
      if (!sessionId) return null;
      const title = str(raw['aiTitle']);
      if (!title) return null;
      return { kind: 'title', sessionId, title };
    }

    case 'cost-state':
      return costState(raw);

    // Known types we don't need: silently ignored, without counting them as
    // unknown, otherwise the diagnostic counter turns into noise.
    case 'mode':
    case 'permission-mode':
    case 'last-prompt':
    case 'bridge-session':
    case 'atis-latch':
    case 'queue-operation':
    case 'file-history-snapshot':
    case 'file-history-delta':
      return null;

    default:
      stats.unknownTypes[type] = (stats.unknownTypes[type] ?? 0) + 1;
      return null;
  }
}
