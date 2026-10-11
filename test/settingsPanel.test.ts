import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockLabel, nearestTime, nextTime, PLANET_ORDER } from '../src/client/ui/settingsPanel.ts';
import { TIMES } from '../src/client/world/sky.ts';
import { PLANETS } from '../src/client/world/planet.ts';

test('the time slider reads as a wall clock', () => {
  assert.equal(clockLabel(0), '00:00');
  assert.equal(clockLabel(0.5), '12:00');
  assert.equal(clockLabel(0.755), '18:07');
  assert.equal(clockLabel(0.9999), '23:59');
});

test('a named time lights its chip, and nothing lights between them', () => {
  for (const t of TIMES) assert.equal(nearestTime(t.value), t.id);
  assert.equal(nearestTime(0.6), null, 'between golden and noon nothing is pressed');
  // Wrap-aware: just before midnight is nearer to dawn than to noon? No, to night.
  assert.equal(nearestTime(0.95), 'night');
});

test('the T key steps through the named times and wraps at midnight', () => {
  let t = 0;
  const seen: string[] = [];
  for (let i = 0; i < TIMES.length + 1; i++) {
    const next = nextTime(t);
    seen.push(next.id);
    t = next.value;
  }
  assert.deepEqual(seen, [...TIMES.map((x) => x.id), TIMES[0]!.id]);
});

test('every planet the P key cycles through exists', () => {
  assert.equal(PLANET_ORDER.length, 3);
  for (const id of PLANET_ORDER) {
    const p = PLANETS[id];
    assert.ok(p.name.length > 0 && p.blurb.length > 0, `${id} has no name or blurb`);
    assert.ok(Number.isInteger(p.ground.high) && Number.isInteger(p.ground.low), `${id} has no ground colours`);
  }
});
