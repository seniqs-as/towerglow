import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { parseGlb } from '../src/client/assets/glb.ts';
import { loadKit, kitReady } from '../src/client/assets/kit.ts';
import { Crates, MAX_CRATES, DROP_SETTLE_S, dropOffset } from '../src/client/world/crates.ts';
import { TILE, deckTop, zoneSlot } from '../src/shared/layout.ts';

function kits(): void {
  if (kitReady('base')) return;
  const buf = readFileSync(new URL('../src/client/assets/spacebase.glb', import.meta.url));
  loadKit('base', parseGlb(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)), null);
}

/** The top of a three-deck stack: the pile stands where the work is, not on the ground. */
const ROOT = new THREE.Vector3(30, deckTop(3), -12);

function crates(): Crates {
  kits();
  const c = new Crates();
  c.place((id) => (id === 'p1' ? ROOT : null));
  return c;
}

test('a commit adds a crate to the pile, twelve at most per project', () => {
  const c = crates();
  for (let i = 0; i < MAX_CRATES + 3; i++) c.add('p1', 'commit');
  assert.equal(c.count('p1'), MAX_CRATES, 'the oldest goes when a thirteenth arrives');
  c.update();
  assert.equal(c.inspect().length, MAX_CRATES);
});

test('the pile stands on the deck, stacked, beside the habitat and clear of the building spots', () => {
  const c = crates();
  for (let i = 0; i < 9; i++) c.add('p1', i % 2 ? 'merge' : 'commit');
  c.update();
  const placed = c.inspect();
  assert.equal(placed.length, 9);
  const layers = new Set(placed.map((p) => p.y.toFixed(3)));
  assert.equal(layers.size, 3, 'nine crates make three layers of four');
  assert.ok(Math.min(...placed.map((p) => p.y)) >= ROOT.y - 1e-6, 'the first layer sits on the top deck');
  for (const p of placed) {
    const fromRoot = Math.hypot(p.x - ROOT.x, p.z - ROOT.z);
    // Inside the corner lamp (0.72 of the tile) and well clear of the habitat.
    assert.ok(fromRoot > 2 && fromRoot < TILE * 0.72, `a crate is off the root tile: ${fromRoot}`);
    for (let spot = 1; spot < 7; spot++) {
      const s = zoneSlot(spot);
      const gap = Math.hypot(p.x - (ROOT.x + s.x), p.z - (ROOT.z + s.z));
      assert.ok(gap > 1.9, `a crate crowds building spot ${spot}: ${gap}`);
    }
  }
});

test('a project that leaves takes its pile with it, and an unplaced one shows nothing', () => {
  const c = crates();
  c.add('p1', 'commit');
  c.add('nowhere', 'commit');
  c.update();
  assert.equal(c.inspect().length, 1, 'no root, no crate');
  c.forget('p1');
  c.update();
  assert.equal(c.inspect().length, 0);
  assert.equal(c.count('p1'), 0);
});

test('a crate from history is on the pile at once; a fresh commit falls onto its slot and lands exactly there', () => {
  const landed: { x: number; y: number; z: number; kind: string }[] = [];
  kits();
  const c = new Crates({ onLand: (x, y, z, kind) => landed.push({ x, y, z, kind }) });
  c.place((id) => (id === 'p1' ? ROOT : null));
  c.add('p1', 'commit');
  c.update(1 / 60, 0);
  const rest = c.inspect()[0]!;
  assert.ok(Math.abs(rest.y - ROOT.y) < 1e-6, 'history does not fall');
  assert.equal(landed.length, 0, 'and raises no dust');

  c.add('p1', 'merge', true);
  c.update(1 / 60, 0);
  const first = c.inspect()[1]!;
  assert.ok(first.y > ROOT.y + 5, `a fresh crate starts high above the pile: ${first.y}`);

  // Run past the fall and the bounce.
  let lowest = Infinity;
  for (let i = 0; i < 180; i++) {
    c.update(1 / 60, 0);
    lowest = Math.min(lowest, c.inspect()[1]!.y);
  }
  const end = c.inspect()[1]!;
  assert.ok(lowest >= ROOT.y - 1e-6, 'it never sinks into the deck');
  assert.ok(Math.abs(end.y - ROOT.y) < 1e-6, `and rests on the deck: ${end.y}`);
  assert.equal(landed.length, 1, 'one landing, not one per bounce');
  assert.equal(landed[0]!.kind, 'merge');
  assert.ok(Math.abs(landed[0]!.x - end.x) < 1e-5 && Math.abs(landed[0]!.z - end.z) < 1e-5, 'the dust goes up where it rests');
});

test('a crate still falling when the pile shifts lands on the slot it moved to', () => {
  const landed: { x: number; z: number }[] = [];
  kits();
  const c = new Crates({ onLand: (x, _y, z) => landed.push({ x, z }) });
  c.place((id) => (id === 'p1' ? ROOT : null));
  for (let i = 0; i < MAX_CRATES; i++) c.add('p1', 'commit');
  c.add('p1', 'reset', true); // the thirteenth: the oldest goes, and everything moves down one slot
  c.update(0.2, 0);
  c.add('p1', 'commit'); // and it shifts again mid-air
  for (let i = 0; i < 120; i++) c.update(1 / 60, 0);
  const placed = c.inspect();
  assert.equal(placed.length, MAX_CRATES);
  const slot = placed[MAX_CRATES - 2]!;
  assert.equal(landed.length, 1);
  assert.ok(Math.abs(landed[0]!.x - slot.x) < 1e-5 && Math.abs(landed[0]!.z - slot.z) < 1e-5, 'landed on its new slot');
});

test('the drop falls all the way before the first impact, then one small hop and rest', () => {
  let prev = dropOffset(0).y;
  assert.equal(dropOffset(0).landed, false);
  assert.equal(dropOffset(Number.NaN).landed, false);
  let t = 0;
  for (; !dropOffset(t).landed; t += 0.01) {
    const y = dropOffset(t).y;
    assert.ok(y <= prev + 1e-12, `still falling at ${t.toFixed(2)}`);
    prev = y;
  }
  assert.ok(t > 0.5 && t < 1.2, `a fall that reads as a fall: ${t}`);
  const hop = Math.max(...Array.from({ length: 40 }, (_, i) => dropOffset(t + i * 0.01).y));
  assert.ok(hop > 0.05 && hop < 0.5, `one small hop: ${hop}`);
  assert.equal(dropOffset(DROP_SETTLE_S + 0.01).y, 0);
  assert.equal(dropOffset(DROP_SETTLE_S + 0.01).landed, true);
});
