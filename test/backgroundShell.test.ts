import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/server/state/world.ts';
import type { DeltaEvent } from '../src/shared/protocol.ts';
import type { LiveSession } from '../src/server/providers/types.ts';

/**
 * A turn that is over while a shell still runs in the background.
 *
 * Claude Code's registry says "shell" and nothing about whose shell it is.
 * Both kinds were measured on tower_defense on 2026-10-08: in the morning
 * Claude ended its turn while a shell it had started waited on a long
 * simulation -- work, and read as idle the tower showed "done"; in the
 * evening the user typed `! npm run dev`, which never ends -- not work, and
 * read as busy the tower kept its lightning for twenty minutes, until the
 * terminal was closed.
 */

const CWD = '/Users/tester/code/tower_defense';

function newWorld(): World {
  const slots = new Map<string, number>();
  return new World({
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
}

const live = (over: Partial<LiveSession> = {}): LiveSession => ({
  sessionId: 's1', provider: 'claude', pid: 1, cwd: CWD, label: 'td-5c',
  title: null, status: 'busy', statusConfidence: 'reported', waitingFor: null,
  kind: 'interactive', version: '2.1.293', model: 'opus',
  startedAt: 1000, updatedAt: 1000, statusSince: 1000,
  ...over,
});

// What the registry source makes of "status": "shell".
const shellOnly = (updatedAt: number): LiveSession => live({ status: 'idle', backgroundShell: true, updatedAt });

const registry = (world: World, s: LiveSession): DeltaEvent[] =>
  world.applyLiveSessions('claude', [s], () => true, () => 1000, () => ({ files: 40, dirs: 0 }));

const launched = (id: string, at: number, spawnedAgentId: string | null = null): DeltaEvent => ({
  t: 'tool.end', id, sessionId: 's1', at, durationMs: 200, ok: true,
  bytes: 0, changed: 0, orphan: false, asyncLaunch: true, spawnedAgentId,
});

const statusOf = (world: World): string | undefined => world.session('s1')?.status;

test('a dev server you started with ! does not keep the tower working', () => {
  const world = newWorld();
  registry(world, live());
  registry(world, shellOnly(2000));
  assert.equal(statusOf(world), 'idle', 'the user\'s shell was read as the agent\'s work');
});

test('a shell Claude left in the background keeps the session working until it ends', () => {
  const world = newWorld();
  registry(world, live());
  world.openShell(launched('toolu_wait', 1500));
  registry(world, shellOnly(2000));
  assert.equal(statusOf(world), 'busy', 'the tower said "done" while the simulation ran');

  // Its task notification carries the id of the call that started it.
  const out = world.endShell('toolu_wait', 9000);
  assert.equal(statusOf(world), 'idle');
  assert.deepEqual(out.map((e) => e.t), ['session.update'], 'the page was not told the work ended');
});

test('a shell read after the registry still turns the session busy', () => {
  // At startup the registry can be read before the transcript tail.
  const world = newWorld();
  registry(world, shellOnly(2000));
  assert.equal(statusOf(world), 'idle');
  const out = world.openShell(launched('toolu_wait', 1500));
  assert.equal(statusOf(world), 'busy');
  assert.deepEqual(out.map((e) => e.t), ['session.update']);
});

test('the user\'s shell outliving Claude\'s one leaves the session idle', () => {
  // Both run, Claude's ends: the registry still says "shell", for the `!` one.
  const world = newWorld();
  registry(world, live());
  world.openShell(launched('toolu_wait', 1500));
  registry(world, shellOnly(2000));
  world.endShell('toolu_wait', 3000);
  registry(world, shellOnly(4000));
  assert.equal(statusOf(world), 'idle');
});

test('an open shell does not make a session busy while the registry says idle', () => {
  // The registry is the authority on the turn: a shell whose end got lost
  // must not light a session Claude Code itself calls idle.
  const world = newWorld();
  registry(world, live({ status: 'idle' }));
  assert.deepEqual(world.openShell(launched('toolu_lost', 1500)), []);
  registry(world, live({ status: 'idle', updatedAt: 2000 }));
  assert.equal(statusOf(world), 'idle');
});

test('a subagent launched in the background is not a shell', () => {
  const world = newWorld();
  registry(world, live());
  assert.deepEqual(world.openShell(launched('toolu_task', 1500, 'abc123def456')), []);
  registry(world, shellOnly(2000));
  assert.equal(statusOf(world), 'idle');
});

test('a session that exits takes its shells with it', () => {
  // Closing the terminal kills the session and every shell it started; the
  // next session must not inherit a busy tower from a call id it never made.
  const world = newWorld();
  registry(world, live());
  world.openShell(launched('toolu_wait', 1500));
  world.applyLiveSessions('claude', [], () => true, () => 1000, () => ({ files: 40, dirs: 0 }));
  registry(world, shellOnly(5000));
  assert.equal(statusOf(world), 'idle');
});
