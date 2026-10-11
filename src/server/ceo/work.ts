import { MAX_FIELD_CHARS } from '../../shared/protocol.ts';
import { lastBlock, OUTCOME_FENCE } from './outcome.ts';
import type { Proposal } from './proposals.ts';
import { MAX_NOTE_CHARS } from './memory.ts';

/**
 * The task that goes to the worker, and the line that remembers it.
 *
 * Twin of `review.ts`, and born from a gap that showed only by looking at the
 * memory on disk: the CEO has a fenced block for its own proposals
 * (`outcome.ts`), the reviewer has one for the verdict (`review.ts`), the
 * worker had NONE. It received the CEO's sentence on stdin and gave back
 * prose, so the note that ended up in memory was the echo of the proposal.
 *
 * Measured on 14 September 2026: after a real job on decsim2, `memory.json`
 * held a single line -- "already done: decsim2 consumed peak cognitive
 * load (1.3M thinking, 2.7M output) across 14 sessions; review 20 commits and
 * stabilize for release" -- that is, the CEO's sentence sent back to the CEO,
 * with its own wrong numbers inside: the commits were 72, not 20. The worker
 * had found this out and written it in the first line of its answer, and that
 * line reached nobody.
 *
 * Hence the contract. The worker says two things: what it actually did, and
 * whether the request stood up. The second is the most valuable, for the same
 * reason the second opinion is worth having -- whoever works sees the
 * project, the CEO sees its statistics.
 */

/** What the CEO must remember about a job done. */
export interface WorkReport {
  /** One line: the one that goes into memory in place of the proposal's summary. */
  did: string;
  /**
   * The request stood up.
   *
   * False when it rested on something that is not true here. Not a textbook
   * case: two workers out of two refuted the brief's numbers in the first line
   * of their answer, and without this field the CEO stays convinced it was
   * right and proposes it to you again.
   */
  founded: boolean;
  /**
   * The documents it wrote for you to read, as paths inside the project.
   *
   * A "planning only" task leaves its plan as a markdown file in the
   * repository -- the ledger keeps twenty thousand characters of outcome and
   * the first real plan was forty-seven thousand -- and this is how Reports
   * learns where: each path becomes a button. Empty when the work was code.
   */
  wrote: string[];
}

/**
 * How many documents a worker may hand over. A plan is one file, a study a
 * few; a list of everything it touched would be the diff, which is git's.
 */
export const MAX_DOCUMENTS = 8;

/**
 * The document paths from a block, as the ledger may keep them.
 *
 * Relative, inside the project, short enough for the delta channel, no
 * duplicates. A path is dropped rather than cut: half a path is not a path.
 * The server checks each one again against the real folder before it opens
 * anything; this is the shape, not the permission.
 */
export function documentsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const p = item.trim().replace(/^\.\//, '');
    if (!p || p.length > MAX_FIELD_CHARS) continue;
    if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) continue;
    if (p.split(/[\\/]/).includes('..')) continue;
    if (out.includes(p)) continue;
    out.push(p);
    if (out.length >= MAX_DOCUMENTS) break;
  }
  return out;
}

/**
 * The task, on stdin.
 *
 * On stdin and not on the command line for the usual reason: the command line
 * and `cwd` stay identical at every call because that is how the prompt cache
 * holds, and only the message varies.
 *
 * The task stays the FIRST thing, verbatim and without framing: it is what you
 * accepted, and it must be carried out. The rest is a request for a report,
 * not a change of assignment -- that is why the order is task, then block,
 * and why the block asks for one line and not a report.
 */
export function workTask(proposal: Proposal): string {
  const where = proposal.projectName ? ` on ${proposal.projectName}` : '';
  return [
    proposal.task ?? proposal.summary,
    '',
    '---',
    '',
    `This work${where} was proposed by the ${proposal.provider} CEO, which sees usage`,
    'numbers and not reasons. If it turns out the request rests on something that is',
    'not true here -- wrong counts, a premise that does not hold, work already done --',
    'say so plainly and do the part that does make sense. Saying it is worth more than',
    'quietly working around it: it is the only way that finding reaches the CEO.',
    '',
    // For Claude a deny-list holds this too; Codex has no per-command rule,
    // so for it this line is the fence.
    'Do not commit and do not push: leave your changes in the working tree, where',
    'the user reviews them before anything is recorded.',
    '',
    'End your answer with this block, and nothing after it:',
    OUTCOME_FENCE,
    '{"did": "one line: what you actually did", "founded": true}',
    '```',
    '`founded` is false when the request rested on something untrue here. `did` is one',
    'line, and it is the only part of your answer the CEO will remember.',
  ].join('\n');
}

/**
 * The worker's line from the fenced block.
 *
 * Defensive like `parseVerdict`, and for the same reason: a model writes the
 * text, and sooner or later it will close the block badly or forget it. None
 * of this may cost the outcome -- the prose stays readable in Reports
 * anyway -- so here we return `null` and the caller knows what to do.
 */
export function parseWorkReport(text: string): WorkReport | null {
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

  const line = obj['did'];
  if (typeof line !== 'string' || line.trim().length === 0) return null;
  return {
    did: line.trim().slice(0, MAX_NOTE_CHARS),
    // Only an explicit `false` counts as "unfounded", as for `holds`: a missing
    // field is a model that did not answer the question, not a model that
    // declares the request founded.
    founded: obj['founded'] !== false,
    wrote: documentsOf(obj['wrote']),
  };
}
