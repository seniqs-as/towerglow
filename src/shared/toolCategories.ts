import type { ToolCategory } from './protocol.ts';

/**
 * From tool name to category. The category decides the pulse's color, so by
 * looking at the city you can tell WHAT an agent is doing without reading a
 * line of text.
 *
 * An unknown tool ends up in `other` instead of breaking something: names
 * change across Claude Code versions, and this list ages.
 */

/**
 * Codex's calls, by the `item.type` its rollout writes: it names the kind of
 * item, not the tool. The provider reads this table to know which items are
 * calls at all -- reasoning, messages, a compaction or a subagent's notice
 * light nothing -- and `categoryOf` reads it too, because the page colours a
 * window from the call's NAME. Measured on 2026-10-14: the provider had a
 * table of its own, the page knew only Claude Code's names, and every Codex
 * call lit its window in the grey of `other` beside the white of the turn --
 * a Codex tower never showed a colour, while its sparks, which read the
 * server's category, did.
 */
export const CODEX_CALLS: Readonly<Record<string, ToolCategory>> = {
  CommandExecution: 'exec',
  FileChange: 'edit',
  ImageView: 'read',
  // `kind: "web.search"`, which also covers opening a page.
  Extension: 'net',
  McpToolCall: 'mcp',
  TodoList: 'plan',
  // Spawning a subagent, waiting on it, writing to it.
  CollabAgentToolCall: 'agent',
};

const EXACT: Record<string, ToolCategory> = {
  ...CODEX_CALLS,
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  MultiEdit: 'edit',
  Bash: 'exec',
  BashOutput: 'exec',
  KillShell: 'exec',
  Glob: 'search',
  Grep: 'search',
  ToolSearch: 'search',
  WebFetch: 'net',
  WebSearch: 'net',
  Agent: 'agent',
  // A skill loads instructions that steer the work: that is planning.
  Skill: 'plan',
  Task: 'agent',
  TaskOutput: 'agent',
  ExitPlanMode: 'plan',
  EnterPlanMode: 'plan',
  TodoWrite: 'plan',
  SendMessage: 'msg',
  ListAgents: 'msg',
  AskUserQuestion: 'msg',
  SendUserMessage: 'msg',
};

export function categoryOf(toolName: string): ToolCategory {
  const exact = EXACT[toolName];
  if (exact) return exact;
  if (toolName.startsWith('mcp__')) return 'mcp';
  return 'other';
}

/** How long the pulse lasts on screen, in seconds. */
export function pulseDuration(category: ToolCategory): number {
  switch (category) {
    case 'exec':
      return 0.9;
    case 'agent':
      return 1.4;
    case 'net':
      return 1.2;
    default:
      return 0.65;
  }
}
