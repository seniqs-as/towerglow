import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasReset, limitsNow, mergeWindows, windowNow } from '../src/shared/limits.ts';
import { World } from '../src/server/state/world.ts';
import type { DeltaEvent, ProviderLimits, RateWindow } from '../src/shared/protocol.ts';

/**
 * What a quota window is worth right now.
 *
 * Both tools write the quota only during a turn. Stop working and the last
 * reading stays as it was: at 89% the evening before, still at 89% the next
 * morning, with the reset nine hours in the past.
 */

const HOUR = 3_600_000;
const NOW = new Date(2026, 8, 17, 9, 7).getTime();

function win(usedPercent: number, resetsAt: number | null, minutes = 300): RateWindow {
  return { label: minutes === 300 ? '5h' : '7d', usedPercent, windowMinutes: minutes, model: null, resetsAt };
}

test('after the reset the window is worth zero, and stays recognisable as restarted', () => {
  // The real numbers from the rollout: 89% written at 20:00, reset at 00:34.
  const w = windowNow(win(89, NOW - 8.5 * HOUR), NOW);
  assert.equal(w.usedPercent, 0);
  // The past instant stays: it is what lets us say "reset since" instead of
  // passing the zero off as a measurement.
  assert.equal(w.resetsAt, NOW - 8.5 * HOUR);
  assert.equal(hasReset(w, NOW), true);
});

test('before the reset the reading is the one written, and it is not even copied', () => {
  const w = win(89, NOW + HOUR);
  assert.equal(windowNow(w, NOW), w);
  assert.equal(hasReset(w, NOW), false);
});

test('without a reset instant there is no way to know, so it is left untouched', () => {
  const w = win(89, null);
  assert.equal(windowNow(w, NOW), w);
  assert.equal(hasReset(w, NOW), false);
});

test('each window decides for itself: the 5h one restarts, the weekly one does not', () => {
  const l: ProviderLimits = {
    provider: 'codex', at: NOW - 13 * HOUR, plan: 'pro',
    windows: [win(89, NOW - 8.5 * HOUR), win(30, NOW + 6 * 24 * HOUR, 10080)],
  };
  const now = limitsNow(l, NOW);
  assert.deepEqual(now.windows.map((w) => w.usedPercent), [0, 30]);
  assert.equal(now.at, l.at, 'the measurement instant does not change: no new one has arrived');
  assert.equal(limitsNow(l, NOW - 10 * HOUR), l);
});

/**
 * A reading that does not name a window.
 *
 * Field case, 2026-09-20: Claude Code's status line publishes the quota of
 * the session's LAST response, so a session that had not called the API since
 * the 5h window opened wrote `seven_day` alone. Every time one of those
 * redrew its bar the 5h disappeared from the HUD, came back as soon as
 * something worked, and left again the moment that turn ended.
 */
test('a reading that names one window does not erase the one it says nothing about', () => {
  const merged = mergeWindows([win(24, NOW + HOUR), win(58, NOW + 3 * 24 * HOUR, 10080)], [win(57, NOW + 3 * 24 * HOUR, 10080)]);
  assert.deepEqual(merged.map((w) => `${w.label} ${w.usedPercent}`), ['5h 24', '7d 57']);
});

test('a window the reading does name is replaced, not doubled', () => {
  const merged = mergeWindows([win(24, NOW + HOUR)], [win(31, NOW + HOUR)]);
  assert.deepEqual(merged.map((w) => `${w.label} ${w.usedPercent}`), ['5h 31']);
});

test('a window kept from before still reads zero once its reset has gone by', () => {
  // Kept is not the same as believed: the 5h that nobody names any more is
  // held so the bar stays, and it is `windowNow` that stops it from claiming
  // a percentage belonging to a window that no longer exists.
  const merged = mergeWindows([win(89, NOW - HOUR)], [win(58, NOW + 3 * 24 * HOUR, 10080)]);
  assert.deepEqual(merged.map((w) => windowNow(w, NOW).usedPercent), [0, 58]);
});

test('the model merges the readings and keeps the plan, whatever the source', () => {
  // The merge lives in the model and not in each source: the status line, the
  // Codex rollouts and a CEO's own process each know only their own windows,
  // and whichever spoke last would otherwise decide the whole state.
  const world = new World({
    homeDir: '/Users/tester',
    placement: { slotOf: () => 0, assignMany: () => {}, save: () => {} },
    redactPaths: false,
    titles: true,
  });
  const reading = (windows: RateWindow[], plan: string | null): Extract<DeltaEvent, { t: 'limits' }> => ({
    t: 'limits', limits: { provider: 'claude', at: NOW, windows, plan },
  });

  world.applyLimits(reading([], 'max 5x'));
  world.applyLimits(reading([win(24, NOW + HOUR), win(58, NOW + 3 * 24 * HOUR, 10080)], null));
  const out = world.applyLimits(reading([win(59, NOW + 3 * 24 * HOUR, 10080)], null));

  const ev = out[0]!;
  assert.equal(ev.t, 'limits');
  if (ev.t !== 'limits') return;
  // What leaves for the client is what the model holds: a partial reading
  // reaching the browser on its own would make the bar blink there anyway.
  assert.deepEqual(ev.limits.windows.map((w) => `${w.label} ${w.usedPercent}`), ['5h 24', '7d 59']);
  assert.equal(ev.limits.plan, 'max 5x', 'the plan comes from elsewhere: no source may erase it');
  assert.deepEqual(world.snapshot().limits[0]!.windows.map((w) => w.label), ['5h', '7d']);
});
