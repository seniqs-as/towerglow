import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { parseGlb } from '../src/client/assets/glb.ts';
import {
  bakeCrew, attachMatrixAt, frameFor, decorateSkinned, CLIP_KEYS, ATTACH, BAKE_FPS,
} from '../src/client/assets/crew.ts';
import type { CrewRig } from '../src/client/assets/crew.ts';

let cached: CrewRig | null = null;
function rig(): CrewRig {
  if (!cached) {
    const buf = readFileSync(new URL('../src/client/assets/crew.glb', import.meta.url));
    cached = bakeCrew(parseGlb(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)));
  }
  return cached;
}

test('the bake writes one row per frame: 84 texels wide, rows equal the summed clip lengths', () => {
  const r = rig();
  assert.equal(r.boneCount, 21);
  assert.equal(r.boneTexture.image.width, 21 * 4);
  const frames = CLIP_KEYS.reduce((n, k) => n + r.clips[k].frames, 0);
  assert.equal(r.frameCount, frames);
  assert.equal(r.boneTexture.image.height, frames);
  assert.equal(r.fps, BAKE_FPS);
  // The clips are laid end to end with no gaps and no overlap.
  let at = 0;
  for (const k of CLIP_KEYS) {
    assert.equal(r.clips[k].start, at, `${k} does not start where the previous clip ended`);
    at += r.clips[k].frames;
  }
  // Every row carries real matrices, not zeros left over from allocation.
  const data = r.boneTexture.image.data as Float32Array;
  const last = data.subarray(data.length - 16);
  assert.ok(last.some((v) => v !== 0), 'the last frame is empty');
});

test('the head attachment places a helmet above the feet in the rest frame', () => {
  const r = rig();
  const head = r.attachSlot.get('head')!;
  const hand = r.attachSlot.get('hand.r')!;
  const m = new THREE.Matrix4();
  const y = (slot: number, frame: number): number => attachMatrixAt(r, frame, slot, m).elements[13]!;
  const idle = r.clips.idle.start;
  // The mannequin is authored 2.2 units tall and the head BONE sits at the
  // neck, about 1.23 up (the helmet adds its own offset above it); the hand
  // is somewhere in the middle, and neither is pinned at the origin.
  assert.ok(y(head, idle) > 1.0, `head at ${y(head, idle)}`);
  assert.ok(y(hand, idle) > 0.4 && y(hand, idle) < y(head, idle), `hand at ${y(hand, idle)}`);
  // Sitting brings the head down: measured, from 1.23 to 0.88.
  const sit = r.clips.sit.start + 5;
  assert.ok(y(head, sit) < y(head, idle) - 0.25, `sitting head at ${y(head, sit)} vs ${y(head, idle)}`);
  assert.equal(ATTACH.length, r.attachSlot.size);
});

test('the desk bake holds the head where the sitting loop starts; the floor bake still turns it', () => {
  const r = rig();
  const head = r.attachSlot.get('head')!;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const swing = (clip: { start: number; frames: number }): number => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let f = 0; f < clip.frames; f++) {
      attachMatrixAt(r, clip.start + f, head, m).decompose(new THREE.Vector3(), q, new THREE.Vector3());
      const yaw = e.setFromQuaternion(q, 'YXZ').y * 180 / Math.PI;
      lo = Math.min(lo, yaw);
      hi = Math.max(hi, yaw);
    }
    return hi - lo;
  };
  // Measured on the file: Sit_Floor_Idle swings the head 33 degrees to the
  // left and back over its four seconds. Alone on the ground that is a
  // sleeping astronaut looking around; behind a desk it is two CEOs turning
  // away from you together, because both start the loop on the same frame.
  assert.ok(swing(r.clips.sit) > 25, `the floor bake no longer turns the head: ${swing(r.clips.sit).toFixed(1)} degrees`);
  assert.ok(swing(r.clips.sitDesk) < 3, `the desk bake swings the head ${swing(r.clips.sitDesk).toFixed(1)} degrees`);
  // Same clip otherwise: the body still breathes, so the pair is not a
  // photograph. The head is the only thing pinned.
  assert.equal(r.clips.sitDesk.name, r.clips.sit.name);
  assert.equal(r.clips.sitDesk.frames, r.clips.sit.frames);
});

test('frameFor wraps a looping clip and holds a one-shot on its last frame', () => {
  const r = rig();
  const walk = r.clips.walk;
  assert.equal(frameFor(walk, 0), walk.start);
  const wrapped = frameFor(walk, walk.duration * 2.5);
  assert.ok(wrapped >= walk.start && wrapped < walk.start + walk.frames - 1, `walk wrapped to ${wrapped}`);
  const sitDown = r.clips.sitDown;
  assert.equal(frameFor(sitDown, 1000), sitDown.start + sitDown.frames - 1, 'a one-shot holds its last frame');
  assert.equal(frameFor(null, 3), 0);
});

test('the body leaves the head out and merges the rest into one geometry', () => {
  const r = rig();
  assert.deepEqual(Object.keys(r.geometry.attributes).sort(), ['normal', 'position', 'skinIndex', 'skinWeight']);
  const count = r.geometry.getAttribute('position').count;
  assert.ok(count > 4000 && count < 6675, `${count} vertices: the head (out of 6675) must be gone, the rest there`);
  assert.ok(r.boneIndex.has('head') && r.boneIndex.has('handr'));
  assert.equal(r.bones.length, 21);
});

test('decorateSkinned splices the bake into the vertex shader, and the shadow pass differently', () => {
  const uniforms = { uBones: { value: null }, uFrameMax: { value: 10 } };
  const lit = decorateSkinned(new THREE.MeshStandardMaterial(), uniforms);
  const depth = decorateSkinned(new THREE.MeshDepthMaterial(), uniforms, { normals: false });
  const run = (m: THREE.Material): string => {
    const shader = {
      vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>\n',
      fragmentShader: '',
      uniforms: {} as Record<string, THREE.IUniform>,
    };
    m.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    assert.equal(shader.uniforms['uFrameMax'], uniforms.uFrameMax);
    return shader.vertexShader;
  };
  const a = run(lit);
  assert.ok(a.includes('objectNormal = mat3( botSkin )'), 'the lit pass skins the normal');
  assert.equal(a.split('botSkinMatrix()').length - 1, 2, 'declared once, called once');
  const b = run(depth);
  assert.ok(!b.includes('objectNormal'), 'the depth pass never touches the normal stage');
  assert.ok(b.includes('botSkin = botSkinMatrix();'));
});
