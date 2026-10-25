import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareOperator, WorkMeter } from '../src/server/state/workMeter.ts';
import { OPERATOR_CAP_MS } from '../src/shared/protocol.ts';

/**
 * A project's hours, for its funders (the user's request, 2026-10-24): how
 * long the agents worked, and how long the person at the keyboard did.
 */

const T0 = Date.parse('2026-10-20T09:00:00.000Z');
const MIN = 60_000;

test('the AI time is the tool\'s own measure of each turn, not the span around it', () => {
  // Measured: where the span and `turn_duration` differ the turn waited,
  // and the tool leaves the wait out. Its number is the one that holds.
  const m = new WorkMeter();
  m.prompt(T0, true);
  m.activity(T0 + 2 * MIN);
  m.turnEnd(T0 + 60 * MIN, 12 * MIN);
  assert.equal(m.totals().aiMs, 12 * MIN);
});

test('a worker\'s turn, which never writes its duration, runs to the last thing it did', () => {
  // `claude -p` writes no `turn_duration`: every worker of a plan read zero
  // hours of AI until this.
  const m = new WorkMeter();
  m.prompt(T0, false);
  m.activity(T0 + 5 * MIN);
  m.activity(T0 + 25 * MIN);
  assert.equal(m.totals().aiMs, 25 * MIN);
  // Resumed with your answer: the first turn ended where it stopped.
  m.prompt(T0 + 90 * MIN, false);
  m.activity(T0 + 100 * MIN);
  assert.equal(m.totals().aiMs, 35 * MIN);
});

test('a turn still open counts for the model it runs on, and one killed before replying for the last one', () => {
  // The card reads open sessions: the split must sum to the AI time there too.
  const m = new WorkMeter();
  m.prompt(T0, true);
  m.model('claude-opus-5-5', 'xhigh');
  m.activity(T0 + 4 * MIN);
  assert.deepEqual(m.totals().models, [{ model: 'claude-opus-5-5', effort: 'xhigh', aiMs: 4 * MIN }]);
  m.turnEnd(T0 + 5 * MIN, 5 * MIN);
  // Stopped before its first reply: nothing named another model.
  m.prompt(T0 + 8 * MIN, true);
  m.activity(T0 + 9 * MIN);
  m.prompt(T0 + 12 * MIN, true);
  const t = m.totals();
  assert.equal(t.aiMs, 6 * MIN);
  assert.deepEqual(t.models, [{ model: 'claude-opus-5-5', effort: 'xhigh', aiMs: 6 * MIN }]);
});

test('time before the session\'s first reply goes to the first model it names', () => {
  // Measured on 2026-10-25: a `/clear` and messages queued behind it made
  // nine minutes of turn before any reply named a model.
  const m = new WorkMeter();
  m.prompt(T0, true);
  m.activity(T0 + 9 * MIN);
  m.prompt(T0 + 11 * MIN, true);
  assert.deepEqual(m.totals().models, []);
  m.model('claude-opus-5-5', 'xhigh');
  m.turnEnd(T0 + 12 * MIN, MIN);
  const t = m.totals();
  assert.equal(t.aiMs, 10 * MIN);
  assert.deepEqual(t.models, [{ model: 'claude-opus-5-5', effort: 'xhigh', aiMs: 10 * MIN }]);
});

test('your time is the stretch since the session last did anything, up to the cap', () => {
  const m = new WorkMeter();
  m.prompt(T0, true);
  m.turnEnd(T0 + 4 * MIN, 4 * MIN);
  m.prompt(T0 + 7 * MIN, true); // read the answer, wrote the next: three minutes
  m.turnEnd(T0 + 8 * MIN, MIN);
  m.prompt(T0 + 8 * 60 * MIN, true); // back after lunch: the cap, not seven hours
  assert.deepEqual(m.totals().operator, [
    T0 + 4 * MIN, T0 + 7 * MIN,
    T0 + 8 * 60 * MIN - OPERATOR_CAP_MS, T0 + 8 * 60 * MIN,
  ]);
});

test('a session\'s first message and a script\'s messages count none of your time', () => {
  const m = new WorkMeter();
  m.prompt(T0, true);
  assert.deepEqual(m.totals().operator, []);
  const worker = new WorkMeter();
  worker.prompt(T0, false);
  worker.activity(T0 + MIN);
  worker.prompt(T0 + 3 * MIN, false);
  assert.deepEqual(worker.totals().operator, []);
});

test('a message typed while the agent works joins its turn instead of ending it', () => {
  const m = new WorkMeter();
  m.prompt(T0, true);
  m.activity(T0 + MIN);
  m.prompt(T0 + 2 * MIN, true, true);
  m.activity(T0 + 9 * MIN);
  m.turnEnd(T0 + 10 * MIN, 0);
  assert.equal(m.totals().aiMs, 10 * MIN);
});

test('a turn you stop runs until you stopped it', () => {
  const m = new WorkMeter();
  m.prompt(T0, true);
  m.activity(T0 + MIN);
  m.abort(T0 + 3 * MIN);
  assert.equal(m.totals().aiMs, 3 * MIN);
});

test('a stretch with two projects waiting on you counts half in each', () => {
  // You cannot be in two places at once, and a funder of one project should
  // not pay for the minutes of another.
  const shares = shareOperator([
    { id: 'a', projectId: 'p1', spans: [0, 10 * MIN] },
    { id: 'b', projectId: 'p2', spans: [5 * MIN, 15 * MIN] },
  ]);
  assert.equal(shares.get('a'), 5 * MIN + 2.5 * MIN);
  assert.equal(shares.get('b'), 2.5 * MIN + 5 * MIN);
  assert.equal((shares.get('a') ?? 0) + (shares.get('b') ?? 0), 15 * MIN);
});

test('two sessions on the same project give it the stretch once, shared between them', () => {
  const shares = shareOperator([
    { id: 'a', projectId: 'p1', spans: [0, 10 * MIN] },
    { id: 'b', projectId: 'p1', spans: [0, 10 * MIN] },
    { id: 'c', projectId: 'p2', spans: [0, 10 * MIN] },
  ]);
  assert.equal(shares.get('a'), 2.5 * MIN);
  assert.equal(shares.get('b'), 2.5 * MIN);
  assert.equal(shares.get('c'), 5 * MIN);
});

test('spans that only touch do not overlap, and a session with none has a share of zero', () => {
  const shares = shareOperator([
    { id: 'a', projectId: 'p1', spans: [0, 5 * MIN, 20 * MIN, 21 * MIN] },
    { id: 'b', projectId: 'p2', spans: [5 * MIN, 9 * MIN] },
    { id: 'c', projectId: 'p3', spans: [] },
  ]);
  assert.equal(shares.get('a'), 6 * MIN);
  assert.equal(shares.get('b'), 4 * MIN);
  assert.equal(shares.get('c'), 0);
});
