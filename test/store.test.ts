import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/client/state/store.ts';
import type { DeltaEvent, SessionInfo } from '../src/shared/protocol.ts';

/*
 * Where a CEO's worker is drawn. It was kept apart and drawn as a mast by
 * the ship, with no terminal and no crew; the user wanted it on its
 * project's lot like any other session: "I wanted every session to be
 * shown on the hexagons of their respective projects".
 */

const T0 = Date.parse('2026-09-19T08:00:00.000Z');

function session(id: string, spawnedByCeo: 'claude' | null): SessionInfo {
  return {
    id, projectId: 'p1', pid: 4242, label: id, title: null, status: 'busy', waitingFor: null,
    kind: 'interactive', model: null, ccVersion: '', gitBranch: null, permissionMode: null, isCeo: false,
    spawnedByCeo, provider: 'claude', statusConfidence: 'reported', startedAt: T0,
    lastActivityAt: T0, statusSince: T0, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    contextLeft: null, contextPct: null, compactedAt: null, turns: 0, toolCalls: 0, lastTurnMs: null, turnsMs: 0,
    reasoningMs: null, recap: null, recapAt: null, recapInherited: false, activityTool: null,
    activityTarget: null, agentsActive: 0, deskIndex: 0,
  };
}

function job(id: string, at: number, sessionId: string | null, summary: string): Extract<DeltaEvent, { t: 'job' }> {
  return {
    t: 'job', id, at, provider: 'claude', kind: 'plan', summary, projectId: 'p1', projectName: 'alpha',
    state: 'running', workState: 'running', reviewFresh: null, workDid: null, workFounded: null,
    sessionId, reviewState: null, reviewHolds: null, toolCalls: 0, costUsd: 0, endedAt: null,
    reason: null, dismissed: false, asks: false, plan: { taskId: 't1', attempt: 1 },
  };
}

function store(): { s: Store; topology: () => number } {
  let n = 0;
  const s = new Store({
    onTopology: () => { n += 1; }, onPresence: () => {}, onFiles: () => {}, onDelta: () => {},
    onCaps: () => {}, onLimits: () => {}, onCeoStream: () => {},
  });
  return { s, topology: () => n };
}

test('a CEO\'s worker is one of the sessions like any other: on its lot, not by the ship', () => {
  const { s, topology } = store();
  s.apply({
    t: 'snapshot', at: T0, projects: [], agents: [], files: [], recent: [], limits: [],
    sessions: [session('mine', null), session('worker', 'claude')],
  });
  assert.deepEqual([...s.sessions.keys()].sort(), ['mine', 'worker']);
  assert.ok(s.activeProjectIds.has('p1'));

  // Born later: a topology change, so the colony walks it out of the ship.
  const before = topology();
  s.apply({ t: 'batch', at: T0, seq: 1, events: [{ t: 'session.add', at: T0, session: session('worker-2', 'claude') }] });
  assert.ok(s.sessions.has('worker-2'));
  assert.equal(topology(), before + 1);

  // Its activity reaches it, like any session's.
  s.apply({ t: 'batch', at: T0, seq: 2, events: [{ t: 'session.update', id: 'worker-2', at: T0, patch: { status: 'waiting' } }] });
  assert.equal(s.sessions.get('worker-2')!.status, 'waiting');

  s.apply({ t: 'batch', at: T0, seq: 3, events: [{ t: 'session.remove', id: 'worker-2', at: T0 }] });
  assert.equal(s.sessions.has('worker-2'), false);
});

test('a worker\'s job is the latest attempt on its session', () => {
  // Answering a worker's question resumes the SAME session: two attempts,
  // one id, and the hover must name the one running now.
  const { s } = store();
  s.apply({
    t: 'batch', at: T0, seq: 1,
    events: [
      job('t1:1', T0, 'sess-w', 'first attempt'),
      job('t1:2', T0 + 60_000, 'sess-w', 'second attempt'),
      job('t2:1', T0 + 30_000, 'other', 'another task'),
    ],
  });
  assert.equal(s.jobOf('sess-w')?.id, 't1:2');
  assert.equal(s.jobOf('nobody'), null);
});

test('Reports started over: the store forgets the erased jobs and keeps the running one', () => {
  // A worker's hover names its task through `jobOf`: a job the server erased
  // must not keep naming it from a map nobody clears.
  const { s } = store();
  s.apply({ t: 'snapshot', at: T0, projects: [], agents: [], files: [], recent: [], limits: [], sessions: [] });
  s.apply({
    t: 'batch', at: T0, seq: 1,
    events: [job('old', T0, 'w1', 'finished long ago'), job('live', T0 + 1, 'w2', 'still working')],
  });
  s.apply({ t: 'batch', at: T0, seq: 2, events: [{ t: 'ceo.cleared', at: T0, what: 'jobs', keep: ['live'] }] });
  assert.deepEqual([...s.jobs.keys()], ['live']);
  assert.equal(s.jobOf('w1'), null);

  // Board's start over is not Reports': the jobs stay where they are.
  s.apply({ t: 'batch', at: T0, seq: 3, events: [{ t: 'ceo.cleared', at: T0, what: 'board', keep: [] }] });
  assert.deepEqual([...s.jobs.keys()], ['live']);
});
