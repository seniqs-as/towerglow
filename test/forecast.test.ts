import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_ELAPSED_FRACTION, describeProvider, describeWhen, describeWindow, detailWindow,
  forecastProvider, forecastWindow, levelOf,
} from '../src/client/ui/forecast.ts';
import type { ProviderLimits, RateWindow } from '../src/shared/protocol.ts';

/**
 * The usage forecast.
 *
 * The flaw to keep away is a sentence that knows more than what is known.
 * A window opened ten minutes ago, a reset that never arrived, a measurement
 * from yesterday reread as if it were from now: each of these cases produces
 * a perfectly readable day and time, and none of the three means anything.
 * Whoever reads "Monday afternoon" closes the laptop earlier or changes plan:
 * the sentence has to be worth that gesture.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const NOW = new Date(2026, 8, 14, 9, 0).getTime();

/** A window that resets in `leftMs`, `minutes` wide. */
function win(minutes: number, usedPercent: number, leftMs: number, over: Partial<RateWindow> = {}): RateWindow {
  return { label: `${minutes}m`, usedPercent, windowMinutes: minutes, model: null, resetsAt: NOW + leftMs, ...over };
}

function limits(windows: RateWindow[], at = NOW): ProviderLimits {
  return { provider: 'claude', at, windows, plan: 'max' };
}

test('at this pace the quota runs out mid-period, and it says how far ahead', () => {
  // Two days into the week, 60% burnt: the pace is 2.1 windows.
  const f = forecastWindow(win(7 * 1440, 60, 5 * DAY), NOW, NOW);
  assert.equal(f.verdict, 'early');
  assert.ok(f.pace !== null && Math.abs(f.pace - 2.1) < 1e-9, `pace ${f.pace}`);
  // 7 days / 2.1 = 3.33 days from the opening: 1.33 days to go from now.
  assert.ok(f.runsOutAt !== null);
  assert.ok(Math.abs(f.runsOutAt! - (NOW + (7 / 2.1 - 2) * DAY)) < 1000, `runs out ${f.runsOutAt}`);
  assert.ok(Math.abs(f.earlyBy! - (7 - 7 / 2.1) * DAY) < 1000, `early by ${f.earlyBy}`);
});

test('the pace the window allows is not an alarm: it is ok', () => {
  // 2 days out of 7 used in 2 days out of 7: exactly the allowed pace.
  const exact = forecastWindow(win(7 * 1440, (2 / 7) * 100, 5 * DAY), NOW, NOW);
  assert.equal(exact.verdict, 'ok');
  assert.equal(exact.runsOutAt, null);
  assert.equal(describeWindow(exact, NOW), 'ok');
  // And below it, the projection says how much would be left at the reset.
  const slow = forecastWindow(win(7 * 1440, 10, 5 * DAY), NOW, NOW);
  assert.equal(slow.verdict, 'ok');
  assert.match(detailWindow(slow, NOW), /about 35% used/);
});

test('a window that has just opened warrants no forecast', () => {
  const windowMs = 7 * DAY;
  const elapsed = windowMs * MIN_ELAPSED_FRACTION * 0.5;
  const f = forecastWindow(win(7 * 1440, 5, windowMs - elapsed), NOW, NOW);
  assert.equal(f.verdict, 'unknown');
  assert.equal(f.gap, 'too-early');
  assert.equal(f.runsOutAt, null);
  assert.match(describeWindow(f, NOW), /too early/);
});

test('untouched quota: it can be said at once, even with the window just opened', () => {
  const f = forecastWindow(win(300, 0, 299 * MIN), NOW, NOW);
  assert.equal(f.verdict, 'ok');
  assert.equal(f.pace, 0);
  assert.match(detailWindow(f, NOW), /nothing used/);
});

test('without the reset time there is no finish line, and that must be said', () => {
  const f = forecastWindow(win(300, 80, 0, { resetsAt: null }), NOW, NOW);
  assert.equal(f.verdict, 'unknown');
  assert.equal(f.gap, 'no-reset');
  assert.match(describeWindow(f, NOW), /no reset time/);
});

test('a reset already past is an old measurement, not a window running dry', () => {
  const f = forecastWindow(win(300, 95, -10 * MIN), NOW, NOW);
  assert.equal(f.verdict, 'unknown');
  assert.equal(f.gap, 'stale');
  assert.equal(f.runsOutAt, null);
  // The panel opens from the bars, which read 0 there: reporting the 95% of
  // a finished window would say the opposite of what they say.
  assert.equal(f.usedPercent, 0);
});

test('quota used up: no forecast into the future, and it says so in the present', () => {
  const f = forecastWindow(win(7 * 1440, 100, 5 * DAY), NOW, NOW);
  assert.equal(f.verdict, 'early');
  assert.ok(f.runsOutAt !== null && f.runsOutAt <= NOW);
  assert.match(describeWindow(f, NOW), /any moment now/);
});

test('the pace is measured from when the quota was written, not from now', () => {
  // A measurement from an hour ago: we know nothing since then, and spreading
  // it over an hour of silence would make slower a pace nobody has disproved.
  const w = win(7 * 1440, 60, 5 * DAY);
  const fresh = forecastWindow(w, NOW, NOW);
  const old = forecastWindow(w, NOW - HOUR, NOW);
  assert.ok(old.pace! > fresh.pace!, `${old.pace} must be higher than ${fresh.pace}`);
});

test('between two windows the one that runs out first stops you, not the average', () => {
  // The weekly one is wide and calm, the 5h is burning: it is the 5h that
  // stops you, and a forecast looking at the average would say all is well.
  const f = forecastProvider(limits([win(300, 80, 2 * HOUR), win(7 * 1440, 20, 5 * DAY)]), NOW);
  assert.equal(f.worst?.label, '300m');
  const said = describeProvider(f, NOW);
  assert.match(said, /at this pace/);
  assert.match(said, /300m window is the one that stops you/);
});

test('when every window holds, the verdict is short', () => {
  const f = forecastProvider(limits([win(300, 10, 2 * HOUR), win(7 * 1440, 20, 5 * DAY)]), NOW);
  assert.equal(f.worst, null);
  assert.equal(describeProvider(f, NOW), 'ok — at this pace the quota lasts to the reset');
});

test('when it happens, said the way a person would say it', () => {
  const today = new Date(2026, 8, 14, 15, 30).getTime();
  assert.match(describeWhen(today, NOW), /^this afternoon \(/);
  assert.match(describeWhen(new Date(2026, 8, 14, 7, 0).getTime(), NOW), /^this morning \(/);
  assert.match(describeWhen(new Date(2026, 8, 14, 19, 0).getTime(), NOW), /^this evening \(/);
  assert.match(describeWhen(new Date(2026, 8, 14, 23, 30).getTime(), NOW), /^tonight \(/);
  assert.match(describeWhen(new Date(2026, 8, 15, 10, 0).getTime(), NOW), /^tomorrow morning \(/);

  // Beyond tomorrow the weekday is needed, and it must not be "this".
  const far = new Date(2026, 8, 17, 14, 0);
  const said = describeWhen(far.getTime(), NOW);
  const weekday = far.toLocaleDateString('en', { weekday: 'short' });
  assert.equal(said.startsWith(`${weekday} afternoon (`), true, said);
});

test('the colour follows the risk: overshooting slightly is not running dry mid-period', () => {
  assert.equal(levelOf(forecastWindow(win(7 * 1440, 10, 5 * DAY), NOW, NOW)), 'ok');
  assert.equal(levelOf(forecastWindow(win(7 * 1440, 35, 5 * DAY), NOW, NOW)), 'warn');
  assert.equal(levelOf(forecastWindow(win(7 * 1440, 60, 5 * DAY), NOW, NOW)), 'high');
});
