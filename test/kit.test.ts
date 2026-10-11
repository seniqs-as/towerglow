import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { parseGlb } from '../src/client/assets/glb.ts';
import {
  loadKit, kitReady, part, hasPart, partNames, atlasTexture, cellMask, CELL, ATLAS,
} from '../src/client/assets/kit.ts';

function load(): void {
  if (kitReady('base')) return;
  for (const [id, file] of [['base', 'spacebase'], ['forest', 'forest']] as const) {
    const buf = readFileSync(new URL(`../src/client/assets/${file}.glb`, import.meta.url));
    loadKit(id, parseGlb(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)), null);
  }
}

test('the base kit exposes every model of the pack by name, as a plain geometry', () => {
  load();
  const names = partNames('base');
  assert.equal(names.length, 73, 'every node, sub-parts included');
  for (const name of ['basemodule_A', 'roofmodule_base', 'landingpad_large', 'spacetruck', 'lights', 'containers_A']) {
    assert.ok(hasPart(name), `missing ${name}`);
  }
  const geo = part('basemodule_A');
  assert.deepEqual(Object.keys(geo.attributes).sort(), ['normal', 'position', 'uv']);
  assert.ok(geo.getAttribute('position').array instanceof Float32Array);
  assert.ok(geo.boundingBox, 'a part knows its own size');
  assert.ok(geo.boundingBox.max.y > geo.boundingBox.min.y);
  assert.ok(geo.index, 'a part is indexed');
});

test('a part sits at its own origin, not where the pack laid it out', () => {
  load();
  // The pack spreads its models over a grid; harvested in the node frame,
  // every one of them stands on the origin.
  for (const name of ['basemodule_A', 'landingpad_large', 'windturbine_tall']) {
    const box = part(name).boundingBox!;
    assert.ok(box.min.x < 0 && box.max.x > 0, `${name} is off to one side: x ${box.min.x}..${box.max.x}`);
    assert.ok(box.min.z < 0 && box.max.z > 0, `${name} is off to one side: z ${box.min.z}..${box.max.z}`);
    assert.ok(box.min.y > -0.5 && box.min.y < 0.5, `${name} does not stand on the ground: y ${box.min.y}`);
  }
});

test('a turbine comes with its rotor, and solo without it', () => {
  load();
  const whole = part('windturbine_tall');
  const tower = part('windturbine_tall', 'base', { solo: true });
  const fan = part('windturbine_tall_fan');
  assert.ok(whole.getAttribute('position').count > tower.getAttribute('position').count, 'the rotor is part of the whole');
  assert.equal(
    whole.getAttribute('position').count,
    tower.getAttribute('position').count + fan.getAttribute('position').count,
    'whole = tower + fan, nothing more',
  );
  // The fan sits up at the hub, in the tower's frame, when taken as a sub-part
  // of the whole; on its own it sits at its own origin.
  assert.ok(fan.boundingBox!.max.y - fan.boundingBox!.min.y > 0.1);
});

test('an unknown part throws instead of handing back nothing', () => {
  load();
  assert.throws(() => part('habitat_of_dreams'), /no part named/);
  assert.throws(() => part('basemodule_A', 'forest'), /forest kit/);
  assert.throws(() => part('basemodule_A', 'base', { solo: true }) && part('windturbine_low', 'base', { solo: true }) && part('nothing', 'base', { solo: true }), /no solo part/);
});

test('a part is a clone: transforming it leaves the kit alone', () => {
  load();
  const a = part('containers_A');
  a.translate(100, 0, 0);
  const b = part('containers_A');
  // Float32 keeps about six digits: at a hundred units a vertex lands within 1e-4.
  assert.ok(Math.abs(b.getAttribute('position').getX(0) - a.getAttribute('position').getX(0) + 100) < 1e-4);
  assert.notEqual(a.getAttribute('position').array, b.getAttribute('position').array, 'two clones share no buffer');
});

test('the forest kit is separate, and has no atlas in a test', () => {
  load();
  assert.equal(partNames('forest').length, 16);
  assert.ok(hasPart('Rock_1_D_Color1', 'forest'));
  assert.equal(hasPart('Rock_1_D_Color1', 'base'), false);
  assert.equal(atlasTexture('base'), null);
});

test('cellMask marks only the named cells', () => {
  const mask = cellMask([CELL.TRIM, CELL.RED], 0.5);
  assert.equal(mask.length, ATLAS.cols * ATLAS.rows);
  assert.equal(mask[CELL.TRIM], 0.5);
  assert.equal(mask[CELL.RED], 0.5);
  assert.equal(mask.reduce((s, v) => s + v, 0), 1);
});

test('loading a kit twice replaces it rather than doubling it', () => {
  load();
  const before = partNames('forest').length;
  const buf = readFileSync(new URL('../src/client/assets/forest.glb', import.meta.url));
  loadKit('forest', parseGlb(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)), new THREE.Texture());
  assert.equal(partNames('forest').length, before);
  const atlas = atlasTexture('forest');
  assert.ok(atlas);
  assert.equal(atlas.colorSpace, THREE.SRGBColorSpace, 'the atlas is prepared on the way in');
  loadKit('forest', parseGlb(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)), null);
});
