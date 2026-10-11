import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeTask, parseJudgement } from '../src/server/ceo/judge.ts';
import { METRICS } from '../src/server/ceo/effect.ts';
import type { EffectReading, EffectSide } from '../src/server/ceo/effect.ts';
import type { Job } from '../src/server/ceo/jobs.ts';

function side(over: Partial<Record<(typeof METRICS)[number], { value: number | null; n: number }>> = {}): EffectSide {
  const s = {} as EffectSide;
  for (const id of METRICS) s[id] = over[id] ?? { value: 100, n: 5 };
  return s;
}

function reading(over: Partial<EffectReading> = {}): EffectReading {
  return {
    state: 'read',
    reason: 'read',
    baseline: {
      at: 1000, projectId: 'p1', provider: 'claude', from: 0, to: 1000,
      sessions: 5, side: side(),
    },
    after: side({ cost: { value: 62, n: 4 } }),
    afterSessions: 4,
    need: 0,
    needFor: null,
    closedAt: null,
    closedBy: null,
    ...over,
  };
}

function job(over: Partial<Job> = {}): Job {
  return {
    id: 'j1', at: 1000, provider: 'claude', kind: 'audit',
    summary: 'cut the calls by 30%',
    projectId: 'p1', projectName: 'my_dashboard',
    work: {
      state: 'done', sessionId: 'w1', toolCalls: 26, costUsd: 1,
      outcome: 'done', truncated: false, reason: '', endedAt: 2000,
    },
    review: null, reviewHolds: null, reviewFresh: null,
    workDid: 'replaced the per-file greps with a recursive one',
    workFounded: true, dismissed: false, effect: null,
    ...over,
  };
}

test('the question asks to break the attribution, not to claim it', () => {
  // The point of the whole mechanism: to "did it work?" the zero-cost answer
  // is yes, and it carries no information. The opposite is asked.
  const text = judgeTask(job(), reading());
  assert.match(text, /BREAK the attribution/);
  assert.match(text, /Claiming these numbers is the cheap answer/);
  assert.match(text, /name the thing OTHER than your advice/);
});

test('the question declares that it was not an experiment', () => {
  // Without it, the model reads two columns of numbers and treats them as a
  // controlled before and after, which they are not.
  const text = judgeTask(job(), reading());
  assert.match(text, /NOT an experiment/);
  assert.match(text, /Nobody held anything constant/);
});

test('a figure without enough sessions is called missing, never unchanged', () => {
  const r = reading({ after: side({ calls: { value: null, n: 1 } }) });
  const text = judgeTask(job(), r);
  assert.match(text, /missing, not unchanged/);
});

test('the cohorts travel next to the numbers, or a minus thirty over two sessions looks like a fact', () => {
  const text = judgeTask(job(), reading());
  assert.match(text, /5 sessions before, 4 after/);
  assert.match(text, /\[5 vs 4 sessions\]/);
});

test('the two figures without a direction declare it in the prompt', () => {
  const text = judgeTask(job(), reading());
  assert.match(text, /no better or worse direction/);
});

test('when the worker had refuted the request, the judge knows it', () => {
  const text = judgeTask(job({ workFounded: false }), reading());
  assert.match(text, /rested on something untrue/);
});

test('when the second opinion had objected, the judge knows it', () => {
  const text = judgeTask(job({ reviewHolds: false }), reading());
  assert.match(text, /second opinion objected/);
});

test('attributed is true only if the CEO writes it: a missing field is a no', () => {
  // The OPPOSITE direction of `holds` and `founded`. There, a missing field is
  // a model that did not answer and the neutral assumption is "it holds". Here
  // the zero-cost answer is "yes, it was my doing", and forgetting the field
  // must not be able to count as a merit.
  const missing = parseJudgement('bla\n```towerglow\n{"why":"shorter tasks"}\n```', 5);
  assert.equal(missing?.attributed, false);

  const explicit = parseJudgement('```towerglow\n{"why":"x","attributed":true}\n```', 5);
  assert.equal(explicit?.attributed, true);

  const asString = parseJudgement('```towerglow\n{"why":"x","attributed":"true"}\n```', 5);
  assert.equal(asString?.attributed, false, 'the string "true" is not a true');
});

test('without a readable block nothing is attributed to anyone', () => {
  assert.equal(parseJudgement('prose only, no block', 1), null);
  assert.equal(parseJudgement('```towerglow\nnot json\n```', 1), null);
  assert.equal(parseJudgement('```towerglow\n{"attributed":true}\n```', 1), null);
  assert.equal(parseJudgement('```towerglow\n{"why":"   "}\n```', 1), null);
});

test('the why is one line, not a paragraph: it gets cut', () => {
  const long = 'x'.repeat(500);
  const v = parseJudgement(`\`\`\`towerglow\n{"why":"${long}"}\n\`\`\``, 1);
  assert.equal(v?.why.length, 200);
});

test('the judgement carries the time it is given, not the clock\'s', () => {
  // Injected dependency, as everywhere: a test that looked at Date.now() would
  // measure when it runs, not what it does.
  const v = parseJudgement('```towerglow\n{"why":"x"}\n```', 12_345);
  assert.equal(v?.at, 12_345);
});

test('an empty block of proposals is a legitimate answer, and the prompt says so', () => {
  const text = judgeTask(job(), reading());
  assert.match(text, /an empty\n?\s*list is a legitimate answer/);
  assert.match(text, /"do more of what I suggested" is not a finding/);
});
