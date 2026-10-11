import { MAX_FIELD_CHARS } from '../../shared/protocol.ts';
import { FOLLOW_DAYS } from './effect.ts';
import { jobLabel } from './jobs.ts';
import type { Job } from './jobs.ts';
import type { CeoMemory, NoteKind } from './memory.ts';
import type { Proposal } from './proposals.ts';
import { parseVerdict } from './review.ts';
import type { Verdict } from './review.ts';

/**
 * What the CEO remembers of a job, rebuilt from the job itself.
 *
 * The notes about a job used to be written once, when a process ended, and
 * never looked at again. Two things went wrong with that, both measured on
 * disk on 18 September 2026:
 *
 *  - The decsim2 job was remembered as "already done: ... review 20 commits
 *    and stabilize for release" -- the CEO's own sentence, wrong count
 *    included, from before the worker had a line of its own. The job record
 *    was later corrected ("72 commits from git log, not 20"), the memory was
 *    not, and the CEO proposed the same 20-commit review twice more.
 *  - The effect of one audit piled up as four lines (see `Note.key`).
 *
 * So the job registry is the source and the memory is its projection: every
 * note about a job has a key, and at start the notes are rebuilt from
 * `jobs.json`. A correction made to a job reaches the CEO at the next start
 * instead of never.
 */

/** A note that comes from a job, keyed so each part of it is one line. */
export interface JobNote {
  key: string;
  kind: NoteKind;
  at: number;
  text: string;
}

/**
 * The line about the work itself.
 *
 * The WORKER's line, not the echo of the proposal.
 *
 * Until now it wrote `already done: <summary>`, i.e. the CEO's sentence sent
 * back to the CEO: the memory confirmed its own numbers to it, the wrong ones
 * included. The line of whoever did the work is worth more for the same
 * reason the second opinion is -- it saw the project, not its statistics --
 * and when it says the request did not hold up, that is the most valuable
 * note in the whole file: it is the only thing that stops the CEO from
 * proposing the same job to you again tomorrow on the same wrong numbers.
 *
 * Without a readable block the summary stays, and that is intended: for the
 * review, silence is free (the CEO simply takes no note), for a job it is not
 * -- a CEO that does not know it already did it proposes it to you again. But
 * it is said as what it is: the CEO's own words, which nobody checked.
 */
export function workNote(job: Job): JobNote | null {
  if (job.work.state === 'running') return null;
  const name = jobLabel(job);
  const note = (kind: NoteKind, text: string): JobNote =>
    ({ key: `work:${job.id}`, kind, at: job.work.endedAt ?? job.at, text });

  if (job.work.state === 'failed') {
    return note('done', `tried (${name}) and it did not finish (${job.work.reason || 'no reason given'}): ${job.summary}`);
  }
  if (job.workDid === null) {
    return note('done', `already done (${name}), in your own unchecked words: ${job.summary}`);
  }
  return job.workFounded === false
    ? note('objection', `done (${name}), but the request did not hold up: ${job.workDid}`)
    : note('done', `already done (${name}): ${job.workDid}`);
}

/**
 * The line about the second opinion.
 *
 * `verdict` is the one parsed from the whole answer when the review has just
 * ended; at start it is parsed again from the stored outcome. No readable
 * block, no note: better not to know than to remember a sentence invented by
 * an optimistic parser.
 */
export function reviewNote(job: Job, verdict: Verdict | null = null): JobNote | null {
  const part = job.review;
  if (!part || part.state === 'running') return null;
  const v = verdict ?? parseVerdict(part.outcome);
  if (!v) return null;
  /*
   * The memory too distinguishes who answered: a note that said "the session
   * that works there" for a session opened five minutes earlier would give
   * the CEO a more authoritative source than the one it had -- and the memory
   * is exactly the place where that difference matters, because the next
   * proposal will start from there.
   */
  const source = job.reviewFresh
    ? 'a fresh session opened in the project'
    : 'the session that works there';
  const name = jobLabel(job);
  return {
    key: `review:${job.id}`,
    kind: 'objection',
    at: part.endedAt ?? job.at,
    text: v.holds
      ? `checked (${name}) with ${source}, and it holds: ${v.verdict}`
      : `${source} objected to ${name}: ${v.verdict}`,
  };
}

/** Writes what there is to know about `job`. Unchanged lines change nothing. */
export function recallJob(memory: CeoMemory, job: Job, verdict: Verdict | null = null): void {
  for (const n of [workNote(job), reviewNote(job, verdict)]) {
    if (n) memory.note({ ...n, provider: job.provider, project: job.projectName });
  }
}

/**
 * At start: the job notes come back from the registry.
 *
 * The unkeyed `done`, `objection` and `effect` notes are the ones written
 * before keys existed, and every one of them came from a job: they are
 * dropped and rebuilt, which is what turns the stale decsim2 line into the
 * worker's. `rejected` notes come from a decision, not from a job, and stay.
 * The effect lines are rebuilt by the next refresh of the measure, which runs
 * before every brief.
 */
export function rebuildJobNotes(memory: CeoMemory, jobs: readonly Job[]): void {
  memory.forget((n) => n.key === undefined && n.kind !== 'rejected');
  for (const j of jobs) recallJob(memory, j);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What the proposal card says when the project was already worked on.
 *
 * The prompt tells the CEO not to propose again what is done, and on
 * 16 September it proposed the decsim2 review it had had done two days before;
 * you accepted it, because nothing on the card said so. An instruction in a
 * prompt is a request. This is on the server and on the card: the last job on
 * the same project within the effect window, and how it went. Nothing is
 * blocked -- the decision stays yours, it is just no longer taken blind.
 *
 * `FOLLOW_DAYS` because it is the window in which the earlier job is still
 * being measured, and a second job on the same project cuts that measure
 * short. One line, inside the field cap of the delta channel.
 */
export function precedentOf(
  p: Pick<Proposal, 'id' | 'projectId' | 'at'>, jobs: readonly Job[],
): string | null {
  if (p.projectId === null) return null;
  let last: Job | null = null;
  for (const j of jobs) {
    if (j.id === p.id || j.projectId !== p.projectId || j.at >= p.at) continue;
    if (p.at - j.at > FOLLOW_DAYS * DAY_MS) continue;
    if (!last || j.at > last.at) last = j;
  }
  if (!last) return null;

  const how = last.work.state === 'running'
    ? 'still running'
    : last.work.state === 'failed'
      ? 'it did not finish'
      : last.workFounded === false || last.reviewHolds === false
        ? 'the request did not hold up'
        : 'done';
  const day = new Date(last.at).toISOString().slice(0, 10);
  const kind = last.kind.trim().slice(0, 24) || 'job';
  const line = `Already worked on here: ${kind} of ${day}, ${how}. ${last.workDid ?? last.summary}`;
  return line.length < MAX_FIELD_CHARS ? line : `${line.slice(0, MAX_FIELD_CHARS - 4)}...`;
}
