import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STEPS_PER_SESSION, Trail } from '../src/client/state/trail.ts';
import type { DeltaEvent } from '../src/shared/protocol.ts';

/**
 * The trail of steps.
 *
 * The defect these tests keep away is always the same: a line that says more
 * than what is known. A step still under way listed among the finished ones,
 * a duration written under an asynchronous launch that came back at once, a
 * subagent's fifty calls in place of the delegation that asked for them.
 * Each one is readable and each one is false.
 */

const S1 = 's1';
const S2 = 's2';

function start(
  id: string, at: number,
  opts: { sessionId?: string; name?: string; agentId?: string | null; path?: string } = {},
): DeltaEvent {
  return {
    t: 'tool.start',
    id,
    sessionId: opts.sessionId ?? S1,
    agentId: opts.agentId ?? null,
    name: opts.name ?? 'Read',
    cat: 'read',
    at,
    target: { kind: 'file', path: opts.path ?? 'src/main.ts', ext: 'ts', dir: 'src', external: false },
  };
}

function end(
  id: string, at: number,
  opts: { sessionId?: string; ok?: boolean; changed?: number; durationMs?: number; asyncLaunch?: boolean } = {},
): DeltaEvent {
  return {
    t: 'tool.end',
    id,
    sessionId: opts.sessionId ?? S1,
    at,
    durationMs: opts.durationMs ?? 120,
    ok: opts.ok ?? true,
    bytes: 0,
    changed: opts.changed ?? 0,
    orphan: false,
    asyncLaunch: opts.asyncLaunch ?? false,
    spawnedAgentId: null,
  };
}

test('a step enters the trail only once it has finished', () => {
  const trail = new Trail();
  trail.apply(start('t1', 1000));
  assert.equal(trail.of(S1).length, 0, 'a step still under way is already in the trail');

  trail.apply(end('t1', 1120));
  assert.equal(trail.of(S1).length, 1);
  assert.equal(trail.of(S1)[0]?.tool, 'Read');
});

test('the most recent step is at the top', () => {
  const trail = new Trail();
  for (const [id, at] of [['t1', 1000], ['t2', 2000], ['t3', 3000]] as const) {
    trail.apply(start(id, at, { path: `${id}.ts` }));
    trail.apply(end(id, at + 10));
  }
  assert.deepEqual(trail.of(S1).map((s) => s.target), ['t3.ts', 't2.ts', 't1.ts']);
});

test('a step carries the instant it BEGAN', () => {
  const trail = new Trail();
  trail.apply(start('t1', 1000));
  trail.apply(end('t1', 9000, { durationMs: 8000 }));
  const step = trail.of(S1)[0];
  assert.equal(step?.at, 1000, 'the trail dates the step from its end');
  assert.equal(step?.durationMs, 8000);
});

test('past the cap the oldest step is lost, not the most recent', () => {
  const trail = new Trail();
  const n = STEPS_PER_SESSION + 5;
  for (let i = 0; i < n; i++) {
    trail.apply(start(`t${i}`, i * 10, { path: `f${i}.ts` }));
    trail.apply(end(`t${i}`, i * 10 + 1));
  }
  const steps = trail.of(S1);
  assert.equal(steps.length, STEPS_PER_SESSION);
  assert.equal(steps[0]?.target, `f${n - 1}.ts`);
  assert.equal(steps.at(-1)?.target, `f${n - STEPS_PER_SESSION}.ts`);
});

test('a subagent\'s calls do not drown those of the session', () => {
  const trail = new Trail();
  trail.apply(start('deleg', 1000, { name: 'Agent', path: 'x' }));
  trail.apply(end('deleg', 1010, { asyncLaunch: true }));
  for (let i = 0; i < 20; i++) {
    trail.apply(start(`sub${i}`, 2000 + i, { agentId: 'a1' }));
    trail.apply(end(`sub${i}`, 2000 + i + 1));
  }
  const steps = trail.of(S1);
  assert.equal(steps.length, 1, 'the subagent\'s calls ended up in the trail');
  assert.equal(steps[0]?.tool, 'Agent', 'the delegation that asked for them is gone');
});

test('an asynchronous launch does not claim a duration', () => {
  const trail = new Trail();
  trail.apply(start('t1', 1000, { name: 'Agent' }));
  // It comes back after ten milliseconds, but the subagent is still working:
  // writing `10ms` would mean calling the hand-off time a duration.
  trail.apply(end('t1', 1010, { asyncLaunch: true, durationMs: 10 }));
  assert.equal(trail.of(S1)[0]?.durationMs, null);
});

test('an end without its start does not invent a step', () => {
  const trail = new Trail();
  trail.apply(end('never-started', 1000));
  assert.equal(trail.of(S1).length, 0);
});

test('two sessions do not mix', () => {
  const trail = new Trail();
  trail.apply(start('a', 1000, { sessionId: S1, path: 'one.ts' }));
  trail.apply(start('b', 1001, { sessionId: S2, path: 'two.ts' }));
  trail.apply(end('b', 1002, { sessionId: S2 }));
  trail.apply(end('a', 1003, { sessionId: S1 }));
  assert.deepEqual(trail.of(S1).map((s) => s.target), ['one.ts']);
  assert.deepEqual(trail.of(S2).map((s) => s.target), ['two.ts']);
});

test('a session that leaves takes its trail with it', () => {
  const trail = new Trail();
  trail.apply(start('t1', 1000));
  trail.apply(end('t1', 1010));
  trail.apply({ t: 'session.remove', id: S1, at: 2000, reason: 'exit' });
  assert.equal(trail.of(S1).length, 0);
});

test('the snapshot rebuilds the trail of a session that was already working', () => {
  const trail = new Trail();
  trail.apply(start('old', 10));
  trail.apply(end('old', 20));
  // The resync starts over from the server's ring: what was there before must
  // not add up with what arrives now.
  trail.reset([start('new', 100, { path: 'fresh.ts' }), end('new', 110)]);
  assert.deepEqual(trail.of(S1).map((s) => s.target), ['fresh.ts']);
});
