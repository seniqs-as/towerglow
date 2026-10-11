import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { parseGlb } from '../src/client/assets/glb.ts';
import { loadKit, kitReady } from '../src/client/assets/kit.ts';
import {
  createBuilding, buildingUniforms, KIND_IDS, SMALL_KINDS, SMALL_FOOTPRINT,
} from '../src/client/world/habitats.ts';
import type { KindId } from '../src/client/world/habitats.ts';
import { Zone, FLASH_S } from '../src/client/world/zones.ts';
import { DECK_TOP, HEX_DIRS, HEX_SIZE, TILE, deckTop, hexToWorld, slotToCell } from '../src/shared/layout.ts';

// Both kits, once: a building asks the base kit for its parts by name, and a
// zone scatters clutter from it only once it is loaded.
function load(): void {
  if (kitReady('base')) return;
  for (const [id, file] of [['base', 'spacebase'], ['forest', 'forest']] as const) {
    const buf = readFileSync(new URL(`../src/client/assets/${file}.glb`, import.meta.url));
    loadKit(id, parseGlb(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)), null);
  }
}

const ACCENT = 0xc96442;

/**
 * Run a material's `onBeforeCompile` against a stub of the shader three would
 * hand it: every include the hooks replace, and an empty uniform table. What
 * comes back is what the GPU would compile, minus the GPU.
 */
function compile(material: THREE.Material): THREE.WebGLProgramParametersWithUniforms {
  const shader = {
    uniforms: {},
    vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>\n',
    fragmentShader: [
      '#include <common>', '#include <clipping_planes_fragment>', '#include <color_fragment>',
      '#include <roughnessmap_fragment>', '#include <metalnessmap_fragment>', '#include <emissivemap_fragment>',
    ].join('\n'),
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, null as unknown as THREE.WebGLRenderer);
  return shader;
}

test('every recipe builds into one mesh with a real footprint and height', () => {
  load();
  assert.equal(KIND_IDS.length, 10);
  for (const kind of KIND_IDS) {
    const b = createBuilding({ seed: 11, accent: ACCENT, kind });
    assert.equal(b.kind, kind);
    assert.ok(b.label.length > 0, `${kind} has a label`);
    assert.ok(b.mesh instanceof THREE.Mesh, `${kind} is one mesh`);
    assert.ok(b.footprint > 0.5 && b.footprint < 4, `${kind} footprint ${b.footprint}`);
    assert.ok(b.height > 1 && b.height < 5, `${kind} height ${b.height}`);
    const geo = b.mesh.geometry;
    const n = geo.getAttribute('position').count;
    assert.ok(n > 0);
    // The merged buffer carries the shader's per-vertex flags for every part.
    for (const name of ['aEmissive', 'aSpin', 'aPivot']) {
      assert.equal(geo.getAttribute(name).count, n, `${kind} carries ${name} for every vertex`);
    }
    const mat = b.mesh.material;
    assert.ok(mat instanceof THREE.MeshStandardMaterial);
    assert.equal(mat.side, THREE.FrontSide, 'closed solids are drawn single-sided');
    assert.equal(mat.map, null, 'no atlas in a test, and still a building');
    assert.ok(b.mesh.customDepthMaterial instanceof THREE.MeshDepthMaterial, `${kind} sinks its shadow too`);
    b.dispose();
  }
});

test('the same seed always gives the same building', () => {
  load();
  const kinds = new Set<KindId>();
  for (let seed = 0; seed < 24; seed++) {
    const a = createBuilding({ seed, accent: ACCENT, kind: null });
    const b = createBuilding({ seed, accent: ACCENT, kind: null });
    assert.equal(a.kind, b.kind, `seed ${seed} picks one kind`);
    assert.equal(a.label, b.label);
    assert.equal(a.mesh.geometry.getAttribute('position').count, b.mesh.geometry.getAttribute('position').count);
    assert.equal(a.footprint, b.footprint);
    assert.equal(a.height, b.height);
    kinds.add(a.kind);
    a.dispose();
    b.dispose();
  }
  assert.ok(kinds.size > 3, `the seed picks the kind, not the caller: ${[...kinds].join(', ')}`);
  // Forcing a kind spends no random draw on the choice, so the forced building
  // is the one the seed would have built had it landed on that kind.
  const forced = createBuilding({ seed: 5, accent: ACCENT, kind: 'lab' });
  assert.equal(forced.kind, 'lab');
  forced.dispose();
});

test('a building rises from nothing: progress 0 hides it, 1 shows it whole', () => {
  load();
  const b = createBuilding({ seed: 3, accent: ACCENT, kind: 'habitat' });
  const surface = compile(b.mesh.material as THREE.Material);
  const shadow = compile(b.mesh.customDepthMaterial as THREE.Material);
  assert.equal(b.progress, 1);
  assert.equal(b.mesh.visible, true);
  assert.equal(surface.uniforms['uProgress']?.value, 1);

  b.setProgress(0);
  assert.equal(b.progress, 0);
  assert.equal(b.mesh.visible, false, 'nothing to draw at zero');
  assert.equal(surface.uniforms['uProgress']?.value, 0, 'the sink reads the uniform');
  assert.equal(shadow.uniforms['uProgress'], surface.uniforms['uProgress'], 'the shadow pass reads the very same object');

  b.setProgress(0.5);
  assert.equal(b.mesh.visible, true);
  assert.equal(surface.uniforms['uProgress']?.value, 0.5);

  b.setProgress(7);
  assert.equal(b.progress, 1, 'clamped');
  assert.equal(b.mesh.visible, true);

  // The sink and the discard are in the compiled program, and the ground line
  // is measured from the geometry's own floor, not from zero.
  assert.match(surface.vertexShader, /transformed\.y -= \( 1\.0 - uProgress \)/);
  assert.match(surface.fragmentShader, /float ground = uMinY \+/);
  assert.match(shadow.fragmentShader, /discard/);
  assert.equal(surface.uniforms['uMinY']?.value, b.mesh.geometry.boundingBox?.min.y);
  assert.equal(surface.uniforms['uMaxY']?.value, b.height);
  // Night is one write for the whole colony: every building shares the object.
  assert.equal(surface.uniforms['uNight'], buildingUniforms.uNight);
  // Rotors are the exception: each building turns on a clock of its own.
  assert.equal(shadow.uniforms['uSpin'], surface.uniforms['uSpin'], 'a blade casts its shadow where it is drawn');
  assert.doesNotMatch(surface.vertexShader, /uTime/, 'no shader reads the colony-wide clock any more');
  assert.doesNotMatch(shadow.vertexShader, /uTime/);
  b.dispose();
});

test('each building turns its rotors on its own clock, so one project can race while the next stands still', () => {
  load();
  const busy = createBuilding({ seed: 1, accent: ACCENT, kind: 'antenna' });
  const quiet = createBuilding({ seed: 1, accent: ACCENT, kind: 'antenna' });
  const surface = compile(busy.mesh.material as THREE.Material);
  const other = compile(quiet.mesh.material as THREE.Material);
  for (let i = 0; i < 60; i++) {
    busy.turn(0.1);
    quiet.turn(0);
  }
  assert.ok(Math.abs(busy.spin - 6) < 1e-9, `the turns add up: ${busy.spin}`);
  assert.equal(quiet.spin, 0, 'a building nobody turned has not moved');
  assert.equal(surface.uniforms['uSpin']?.value, busy.spin, 'the shader reads what was turned');
  assert.equal(other.uniforms['uSpin']?.value, 0);
  busy.turn(Number.NaN);
  assert.ok(Math.abs(busy.spin - 6) < 1e-9, 'a NaN turn is ignored rather than freezing the blades for good');
  busy.dispose();
  quiet.dispose();
});

test('only a building with a turning part says it has a rotor', () => {
  load();
  for (const seed of [1, 2, 3]) {
    const mast = createBuilding({ seed, accent: ACCENT, kind: 'antenna' });
    const silo = createBuilding({ seed, accent: ACCENT, kind: 'silo' });
    assert.equal(mast.hasRotor, true, `relay mast seed ${seed}`);
    assert.equal(silo.hasRotor, false, `storage seed ${seed}`);
    mast.dispose();
    silo.dispose();
  }
});

test('the construction band can be lit on a finished building, clamped to 0..1', () => {
  load();
  const b = createBuilding({ seed: 4, accent: ACCENT, kind: 'pad' });
  const surface = compile(b.mesh.material as THREE.Material);
  assert.equal(b.progress, 1);
  assert.match(surface.fragmentShader, /max\( rising, uBand \)/, 'the band is not gated on rising alone');
  b.setBand(0.6);
  assert.equal(b.band, 0.6);
  assert.equal(surface.uniforms['uBand']?.value, 0.6);
  b.setBand(4);
  assert.equal(b.band, 1);
  b.setBand(-1);
  assert.equal(b.band, 0);
  b.setBand(Number.NaN);
  assert.equal(surface.uniforms['uBand']?.value, 0);
  b.dispose();
});

test('a rotor turns about a hub that was scaled along with the mast', () => {
  load();
  // The relay mast is the one recipe with a spinning part. `scale()` moves
  // positions and normals but not a custom attribute, so the hub has to be
  // rescaled by hand: at 1.45 the tall hub sits at 2.9725, the low at 1.2905.
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const b = createBuilding({ seed, accent: ACCENT, kind: 'antenna' });
    const spin = b.mesh.geometry.getAttribute('aSpin');
    const pivot = b.mesh.geometry.getAttribute('aPivot');
    let turning = 0;
    for (let i = 0; i < spin.count; i++) {
      if (spin.getX(i) <= 0) continue;
      turning++;
      const y = pivot.getY(i);
      assert.ok(Math.abs(y - 2.05 * 1.45) < 1e-4 || Math.abs(y - 0.89 * 1.45) < 1e-4, `hub at ${y}`);
      assert.ok(spin.getX(i) > 0.17 && spin.getX(i) < 0.26, 'slow: a little over half a minute a turn');
    }
    assert.ok(turning > 0, 'the fan is on the mast');
    assert.ok(turning < spin.count, 'and the mast itself stands still');
    b.dispose();
  }
});

test('the small kinds fit inside a building spot', () => {
  load();
  assert.ok(SMALL_KINDS.length > 0);
  // Ring spots stand `TILE * 0.58` apart (see `zoneSlot`): two small
  // buildings on neighbouring spots must leave a gap between them.
  assert.ok(SMALL_FOOTPRINT * 2 < TILE * 0.58, 'two smalls never touch');
  for (const kind of SMALL_KINDS) {
    for (let seed = 0; seed < 128; seed++) {
      const b = createBuilding({ seed, accent: ACCENT, kind });
      assert.ok(b.footprint <= SMALL_FOOTPRINT, `${kind} seed ${seed} reaches ${b.footprint}`);
      b.dispose();
    }
  }
});

// -- zones --------------------------------------------------------------------------------

/** Vertices one primitive contributes to a merged buffer: how bars and tiles are counted. */
const BOX_VERTS = new THREE.BoxGeometry(1, 1, 1).getAttribute('position').count;
const HEX_VERTS = new THREE.CylinderGeometry(1, 1, 1, 6).getAttribute('position').count;
/** The ramp's slab: the slope and a side either way, a face's corners each. */
const RAMP_VERTS = 4 + 3 + 3;
/** Every edge's bar, the ramp edge's split either side of the ramp, and a rail down each side of it. */
const KERB_BARS = 6 + 1 + 2;

function meshNamed(zone: Zone, name: string): THREE.Mesh {
  const o = zone.group.getObjectByName(name);
  assert.ok(o instanceof THREE.Mesh, `zone has a ${name}`);
  return o;
}

test('a zone is one hex, its decks stacked by size, with the kerb on the top one', () => {
  load();
  const zone = new Zone({ id: 'stack', slot: 4, levels: 3, accent: ACCENT }, null);
  assert.deepEqual(zone.cell, slotToCell(4));
  const at = hexToWorld(zone.cell.q, zone.cell.r);
  assert.equal(zone.holds(at.x, at.z, 0), true);
  const [dq, dr] = HEX_DIRS[0]!;
  const next = hexToWorld(zone.cell.q + dq, zone.cell.r + dr);
  assert.equal(zone.holds(next.x, next.z, 0), false, 'one hex, never its neighbour');
  assert.equal(zone.levels, 3);
  assert.equal(zone.top, deckTop(3));
  assert.ok(Math.abs(zone.radius - HEX_SIZE) < 1e-9);

  // A plate per level, plus the core behind the seams, plus the ramp.
  const deck = meshNamed(zone, 'deck');
  assert.equal(deck.geometry.getAttribute('position').count, 4 * HEX_VERTS + RAMP_VERTS);
  deck.geometry.computeBoundingBox();
  assert.ok(Math.abs(deck.geometry.boundingBox!.max.y - zone.top) < 1e-6, 'the top face is the top deck');
  assert.ok(deck.geometry.boundingBox!.min.y < 0, 'and the skirt reaches under the ground');
  // Every plate is as thick as the ground deck: each level adds exactly one.
  const tops = new Set<string>();
  const pos = deck.geometry.getAttribute('position');
  for (let i = 0; i < pos.count; i++) tops.add(pos.getY(i).toFixed(3));
  for (let level = 1; level <= 3; level++) {
    assert.ok(tops.has((level * DECK_TOP).toFixed(3)), `no plate tops out at level ${level}`);
  }

  // The kerb: all six edges, on the top deck, never inside it -- except the
  // rails, which follow the ramp down and on under the ground.
  const kerb = meshNamed(zone, 'kerb');
  assert.equal(kerb.geometry.getAttribute('position').count, KERB_BARS * BOX_VERTS);
  const kpos = kerb.geometry.getAttribute('position');
  for (let i = 0; i < kpos.count; i++) {
    const x = kpos.getX(i) + zone.center.x;
    const z = kpos.getZ(i) + zone.center.z;
    const ramp = zone.rampHeight(x, z);
    if (ramp === null) assert.ok(kpos.getY(i) >= zone.top - 1e-6, `a kerb corner below the top deck at ${x}, ${z}`);
    else assert.ok(kpos.getY(i) >= ramp - 0.05, `a rail corner under the ramp at ${x}, ${z}`);
  }

  // The group stands on the cell; spot 0 is its centre, on the top deck.
  const origin = hexToWorld(zone.cell.q, zone.cell.r);
  assert.deepEqual([zone.group.position.x, zone.group.position.y, zone.group.position.z], [origin.x, 0, origin.z]);
  const out = new THREE.Vector3();
  zone.worldSlot(0, out);
  assert.deepEqual([out.x, out.y, out.z], [origin.x, zone.top, origin.z]);
  zone.worldSlot(1, out);
  assert.ok(Math.abs(Math.hypot(out.x - origin.x, out.z - origin.z) - TILE * 0.58) < 1e-9, 'spot 1 is on the ring');

  // Room to stand: the middle yes, the edge of the deck no, whatever the angle.
  assert.equal(zone.holds(origin.x, origin.z), true);
  const apothem = TILE * Math.cos(Math.PI / 6);
  for (let k = 0; k < 12; k++) {
    const a = (Math.PI / 6) * k;
    assert.equal(zone.holds(origin.x + Math.cos(a) * apothem, origin.z + Math.sin(a) * apothem), false, `edge at ${k}`);
    assert.equal(zone.holds(origin.x + Math.cos(a) * 3.5, origin.z + Math.sin(a) * 3.5), true, `inside at ${k}`);
  }
  zone.dispose();
});

test('a zone with no surfaces still builds', () => {
  load();
  for (const levels of [1, 7, Number.NaN]) {
    const zone = new Zone({ id: `plain-${levels}`, slot: 9, levels, accent: ACCENT }, null);
    const drawn = Number.isFinite(levels) ? levels : 1;
    assert.equal(zone.levels, drawn, 'a NaN stack is one deck');
    const deck = meshNamed(zone, 'deck');
    assert.ok(deck.material instanceof THREE.MeshStandardMaterial);
    assert.equal(deck.material.map, null, 'plain colour, no texture');
    assert.equal(deck.geometry.getAttribute('position').count, (drawn === 1 ? 1 : drawn + 1) * HEX_VERTS + RAMP_VERTS);
    assert.equal(meshNamed(zone, 'kerb').geometry.getAttribute('position').count, KERB_BARS * BOX_VERTS);
    // The kit is loaded, so the yard gets its clutter -- on the top deck, and
    // the navigation grid gets a footprint for every prop, never a needle.
    const clutter = zone.group.getObjectByName('clutter');
    if (zone.clutterSpots.length > 0) {
      assert.ok(clutter instanceof THREE.Mesh);
      clutter.geometry.computeBoundingBox();
      // Two hundredths of slack: the packed cargo is modelled a hair below its
      // own origin (-0.010, times the 1.35 the clutter scales it by).
      assert.ok(clutter.geometry.boundingBox!.min.y >= zone.top - 0.02, 'the clutter sits on the top deck');
      assert.ok(clutter.geometry.boundingBox!.min.y < zone.top + 0.02, 'and not above it');
      for (const s of zone.clutterSpots) assert.ok(s.r >= 0.45);
    } else {
      assert.equal(clutter, undefined);
    }
    zone.setNight(0.8, true, 12);
    zone.dispose();
  }
  // The same id lays the same yard out on every reload.
  const a = new Zone({ id: 'again', slot: 2, levels: 4, accent: ACCENT }, null);
  const b = new Zone({ id: 'again', slot: 2, levels: 4, accent: ACCENT }, null);
  assert.deepEqual(a.clutterSpots, b.clutterSpots);
  a.dispose();
  b.dispose();
});

test('the kerb chase is clamped and follows the head the colony hands it, in the compiled kerb shader', () => {
  load();
  const zone = new Zone({ id: 'chase', slot: 2, levels: 1, accent: ACCENT }, null);
  const kerb = compile(meshNamed(zone, 'kerb').material as THREE.Material);
  assert.match(kerb.fragmentShader, /uniform float uChase/);
  assert.match(kerb.vertexShader, /vKerbXZ = position\.xz/, 'the angle is taken in zone-local space');
  assert.deepEqual(zone.kerbState(), { chase: 0, head: 0, flash: 0 }, 'a quiet zone runs nothing');

  zone.setChase(0.5, 1.2);
  assert.deepEqual(zone.kerbState(), { chase: 0.5, head: 1.2, flash: 0 });
  assert.equal(kerb.uniforms['uChase']?.value, 0.5, 'the shader reads what the colony wrote');
  zone.setChase(3, 2.4);
  assert.equal(zone.kerbState().chase, 1, 'clamped at full');
  zone.setChase(Number.NaN, Number.NaN);
  assert.deepEqual(zone.kerbState(), { chase: 0, head: 2.4, flash: 0 }, 'NaN is off, and a NaN head keeps its place');
  zone.dispose();
});

test('a kerb flash peaks on the next frame and is gone after FLASH_S, even when asked before the first frame', () => {
  load();
  const zone = new Zone({ id: 'flash', slot: 3, levels: 2, accent: ACCENT }, null);
  const kerb = compile(meshNamed(zone, 'kerb').material as THREE.Material);
  zone.flash(0x8ef6c4);
  // The first frame of the page is at 40 s on the stage clock: the flash starts
  // there, not at zero, where it would already be over.
  zone.setNight(0, false, 40);
  assert.equal(zone.kerbState().flash, 1);
  assert.equal(kerb.uniforms['uFlash']?.value, 1);
  const color = kerb.uniforms['uFlashColor']?.value as THREE.Color;
  assert.equal(color.getHex(), 0x8ef6c4);
  zone.setNight(0, false, 40 + FLASH_S / 2);
  const mid = zone.kerbState().flash;
  assert.ok(mid > 0 && mid < 0.5, `fading, faster off the peak: ${mid}`);
  zone.setNight(0, false, 40 + FLASH_S + 0.01);
  assert.equal(zone.kerbState().flash, 0, 'over');
  // A second flash starts again from the top, and the urgent pulse is untouched.
  zone.flash(0xc77dff);
  zone.setNight(0.5, true, 60);
  assert.equal(zone.kerbState().flash, 1);
  assert.equal(color.getHex(), 0xc77dff);
  zone.dispose();
});
