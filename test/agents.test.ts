import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/server/state/world.ts';
import type { DeltaEvent } from '../src/shared/protocol.ts';
import type { LiveSession } from '../src/server/providers/types.ts';

/**
 * Birth and death of subagents.
 *
 * This is what now lights the windows of the facade, so a bug here shows up
 * at once as a dark building while work goes on inside -- or, worse, as a
 * window left lit for an agent that has already gone.
 */

const CWD = '/Users/tester/code/app';

function worldWithSession(): { world: World; sessionId: string } {
  const slots = new Map<string, number>();
  const world = new World({
    homeDir: '/Users/tester',
    placement: {
      slotOf: (id) => {
        if (!slots.has(id)) slots.set(id, slots.size);
        return slots.get(id)!;
      },
      assignMany: () => {},
      save: () => {},
    },
    redactPaths: false,
    titles: true,
  });

  const live: LiveSession = {
    sessionId: 's1', provider: 'claude', pid: 1, cwd: CWD, label: 'app-7b',
    title: null, status: 'busy', statusConfidence: 'reported', waitingFor: null,
    kind: 'interactive', version: '2.1.0', model: 'opus',
    startedAt: 1000, updatedAt: 1000, statusSince: 1000,
  };
  world.applyLiveSessions('claude', [live], () => true, () => 1000, () => ({ files: 40, dirs: 0 }));
  return { world, sessionId: 's1' };
}

const spawn = (id: string, type: string, at: number): DeltaEvent => ({
  t: 'tool.start', id, sessionId: 's1', agentId: null,
  name: 'Task', cat: 'agent', at, target: { kind: 'agent', agentType: type },
});

const finish = (id: string, at: number, asyncLaunch = false): DeltaEvent => ({
  t: 'tool.end', id, sessionId: 's1', at, durationMs: 500, ok: true,
  bytes: 0, changed: 0, orphan: false, asyncLaunch,
  spawnedAgentId: asyncLaunch ? 'abc123def456' : null,
});

const turnEnd = (at: number): DeltaEvent => ({
  t: 'turn.end', sessionId: 's1', at, durationMs: 9000, messageCount: 12,
});

test('calling a subagent brings it to life, with its type', () => {
  const { world } = worldWithSession();
  const out = world.trackAgent(spawn('toolu_1', 'Explore', 2000));

  assert.equal(out.length, 1);
  const ev = out[0]!;
  assert.equal(ev.t, 'agent.add');
  if (ev.t !== 'agent.add') return;
  assert.equal(ev.agent.agentType, 'Explore');
  assert.equal(ev.agent.projectId, world.snapshot().projects[0]!.id);
  assert.equal(world.snapshot().agents.length, 1);
});

test('when the call ends the agent disappears', () => {
  const { world } = worldWithSession();
  world.trackAgent(spawn('toolu_1', 'Plan', 2000));
  const out = world.trackAgent(finish('toolu_1', 5000));

  assert.equal(out.length, 1);
  assert.equal(out[0]!.t, 'agent.remove');
  assert.deepEqual(world.snapshot().agents, [], 'the agent stayed lit after the end');
});

test('concurrent agents coexist and leave one at a time', () => {
  const { world } = worldWithSession();
  for (const [id, type] of [['a', 'Explore'], ['b', 'Plan'], ['c', 'Explore']] as const) {
    world.trackAgent(spawn(id, type, 2000));
  }
  assert.equal(world.snapshot().agents.length, 3);
  // Distinct desks: two agents cannot occupy the same place.
  const desks = new Set(world.snapshot().agents.map((a) => a.deskIndex));
  assert.equal(desks.size, 3, 'two agents on the same desk');

  world.trackAgent(finish('b', 4000));
  assert.deepEqual(world.snapshot().agents.map((a) => a.id).sort(), ['a', 'c']);
});

test('a call to any other tool is not an agent', () => {
  const { world } = worldWithSession();
  const bash: DeltaEvent = {
    t: 'tool.start', id: 'toolu_9', sessionId: 's1', agentId: null,
    name: 'Bash', cat: 'exec', at: 2000, target: { kind: 'cmd', bin: 'ls' },
  };
  assert.deepEqual(world.trackAgent(bash), []);
  assert.deepEqual(world.snapshot().agents, []);
});

test('the session keeps count of how many agents it has in the field', () => {
  const { world } = worldWithSession();
  world.trackAgent(spawn('a', 'Explore', 2000));
  world.trackAgent(spawn('b', 'Plan', 2100));
  assert.equal(world.snapshot().sessions[0]!.agentsActive, 2);

  world.trackAgent(finish('a', 3000));
  assert.equal(world.snapshot().sessions[0]!.agentsActive, 1);
  world.trackAgent(finish('b', 3100));
  assert.equal(world.snapshot().sessions[0]!.agentsActive, 0);
});

test('a BACKGROUND agent outlives both the tool call and the turn', () => {
  // Verified on a real session: three agents launched at 21:09, turn closed
  // at 21:09:57, and the terminal still saying at 21:13 "waiting for 3
  // background agents". Neither the end of the call nor the end of the turn
  // is their boundary.
  const { world } = worldWithSession();
  world.trackAgent(spawn('toolu_1', 'Explore', 2000));
  world.trackAgent(finish('toolu_1', 2050, true));
  assert.equal(world.snapshot().agents.length, 1, 'switched off right after launch');

  world.noteSessionEvent(turnEnd(60000));
  assert.equal(world.snapshot().agents.length, 1, 'switched off by the end of the turn');

  // What closes it is its delivery, which arrives in the transcript as a notification.
  world.endAgent('toolu_1', 240000);
  assert.deepEqual(world.snapshot().agents, [], 'the delivery did not close it');
  assert.equal(world.snapshot().sessions[0]!.agentsActive, 0, 'counter not updated');
});

test('the delivery of an unknown agent does no harm', () => {
  const { world } = worldWithSession();
  assert.deepEqual(world.endAgent('toolu_never_seen', 1000), []);
});

test('an orphaned agent does not stay lit forever', () => {
  // The warm-up reads the tail of the transcript: it can find an agent's
  // BIRTH and not its delivery, left a few megabytes further back. Without
  // pruning that window would stay lit for good.
  const { world } = worldWithSession();
  const live: LiveSession = {
    sessionId: 's1', provider: 'claude', pid: 1, cwd: CWD, label: 'app-7b',
    title: null, status: 'busy', statusConfidence: 'reported', waitingFor: null,
    kind: 'interactive', version: '2.1.0', model: 'opus',
    startedAt: 1000, updatedAt: 1000, statusSince: 1000,
  };

  world.trackAgent(spawn('old', 'Explore', Date.now() - 31 * 60_000));
  world.trackAgent(spawn('recent', 'Plan', Date.now() - 60_000));
  assert.equal(world.snapshot().agents.length, 2);

  world.applyLiveSessions('claude', [live], () => true, () => 1000, () => ({ files: 40, dirs: 0 }));

  const remaining = world.snapshot().agents.map((a) => a.id);
  assert.deepEqual(remaining, ['recent'], 'pruned the wrong ones');
  assert.equal(world.snapshot().sessions[0]!.agentsActive, 1, 'counter not updated');
});

const useSkill = (id: string, name: string, at: number): DeltaEvent => ({
  t: 'tool.start', id, sessionId: 's1', agentId: null,
  name: 'Skill', cat: 'plan', at, target: { kind: 'skill', name },
});

test('using a skill lights a window, distinct from a subagent', () => {
  const { world } = worldWithSession();
  const out = world.trackAgent(useSkill('toolu_s', 'claude-in-chrome', 2000));
  assert.equal(out.length, 1);
  const ev = out[0]!;
  assert.equal(ev.t, 'agent.add');
  if (ev.t !== 'agent.add') return;
  assert.equal(ev.agent.kind, 'skill');
  assert.equal(ev.agent.agentType, 'claude-in-chrome');
});

test('a skill stays lit after the tool returns, until the end of the turn', () => {
  // The Skill tool returns at once -- it loads the instructions and nothing
  // more -- but those instructions guide the rest of the turn. Switching it off
  // on return would be a split-second flash; keeping it past the turn would
  // say it is still in use.
  const { world } = worldWithSession();
  world.trackAgent(useSkill('toolu_s', 'dataviz', 2000));
  world.trackAgent(finish('toolu_s', 2100));
  assert.equal(world.snapshot().agents.length, 1, 'switched off when the tool returned');

  const closed = world.trackAgent(turnEnd(9000));
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.t, 'agent.remove');
  assert.deepEqual(world.snapshot().agents, [], 'stayed lit past the turn');
});

test('the end of a turn closes skills but NOT background subagents', () => {
  // The two have different boundaries, and mixing them up is exactly the
  // defect already seen: background agents switched off while still working.
  const { world } = worldWithSession();
  world.trackAgent(useSkill('toolu_s', 'dataviz', 2000));
  world.trackAgent(spawn('toolu_a', 'Explore', 2000));
  world.trackAgent(finish('toolu_a', 2050, true));

  world.trackAgent(turnEnd(9000));
  const left = world.snapshot().agents;
  assert.equal(left.length, 1);
  assert.equal(left[0]!.kind, 'subagent', 'the turn switched off a background agent');
});
