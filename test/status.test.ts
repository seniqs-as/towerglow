import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crewStatus, SLEEP_AFTER_MS } from '../src/client/state/status.ts';
import type { CrewSession } from '../src/client/state/status.ts';
import { Notices, NOTICE_HOLD_MS } from '../src/client/state/notices.ts';

const NOW = 1_000_000_000;

function session(over: Partial<CrewSession> = {}): CrewSession {
  return { status: 'idle', statusSince: NOW - 1000, lastActivityAt: NOW - 1000, ...over };
}

test('an error outranks a running turn: a stuck session is not busy', () => {
  assert.equal(crewStatus(session({ status: 'busy' }), 'error', NOW), 'blocked');
  assert.equal(crewStatus(session({ status: 'waiting' }), 'error', NOW), 'blocked');
});

test('waiting sits below working, and above idle', () => {
  assert.equal(crewStatus(session({ status: 'busy' }), null, NOW), 'working');
  assert.equal(crewStatus(session({ status: 'busy' }), 'permission_needed', NOW), 'working');
  assert.equal(crewStatus(session({ status: 'waiting' }), null, NOW), 'waiting');
  assert.equal(crewStatus(session(), null, NOW), 'idle');
});

test('a session quiet for long sits down', () => {
  const old = NOW - SLEEP_AFTER_MS - 1;
  assert.equal(crewStatus(session({ statusSince: old, lastActivityAt: old }), null, NOW), 'sleeping');
  // Quiet since whichever came last: a recent event keeps it awake.
  assert.equal(crewStatus(session({ statusSince: old, lastActivityAt: NOW - 5000 }), null, NOW), 'idle');
  // Sleep never overrides a state that wants something.
  assert.equal(crewStatus(session({ status: 'waiting', statusSince: old, lastActivityAt: old }), null, NOW), 'waiting');
});

test('an error notice is held, and wears off after its hold', () => {
  const n = new Notices();
  assert.equal(n.apply({ t: 'notice', sessionId: 's1', at: NOW, code: 'error' }), true);
  assert.equal(n.of('s1', NOW + 1), 'error');
  assert.equal(n.of('s1', NOW + NOTICE_HOLD_MS - 1), 'error');
  assert.equal(n.of('s1', NOW + NOTICE_HOLD_MS + 1), null);
});

test('a new tool call clears the error: the session has moved on', () => {
  const n = new Notices();
  n.apply({ t: 'notice', sessionId: 's1', at: NOW, code: 'error' });
  assert.equal(n.apply({
    t: 'tool.start', id: 't1', sessionId: 's1', agentId: null, name: 'Bash', cat: 'exec', at: NOW + 10, target: null,
  }), true);
  assert.equal(n.of('s1', NOW + 11), null);
  // So does a turn starting.
  n.apply({ t: 'notice', sessionId: 's1', at: NOW + 20, code: 'error' });
  n.apply({ t: 'session.update', id: 's1', patch: { status: 'busy' }, at: NOW + 30 });
  assert.equal(n.of('s1', NOW + 31), null);
});

test('a notice for no session in particular is ignored', () => {
  const n = new Notices();
  assert.equal(n.apply({ t: 'notice', sessionId: null, at: NOW, code: 'error' }), false);
});

test('a session that leaves takes its notices with it', () => {
  const n = new Notices();
  n.apply({ t: 'notice', sessionId: 's1', at: NOW, code: 'error' });
  n.apply({ t: 'session.remove', id: 's1', at: NOW + 1, reason: 'exit' });
  assert.equal(n.of('s1', NOW + 2), null);
});
