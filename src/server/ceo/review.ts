import { lastBlock, OUTCOME_FENCE } from './outcome.ts';
import type { Proposal } from './proposals.ts';
import { MAX_NOTE_CHARS } from './memory.ts';

/**
 * The review: whoever is doing the work is asked whether the advice holds.
 *
 * A project's CEO sees the statistics and not the reasons: it knows a session
 * spent 212 tool calls, it does not know WHY. Whoever is working there knows,
 * and that context is on disk in their transcript. Resuming it with a fork --
 * `--resume ... --fork-session` -- gives a reviewer that knows everything the
 * session knew, without writing a line into the live session.
 *
 * The question asks for OBJECTIONS and not approval, and that is the choice
 * that decides whether this function is any use. An agent of the same family
 * is being asked to judge a finding about its own habits: its "these are good
 * suggestions" is the default answer and is worth nothing. What is worth
 * something is its "this does not apply, because here the constraint is a
 * different one" -- which is exactly what the CEO could not know.
 */

/**
 * The task that goes to the reviewer, on stdin.
 *
 * On stdin and not on the command line: the command line and `cwd` stay
 * identical at every call because that is how the prompt cache holds, and
 * only the message varies.
 */
export function reviewTask(proposal: Proposal): string {
  const where = proposal.projectName ? ` on ${proposal.projectName}` : '';
  return [
    `The ${proposal.provider} CEO looked at this project from the outside -- it sees`,
    'usage numbers, not reasons -- and proposed the following work' + where + '.',
    '',
    `PROPOSAL (${proposal.kind}): ${proposal.summary}`,
    proposal.task ? `TASK: ${proposal.task}` : '',
    '',
    'You have the context it does not. Judge it, and be concrete: which parts do',
    'NOT apply here, and because of which constraint it could not see? Say so even',
    'if most of it is fine. Agreeing is the cheap answer and is worth nothing --',
    'if you have no objection, say that plainly and say why the reasoning holds.',
    '',
    'Change nothing. This is a second opinion, not the work.',
    '',
    'End your answer with this block, and nothing after it:',
    OUTCOME_FENCE,
    '{"verdict": "one line: the single thing the CEO should know", "holds": true}',
    '```',
    '`holds` is false when a substantial part of the proposal does not apply here.',
  ].filter((l) => l !== undefined).join('\n');
}

/**
 * The question to whoever was NOT there: a new session, opened just now in
 * the project.
 *
 * It is needed because work on a project happens in shifts: a proposal
 * accepted in the evening finds nobody to resume, and before this it was left
 * without a review. A new session costs a fraction of a fork -- it has no
 * transcript to go over -- but it knows one thing only: how the repository
 * is made.
 *
 * So the question is a different one, and saying so is everything: not "you
 * have the context the CEO lacks", which here would be false, but "verify the
 * premises". The numbers in a brief are checked with `git log` and with the
 * files, and on decsim2 that was enough to discover that the "20 commits"
 * were 72. Asking a five-minute newcomer why the work was done that way would
 * instead produce the worst answer of all: an invented explanation that
 * sounds plausible.
 */
export function freshReviewTask(proposal: Proposal): string {
  const where = proposal.projectName ? ` on ${proposal.projectName}` : '';
  return [
    `The ${proposal.provider} CEO looked at this project from the outside -- it sees`,
    'usage numbers, not reasons -- and proposed the following work' + where + '.',
    '',
    `PROPOSAL (${proposal.kind}): ${proposal.summary}`,
    proposal.task ? `TASK: ${proposal.task}` : '',
    '',
    'No session of this project is open, so nobody can tell you WHY the work was',
    'done the way it was. Do not guess at it: an invented reason that sounds',
    'plausible is worse than no answer.',
    '',
    'What you CAN do is check the premises against the repository itself. Every',
    'number in that proposal came from outside and may be wrong: verify the ones',
    'that matter with git and with the files. Read the project instructions --',
    'CLAUDE.md, AGENTS.md, README -- and say if what is being proposed is ruled',
    'out by a constraint written there. Then say whether the premises hold.',
    '',
    'Change nothing. This is a second opinion, not the work.',
    '',
    'End your answer with this block, and nothing after it:',
    OUTCOME_FENCE,
    '{"verdict": "one line: the single thing the CEO should know", "holds": true}',
    '```',
    '`holds` is false when a premise does not survive the check.',
  ].filter((l) => l !== undefined).join('\n');
}

/** What the CEO must remember about this review. */
export interface Verdict {
  /** One line: it is the one that goes into the memory and the brief. */
  verdict: string;
  /** False when a substantial part of the proposal does not apply. */
  holds: boolean;
}

/**
 * The verdict from the fenced block.
 *
 * Defensive like `parseOutcome` and for the same reason: a model writes the
 * text, and sooner or later it will close the block badly, emit two of them,
 * or forget it. None of this may cost the review -- the prose stays readable
 * in Reports anyway -- so here we return `null` and the CEO simply takes no
 * note.
 */
export function parseVerdict(text: string): Verdict | null {
  const block = lastBlock(text);
  if (!block || !block.trim()) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const line = obj['verdict'];
  if (typeof line !== 'string' || line.trim().length === 0) return null;
  return {
    verdict: line.trim().slice(0, MAX_NOTE_CHARS),
    // Only an explicit `false` counts as an objection: a missing field is a
    // model that did not answer the question, not a model that agrees.
    holds: obj['holds'] !== false,
  };
}
