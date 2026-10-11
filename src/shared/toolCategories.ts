import type { ToolCategory } from './protocol.ts';

/**
 * From tool name to category. The category decides the pulse's color, so by
 * looking at the city you can tell WHAT an agent is doing without reading a
 * line of text.
 *
 * An unknown tool ends up in `other` instead of breaking something: names
 * change across Claude Code versions, and this list ages.
 */
const EXACT: Record<string, ToolCategory> = {
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
