import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  askLabel, canJudge, changeOf, describeWindow, formatValue, headlineOf, metricRow, quotaLine,
} from '../src/client/ui/effect.ts';
import { EFFECT_METRICS } from '../src/shared/protocol.ts';
import type { EffectItem, EffectPair } from '../src/shared/protocol.ts';

/**
 * No DOM, like every client test: the decision lives in a pure function
 * precisely so that it can be defended here.
 */
function pair(over: Partial<EffectPair> = {}): EffectPair {
  return { before: 100, after: 50, beforeN: 5, afterN: 5, ...over };
}

function item(over: Partial<EffectItem> = {}): EffectItem {
  const metrics = {} as EffectItem['metrics'];
  for (const id of EFFECT_METRICS) metrics[id] = pair();
  return {
    jobId: 'j1', at: 1_700_000_000_000, provider: 'claude', kind: 'audit',
    summary: 'cut the calls', workDid: 'done', workFounded: true,
    reviewHolds: null, projectName: 'my_dashboard',
    state: 'read', reason: '4 of 5 figures readable over 5 sessions',
    metrics, beforeSessions: 5, afterSessions: 5, need: 0, needFor: null,
    quotaBefore: 1.8, quotaAfter: 1.1, quotaWindow: '7d',
    closedAt: null, closedBy: null, closesAt: 1_700_000_000_000 + 14 * 86_400_000, judged: null,
    ...over,
  };
}

test('under fifteen percent the number shows but the verdict stays silent', () => {
  // Two periods of work are never identical: a coloured "+3%" on every figure
  // would fill the screen with movements that do not change a decision.
  const c = changeOf(100, 110, 'lower');
  assert.equal(c.percent, 10);
  assert.equal(c.tone, 'flat', 'the number is there, the colour is not');
});

test('the direction decides what is better, and it is not always "less"', () => {
  assert.equal(changeOf(100, 50, 'lower').tone, 'better');
  assert.equal(changeOf(100, 50, 'higher').tone, 'worse');
  assert.equal(changeOf(50, 100, 'higher').tone, 'better');
});

test('the two figures without a direction are not coloured even when they move a lot', () => {
  // Fewer calls per turn can mean more efficiency or less work done. Green
  // would be choosing on behalf of the reader.
  assert.equal(changeOf(100, 20, 'none').tone, 'flat');
  assert.equal(metricRow('calls', pair()).tone, 'flat');
  assert.equal(metricRow('output', pair()).tone, 'flat');
});

test('a figure without a number says how many sessions are missing, not a dash', () => {
  // A dash reads as a zero. "2 more after" says the measurement is on its
  // way, which is a different thing.
  const r = metricRow('calls', pair({ after: null, afterN: 1 }));
  assert.equal(r.change, null);
  assert.equal(r.tone, 'unknown');
  assert.equal(r.shortfall, '2 more after');
});

test('the before is missing, and it does not promise sessions that will never arrive', () => {
  // The baseline is taken when the job finishes and is not recomputed: on the
  // "before" side no extra session can ever arrive. "1 more before" was a
  // wait that never ends -- measured on a real job of 13 September 2026,
  // where two figures out of five were left asking for sessions that nobody
  // could provide.
  assert.equal(metricRow('cost', pair({ before: null, beforeN: 0 })).shortfall, 'no sessions before');
  assert.equal(metricRow('yield', pair({ before: null, beforeN: 2 })).shortfall, 'only 2 before');
});

test('when both are missing the before rules: a growing after does not save the figure', () => {
  const r = metricRow('calls', pair({ before: null, beforeN: 1, after: null, afterN: 0 }));
  assert.equal(r.shortfall, 'only 1 before');
});

test('every figure has its own unit, and writing it wrong is worse than leaving it out', () => {
  assert.equal(formatValue('cache', 94), '94%');
  assert.equal(formatValue('output', 12.4), '12%');
  assert.equal(formatValue('calls', 8.27), '8.3');
  assert.equal(formatValue('cost', 2_100_000), '2.1M');
  assert.equal(formatValue('cost', null), '--');
});

test('without the same window the quota line is not written at all', () => {
  // quotaShare keeps the most consumed window, which can change between two
  // calls: two percentages on different windows side by side would read as
  // a comparison, and they would not be one.
  assert.equal(quotaLine(item({ quotaWindow: null })), null);
  assert.equal(quotaLine(item({ quotaAfter: null })), null);
  assert.match(quotaLine(item())!, /<=1.8% -> <=1.1% of 7d/);
});

test('the judge button exists only when there is something to judge', () => {
  // Asking a CEO to explain a movement that is not there yet means paying for
  // a preamble just to be told about the wait.
  assert.equal(canJudge(item({ state: 'read' })), true);
  assert.equal(canJudge(item({ state: 'waiting' })), false);
  assert.equal(canJudge(item({ state: 'void' })), false);
});

test('the line above the title says whether someone had objected', () => {
  assert.match(headlineOf(item({ reviewHolds: false })), /was objected to/);
  assert.match(headlineOf(item({ workFounded: false })), /request did not hold up/);
  assert.doesNotMatch(headlineOf(item()), /objected/);
});

test('a window closed by another job says so, instead of looking like it ended by itself', () => {
  assert.match(describeWindow(item({ closedBy: 'job' }), 0), /closed by a later job/);
  assert.match(describeWindow(item({ closedBy: 'enough' }), 0), /enough sessions/);
});

test('while it is open it says how long is left, counting from the end of the job', () => {
  const at = 1_700_000_000_000;
  const now = at + 4 * 24 * 60 * 60 * 1000;
  const closesAt = at + 14 * 86_400_000;
  assert.match(describeWindow(item({ closesAt, closedBy: null }), now), /closes in 10 days/);
  // Without a deadline from the server no duration is guessed: it says it is open.
  assert.equal(describeWindow(item({ closesAt: null, closedBy: null }), now), 'window open');
});

test('a change over a zero base does not invent a percentage', () => {
  const c = changeOf(0, 50, 'lower');
  assert.equal(c.tone, 'unknown');
  assert.equal(c.percent, 0);
});

test('the button says what you get and what it costs, not the craft of the prompt', () => {
  // "break this attribution" is the task written in `judge.ts`: whoever looks at
  // the panel has not read it, and when asked directly -- observed on 15
  // September 2026 -- did not know what the button would do.
  const fresh = item();
  assert.equal(askLabel(fresh, false), 'ask the CEO what else could explain this (costs a call)');
  assert.match(askLabel({ ...fresh, judged: { attributed: false, why: 'x', at: 1 } }, false), /^ask again/);
});

test('while waiting, the button says so: between the click and the first word there is a preamble', () => {
  assert.equal(askLabel(item(), true), 'asking the CEO...');
});
