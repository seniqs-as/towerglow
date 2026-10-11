import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/server/state/world.ts';
import type { LiveSession } from '../src/server/providers/types.ts';

/**
 * A tower follows its folder.
 *
 * Seen on 2026-09-28: tower_defense, a project created an hour earlier, had
 * grown to 98 files and still stood as the tower of an empty folder -- four
 * floors on the narrowest base in the city. The size was read once, the first
 * time the project was seen, and a new project is first seen empty.
 */

const NEW = '/Users/tester/code/tower_defense';
const IDLE = '/Users/tester/code/archive';

function world(): World {
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

function session(cwd: string): LiveSession {
  return {
    sessionId: 's1', provider: 'claude', pid: 1, cwd, label: 'td-1',
    title: null, status: 'busy', statusConfidence: 'reported', waitingFor: null,
    kind: 'interactive', version: '2.1.0', model: 'opus',
    startedAt: 1000, updatedAt: 1000, statusSince: 1000,
  };
}

const sizeOf = (w: World, name: string): number | undefined =>
  w.snapshot().projects.find((p) => p.realName === name)?.size;

test('a project first seen as an empty folder grows with the work done in it', () => {
  const w = world();
  w.applyLiveSessions('claude', [session(NEW)], () => true, () => 1000, () => 0);
  assert.equal(sizeOf(w, 'tower_defense'), 0);

  const out = w.refreshSizes(() => 98);
  assert.equal(out.length, 1);
  const ev = out[0]!;
  assert.equal(ev.t, 'project.add', 'the same event a rename sends: the client replaces the project');
  assert.equal(ev.t === 'project.add' && ev.project.size, 98);
  assert.equal(sizeOf(w, 'tower_defense'), 98, 'a client that connects later finds it in the snapshot');
});

test('a size that did not move says nothing', () => {
  const w = world();
  w.applyLiveSessions('claude', [session(NEW)], () => true, () => 1000, () => 40);
  const before = w.version;
  assert.deepEqual(w.refreshSizes(() => 40), []);
  assert.equal(w.version, before, 'nothing happened: the version must not say otherwise');
});

test('a project nobody works in is not scanned again', () => {
  const w = world();
  w.ensureProjects([IDLE], () => true, () => 1000, () => 300);
  w.applyLiveSessions('claude', [session(NEW)], () => true, () => 1000, () => 0);

  const scanned: string[] = [];
  w.refreshSizes((cwd) => {
    scanned.push(cwd);
    return 12;
  });
  assert.deepEqual(scanned, [NEW]);
  assert.equal(sizeOf(w, 'archive'), 300);
});

test('a project that keeps its place keeps it while it grows', () => {
  const w = world();
  w.applyLiveSessions('claude', [session(NEW)], () => true, () => 1000, () => 0);
  const before = w.snapshot().projects[0]!;
  w.refreshSizes(() => 98);
  const after = w.snapshot().projects[0]!;
  assert.equal(after.slot, before.slot);
  assert.equal(after.id, before.id);
  assert.equal(after.name, before.name);
});

test('a folder that is gone is not measured', () => {
  const w = world();
  w.applyLiveSessions('claude', [session(NEW)], () => false, () => 1000, () => 40);
  let scans = 0;
  const out = w.refreshSizes(() => {
    scans++;
    return 0;
  });
  assert.equal(scans, 0);
  assert.deepEqual(out, []);
  assert.equal(sizeOf(w, 'tower_defense'), 40, 'a ruin keeps the shape it had');
});
