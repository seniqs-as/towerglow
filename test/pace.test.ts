import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHASE_MAX, Pace, PACE_WINDOW_MS, chaseSpeed } from '../src/client/state/pace.ts';

test('the pace counts the last minute of calls on a project, and forgets the rest', () => {
  const pace = new Pace();
  const now = 5_000_000;
  for (let i = 0; i < 10; i++) pace.hit('p', now - i * 10_000);
  // 0, 10, ... 50 s ago are in; 60 s ago and older are not.
  assert.equal(pace.perMinute('p', now), 6);
  assert.equal(pace.perMinute('p', now + PACE_WINDOW_MS), 0);
  assert.equal(pace.perMinute('other', now), 0);
});

test('a call that arrives out of order is still counted and still ages out', () => {
  const pace = new Pace();
  pace.hit('p', 100_000);
  pace.hit('p', 40_000);
  pace.hit('p', 90_000);
  assert.equal(pace.perMinute('p', 100_000), 2, 'the one from a minute before is out');
  assert.equal(pace.perMinute('p', 155_000), 1);
  pace.hit('p', Number.NaN);
  assert.equal(pace.perMinute('p', 155_000), 1, 'a broken instant counts for nothing');
});

test('the kerb light speeds up with the pace, less and less, and never becomes a strobe', () => {
  let prev = chaseSpeed(0);
  assert.ok(prev > 0, 'a project at work always moves its light');
  for (const n of [1, 5, 20, 60, 200, 10_000]) {
    const s = chaseSpeed(n);
    assert.ok(s >= prev, `slower at ${n}`);
    prev = s;
  }
  assert.ok(chaseSpeed(10) - chaseSpeed(1) > chaseSpeed(100) - chaseSpeed(91), 'not logarithmic');
  assert.ok(chaseSpeed(1e9) <= CHASE_MAX);
  assert.equal(chaseSpeed(Number.NaN), chaseSpeed(0));
});

test('the kerb light never laps faster than once every two seconds, nor slower than once every half minute', () => {
  // A lap a second read as a spinner on a busy project: the ceiling is a pace
  // you can follow with the eye.
  const lap = (rad: number): number => (Math.PI * 2) / rad;
  assert.ok(lap(chaseSpeed(1e9)) >= 2, `a lap in ${lap(chaseSpeed(1e9)).toFixed(2)} s`);
  // And a quiet session must still visibly move, or working and idle look alike.
  assert.ok(lap(chaseSpeed(0)) <= 30, `a lap in ${lap(chaseSpeed(0)).toFixed(1)} s`);
});
