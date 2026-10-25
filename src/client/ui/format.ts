import { MAX_SCANNED_DEPTH, MAX_SCANNED_FILES, OPERATOR_CAP_MS, addModelTimes } from '../../shared/protocol.ts';
import type { ModelTime, ProjectInfo, ProjectWork, SessionInfo, TokenTotals, WorkMonth } from '../../shared/protocol.ts';
import { floorsForSize, levelsForSize } from '../../shared/layout.ts';

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

/** The view on screen, which decides what a project's height is counted in. */
export type SizeView = 'city' | 'colony';

/**
 * How tall a project stands, and what that height is counted from (the
 * user's request, 2026-10-16, after asking why one tower grew faster than
 * the rest). The height in the unit of the view on screen -- floors in the
 * city, decks in the colony: the same count on two scales -- then the files
 * and folders the server's scan found. Approximate by construction: the scan
 * skips hidden, dependency and build folders and stops at
 * `MAX_SCANNED_FILES`, where a count only says "at least".
 */
export function sizeRows(project: Pick<ProjectInfo, 'size' | 'dirs'>, view: SizeView): [string, string][] {
  const cut = project.size >= MAX_SCANNED_FILES;
  return [
    view === 'city'
      ? ['floors', String(floorsForSize(project.size))]
      : ['decks', String(levelsForSize(project.size))],
    ['files', approxCount(project.size, cut)],
    // A server older than the field sends none: a dash, never a zero.
    ['folders', Number.isFinite(project.dirs) ? approxCount(project.dirs, cut) : '\u2014'],
  ];
}

/** What the scan counts and what it leaves out: the reason the numbers are approximate. */
export const SIZE_NOTE =
  `Counted by name, up to ${MAX_SCANNED_FILES.toLocaleString('en-US')} files and ` +
  `${MAX_SCANNED_DEPTH} levels deep, ` +
  'without hidden folders, dependencies and build output.';

function approxCount(n: number, cut: boolean): string {
  const shown = n.toLocaleString('en-US');
  return cut ? `${shown}+` : `\u2248 ${shown}`;
}

/**
 * A project's work on its card: what it took, to show whoever funds it (the
 * user's request, 2026-10-24). The totals first, then month by month, then
 * what the hours are counted from -- they are measures of different
 * solidity, and a funder reading them deserves to know which is which.
 */
export interface WorkView {
  rows: [string, string][];
  /**
   * Model and effort, their AI time, their share of it: the largest first,
   * then the part no model was recorded for (the user's request, 2026-10-25).
   */
  models: [string, string, string][];
  /** Month, tokens, AI time, your time: newest first. */
  months: [string, string, string, string][];
}

export function workView(work: ProjectWork): WorkView {
  const total: WorkMonth = {
    month: '', sessions: 0, timed: 0,
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    aiMs: 0, operatorMs: 0, models: [],
  };
  for (const m of work.months) {
    total.sessions += m.sessions;
    total.timed += m.timed;
    total.tokens.in += m.tokens.in;
    total.tokens.out += m.tokens.out;
    total.tokens.cacheRead += m.tokens.cacheRead;
    total.tokens.cacheWrite += m.tokens.cacheWrite;
    total.aiMs += m.aiMs;
    total.operatorMs += m.operatorMs;
    // A server older than the field sends none: its hours are not recorded.
    addModelTimes(total.models, m.models ?? []);
  }
  const t = total.tokens;
  const sessions = work.live > 0 ? `${total.sessions} \u00b7 ${work.live} open` : String(total.sessions);
  return {
    rows: [
      ['tokens', countText(tokensOf(t))],
      ['input \u00b7 output', `${countText(t.in)} \u00b7 ${countText(t.out)}`],
      ['cache read \u00b7 write', `${countText(t.cacheRead)} \u00b7 ${countText(t.cacheWrite)}`],
      ['AI time', hoursText(total.aiMs, total)],
      ['your time', hoursText(total.operatorMs, total)],
      ['sessions', sessions],
    ],
    models: modelRows(total.models, total.aiMs),
    months: work.months.map((m) => [
      monthLabel(m.month), countText(tokensOf(m.tokens)), hoursText(m.aiMs, m), hoursText(m.operatorMs, m),
    ]),
  };
}

/** Every model that worked is named, however briefly. */
function modelRows(models: readonly ModelTime[], aiMs: number): [string, string, string][] {
  if (aiMs <= 0) return [];
  const brief = (ms: number): string => (ms < 60_000 ? '<1 min' : durationText(ms));
  const rows: [string, string, string][] = [...models]
    .filter((m) => m.aiMs > 0)
    .sort((a, b) => b.aiMs - a.aiMs)
    // No effort written: the model alone, since a dash on this card means unread hours.
    .map((m) => [m.effort ? `${m.model} \u00b7 ${m.effort}` : m.model, brief(m.aiMs), shareText(m.aiMs / aiMs)]);
  // Under a minute the remainder is rounding, not sessions left unread.
  const rest = aiMs - models.reduce((sum, m) => sum + m.aiMs, 0);
  if (rest >= 60_000) rows.push(['not recorded', durationText(rest), shareText(rest / aiMs)]);
  return rows;
}

function shareText(f: number): string {
  const pct = Math.round(f * 100);
  return pct === 0 && f > 0 ? '<1%' : `${pct}%`;
}

/** What the hours are counted from, and why some read "at least". */
export const WORK_NOTE =
  'AI time: the agents\' turns as Claude Code and Codex time them, summed across sessions. ' +
  'Each turn counts for the model and effort it ran on, as the tool recorded them (a model alone: no effort recorded); ' +
  'not recorded: sessions read before Towerglow kept models. ' +
  `Your time: for each message you send, the time since the session last did anything, up to ${OPERATOR_CAP_MS / 60_000} minutes; ` +
  'a stretch with several projects going is split among them. ' +
  '\u2265 and \u2014: some or all of the sessions could not be read, and their hours are missing. ' +
  'Months follow the day a session began; a year at most is kept.';

/** Cache reads are most of it, and they are tokens: the total says so by including them. */
function tokensOf(t: TokenTotals): number {
  return t.in + t.out + t.cacheRead + t.cacheWrite;
}

/**
 * Hours, as a funder counts them. Over sessions none of which were read, a
 * dash: zero would claim a measure nobody made.
 */
function hoursText(ms: number, of: Pick<WorkMonth, 'sessions' | 'timed'>): string {
  if (of.timed === 0) return of.sessions === 0 ? '0 h' : '\u2014';
  const shown = durationText(ms);
  return of.timed < of.sessions ? `\u2265 ${shown}` : shown;
}

function durationText(ms: number): string {
  return ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`;
}

function countText(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-10` as `Oct 2026`: the key is a month, not a date to localise. */
function monthLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  const name = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && name ? `${name} ${m[1]}` : key;
}
