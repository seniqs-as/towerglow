import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionsOf, metaOf, outcomeReadable, textIsStale, verdictVisibility,
} from '../src/client/ui/reports.ts';
import type { JobEvent } from '../src/client/ui/reports.ts';

/*
 * The second opinion that never showed up.
 *
 * The text of a job does not travel on the delta channel -- it is thousands
 * of characters -- and is requested by opening the row. It was requested ONLY
 * ONCE, and the second opinion necessarily ends after the outcome: whoever had
 * opened the row in the meantime was left with the answer without the review,
 * and no later event brought it to them. The row showed "the session
 * OBJECTED" and the text of the objection could not be seen anywhere, until
 * the page was reloaded. Seen in the field on 14 September 2026.
 *
 * These tests run without a DOM, like all the client ones: the decision lives
 * in a pure function precisely so that it can be defended here.
 */

function job(over: Partial<JobEvent> = {}): JobEvent {
  return {
    t: 'job',
    id: 'p-mu01weva-2',
    at: 1789319379269,
    provider: 'claude',
    kind: 'audit',
    summary: 'my_dashboard burns 29.5% of 7d quota',
    projectId: '40b163051869a85d',
    projectName: 'my_dashboard',
    state: 'done',
    // The state of whoever did the work, distinct from the turret's: while
    // the review runs `state` says `running` and this one says `done`.
    workState: 'done',
    sessionId: '157fc912-9f85-464a-8ee4-6620db840646',
    reviewState: 'running',
    reviewHolds: null,
    reviewFresh: null,
    workDid: null,
    workWrote: [],
    workFounded: null,
    toolCalls: 26,
    costUsd: 0.85,
    endedAt: null,
    reason: null,
    dismissed: false,
    ...over,
  };
}

/*
 * The log of a finished task, and the documents it wrote.
 *
 * Before, a worker's window opened only from its astronaut, which is back
 * aboard when the session ends; and the plan of a "planning only" task lived
 * in the repository with nothing on screen pointing at it. Both are buttons
 * in the row now, and this is the rule of when they are there.
 */
test('the log button needs a session and the focus capability, not the end of the job', () => {
  assert.deepEqual(actionsOf(job({ sessionId: 'abc', workWrote: [] }), true), { log: true, docs: [] });
  assert.deepEqual(actionsOf(job({ sessionId: 'abc', workState: 'running', state: 'running' }), true).log, true, 'a running job follows');
  assert.equal(actionsOf(job({ sessionId: null }), true).log, false, 'no session, no transcript to show');
  assert.equal(actionsOf(job({ sessionId: 'abc' }), false).log, false, 'with --no-focus nothing opens windows');
});

test('each document the worker wrote is offered, in the order it named them', () => {
  const docs = ['docs/player_involvement_plan.md', 'docs/notes.md'];
  assert.deepEqual(actionsOf(job({ workWrote: docs }), true).docs, docs);
  assert.deepEqual(actionsOf(job({ workWrote: docs }), false).docs, [], 'the server could not open them');
});

test('a review that ends after the outcome makes the cached text get thrown away', () => {
  const before = job({ reviewState: 'running', reviewHolds: null });
  const after = job({ reviewState: 'done', reviewHolds: false });
  assert.equal(textIsStale(before, after), true);
});

test('a FAILED review changes the text too: the reason must be read', () => {
  const before = job({ reviewState: 'running' });
  const after = job({ reviewState: 'failed' });
  assert.equal(textIsStale(before, after), true);
});

test('a job that ends while the row is open makes the text get thrown away', () => {
  const before = job({ state: 'running', reviewState: null });
  const after = job({ state: 'done', reviewState: null });
  assert.equal(textIsStale(before, after), true);
});

test('a growing job does NOT make the text be requested again at every tool call', () => {
  // The opposite regression, and it would cost more than the bug: `progress`
  // sends an event for every tool call, and throwing the cache away there
  // would mean requesting ten thousand characters every few seconds while you
  // are reading them.
  const before = job({ toolCalls: 26, costUsd: 0.85 });
  const after = job({ toolCalls: 27, costUsd: 5.25 });
  assert.equal(textIsStale(before, after), false);
});

test('closing the turret does not touch the text: closing is not deleting', () => {
  const before = job({ dismissed: false });
  const after = job({ dismissed: true });
  assert.equal(textIsStale(before, after), false);
});

test('a verdict that arrives without a state change is not enough to throw the text away', () => {
  // `reviewHolds` alone moves nothing: it ALWAYS arrives together with the
  // final state of the review, and that is what decides. If one day it arrived
  // alone, this test will say the rule needs rethinking instead of pretending.
  const before = job({ reviewState: 'done', reviewHolds: null });
  const after = job({ reviewState: 'done', reviewHolds: true });
  assert.equal(textIsStale(before, after), false);
});

/*
 * The review behind its own button ("agent's feedback").
 *
 * It used to be always open under the outcome, and in a row that tall you
 * read "the session OBJECTED" in the meta and then had to know the text was
 * down there. Now it is something that opens, with the same shape as the row:
 * a button and a small triangle.
 */

test('no review, no REVIEW command: nothing opens onto emptiness', () => {
  // The name is capitalized because that state is no longer empty: it is
  // exactly there that ANOTHER command is offered, `ask the agent`. The two
  // are two things -- one opens a text that exists, the other starts a
  // process -- and this test defends only the first.
  assert.deepEqual(verdictVisibility(null, false), { button: false, text: false });
  // Open or closed changes nothing when there is nothing to open: a review
  // that does not start is not a failure, and must not look like one.
  assert.deepEqual(verdictVisibility(null, true), { button: false, text: false });
});

test('while the session answers the command is not offered yet', () => {
  // The meta already says so ("asking the session"). Offering to read an
  // answer that has not arrived would mean opening an empty box.
  assert.deepEqual(verdictVisibility('running', false), { button: false, text: false });
});

test('the command is decided by the state and not by the text, which arrives later', () => {
  // That is the point of the hint: if it depended on the text it would appear
  // only AFTER opening the outcome, that is, too late to tell you it exists.
  assert.deepEqual(verdictVisibility('done', false), { button: true, text: false });
  assert.deepEqual(verdictVisibility('done', true), { button: true, text: true });
});

test('a failed review has a command too: the reason must be read', () => {
  assert.deepEqual(verdictVisibility('failed', true), { button: true, text: true });
});

test('the outcome is readable as soon as the job ends, even if the review is still running', () => {
  // The defect `workState` fixes: the turret runs as long as either of the
  // two parts runs, and with `state` the outcome stayed hidden until the end
  // of the review -- that is, exactly when you wanted to read the thing the
  // review judges.
  assert.equal(outcomeReadable('done'), true);
  assert.equal(outcomeReadable('failed'), true);
  assert.equal(outcomeReadable('running'), false);
});

test('a job without a review declares it, instead of staying silent', () => {
  // "The session did not object" and "there was no session to ask", left
  // unsaid, read as the same thing.
  const withoutReview = metaOf(job({ state: 'done', workState: 'done', reviewState: null }));
  assert.match(withoutReview, /no second opinion yet/);
  const withReview = metaOf(job({ state: 'done', workState: 'done', reviewState: 'done' }));
  assert.equal(withReview.includes('no second opinion yet'), false);
  const running = metaOf(job({ state: 'running', workState: 'running', reviewState: null }));
  assert.equal(
    running.includes('no second opinion yet'), false,
    'while it works it is not yet the moment to say so',
  );
});

/*
 * What the worker says, readable without opening anything.
 *
 * The worker produces two things besides the outcome: a line on what it
 * actually did, and whether the request held up. They only ended up in the
 * CEO memory -- a file the user never opens -- while the Reports row showed
 * the summary of the PROPOSAL, that is the CEO sentence, with its numbers in
 * it even when the worker had opened its answer by disproving them.
 *
 * It costs nothing, unlike the review: it comes from a process that was
 * working anyway. Measured: two jobs out of two reported the false premise.
 */

test('a premise that does not hold up can be read in the row, without opening anything', () => {
  const line = metaOf(job({ workFounded: false, workDid: 'categorized 72 commits' }));
  assert.match(line, /the request did not hold up/);
});

test('a well-founded request adds no noise to the row', () => {
  const line = metaOf(job({ workFounded: true, workDid: 'cut the calls by 30%' }));
  assert.equal(line.includes('did not hold up'), false);
});

test('a job without an outcome block says nothing instead of inventing', () => {
  // `workFounded` null means "I do not know", and must not be confused with
  // "it held up": the model may have forgotten the block, and no judgement is
  // built on that silence.
  const line = metaOf(job({ workFounded: null, workDid: null }));
  assert.equal(line.includes('did not hold up'), false);
});

test('the review of whoever judges and the line of whoever did the work sit together', () => {
  // They are two different things and can both be true: the worker found the
  // premise false AND the session objected to the advice.
  const line = metaOf(job({
    workFounded: false, reviewHolds: false, reviewState: 'done',
    workDid: 'nothing to consolidate',
  }));
  assert.match(line, /the request did not hold up/);
  assert.match(line, /the session OBJECTED/);
  // First whoever did the work, then whoever judges: it is the order they
  // arrive in, and the order in which the second leans on the first.
  assert.ok(
    line.indexOf('did not hold up') < line.indexOf('OBJECTED'),
    'the reviewer verdict must not come before that of whoever did the work',
  );
});

/*
 * Two voices, two weights, two names.
 *
 * When no session of that project is open, the review comes from a fresh
 * session that has read the repository: useful, but it does not know why the
 * work was done that way. Calling it "the session" would give it the
 * authority of someone who was there.
 */

test('the review of whoever was working there speaks in the name of the session', () => {
  const line = metaOf(job({ reviewState: 'done', reviewHolds: false, reviewFresh: false }));
  assert.match(line, /the session OBJECTED/);
});

test('a check by a fresh session does not pass itself off as someone who was there', () => {
  const line = metaOf(job({ reviewState: 'done', reviewHolds: false, reviewFresh: true }));
  assert.match(line, /a fresh check OBJECTED/);
  assert.equal(line.includes('the session OBJECTED'), false);
});

test('even while it runs it is known which of the two is being waited for', () => {
  const resumed = metaOf(job({ reviewState: 'running', reviewFresh: false }));
  assert.match(resumed, /asking the session/);
  const fresh = metaOf(job({ reviewState: 'running', reviewFresh: true }));
  assert.match(fresh, /checking the premises/);
});

test('an agreement is worth as much as whoever gives it, and says so', () => {
  assert.match(metaOf(job({ reviewState: 'done', reviewHolds: true, reviewFresh: false })), /the session agrees/);
  assert.match(metaOf(job({ reviewState: 'done', reviewHolds: true, reviewFresh: true })), /a fresh check agrees/);
});
