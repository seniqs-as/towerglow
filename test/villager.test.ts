import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { parseGlb } from '../src/client/assets/glb.ts';
import { buildVillager, VILLAGER_PARTS, VILLAGER_SCALE } from '../src/client/assets/villager.ts';
import type { VillagerBody } from '../src/client/assets/villager.ts';
import { Visitor } from '../src/client/agents/visitor.ts';
import type { Agent } from '../src/client/agents/astronauts.ts';
import { CEO_SIZE, ROOM } from '../src/client/world/interior.ts';

/**
 * You, out of the wardrobe: the villager pack holds three heads, three
 * beards and six outfits on one skeleton, and what goes on screen is one
 * person in ordinary clothes. Built here from the real file, with no DOM.
 */

function body(face: THREE.Texture | null = null): VillagerBody {
  const buf = readFileSync(new URL('../src/client/assets/villager.glb', import.meta.url));
  const doc = parseGlb(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  return buildVillager(doc, face);
}

function meshes(b: VillagerBody): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  b.root.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
}

test('one of everything a person has one of: no second head, no beard, no gear, no costume', () => {
  const names = meshes(body()).map((m) => m.name).sort();
  // The cap is the one thing worn that the pack does not carry: see `capFor`.
  assert.deepEqual(names, [...VILLAGER_PARTS, 'Cap'].sort());
  for (const gone of ['Head_B_0', 'Head_C_0', 'Beard_A', 'Hair_Long', 'Gear_Sword', 'Outfit_Robe_0']) {
    assert.ok(!names.includes(gone), `${gone} is still being worn`);
  }
  // Every part out of the pack is skinned to the one armature: a figure with
  // a loose sleeve would walk out of it.
  for (const m of meshes(body())) {
    if (m.name === 'Cap') continue;
    assert.ok(m instanceof THREE.SkinnedMesh, `${m.name} is not skinned`);
  }
});

/** An astronaut is 1.222 m to the top of its helmet: the mannequin's 2.204 units at CREW_SCALE 0.56, plus the helmet's offset above the head bone. */
const ASTRONAUT_M = 1.222;

/** What the figure occupies, floor to crown, cap and all, in its own units. */
function bounds(b: VillagerBody): THREE.Box3 {
  b.root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const m of meshes(b)) {
    m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld));
  }
  return box;
}

test('you walk in taller than the crew, and taller than the CEOs you came to see', () => {
  const box = bounds(body());
  const drawn = box.max.y * VILLAGER_SCALE;
  // The user's call (2026-09-20): the one who walks in is the tall one.
  assert.ok(drawn > ASTRONAUT_M * 1.2, `${drawn.toFixed(3)} m against an astronaut's ${ASTRONAUT_M}`);
  assert.ok(drawn > ASTRONAUT_M * CEO_SIZE + 0.15, `${drawn.toFixed(3)} m against a CEO's ${(ASTRONAUT_M * CEO_SIZE).toFixed(3)}`);
  // And a person, not a giant: a head over the desk, not over the room.
  assert.ok(drawn < ROOM.height * 0.6, `${drawn.toFixed(3)} m in a room ${ROOM.height} high`);
  assert.ok(box.min.y > -0.01 && box.min.y < 0.01, `not standing on the floor: ${box.min.y}`);
});

test('the cap is worn, not skinned: it rides the head bone the pack has no hat for', () => {
  const b = body();
  const cap = b.root.getObjectByName('Cap');
  assert.ok(cap instanceof THREE.Mesh, 'bare-headed');
  // On the bone, so every clip carries it: skinned to nothing, parented to
  // the one thing that already turns with the head.
  assert.equal(cap.parent?.name, 'Head');
  assert.ok((cap.parent as THREE.Bone).isBone, 'hung off a node that does not move with the head');
  const white = (cap.material as THREE.MeshStandardMaterial).color;
  assert.ok(white.r > 0.85 && white.g > 0.85 && white.b > 0.85, `not a white cap: #${white.getHexString()}`);
  // Over the hair, not through it: the crown's top clears the hair's.
  const hair = meshes(b).find((m) => m.name === 'Hair_Short')!;
  b.root.updateMatrixWorld(true);
  hair.geometry.computeBoundingBox();
  const hairTop = hair.geometry.boundingBox!.clone().applyMatrix4(hair.matrixWorld).max.y;
  cap.geometry.computeBoundingBox();
  const capTop = cap.geometry.boundingBox!.clone().applyMatrix4(cap.matrixWorld).max.y;
  assert.ok(capTop > hairTop, `the cap's crown at ${capTop.toFixed(3)} is under the hair at ${hairTop.toFixed(3)}`);
});

test('the clothes keep the colour the pack painted them; skin and hair are given one', () => {
  const by = new Map(meshes(body()).map((m) => [m.name, m.material as THREE.MeshStandardMaterial]));
  const shirt = by.get('Base_Shirt')!;
  assert.notEqual(shirt.color.getHex(), 0xffffff, 'the shirt is a blank white sheet');
  assert.equal(by.get('Base_Trousers')!.vertexColors, false, 'the trousers have no shading gradient to switch on');
  // Skin and hair arrive white with their shading in the vertex colours:
  // both halves have to be there or the figure is a snowman.
  const skin = by.get('Body')!;
  assert.notEqual(skin.color.getHex(), 0xffffff);
  assert.equal(skin.vertexColors, true);
  assert.notEqual(by.get('Hair_Short')!.color.getHex(), 0xffffff);
  // One material each: a tint on a material the pack shares with the gear
  // would paint a sword nobody is carrying.
  assert.notEqual(skin, by.get('Base_Shirt'));
  assert.notEqual(skin.uuid, by.get('Head_A_0')!.uuid);
});

test('the face atlas lands on the three materials that asked for it, and nowhere else', () => {
  const face = new THREE.Texture();
  const by = new Map(meshes(body(face)).map((m) => [m.name, m.material as THREE.MeshStandardMaterial]));
  // The eyes, the brows and the mouth are quads over a blank head: without
  // the atlas they are three stickers of flat colour.
  for (const part of ['Head_A_1', 'Head_A_2', 'Head_A_3']) {
    assert.equal(by.get(part)!.map, face, `${part} has no face on it`);
    assert.equal(by.get(part)!.transparent, true, `${part} would be a square patch on the cheek`);
  }
  // The head's own skin has UVs too, and they are degenerate: a texture on
  // that material is one pixel of the atlas smeared over the whole face.
  assert.equal(by.get('Head_A_0')!.map, null);
  assert.equal(by.get('Body')!.map, null);
  assert.equal(face.colorSpace, THREE.SRGBColorSpace, 'a colour map read as raw data comes out washed out');
});

test('the figure walks and stands, and says so if the pack ever stops carrying both', () => {
  const b = body();
  assert.equal(b.idle.name, 'Idle');
  assert.equal(b.walk.name, 'Walk');
  assert.ok(b.walk.duration > 0 && b.idle.duration > 0);
});

// -- the figure that wears an astronaut ------------------------------------------------

function agent(fields: Partial<Agent>): Agent {
  return {
    id: 'you', status: 'idle', state: 'at-site', pos: new THREE.Vector3(), yaw: 0,
    head: new THREE.Vector3(), groundY: 0, hop: 0, phase: 0, walkAmp: 0, scale: 1,
    workSwing: false, gesture: 'hammer', size: 1, cueLeft: 0, clipKey: 'idle',
    frame: 0, faceFrame: 0, hidden: true, index: 0, ...fields,
  } as Agent;
}

test('the visitor wears the astronaut it follows: its place, its heading, how much of it there is', () => {
  const v = new Visitor(body());
  assert.equal(v.object3d.visible, false, 'drawn before anyone said where');
  v.follow(agent({ pos: new THREE.Vector3(3, 1.5, -2), yaw: 1.2, clipKey: 'walk', walkAmp: 1 }));
  v.update(1 / 30);
  assert.deepEqual(v.object3d.position.toArray(), [3, 1.5, -2]);
  assert.equal(v.object3d.rotation.y, 1.2);
  assert.ok(Math.abs(v.object3d.scale.x - VILLAGER_SCALE) < 1e-9);
  // Rising out of the ground at the foot of the ramp, and shrinking into the
  // hatch at the top of it, are both the astronaut's scale: nothing else.
  v.follow(agent({ scale: 0.5 }));
  assert.ok(Math.abs(v.object3d.scale.x - VILLAGER_SCALE * 0.5) < 1e-9);
  v.follow(agent({ scale: 0 }));
  assert.equal(v.object3d.visible, false, 'still on the ramp after going in through the hatch');
});

test('two figures off one body are two poses, not one: the ramp and the room are both yours', () => {
  const b = body();
  const ramp = new Visitor(b);
  const room = new Visitor(b);
  ramp.follow(agent({ pos: new THREE.Vector3(0, 0, 40) }));
  room.follow(agent({ pos: new THREE.Vector3(0, 0, 3) }));
  assert.notEqual(ramp.object3d, room.object3d);
  assert.equal(ramp.object3d.position.z, 40);
  assert.equal(room.object3d.position.z, 3);
  // The clone shares geometry and materials with the body: disposing one
  // figure must not take the other one's mesh with it.
  ramp.dispose();
  const left: THREE.Mesh[] = [];
  room.object3d.traverse((o) => {
    if (o instanceof THREE.Mesh) left.push(o);
  });
  assert.equal(left.length, VILLAGER_PARTS.length + 1, 'the cap went with the other figure');
  assert.ok(left.every((m) => m.geometry.getAttribute('position').count > 0), 'geometry disposed under it');
});
