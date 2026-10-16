import type { SessionInfo } from '../../shared/protocol.ts';

/**
 * A duration readable at a glance. At most two units: under a minute the
 * seconds, then minutes and seconds, then hours and minutes, then days and hours.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600) % 24;
  const d = Math.floor(total / 86400);
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * A session stopped at the usage limit, in words: for how long, and what it
 * takes to start it again. One text for the badge's bubble and the card, so
 * the two cannot tell it differently. `null` for a session that is not.
 *
 * It does not start again when the limit resets -- that is the whole point
 * of saying it (the user's request, 2026-10-16) -- so even before the reset
 * the text says what will be needed after it.
 */
export function limitStopText(
  s: Pick<SessionInfo, 'limitStoppedAt' | 'limitResetsAt'>,
  now: number,
): { since: string; next: string } | null {
  // `??`: a server older than the fields sends neither.
  const at = s.limitStoppedAt ?? null;
  if (at === null) return null;
  const resets = s.limitResetsAt ?? null;
  const since = formatElapsed(now - at);
  if (resets === null) {
    return { since, next: 'It will not start again by itself: send it a message once the limit resets' };
  }
  if (resets <= now) return { since, next: 'The limit has reset: send it a message to start it again' };
  return {
    since,
    next: `The limit resets at ${clockOf(resets, now)}, in ${formatElapsed(resets - now)}. ` +
      'It will not start again by itself: send it a message then',
  };
}

/** A time of day; with the weekday when it is not within the next twenty hours. */
function clockOf(at: number, now: number): string {
  const far = at - now > 20 * 3_600_000;
  return new Date(at).toLocaleString(undefined, far
    ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' });
}

/**
 * From the tool's name to the verb. The two lists are the two providers: Claude
 * Code names tools, Codex names items, but what they describe is the same
 * handful of gestures.
 */
const VERB: Record<string, string> = {
  // Claude Code
  Read: 'Reading',
  Edit: 'Editing',
  MultiEdit: 'Editing',
  Write: 'Writing',
  NotebookEdit: 'Editing',
  Bash: 'Running',
  BashOutput: 'Running',
  Grep: 'Searching',
  Glob: 'Searching',
  Task: 'Delegating',
  Agent: 'Delegating',
  WebFetch: 'Fetching',
  WebSearch: 'Searching web',
  TodoWrite: 'Planning',
  ExitPlanMode: 'Planning',
  SendMessage: 'Messaging',
  ListAgents: 'Checking agents',
  AskUserQuestion: 'Asking you',
  // Codex
  CommandExecution: 'Running',
  FileChange: 'Editing',
  Extension: 'Searching web',
  ImageView: 'Viewing',
  McpToolCall: 'Calling',
  TodoList: 'Planning',
};

/**
 * What the session is doing, in three words.
 *
 * It is the most direct answer to the question you ask while watching the
 * city, and for Claude Code it is also the only one: its `ai-title` names the
 * SESSION, not the turn -- measured on a real transcript, it stays identical
 * to the handle for hundreds of records in a row -- so it never says what is
 * happening now.
 */
export function describeActivity(session: SessionInfo, short = false): string | null {
  const tool = session.activityTool;
  if (!tool) return null;
  return describeStep(tool, session.activityTarget, short);
}

/**
 * The same gesture, phrased for any step and not only the one in progress.
 *
 * The trace in the panel names gestures that are already over, and must call
 * them exactly what the live line called them a moment earlier: two ways of
 * saying `Bash` would make the same call look like two different things.
 */
export function describeStep(tool: string, target: string | null, short = false): string {
  // An MCP tool is called `mcp__<server>__<name>`: spelled out in full it
  // takes half a line to name the transport instead of the gesture.
  const mcp = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(tool);
  if (mcp) return `Calling ${mcp[1]}`;
  const verb = VERB[tool] ?? tool;
  if (!target) return verb;
  const shown = short ? (target.split('/').pop() ?? target) : target;
  return `${verb} ${shown}`;
}
