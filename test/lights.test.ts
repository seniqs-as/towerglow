import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FADE_MS, Lights, MIN_LIT_MS, offAt } from '../src/client/state/lights.ts';
import type { LightSpec } from '../src/client/state/lights.ts';
import type { AgentInfo, DeltaEvent, SessionInfo, SessionStatus } from '../src/shared/protocol.ts';

/**
 * The lit windows.
 *
 * The defect these tests keep away you have already seen: windows that are
 * never seen, because the work that lit them lasted less than it takes to
 * notice. The other side is just as visible: a window that never goes out
 * again, and stops saying anything.
 */

const PROJECT = 'p1';

function session(id: string, status: SessionStatus, statusSince: number, provider: 'claude' | 'codex' = 'claude'): SessionInfo {
  return {
    id, projectId: PROJECT, pid: 1, label: 'app-7b', title: null, status, waitingFor: null,
    kind: 'interactive', model: 'opus', ccVersion: '2.1.0', gitBranch: null, permissionMode: null,
    isCeo: false, provider, statusConfidence: 'reported', startedAt: 0, lastActivityAt: statusSince,
    statusSince, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    contextLeft: null, contextPct: null, turns: 0, toolCalls: 0, lastTurnMs: null, turnsMs: 0,
    reasoningMs: null, activityTool: null, activityTarget: null, agentsActive: 0, deskIndex: 0,
  };
}

function agent(id: string, sessionId: string, startedAt: number, kind: 'subagent' | 'skill' = 'subagent'): AgentInfo {
  return {
    id, sessionId, projectId: PROJECT, kind, agentType: kind === 'skill' ? 'dataviz' : 'Explore',
    agentId: null, model: null, startedAt, lastActivityAt: startedAt, endedAt: null, toolCalls: 0,
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 }, deskIndex: 1,
  };
}

const sessions = (...list: SessionInfo[]): Map<string, SessionInfo> => new Map(list.map((s) => [s.id, s]));
const agents = (...list: AgentInfo[]): Map<string, AgentInfo> => new Map(list.map((a) => [a.id, a]));

const toolStart = (id: string, sessionId: string, at: number, name = 'Read'): DeltaEvent => ({
  t: 'tool.start', id, sessionId, agentId: null, name, cat: 'read', at,
  target: name === 'Agent'
    ? { kind: 'agent', agentType: 'Explore' }
    : name === 'Skill'
      ? { kind: 'skill', name: 'dataviz' }
      : { kind: 'file', path: 'src/a.ts', ext: 'ts', dir: 'src', external: false },
});

const toolEnd = (id: string, sessionId: string, at: number): DeltaEvent => ({
  t: 'tool.end', id, sessionId, at, durationMs: 10, ok: true, bytes: 0, changed: 0,
  orphan: false, asyncLaunch: false, spawnedAgentId: null,
});

/** The page clock in the tests: frozen, and close to the event instants. */
const clock = (): number => 1000;

const spec = (id: string, bornAt: number): LightSpec => ({
  id, kind: 'tool', sessionId: 's1', projectId: PROJECT, provider: 'claude', name: 'Read', bornAt,
});

test('a very short piece of work stays lit for the minimum, then fades and disappears', () => {
  const lights = new Lights(() => 64, () => 1000);
  lights.light(spec('tool:a', 1000));
  lights.end('tool:a', 1050);

  const light = lights.get('tool:a')!;
  assert.equal(offAt(light), 1000 + MIN_LIT_MS, 'the minimum is not counted from the start');

  assert.equal(lights.prune(1000 + MIN_LIT_MS - 1), false, 'turned off before the minimum');
  // During the fade the window is still there: the shader is what dims it.
  assert.equal(lights.prune(1000 + MIN_LIT_MS + FADE_MS - 1), false, 'removed halfway through the fade');
  assert.equal(lights.prune(1000 + MIN_LIT_MS + FADE_MS), true);
  assert.equal(lights.get('tool:a'), undefined, 'still there after the fade');
});

test('a long piece of work goes out when it really ends, with no tail added', () => {
  const lights = new Lights(() => 64, clock);
  const end = 1000 + MIN_LIT_MS + 60_000;
  lights.light(spec('tool:long', 1000));
  lights.end('tool:long', end);
  assert.equal(offAt(lights.get('tool:long')!), end);
});

test('while the work is in progress the window does not go out', () => {
  const lights = new Lights(() => 64, clock);
  lights.light(spec('tool:open', 1000));
  assert.equal(offAt(lights.get('tool:open')!), Infinity);
  assert.equal(lights.prune(1000 + 24 * 3_600_000), false);
});

test('the first end counts: a second announcement does not move the switch-off', () => {
  const lights = new Lights(() => 64, clock);
  lights.light(spec('tool:a', 1000));
  assert.equal(lights.end('tool:a', 2000), true);
  assert.equal(lights.end('tool:a', 90_000), false);
  assert.equal(lights.get('tool:a')!.endedAt, 2000);
  assert.equal(lights.end('tool:never-seen', 2000), false);
});

test('the windows of one building do not overlap while there is room', () => {
  const capacity = 12;
  const lights = new Lights(() => capacity, clock);
  for (let i = 0; i < capacity; i++) lights.light(spec(`tool:${i}`, 1000));
  const slots = new Set([...lights.values()].map((l) => l.slot));
  assert.equal(slots.size, capacity, 'two windows lit in the same place');
  // With the facade full it lights up anyway: better overlapping than dark.
  assert.equal(lights.light(spec('tool:one-more', 1000)), true);
});

test('a window keeps its place while the others come and go', () => {
  const lights = new Lights(() => 64, clock);
  lights.light(spec('tool:stays', 1000));
  const slot = lights.get('tool:stays')!.slot;
  for (let i = 0; i < 20; i++) {
    lights.light(spec(`tool:${i}`, 1000));
    lights.end(`tool:${i}`, 1000);
  }
  lights.prune(1000 + MIN_LIT_MS + FADE_MS);
  for (let i = 20; i < 30; i++) lights.light(spec(`tool:${i}`, 2000));
  assert.equal(lights.get('tool:stays')!.slot, slot, 'the window moved');
});

test('every tool call lights a window, in the session colour', () => {
  const lights = new Lights(() => 64, clock);
  const all = sessions(session('s1', 'busy', 900, 'codex'));
  assert.equal(lights.apply(toolStart('t1', 's1', 1000), all), true);
  const light = lights.get('tool:t1')!;
  assert.equal(light.kind, 'tool');
  assert.equal(light.provider, 'codex');
  assert.equal(light.name, 'Read', 'the name to show on mouse hover');
  assert.equal(light.projectId, PROJECT);

  assert.equal(lights.apply(toolEnd('t1', 's1', 1010), all), true);
  assert.equal(offAt(lights.get('tool:t1')!), 1000 + MIN_LIT_MS);
});

test('summoning a subagent or a skill does not ALSO light a call window', () => {
  // Their window arrives with agent.add: counting them twice would say there
  // are more people inside the building than there are.
  const lights = new Lights(() => 64, clock);
  const all = sessions(session('s1', 'busy', 900));
  assert.equal(lights.apply(toolStart('t1', 's1', 1000, 'Agent'), all), false);
  assert.equal(lights.apply(toolStart('t2', 's1', 1000, 'Skill'), all), false);
  assert.deepEqual([...lights.values()], []);
});

test('a call from an unknown session lights nothing', () => {
  const lights = new Lights(() => 64, clock);
  assert.equal(lights.apply(toolStart('t1', 'ghost', 1000), sessions()), false);
});

test('a subagent that delivers in ten seconds stays lit for the minimum', () => {
  const lights = new Lights(() => 64, clock);
  const all = sessions(session('s1', 'busy', 900));
  lights.apply({ t: 'agent.add', agent: agent('toolu_a', 's1', 1000) }, all);
  lights.apply({ t: 'agent.remove', id: 'toolu_a', at: 11_000, reason: 'stop' }, all);

  const light = lights.get('agent:toolu_a')!;
  assert.equal(light.kind, 'subagent');
  assert.equal(light.name, 'Explore');
  assert.equal(offAt(light), 1000 + MIN_LIT_MS);
});

test('the end of the turn closes the calls left open, only for that session', () => {
  const lights = new Lights(() => 64, clock);
  const all = sessions(session('s1', 'busy', 900), session('s2', 'busy', 900));
  lights.apply(toolStart('mine', 's1', 1000), all);
  lights.apply(toolStart('theirs', 's2', 1000), all);

  lights.apply({ t: 'turn.end', sessionId: 's1', at: 5000, durationMs: 4000, messageCount: 3 }, all);
  assert.equal(lights.get('tool:mine')!.endedAt, 5000);
  assert.equal(lights.get('tool:theirs')!.endedAt, null, 'closed a call of another session');
});

test('a turn in progress lights the session window, as long as it works', () => {
  const lights = new Lights(() => 64, clock);
  lights.sync(sessions(session('s1', 'busy', 1000)), agents(), 2000);
  const light = lights.get('turn:s1')!;
  assert.equal(light.kind, 'turn');
  assert.equal(light.bornAt, 1000, 'the turn starts from when the session became busy');
  assert.equal(light.endedAt, null);

  // Calling it again with the same state changes nothing.
  assert.equal(lights.sync(sessions(session('s1', 'busy', 1000)), agents(), 3000), false);

  lights.sync(sessions(session('s1', 'idle', 90_000)), agents(), 90_500);
  assert.equal(lights.get('turn:s1')!.endedAt, 90_000, 'the end is not the time of the state change');
});

test('a session that goes back to work while its window fades relights it in the same place', () => {
  const lights = new Lights(() => 64, clock);
  lights.sync(sessions(session('s1', 'busy', 1000)), agents(), 1000);
  const slot = lights.get('turn:s1')!.slot;
  lights.sync(sessions(session('s1', 'waiting', 4000)), agents(), 4000);
  assert.equal(lights.get('turn:s1')!.endedAt, 4000);

  lights.sync(sessions(session('s1', 'busy', 9000)), agents(), 9000);
  const back = lights.get('turn:s1')!;
  assert.equal(back.endedAt, null, 'it did not relight');
  assert.equal(back.slot, slot, 'it came back in another place');
});

test('while waiting for a permission the tool stays lit; once the turn is over it closes', () => {
  const lights = new Lights(() => 64, clock);
  const busy = sessions(session('s1', 'busy', 900));
  lights.apply(toolStart('t1', 's1', 1000, 'Bash'), busy);

  lights.sync(sessions(session('s1', 'waiting', 1200)), agents(), 1200);
  assert.equal(lights.get('tool:t1')!.endedAt, null, 'turned off while waiting for the permission');

  lights.sync(sessions(session('s1', 'idle', 8000)), agents(), 8000);
  assert.equal(lights.get('tool:t1')!.endedAt, 8000, 'left open after the turn was over');
});

test('whoever opens the page finds the windows of agents and turns already in progress lit', () => {
  const lights = new Lights(() => 64, clock);
  lights.sync(
    sessions(session('s1', 'busy', 1000)),
    agents(agent('toolu_a', 's1', 1500), agent('toolu_s', 's1', 1600, 'skill')),
    60_000,
  );
  const kinds = [...lights.values()].map((l) => l.kind).sort();
  assert.deepEqual(kinds, ['skill', 'subagent', 'turn']);
});

test('an agent that vanished while the page was not listening goes out on resync', () => {
  // After a reconnection a new snapshot arrives: whoever is gone has sent no
  // agent.remove to this page, but has to be turned off all the same.
  const lights = new Lights(() => 64, clock);
  const all = sessions(session('s1', 'busy', 1000));
  lights.sync(all, agents(agent('toolu_a', 's1', 1500)), 2000);
  lights.sync(all, agents(), 70_000);
  assert.equal(lights.get('agent:toolu_a')!.endedAt, 70_000);
});

test('a closed session turns off all its windows', () => {
  const lights = new Lights(() => 64, clock);
  const all = sessions(session('s1', 'busy', 1000));
  lights.sync(all, agents(agent('toolu_a', 's1', 1500)), 2000);
  lights.apply(toolStart('t1', 's1', 2000), all);

  lights.sync(sessions(), agents(), 9000);
  for (const light of lights.values()) {
    assert.equal(light.endedAt, 9000, `${light.id} left lit without a session`);
  }
});

test('a transcript tail read again does not flash windows that already went out', () => {
  // The server, when it attaches to a transcript, rereads its tail and sends
  // again calls that ended hours ago: none of them must reach the screen.
  const now = 10 * 3_600_000;
  const lights = new Lights(() => 64, () => now);
  const all = sessions(session('s1', 'busy', 900));
  for (let i = 0; i < 300; i++) {
    const at = now - 3_600_000 + i * 1000;
    lights.apply(toolStart(`old${i}`, 's1', at), all);
    lights.apply(toolEnd(`old${i}`, 's1', at + 200), all);
  }
  assert.deepEqual([...lights.values()], [], 'expired windows left on stage');

  // A call from a moment ago, instead, stays.
  lights.apply(toolStart('fresh', 's1', now - 2000), all);
  lights.apply(toolEnd('fresh', 's1', now - 1900), all);
  assert.ok(lights.get('tool:fresh'), 'turned off a call just made');
});
