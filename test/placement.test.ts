import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPlacementStore } from '../src/server/state/placement.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-placement-'));
}

test('the most recent takes the centre, the oldest the edges', () => {
  const store = createPlacementStore(tmpDir());
  store.assignMany([
    { id: 'old', lastActiveAt: 1000 },
    { id: 'newest', lastActiveAt: 9000 },
    { id: 'middle', lastActiveAt: 5000 },
  ]);
  assert.equal(store.slotOf('newest'), 0);
  assert.equal(store.slotOf('middle'), 1);
  assert.equal(store.slotOf('old'), 2);
});

test('a new project does NOT move the ones already placed', () => {
  const store = createPlacementStore(tmpDir());
  store.assignMany([
    { id: 'a', lastActiveAt: 3000 },
    { id: 'b', lastActiveAt: 2000 },
  ]);
  const before = { a: store.slotOf('a'), b: store.slotOf('b') };

  // it arrives later, and it is the most recent of all: it must still queue up
  store.assignMany([{ id: 'c', lastActiveAt: 99999 }]);

  assert.equal(store.slotOf('a'), before.a);
  assert.equal(store.slotOf('b'), before.b);
  assert.equal(store.slotOf('c'), 2);
});

test('becoming active again does not change the place', () => {
  const store = createPlacementStore(tmpDir());
  store.assignMany([{ id: 'x', lastActiveAt: 1 }, { id: 'y', lastActiveAt: 2 }]);
  const slotX = store.slotOf('x');
  store.assignMany([{ id: 'x', lastActiveAt: Date.now() }]);
  assert.equal(store.slotOf('x'), slotX);
});

test('the layout survives a restart', () => {
  const dir = tmpDir();
  const first = createPlacementStore(dir);
  first.assignMany([
    { id: 'one', lastActiveAt: 500 },
    { id: 'two', lastActiveAt: 900 },
  ]);
  const expected = { one: first.slotOf('one'), two: first.slotOf('two') };
  first.save();

  const second = createPlacementStore(dir);
  assert.equal(second.slotOf('one'), expected.one);
  assert.equal(second.slotOf('two'), expected.two);
});

test('slotOf assigns a never-seen project on the fly, without collisions', () => {
  const store = createPlacementStore(tmpDir());
  store.assignMany([{ id: 'a', lastActiveAt: 1 }, { id: 'b', lastActiveAt: 2 }]);
  const slots = new Set(['a', 'b', 'surprise', 'another'].map((id) => store.slotOf(id)));
  assert.equal(slots.size, 4);
});

test('a corrupt layout file does not block the tool', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'layout.json'), '{ this is not json');
  const store = createPlacementStore(dir);
  assert.equal(store.slotOf('something'), 0);
});
