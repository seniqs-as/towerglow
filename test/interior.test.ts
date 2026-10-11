import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  Interior, WalkKeys, atDesk, atHatch, ceoStatus, obstaclesFor, seatsFor, walkRoom,
  CEO_SIZE, DESK, DESK_REACH, ENTRY, EXIT_Z, ROOM, SEAT_Y, SEAT_Z, WALKER_RADIUS,
} from '../src/client/world/interior.ts';
import type { DeskPanel } from '../src/client/world/interior.ts';
import { Boarding } from '../src/client/world/boarding.ts';
import { WalkCamera, FOLLOW_BACK, FOLLOW_UP } from '../src/client/core/walkCamera.ts';
import { Astronauts } from '../src/client/agents/astronauts.ts';
import type { CrewWorld } from '../src/client/agents/astronauts.ts';
import { parseGlb } from '../src/client/assets/glb.ts';
import { buildVillager, VILLAGER_SCALE } from '../src/client/assets/villager.ts';
import type { VillagerBody } from '../src/client/assets/villager.ts';
import { ATTACH, BAKE_FPS, CLIP, CLIP_KEYS } from '../src/client/assets/crew.ts';
import type { ClipKey, ClipSpec, CrewRig } from '../src/client/assets/crew.ts';
import { Settings } from '../src/client/core/settings.ts';

/**
 * The room inside the ship, walked with no DOM and no renderer: where you
 * can go, when the Board opens, and that what opens is the panel the room
 * was handed -- the one thing that keeps a second scene from being a second
 * copy of the CEOs' state.
 */

const DT = 1 / 30;

/** A Board panel that remembers every call, and who it was called on. */
class FakePanel implements DeskPanel {
  enabled = true;
  isOpen = false;
  opens: { self: FakePanel; focus: boolean | undefined }[] = [];
  closes = 0;
  open(focus?: boolean): void {
    if (!this.enabled) return;
    this.opens.push({ self: this, focus });
    this.isOpen = true;
  }
  close(): void {
    this.closes++;
    this.isOpen = false;
  }
}

function room(panel: DeskPanel = new FakePanel(), onLeave: () => void = () => {}): Interior {
  return new Interior({ settings: new Settings({ storage: null }), faceTexture: null, panel, onLeave });
}

/** Step the room for `seconds`; `t` runs on across calls. */
function run(r: Interior, seconds: number, from = 0): number {
  let t = from;
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    t += DT;
    r.update(DT, t);
  }
  return t;
}

/** Hold a key until `until` says so, or for `max` seconds. */
function walk(r: Interior, code: string, until: () => boolean, max = 10): void {
  r.keys.press(code);
  let t = 0;
  while (!until() && t < max) {
    t += DT;
    r.update(DT, t);
  }
  r.keys.release(code);
}

/** Just enough rig for the clip logic: every clip four frames, the head at the neck. */
function fakeRig(): CrewRig {
  const clips = {} as Record<ClipKey, ClipSpec>;
  let frameCount = 0;
  for (const key of CLIP_KEYS) {
    clips[key] = { start: frameCount, frames: 4, duration: 3 / BAKE_FPS, loop: CLIP[key].loop, name: CLIP[key].name };
    frameCount += 4;
  }
  const attach = new Float32Array(frameCount * ATTACH.length * 16);
  for (let f = 0; f < frameCount * ATTACH.length; f++) {
    const o = f * 16;
    attach[o] = attach[o + 5] = attach[o + 10] = attach[o + 15] = 1;
    attach[o + 13] = 1;
  }
  return {
    geometry: new THREE.BufferGeometry(), bones: [], boneIndex: new Map(), boneTexture: new THREE.DataTexture(),
    attach, attachSlot: new Map(ATTACH.map((name, i) => [name, i])), boneCount: 0, frameCount, clips, fps: BAKE_FPS,
  };
}

/** The real villager, built once: it is the body you are drawn in. */
let cachedBody: VillagerBody | null = null;
function villager(): VillagerBody {
  if (!cachedBody) {
    const buf = readFileSync(new URL('../src/client/assets/villager.glb', import.meta.url));
    cachedBody = buildVillager(parseGlb(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)), null);
  }
  return cachedBody;
}

// -- the Board panel -----------------------------------------------------------------

test('the desk opens the one Board panel it was handed, and walking away closes it', () => {
  const panel = new FakePanel();
  const r = room(panel);
  r.setCeos(['claude']);
  r.enter();
  walk(r, 'KeyW', () => r.atDesk);
  assert.ok(r.atDesk, `never reached the desk: stopped at z ${r.you.z}`);
  assert.equal(panel.opens.length, 1, 'opened once, not once a frame');
  // The same object, not a panel the room built for itself: a second
  // surface holding the conversation is what got the first interior removed.
  assert.equal(panel.opens[0]?.self, panel);
  // Opened without taking the focus: you arrive holding W, and a text box
  // with the focus would type the key's repeats.
  assert.equal(panel.opens[0]?.focus, false);

  walk(r, 'KeyS', () => !r.atDesk);
  assert.equal(panel.closes, 1);
  assert.equal(panel.isOpen, false);
});

test('the room imports neither the Board panel nor the store: it cannot keep a copy of either', () => {
  for (const file of ['world/interior.ts', 'world/boarding.ts', 'core/walkCamera.ts', 'world/stage.ts']) {
    const src = readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    for (const spec of imports) {
      assert.ok(!spec.includes('/ui/'), `${file} imports ${spec}: the room is handed the panel, it never builds one`);
      assert.ok(!spec.includes('/state/'), `${file} imports ${spec}: what a CEO said lives in the panel and the server`);
    }
  }
});

test('a panel you opened yourself stays open when you walk away from the desk', () => {
  const panel = new FakePanel();
  panel.isOpen = true;
  const r = room(panel);
  r.setCeos(['claude']);
  r.enter();
  walk(r, 'KeyW', () => r.atDesk);
  walk(r, 'KeyS', () => !r.atDesk);
  assert.equal(panel.opens.length, 0, 'it was already open');
  assert.equal(panel.closes, 0, 'yours, not the desk\'s to close');
  assert.equal(panel.isOpen, true);
});

test('without CEOs the desk opens nothing', () => {
  const panel = new FakePanel();
  panel.enabled = false;
  const r = room(panel);
  r.enter();
  walk(r, 'KeyW', () => r.atDesk);
  assert.equal(panel.isOpen, false);
});

test('leaving the room from the desk closes the panel the desk opened', () => {
  const panel = new FakePanel();
  const r = room(panel);
  r.setCeos(['claude']);
  r.enter();
  walk(r, 'KeyW', () => r.atDesk);
  r.leave();
  assert.equal(panel.isOpen, false);
  assert.equal(r.inside, false);
});

// -- the CEOs ------------------------------------------------------------------------

test('the CEO sits at the desk, smaller than you, facing the way you come in', () => {
  const r = room();
  r.crew.setRig(fakeRig());
  r.setCeos(['claude']);
  r.enter();
  run(r, 2);
  const ceo = r.ceoOf('claude');
  const you = r.crew.byId.get('you');
  assert.ok(ceo && you);
  assert.equal(ceo.size, CEO_SIZE);
  // Bigger than a session's astronaut out on the plots -- it is the one you
  // came to see -- and smaller than you, who walk in as a villager and are
  // drawn at `VILLAGER_SCALE`: the height test lives in villager.test.ts.
  assert.ok(ceo.size > you.size, 'no bigger than any other astronaut');
  assert.ok(ceo.size < 1.5, 'still the largest an astronaut can be');
  assert.equal(ceo.state, 'at-site');
  // The desk's own bake of the sitting loop: the one whose head stays put.
  assert.equal(ceo.clipKey, 'sitDesk');
  assert.ok(Math.abs(ceo.pos.z - SEAT_Z) < 1e-6 && Math.abs(ceo.pos.x) < 1e-6, `not in its chair: ${ceo.pos.x}, ${ceo.pos.z}`);
  assert.ok(Math.abs(ceo.pos.y - SEAT_Y) < 1e-6, `sitting on the floor, not the seat: ${ceo.pos.y}`);
  // Facing +Z: towards the hatch.
  assert.ok(Math.abs(Math.cos(ceo.yaw) - 1) < 1e-3, `facing ${ceo.yaw}`);
});

test('an idle CEO stays in its chair: seated is not sent pottering round the room', () => {
  const r = room();
  r.setCeos(['claude']);
  r.setCeoState('claude', 'idle');
  run(r, 30);
  const ceo = r.ceoOf('claude');
  assert.ok(ceo);
  assert.ok(Math.hypot(ceo.pos.x, ceo.pos.z - SEAT_Z) < 1e-6, 'wandered off');
});

test('two CEOs sit side by side, a chair each, and the panel\'s list says who', () => {
  const r = room();
  r.setCeos(['claude', 'codex']);
  run(r, 1);
  const a = r.ceoOf('claude');
  const b = r.ceoOf('codex');
  assert.ok(a && b);
  assert.ok(Math.abs(a.pos.x - b.pos.x) > 1.5, 'one on the other\'s lap');
  assert.deepEqual(seatsFor(2).map((x) => Math.abs(x) <= DESK.halfWidth - 0.5), [true, true], 'a chair off the end of the desk');
  r.setCeos(['codex']);
  run(r, 20);
  assert.equal(r.ceoOf('claude')?.state ?? 'gone', 'gone', 'a CEO the caps dropped still sits there');
});

test('two CEOs behind one desk are not one figure drawn twice: their loops and their faces run apart', () => {
  const r = room();
  r.crew.setRig(fakeRig());
  r.setCeos(['claude', 'codex']);
  r.enter();
  let t = run(r, 0.5);
  const a = r.ceoOf('claude');
  const b = r.ceoOf('codex');
  assert.ok(a && b);
  assert.equal(a.clipKey, 'sitDesk');
  // The sitting loop is started at a point of each one's own. Started
  // together -- which is what happens, because they sit down on the same
  // frame -- two bodies breathe as one and it reads as a single object.
  assert.notEqual(a.frame, b.frame, 'both on the same frame of the sitting loop');
  let apart = 0;
  const facesA = new Set<number>();
  const facesB = new Set<number>();
  for (let k = 0; k < 30 * 12; k++) {
    t += DT;
    r.update(DT, t);
    facesA.add(a.faceFrame);
    facesB.add(b.faceFrame);
    if (a.faceFrame !== b.faceFrame) apart++;
  }
  // An idle astronaut out in the colony wears one frame and blinks. A metre
  // away across a desk that is a mask, so a seated idler gets a loop.
  assert.ok(facesA.size > 3, `one expression and a blink: ${[...facesA].join(',')}`);
  assert.ok(facesB.size > 3, `one expression and a blink: ${[...facesB].join(',')}`);
  // And it runs at a pace of its own: the point is not that they differ once
  // but that they are never in step.
  assert.ok(apart > 30 * 6, `the same face at the same moment for all but ${(apart / 30).toFixed(1)}s of 12`);
});

test('a CEO wears its state: answering is working, a question for you is waiting, stopped is asleep', () => {
  assert.equal(ceoStatus('thinking'), 'working');
  assert.equal(ceoStatus('starting'), 'working');
  assert.equal(ceoStatus('asking'), 'waiting');
  assert.equal(ceoStatus('waiting'), 'waiting');
  assert.equal(ceoStatus('error'), 'blocked');
  assert.equal(ceoStatus('off'), 'sleeping');
  assert.equal(ceoStatus('idle'), 'idle');
  const r = room();
  r.setCeos(['claude']);
  r.setCeoState('claude', 'thinking');
  run(r, 0.5);
  assert.equal(r.ceoOf('claude')?.status, 'working');
});

// -- walking -------------------------------------------------------------------------

test('you come in a stride inside the hatch, facing the desk, not on the hatch itself', () => {
  const r = room();
  r.enter();
  assert.deepEqual({ ...r.you }, { x: ENTRY.x, z: ENTRY.z });
  assert.equal(atHatch(r.you), false, 'coming in would be going out');
  const you = r.crew.byId.get('you');
  assert.ok(you);
  assert.ok(Math.abs(Math.cos(you.yaw) + 1) < 1e-3, `facing ${you.yaw}`);
});

test('you are the villager, and the astronaut that does your walking is not drawn', () => {
  const r = room();
  r.crew.setRig(fakeRig());
  r.setVillager(villager());
  r.setCeos(['claude']);
  r.enter();
  const you = r.crew.byId.get('you');
  const figure = r.scene.getObjectByName('visitor');
  assert.ok(you && figure);
  // One figure, one position. The crew still says where you are, which way
  // you face and whether you are walking -- an astronaut drawn as well
  // would be the same person standing in its own shoes.
  assert.equal(you.hidden, true, 'a suit and a villager in the same place');
  run(r, 0.5);
  assert.ok(figure.visible);
  assert.ok(Math.hypot(figure.position.x - r.you.x, figure.position.z - r.you.z) < 1e-9, 'standing somewhere else');
  assert.ok(Math.abs(figure.scale.x - VILLAGER_SCALE) < 1e-9);
  walk(r, 'KeyA', () => r.you.x < ENTRY.x - 1);
  assert.ok(Math.hypot(figure.position.x - r.you.x, figure.position.z - r.you.z) < 1e-9, 'left behind while you walked');
  assert.ok(Math.abs(figure.rotation.y - you.yaw) < 1e-9, 'facing its own way');
});

test('without the model pack you are still somebody: the astronaut stands in', () => {
  const r = room();
  r.crew.setRig(fakeRig());
  r.enter();
  run(r, 0.5);
  const you = r.crew.byId.get('you');
  assert.ok(you);
  assert.equal(you.hidden, false, 'nothing drawn at all where you are standing');
  assert.equal(r.scene.getObjectByName('visitor'), undefined);
});

test('the desk stops you: walking at it for ten seconds leaves you at its front, not in the chair', () => {
  const r = room();
  r.setCeos(['claude']);
  r.enter();
  r.keys.press('KeyW');
  run(r, 10);
  assert.ok(r.you.z >= DESK.front + WALKER_RADIUS - 1e-9, `walked into the desk: z ${r.you.z}`);
  assert.ok(atDesk(r.you));
});

test('walking into the desk at an angle slides along its edge instead of stopping dead', () => {
  const obstacles = obstaclesFor(seatsFor(1));
  const from = { x: 0, z: DESK.front + WALKER_RADIUS + 0.01 };
  const to = walkRoom(from, 0.2, -0.2, obstacles);
  assert.ok(to.x > from.x + 0.19, 'the free axis still moves');
  assert.ok(to.z >= DESK.front + WALKER_RADIUS, 'the blocked one does not');
});

test('the walls hold: no key takes you out of the room', () => {
  const obstacles = obstaclesFor(seatsFor(1));
  let p = { x: 0, z: 0 };
  for (let i = 0; i < 200; i++) p = walkRoom(p, 0.3, 0.3, obstacles);
  assert.ok(p.x <= ROOM.halfWidth - WALKER_RADIUS + 1e-9);
  assert.ok(p.z <= ROOM.front - WALKER_RADIUS + 1e-9);
  for (let i = 0; i < 400; i++) p = walkRoom(p, -0.3, -0.3, obstacles);
  assert.ok(p.x >= -ROOM.halfWidth + WALKER_RADIUS - 1e-9);
  assert.ok(p.z >= ROOM.back + WALKER_RADIUS - 1e-9);
});

test('walking back onto the hatch is the way out, and it is taken once', () => {
  let left = 0;
  const r = room(new FakePanel(), () => left++);
  r.enter();
  walk(r, 'KeyS', () => left > 0, 5);
  assert.equal(left, 1);
  assert.equal(r.inside, false);
  assert.ok(r.you.z >= EXIT_Z);
  run(r, 1);
  assert.equal(left, 1, 'stepped out twice');
});

test('you walk at the crew\'s pace, and the clip says so: walking while the key is down, standing after', () => {
  const r = room();
  r.crew.setRig(fakeRig());
  r.enter();
  r.keys.press('KeyW');
  let t = run(r, 0.5);
  const you = r.crew.byId.get('you');
  assert.ok(you);
  assert.equal(you.clipKey, 'walk');
  assert.ok(Math.abs(r.you.z - (ENTRY.z - 2.1 * 0.5)) < 0.05, `at ${r.you.z}`);
  r.keys.release('KeyW');
  run(r, 0.5, t);
  assert.equal(you.clipKey, 'idle');
});

test('a key held while the focus jumps into a text box is let go, and opposite keys cancel', () => {
  const keys = new WalkKeys();
  assert.equal(keys.press('KeyQ'), false, 'not a walking key');
  assert.equal(keys.press('KeyW'), true);
  assert.deepEqual(keys.move(), { x: 0, z: -1 });
  keys.press('KeyD');
  const m = keys.move();
  assert.ok(Math.abs(Math.hypot(m.x, m.z) - 1) < 1e-9, 'a diagonal is not faster');
  keys.press('KeyS');
  assert.deepEqual(keys.move(), { x: 1, z: 0 });
  keys.clear();
  assert.deepEqual(keys.move(), { x: 0, z: 0 });
});

test('the desk is where you can talk from: in front of it, not behind it or across the room', () => {
  assert.equal(atDesk({ x: 0, z: DESK.front + 0.5 }), true);
  assert.equal(atDesk({ x: 0, z: DESK.front + DESK_REACH + 0.2 }), false);
  assert.equal(atDesk({ x: 0, z: DESK.back - 0.5 }), false);
  assert.equal(atDesk({ x: ROOM.halfWidth - 0.5, z: DESK.front + 0.5 }), false);
});

// -- the lens ------------------------------------------------------------------------

test('the lens sits behind you and never turns, so the wall behind you is always behind it', () => {
  const lens = new WalkCamera(new THREE.PerspectiveCamera(50, 1, 0.1, 80));
  lens.snap({ x: 1, z: 2 });
  const cam = lens.camera;
  assert.ok(Math.abs(cam.position.x - 1) < 1e-9 && Math.abs(cam.position.z - (2 + FOLLOW_BACK)) < 1e-9);
  assert.equal(cam.position.y, FOLLOW_UP);
  const ahead = new THREE.Vector3();
  cam.getWorldDirection(ahead);
  assert.ok(ahead.z < 0 && Math.abs(ahead.x) < 1e-9, 'looking anywhere but towards the desk');
  for (let i = 0; i < 120; i++) lens.update({ x: -3, z: -1 }, DT);
  cam.getWorldDirection(ahead);
  assert.ok(Math.abs(ahead.x) < 1e-9, 'turned to follow');
  assert.ok(Math.abs(cam.position.x + 3) < 0.01 && Math.abs(cam.position.z - (-1 + FOLLOW_BACK)) < 0.01, 'fell behind');
  assert.ok(lens.distance > 0);
});

// -- up the ramp ---------------------------------------------------------------------

const DOOR = new THREE.Vector3(0, 0, 10);
const WAY_IN = [new THREE.Vector3(0, 0.2, 9.4), new THREE.Vector3(0, 3.2, 6), new THREE.Vector3(0, 3.2, 5.1)];
const outside: CrewWorld & { ping: () => void; pings: number } = {
  pings: 0,
  shipDoor: (out) => out.copy(DOOR),
  shipWayIn: (out) => WAY_IN.forEach((p, i) => out[i]?.copy(p)),
  groundAt: () => 0,
  ping() {
    this.pings++;
  },
};

test('you rise at the foot of the ramp, climb it, and are aboard only once through the hatch', () => {
  const boarding = new Boarding(new Settings({ storage: null }), null, outside);
  let aboard = 0;
  boarding.onAboard = () => aboard++;
  boarding.start();
  assert.equal(boarding.busy, true);
  assert.equal(boarding.object3d.visible, true);
  let t = 0;
  let highest = 0;
  for (let i = 0; i < 30 * 12 && aboard === 0; i++) {
    t += DT;
    boarding.update(DT, t);
    highest = Math.max(highest, t);
  }
  assert.equal(aboard, 1, 'never got through the hatch');
  assert.ok(highest > 1.5, `through the hatch in ${highest.toFixed(2)} s: that is not a climb`);
  assert.equal(boarding.busy, false);
  assert.equal(boarding.object3d.visible, false, 'nothing left to draw');
  assert.ok(outside.pings >= 1, 'the ramp did not light up');
});

test('the figure climbing the ramp is you, not a suit: it rises, climbs and goes in with the walk', () => {
  const boarding = new Boarding(new Settings({ storage: null }), null, outside);
  boarding.setVillager(villager());
  boarding.start();
  const figure = boarding.object3d.getObjectByName('visitor');
  assert.ok(figure);
  let t = 0;
  let aboard = 0;
  boarding.onAboard = () => aboard++;
  let highest = 0;
  let grew = false;
  for (let i = 0; i < 30 * 12 && aboard === 0; i++) {
    t += DT;
    boarding.update(DT, t);
    if (figure.visible) {
      highest = Math.max(highest, figure.position.y);
      // Coming up out of the ground at the foot of the ramp is the
      // astronaut's scale, and the figure wears that too.
      if (figure.scale.x > 0.01 && figure.scale.x < VILLAGER_SCALE - 1e-6) grew = true;
    }
  }
  assert.equal(aboard, 1, 'never got through the hatch');
  assert.ok(grew, 'appeared at full size instead of rising out of the ground');
  assert.ok(highest > 2, `never climbed: highest ${highest.toFixed(2)}`);
  assert.equal(figure.visible, false, 'still standing on the ramp after going in');
});

test('asking to board twice sends one of you up the ramp', () => {
  const boarding = new Boarding(new Settings({ storage: null }), null, outside);
  let aboard = 0;
  boarding.onAboard = () => aboard++;
  boarding.start();
  boarding.start();
  let t = 0;
  for (let i = 0; i < 30 * 12; i++) {
    t += DT;
    boarding.update(DT, t);
  }
  assert.equal(aboard, 1);
});

// -- the crew, by hand ---------------------------------------------------------------

test('a hand-moved astronaut goes where it is put, and a roster written earlier does not pull it back', () => {
  const crew = new Astronauts(new Settings({ storage: null }), null);
  const world: CrewWorld = { shipDoor: (o) => o.set(0, 0, 50), shipWayIn: () => {}, groundAt: () => 0 };
  const entry = { id: 'you', status: 'idle' as const, provider: 'claude' as const, site: { x: 0, y: 0, z: 0 }, anchor: null, known: true, seed: 7, driven: true };
  crew.setRoster([entry], world);
  crew.place('you', 3, -2, 0);
  crew.update(DT, DT);
  const you = crew.byId.get('you');
  assert.ok(you);
  assert.ok(Math.hypot(you.pos.x - 3, you.pos.z + 2) < 1e-9, 'not where it was put');
  // The roster still says (0, 0): it is `place` that says where you are.
  crew.setRoster([entry], world);
  crew.update(DT, DT * 2);
  assert.ok(Math.hypot(you.pos.x - 3, you.pos.z + 2) < 1e-9, 'pulled back by a stale roster');
  // Nobody else may move a driven one: `place` on an ordinary astronaut is ignored.
  crew.setRoster([entry, { ...entry, id: 'other', driven: false, site: { x: 9, y: 0, z: 9 } }], world);
  crew.place('other', -9, -9, 0);
  run2(crew, 1);
  const other = crew.byId.get('other');
  assert.ok(other && Math.hypot(other.pos.x + 9, other.pos.z + 9) > 5);
});

function run2(crew: Astronauts, seconds: number): void {
  let t = 10;
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    t += DT;
    crew.update(DT, t);
  }
}
