import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { World } from '../src/server/state/world.ts';
import type { LiveSession } from '../src/server/providers/types.ts';
import { measureProject } from '../src/server/sources/projectsSource.ts';
import type { ProjectMeasure } from '../src/server/sources/projectsSource.ts';

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

const files = (n: number, dirs = 0): (() => ProjectMeasure) => () => ({ files: n, dirs });

test('a project first seen as an empty folder grows with the work done in it', () => {
  const w = world();
  w.applyLiveSessions('claude', [session(NEW)], () => true, () => 1000, files(0));
  assert.equal(sizeOf(w, 'tower_defense'), 0);

  const out = w.refreshSizes(files(98));
  assert.equal(out.length, 1);
  const ev = out[0]!;
  assert.equal(ev.t, 'project.add', 'the same event a rename sends: the client replaces the project');
  assert.equal(ev.t === 'project.add' && ev.project.size, 98);
  assert.equal(sizeOf(w, 'tower_defense'), 98, 'a client that connects later finds it in the snapshot');
});

test('a size that did not move says nothing', () => {
  const w = world();
  w.applyLiveSessions('claude', [session(NEW)], () => true, () => 1000, files(40, 6));
  const before = w.version;
  assert.deepEqual(w.refreshSizes(files(40, 6)), []);
  assert.equal(w.version, before, 'nothing happened: the version must not say otherwise');
});

test('a project nobody works in is not scanned again', () => {
  const w = world();
  w.ensureProjects([IDLE], () => true, () => 1000, files(300));
  w.applyLiveSessions('claude', [session(NEW)], () => true, () => 1000, files(0));

  const scanned: string[] = [];
  w.refreshSizes((cwd) => {
    scanned.push(cwd);
    return { files: 12, dirs: 2 };
  });
  assert.deepEqual(scanned, [NEW]);
  assert.equal(sizeOf(w, 'archive'), 300);
});

test('a project that keeps its place keeps it while it grows', () => {
  const w = world();
  w.applyLiveSessions('claude', [session(NEW)], () => true, () => 1000, files(0));
  const before = w.snapshot().projects[0]!;
  w.refreshSizes(files(98));
  const after = w.snapshot().projects[0]!;
  assert.equal(after.slot, before.slot);
  assert.equal(after.id, before.id);
  assert.equal(after.name, before.name);
});

test('a folder that is gone is not measured', () => {
  const w = world();
  w.applyLiveSessions('claude', [session(NEW)], () => false, () => 1000, files(40));
  let scans = 0;
  const out = w.refreshSizes(() => {
    scans++;
    return { files: 0, dirs: 0 };
  });
  assert.equal(scans, 0);
  assert.deepEqual(out, []);
  assert.equal(sizeOf(w, 'tower_defense'), 40, 'a ruin keeps the shape it had');
});

/**
 * The details say how many files and folders the tower stands for (the
 * user's request, 2026-10-16). A Laravel scaffold gives a folder a hundred
 * new files in one commit and fills `storage/framework/views` on every page
 * rendered: the count a tower is built from is what the card has to show.
 */
test('the folders are counted with the files, and a new folder is news', () => {
  const w = world();
  w.applyLiveSessions('claude', [session(NEW)], () => true, () => 1000, files(40, 6));
  assert.equal(w.snapshot().projects[0]!.dirs, 6);

  const out = w.refreshSizes(files(40, 7));
  assert.equal(out.length, 1, 'an empty folder adds no file, and still changes what the card says');
  assert.equal(out[0]!.t === 'project.add' && out[0]!.project.dirs, 7);
});

test('the scan counts the folders it goes into, and none it skips', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'towerglow-size-'));
  try {
    for (const dir of ['app/Http', 'app/Models', 'node_modules/left-pad', '.git/objects', 'storage/framework/views']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    for (const file of ['app/Http/Kernel.php', 'app/Models/User.php', 'node_modules/left-pad/index.js',
      '.git/HEAD', 'storage/framework/views/0a1b.php', '.env', 'composer.json']) {
      fs.writeFileSync(path.join(root, file), '');
    }
    // app, app/Http, app/Models, storage, storage/framework, storage/framework/views:
    // node_modules and .git are neither entered nor counted.
    assert.deepEqual(measureProject(root), { files: 5, dirs: 6 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the home folder registered as a project measures nothing', () => {
  assert.deepEqual(measureProject('/Users/tester', '/Users/tester'), { files: 0, dirs: 0 });
});
