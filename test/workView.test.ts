import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORK_NOTE, workView } from '../src/client/ui/format.ts';
import type { WorkMonth } from '../src/shared/protocol.ts';

/**
 * What a project took, on its tower's card (the user's request, 2026-10-24:
 * tokens, the AI's hours and the operator's, to show whoever funds it).
 */

const H = 3_600_000;

function month(key: string, over: Partial<WorkMonth> = {}): WorkMonth {
  return {
    month: key, sessions: 10, timed: 10,
    tokens: { in: 3_400_000, out: 12_100_000, cacheRead: 1_180_000_000, cacheWrite: 45_200_000, thinking: 9 },
    aiMs: 40 * H, operatorMs: 8 * H,
    ...over,
  };
}

test('the totals come first, with the tokens split the way they are priced', () => {
  const v = workView({ months: [month('2026-10'), month('2026-09')], live: 2 });
  assert.deepEqual(v.rows, [
    ['tokens', '2.48B'],
    ['input · output', '6.8M · 24.2M'],
    ['cache read · write', '2.36B · 90.4M'],
    ['AI time', '80.0 h'],
    ['your time', '16.0 h'],
    ['sessions', '20 · 2 open'],
  ]);
});

test('month by month, newest first, under an hour in minutes', () => {
  const v = workView({ months: [month('2026-10', { operatorMs: 42 * 60_000 }), month('2026-09')], live: 0 });
  assert.deepEqual(v.months, [
    ['Oct 2026', '1.24B', '40.0 h', '42 min'],
    ['Sep 2026', '1.24B', '40.0 h', '8.0 h'],
  ]);
  assert.equal(v.rows[5]?.[1], '20');
});

test('hours with sessions that could not be read are a floor, and none read is a dash', () => {
  // Zero would claim a measure nobody made: a month folded before the hours
  // existed has tokens and no time.
  const v = workView({
    months: [month('2026-10', { timed: 7 }), month('2026-09', { timed: 0, aiMs: 0, operatorMs: 0 })],
    live: 0,
  });
  assert.deepEqual(v.months.map((m) => m.slice(2)), [['≥ 40.0 h', '≥ 8.0 h'], ['—', '—']]);
  assert.equal(v.rows[3]?.[1], '≥ 40.0 h');
});

test('the note says what the hours are counted from, cap included', () => {
  assert.match(WORK_NOTE, /up to 10 minutes/);
  assert.match(WORK_NOTE, /split among them/);
  assert.match(WORK_NOTE, /≥ and —/);
});
