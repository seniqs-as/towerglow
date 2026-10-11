import { MAX_SUMMARY_CHARS } from '../../shared/protocol.ts';

/**
 * From an answer to a typed outcome.
 *
 * Defensive for the same reason the transcript parser is: the text comes from a
 * model, and a model will sooner or later close the block wrong, emit two of
 * them, or forget it entirely. None of that may cost the user the answer -- a
 * report that cannot be parsed is still a report worth reading, so a failure
 * here returns `null` and the prose stands on its own.
 *
 * Everything is clipped HERE, at the source, and not left to the guard in
 * `redact.ts`. The guard's clamp counter is an invariant: it reads zero in a
 * healthy system, and a counter that ticks on ordinary traffic stops being a
 * signal that something is wrong.
 */

/** The fence the contract asks for. Named, so it cannot collide with real code. */
export const OUTCOME_FENCE = '```towerglow';
/** What a model reaches for when it ignores the name. Parsed, but never hidden. */
const FALLBACK_FENCE = '```json';
const CLOSE = '```';

/** More than this is not a list of proposals, it is a brainstorm. */
const MAX_PROPOSALS = 4;
/** A title is a headline: it goes on one line of a panel. */
const MAX_TITLE = 80;
/** One word, room for two. */
const MAX_KIND = 40;
/**
 * The full task a dedicated session will receive.
 *
 * A thousand characters and not a hundred and twenty-eight: it is an
 * assignment, not a plate. It does NOT cross the delta channel -- the browser
 * gets a copy cut to `MAX_FIELD_CHARS`, enough to read what would launch --
 * and the original stays in the proposals registry, server side.
 */
const MAX_TASK = 1000;
/** A project's name, as it appears on screen. */
const MAX_PROJECT = 64;

export interface ParsedProposal {
  kind: string;
  summary: string;
  /**
   * Which project. `null` when the proposal concerns none.
   *
   * It is the on-screen NAME, because that is the only thing the model saw in
   * the brief: resolving it to an id is the server's job, and a name that
   * matches nothing makes the proposal non-executable instead of dangerous.
   */
  project: string | null;
  /** The full task: only its start reaches the browser. */
  command: string | null;
}

export interface CeoOutcome {
  title: string;
  proposals: ParsedProposal[];
}

/**
 * The part of the answer a person reads: everything before the block.
 *
 * Only the named fence is hidden. A model that falls back to ```json still gets
 * its proposals read, but the block stays on screen -- pretending the contract
 * was honoured would hide the one piece of evidence that it was not.
 */
export function visibleProse(text: string): string {
  const cut = text.indexOf(OUTCOME_FENCE);
  return cut < 0 ? text : text.slice(0, cut);
}

function str(value: unknown, cap: number): string {
  if (typeof value !== 'string') return '';
  const t = value.trim();
  return t.length > cap ? t.slice(0, cap) : t;
}

/** The last block in the answer, or `null` if there is none worth reading. */
/**
 * The last fenced block of an answer.
 *
 * Exported because the review uses the same fence with content of its own:
 * two ways of finding the block would mean two ways of getting it wrong, and
 * the hard case -- an unclosed block, which is the normal shape of a
 * truncated answer -- is solved here once.
 */
export function lastBlock(text: string): string | null {
  for (const fence of [OUTCOME_FENCE, FALLBACK_FENCE]) {
    const open = text.lastIndexOf(fence);
    if (open < 0) continue;
    const from = open + fence.length;
    const close = text.indexOf(CLOSE, from);
    // An unterminated block is the normal shape of a truncated answer: take
    // what is there rather than throwing away a whole analysis for a newline.
    return close < 0 ? text.slice(from) : text.slice(from, close);
  }
  return null;
}

export function parseOutcome(text: string): CeoOutcome | null {
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

  const proposals: ParsedProposal[] = [];
  const list = obj['proposals'];
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (proposals.length >= MAX_PROPOSALS) break;
      if (!entry || typeof entry !== 'object') continue;
      const p = entry as Record<string, unknown>;
      const summary = str(p['summary'], MAX_SUMMARY_CHARS);
      // A proposal without a summary is not a proposal: it would reach the
      // panel as an empty card that can still be accepted.
      if (!summary) continue;
      const command = str(p['command'], MAX_TASK);
      const project = str(p['project'], MAX_PROJECT);
      proposals.push({
        kind: str(p['kind'], MAX_KIND) || 'other',
        summary,
        project: project === '' || project === 'null' ? null : project,
        command: command === '' || command === 'null' ? null : command,
      });
    }
  }

  const title = str(obj['title'], MAX_TITLE);
  // A block that carries neither a title nor a single proposal is noise that
  // happened to be valid JSON, and stamping a report on it would be a lie.
  if (!title && proposals.length === 0) return null;
  return { title: title || 'report', proposals };
}
