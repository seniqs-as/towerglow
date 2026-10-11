import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { parseGlb, bytesFromDataUri } from '../src/client/assets/glb.ts';
import type { GlbDocument } from '../src/client/assets/glb.ts';

function bytes(name: string): Uint8Array {
  const buf = readFileSync(new URL(`../src/client/assets/${name}.glb`, import.meta.url));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

const docs = new Map<string, GlbDocument>();
function doc(name: string): GlbDocument {
  let d = docs.get(name);
  if (!d) {
    d = parseGlb(bytes(name));
    docs.set(name, d);
  }
  return d;
}

test('spacebase.glb has 57 root nodes, 67 meshes, one material and one embedded PNG', () => {
  const d = doc('spacebase');
  assert.equal(d.root.children.length, 57);
  assert.equal(d.nodeCount, 73);
  assert.equal(d.meshCount, 67);
  assert.equal(d.materialCount, 1);
  assert.ok(d.image, 'the atlas must come out');
  assert.equal(d.image.mimeType, 'image/png');
  // PNG signature: the bytes are the file's, not a slice of something else.
  assert.deepEqual([...d.image.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(d.image.bytes.length, 25749);
  assert.equal(d.skinned.length, 0);
  assert.equal(d.animations.length, 0);
});

test('interleaved buffer views are de-interleaved: position is a plain float array of item size 3', () => {
  const d = doc('crew');
  const mesh = d.skinned[0]!;
  const pos = mesh.geometry.getAttribute('position');
  assert.ok(pos.array instanceof Float32Array);
  assert.equal(pos.itemSize, 3);
  assert.equal(pos.array.length, pos.count * 3);
  // The accessor's own min/max, read off the file: the left arm sits at
  // x in [0.089, 0.989], y in [0.985, 1.231]. Reading the wrong stride would
  // scramble these into garbage.
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox!;
  assert.ok(Math.abs(box.min.x - 0.0888) < 1e-3 && Math.abs(box.max.x - 0.9892) < 1e-3, `x ${box.min.x}..${box.max.x}`);
  assert.ok(Math.abs(box.min.y - 0.9846) < 1e-3 && Math.abs(box.max.y - 1.2310) < 1e-3, `y ${box.min.y}..${box.max.y}`);
  const joints = mesh.geometry.getAttribute('skinIndex');
  assert.equal(joints.itemSize, 4);
  assert.ok(joints.array instanceof Uint8Array, 'joints are bytes in the file and stay bytes');
  const index = mesh.geometry.index!;
  assert.ok(index.array instanceof Uint16Array);
  let max = 0;
  for (let i = 0; i < index.count; i++) max = Math.max(max, index.getX(i));
  assert.ok(max < pos.count, 'an index must point inside the vertex array');
});

test('crew.glb has one skin with 21 joints and 15 named clips', () => {
  const d = doc('crew');
  assert.equal(d.skinned.length, 6);
  const skeleton = d.skinned[0]!.skeleton;
  assert.equal(skeleton.bones.length, 21);
  assert.equal(skeleton.boneInverses.length, 21);
  // Compared as booleans on purpose: an assertion that fails on two Object3D
  // graphs tries to print their difference, and a scene graph is cyclic and
  // huge. The first version of this line took the whole test file down with
  // a SIGKILL instead of a message.
  for (const m of d.skinned) assert.ok(m.skeleton === skeleton, `${m.name} has a skeleton of its own`);
  assert.deepEqual(d.animations.map((a) => a.name).sort(), [
    'Cheering', 'Hammering', 'Hit_A', 'Idle_A', 'Idle_B', 'Interact', 'Jump_Full_Short', 'Running_A',
    'Sit_Floor_Down', 'Sit_Floor_Idle', 'Sit_Floor_StandUp', 'Spawn_Ground', 'Waving', 'Walking_A', 'Working_A',
  ].sort());
  for (const a of d.animations) assert.ok(a.duration > 0.3, `${a.name} has no duration`);
});

test('node names are sanitised as three does, so the hand.r bone still binds (handr)', () => {
  const d = doc('crew');
  const names = d.skinned[0]!.skeleton.bones.map((b) => b.name);
  assert.ok(names.includes('handr'), `bones: ${names.join(' ')}`);
  assert.ok(!names.some((n) => n.includes('.')), 'no dot survives: it is a path separator in a track name');
  assert.ok(names.includes('head') && names.includes('chest'));
});

test('every track of every clip finds its node in the rig', () => {
  const d = doc('crew');
  for (const clip of d.animations) {
    assert.ok(clip.tracks.length > 40, `${clip.name} has ${clip.tracks.length} tracks`);
    for (const track of clip.tracks) {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      const node = THREE.PropertyBinding.findNode(d.root, parsed.nodeName);
      assert.ok(node, `${clip.name}: no node for ${track.name}`);
      assert.ok(['position', 'quaternion', 'scale'].includes(parsed.propertyName));
    }
  }
});

test('the mixer drives the skeleton: a frame of Walking_A moves a leg', () => {
  const d = doc('crew');
  const mixer = new THREE.AnimationMixer(d.root);
  const clip = d.animations.find((a) => a.name === 'Walking_A')!;
  const leg = THREE.PropertyBinding.findNode(d.root, 'upperlegl') as THREE.Object3D;
  const rest = leg.quaternion.clone();
  const action = mixer.clipAction(clip);
  action.play();
  mixer.setTime(clip.duration * 0.3);
  assert.ok(leg.quaternion.angleTo(rest) > 0.05, 'the leg must have swung');
  mixer.stopAllAction();
});

test('forest.glb parts arrive at their own origin with position, normal and uv only', () => {
  const d = doc('forest');
  assert.equal(d.root.children.length, 16);
  for (const node of d.root.children) {
    assert.ok(node instanceof THREE.Mesh, `${node.name} is not a mesh`);
    assert.deepEqual(Object.keys(node.geometry.attributes).sort(), ['normal', 'position', 'uv']);
    assert.ok(node.geometry.index, `${node.name} is not indexed`);
  }
});

test('a truncated or non-glTF file is refused with an Error, never a NaN geometry', () => {
  assert.throws(() => parseGlb(new Uint8Array(8)), /too short/);
  assert.throws(() => parseGlb(new TextEncoder().encode('not a glb at all, just text')), /bad magic/);
  const whole = bytes('forest');
  assert.throws(() => parseGlb(whole.subarray(0, whole.length - 5000)), /truncated/);
  // A header that lies about its length is the same as a truncated file.
  const lying = whole.slice(0, 40000);
  assert.throws(() => parseGlb(lying), /truncated/);
});

test('a data URI decodes back to the same bytes', () => {
  const original = new Uint8Array([0, 1, 2, 250, 251, 255, 103, 108, 84, 70]);
  const uri = `data:model/gltf-binary;base64,${Buffer.from(original).toString('base64')}`;
  assert.deepEqual([...bytesFromDataUri(uri)], [...original]);
  assert.throws(() => bytesFromDataUri('data:text/plain,hello'), /base64/);
});
