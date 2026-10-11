import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Astronauts, ARRIVE_RADIUS, MAX_ENTRANCE, crossesDownbeat } from '../src/client/agents/astronauts.ts';
import type { Agent, CrewWorld, RosterEntry } from '../src/client/agents/astronauts.ts';
import type { Navigation } from '../src/client/agents/navigation.ts';
import { ATTACH, BAKE_FPS, CLIP, CLIP_KEYS } from '../src/client/assets/crew.ts';
import type { ClipKey, ClipSpec, CrewRig } from '../src/client/assets/crew.ts';
import { Settings } from '../src/client/core/settings.ts';
import { PROVIDER_COLOR } from '../src/client/world/palette.ts';
import { fnv1a32 } from '../src/shared/hash.ts';

/**
 * The crew's state machine, run with no rig, no DOM and no renderer: what an
 * astronaut does between the ship door and its site is a matter of numbers.
 */

const DT = 1 / 30;
const DOOR = new THREE.Vector3(0, 0, -50);
/** Past the door, the ship's way in runs on towards -Z: the ramp's foot, its lip, a step inside. */
const WAY_IN = [new THREE.Vector3(0, 0.2, -50.6), new THREE.Vector3(0, 3.2, -54), new THREE.Vector3(0, 3.2, -54.9)];
const INSIDE = WAY_IN[2]!;

/** Flat ground, one door. */
const world: CrewWorld = {
  shipDoor: (out) => out.copy(DOOR),
  shipWayIn: (out) => WAY_IN.forEach((p, i) => out[i]?.copy(p)),
  groundAt: () => 0,
};

function entry(over: Partial<RosterEntry> & { id: string }): RosterEntry {
  return {
    status: 'idle',
    provider: 'claude',
    site: { x: 12, y: 0, z: 8 },
    anchor: null,
    known: false,
    seed: fnv1a32(over.id),
    ...over,
  };
}

function build(): Astronauts {
  return new Astronauts(new Settings({ storage: null }), null);
}

/** Step `seconds` of simulation; `t` runs on across calls. */
function run(crew: Astronauts, seconds: number, from = 0): number {
  let t = from;
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    t += DT;
    crew.update(DT, t);
  }
  return t;
}

function dist2d(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * A rig with no body: just the clip table and an attachment table the worn
 * parts can read, enough for the animation logic to pick and advance clips.
 * The work clip is `workFrames` long so a test can choose its cycle.
 */
function fakeRig(workFrames = 22): CrewRig {
  const clips = {} as Record<ClipKey, ClipSpec>;
  let frameCount = 0;
  for (const key of CLIP_KEYS) {
    const frames = key === 'work' ? workFrames : 4;
    clips[key] = {
      start: frameCount, frames, duration: (frames - 1) / BAKE_FPS, loop: CLIP[key].loop, name: CLIP[key].name,
    };
    frameCount += frames;
  }
  const attach = new Float32Array(frameCount * ATTACH.length * 16);
  for (let f = 0; f < frameCount; f++) {
    for (let s = 0; s < ATTACH.length; s++) {
      const o = (f * ATTACH.length + s) * 16;
      attach[o] = 1;
      attach[o + 5] = 1;
      attach[o + 10] = 1;
      attach[o + 15] = 1;
      // The head bone sits at the neck, 1.23 up on the real mannequin.
      attach[o + 13] = s === 0 ? 1.23 : 0.8;
    }
  }
  return {
    geometry: new THREE.BufferGeometry(),
    bones: [],
    boneIndex: new Map(),
    boneTexture: new THREE.DataTexture(),
    attach,
    attachSlot: new Map(ATTACH.map((name, i) => [name, i])),
    boneCount: 0,
    frameCount,
    clips,
    fps: BAKE_FPS,
  };
}

test('a new session walks out of the ship door', () => {
  const crew = build();
  crew.setRoster([entry({ id: 'a', site: { x: 12, y: 0, z: 8 } })], world);
  const a = crew.byId.get('a');
  assert.ok(a);
  assert.equal(a.state, 'spawning');
  assert.ok(dist2d(a.pos, DOOR) < 1.0, `spawned ${dist2d(a.pos, DOOR)} from the door`);
  assert.equal(a.scale, 0, 'pops up out of the ship');

  const before = dist2d(a.pos, { x: 12, z: 8 });
  let t = run(crew, 0.5);
  assert.equal(a.state, 'spawning');
  assert.ok(dist2d(a.pos, { x: 12, z: 8 }) < before - 0.2, 'moves towards its site while still spawning');

  t = run(crew, 1.0, t);
  assert.equal(a.state, 'walking');
  assert.equal(a.scale, 1);
  assert.equal(crew.visibleCount, 1);

  // It gets there: the site is 60-odd units off, at two units a second.
  run(crew, 40, t);
  assert.equal(a.state, 'at-site');
  assert.ok(dist2d(a.pos, { x: 12, z: 8 }) < ARRIVE_RADIUS);
});

test('a session known before the page opened appears in place', () => {
  const crew = build();
  crew.setRoster([entry({ id: 'k', known: true, site: { x: -20, y: 0, z: 30 } })], world);
  const k = crew.byId.get('k');
  assert.ok(k);
  assert.equal(k.state, 'walking', 'no entrance: it is just there');
  assert.equal(k.scale, 1);
  assert.ok(dist2d(k.pos, { x: -20, z: 30 }) < 1.0);
  run(crew, DT);
  assert.equal(k.state, 'at-site');
});

test('past the entrance quota the rest of a big arrival is placed on its plots', () => {
  const crew = build();
  const many: RosterEntry[] = [];
  for (let i = 0; i < MAX_ENTRANCE + 4; i++) many.push(entry({ id: `s${i}`, site: { x: 10 + i * 2, y: 0, z: 10 } }));
  crew.setRoster(many, world);
  const spawning = [...crew.agents].filter((a) => a.state === 'spawning').length;
  assert.equal(spawning, MAX_ENTRANCE);
  assert.equal(crew.agents.length, many.length);
});

test('a removed session walks home and is gone once it is inside the ship', () => {
  const crew = build();
  crew.setRoster([entry({ id: 'h', known: true, site: { x: 0, y: 0, z: -30 } })], world);
  const h = crew.byId.get('h');
  assert.ok(h);
  let t = run(crew, 0.5);
  assert.equal(h.state, 'at-site');

  assert.equal(crew.setRoster([], world), 1, 'still on the map while it walks home');
  assert.equal(h.state, 'leaving');
  assert.ok(crew.byId.has('h'));

  let gone = -1;
  for (let k = 0; k < 30 * 30 && gone < 0; k++) {
    t += DT;
    crew.update(DT, t);
    if (h.state === 'gone') gone = t;
  }
  assert.ok(gone > 0, 'never left');
  assert.ok(gone < 15, `took ${gone}s to cover twenty units and a ramp`);
  assert.ok(dist2d(h.pos, INSIDE) < 0.1, `retired ${dist2d(h.pos, INSIDE)} from inside the hatch`);
  assert.ok(!crew.byId.has('h'));
  assert.equal(crew.agents.length, 0);
  assert.equal(crew.visibleCount, 0);
});

test('from a far project the walk home reaches the door; only a walker that cannot move is retired on the way', () => {
  // Seen on the colony: an astronaut leaving a project in the outer ring
  // vanished half way to the ship. Walking home was retired after 22 seconds
  // whatever it was doing, and ninety units is more than that at any pace.
  const crew = build();
  crew.setRoster([entry({ id: 'far', known: true, site: { x: 0, y: 0, z: 40 } })], world);
  const far = crew.byId.get('far');
  assert.ok(far);
  let t = run(crew, 0.5);
  crew.setRoster([], world);
  assert.equal(far.state, 'leaving');
  let gone = -1;
  for (let k = 0; k < 30 * 90 && gone < 0; k++) {
    t += DT;
    crew.update(DT, t);
    if (far.state === 'gone') gone = t - 0.5;
  }
  assert.ok(gone > 22, `gone after ${gone}s: ninety units cannot be walked that fast`);
  assert.ok(dist2d(far.pos, INSIDE) < 0.1, `retired ${dist2d(far.pos, INSIDE).toFixed(1)} from inside the hatch`);

  // The ghost guard is still there: a walker the grid refuses every step is
  // retired rather than left shouldering the wall.
  const stuck = build();
  stuck.setNavigation({ version: 0, findPath: () => null, slide: () => false, isBlocked: () => false } as unknown as Navigation);
  stuck.setRoster([entry({ id: 'wall', known: true, site: { x: 0, y: 0, z: 40 } })], world);
  const wall = stuck.byId.get('wall');
  assert.ok(wall);
  t = run(stuck, 0.5);
  stuck.setRoster([], world);
  gone = -1;
  for (let k = 0; k < 30 * 30 && gone < 0; k++) {
    t += DT;
    stuck.update(DT, t);
    if (wall.state === 'gone') gone = t - 0.5;
  }
  assert.ok(gone > 0, 'a walker that cannot move walks home forever');
  assert.ok(gone < 10, `stood against the wall for ${gone}s`);
});

test('going home is up the ramp and in through the hatch, never down into the ground', () => {
  // Seen on the colony: astronauts going home stopped at the foot of the
  // ramp and shrank there, pivoting on their boots, which from above is a
  // crew sinking straight down into the dirt in front of the ship.
  const crew = build();
  crew.setRoster([entry({ id: 'r', known: true, site: { x: 0, y: 0, z: -40 } })], world);
  const r = crew.byId.get('r');
  assert.ok(r);
  let t = run(crew, 0.5);
  crew.setRoster([], world);

  let boarded = false;
  let lowest = Infinity;
  let highest = -Infinity;
  let shrankAt = Infinity;
  for (let k = 0; k < 30 * 20 && r.state !== 'gone'; k++) {
    t += DT;
    crew.update(DT, t);
    if (r.state !== 'boarding') continue;
    boarded = true;
    // Where the ramp is under it: flat to the foot, then the slope, then the lip's height.
    const along = DOOR.z - r.pos.z;
    const ramp = along < 0.6 ? 0 : Math.min(3.2, 0.2 + ((along - 0.6) / 3.4) * 3);
    lowest = Math.min(lowest, r.pos.y - ramp);
    highest = Math.max(highest, r.pos.y);
    if (r.scale < 1 && shrankAt === Infinity) shrankAt = along;
  }
  assert.ok(boarded, 'went from walking home straight to gone, without the ramp');
  assert.equal(r.state, 'gone');
  assert.ok(lowest > -0.25, `${lowest.toFixed(2)} below the ramp`);
  assert.ok(highest > 3, `topped out at ${highest.toFixed(2)}: never climbed to the hatch`);
  assert.ok(shrankAt > 3, `started shrinking ${shrankAt.toFixed(2)} along, on the way up rather than at the hatch`);
});

test('two sessions ending together climb the ramp one behind the other', () => {
  const crew = build();
  crew.setRoster([
    entry({ id: 'a', known: true, site: { x: 1, y: 0, z: -44 } }),
    entry({ id: 'b', known: true, site: { x: -1, y: 0, z: -44 } }),
  ], world);
  let t = run(crew, 0.5);
  crew.setRoster([], world);
  const a = crew.byId.get('a');
  const b = crew.byId.get('b');
  assert.ok(a && b);
  let closest = Infinity;
  for (let k = 0; k < 30 * 20 && (a.state !== 'gone' || b.state !== 'gone'); k++) {
    t += DT;
    crew.update(DT, t);
    if (a.state === 'boarding' && b.state === 'boarding' && a.scale > 0.5 && b.scale > 0.5) {
      closest = Math.min(closest, Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z));
    }
  }
  assert.equal(a.state, 'gone');
  assert.equal(b.state, 'gone');
  assert.ok(Number.isFinite(closest), "never on the ramp together: the test proves nothing");
  assert.ok(closest > 0.9, `two on the ramp ${closest.toFixed(2)} apart: inside one another`);
});

test('the clip follows the ground actually covered, not the intended velocity', () => {
  const crew = build();
  crew.setRig(fakeRig());
  // A grid that refuses every step: the astronaut wants to walk and cannot.
  const wall = {
    version: 0,
    findPath: () => null,
    slide: () => false,
    isBlocked: () => false,
  } as unknown as Navigation;
  crew.setNavigation(wall);
  crew.setRoster([entry({ id: 'w', status: 'waiting', known: true, site: { x: 20, y: 0, z: 20 } })], world);
  const w = crew.byId.get('w');
  assert.ok(w);
  // Placed off its site, so it has somewhere to go.
  w.pos.set(0, 0, 0);
  const start = w.pos.clone();

  // Five seconds in all: at eight a blocked walker gives up and adopts the ground it reached.
  const seen = new Set<string>();
  run(crew, 2);
  for (let k = 0; k < 90; k++) {
    crew.update(DT, 2 + k * DT);
    seen.add(w.clipKey);
  }
  assert.equal(w.state, 'walking', 'still trying');
  assert.ok(w.pos.equals(start), 'did not move');
  assert.ok(!seen.has('walk') && !seen.has('run'), `played ${[...seen].join(',')}`);
  assert.ok(seen.has('wave'), 'stands in its status clip instead');

  // And one that genuinely covers ground plays walk.
  const free = build();
  free.setRig(fakeRig());
  free.setRoster([entry({ id: 'f', status: 'waiting', known: true, site: { x: 20, y: 0, z: 20 } })], world);
  const f = free.byId.get('f');
  assert.ok(f);
  f.pos.set(0, 0, 0);
  run(free, 1);
  assert.equal(f.clipKey, 'walk');
});

test('working plays the hammer and swings it once per cycle', () => {
  const crew = build();
  // 22 frames: a 21-frame cycle, so the halfway mark falls between two frames
  // and no rounding can put it on one.
  crew.setRig(fakeRig(22));
  crew.setRoster([entry({ id: 'w', status: 'working', known: true, site: { x: 5, y: 0, z: 5 } })], world);
  const w = crew.byId.get('w');
  assert.ok(w);

  const swings: number[] = [];
  let t = 0;
  for (let k = 0; k < 400; k++) {
    t += DT;
    crew.update(DT, t);
    if (k > 30) assert.equal(w.clipKey, 'work', `frame ${k}: ${w.clipKey}`);
    if (w.workSwing) swings.push(k);
  }
  assert.ok(swings.length >= 15, `only ${swings.length} swings in 400 frames`);
  for (let i = 1; i < swings.length; i++) {
    assert.equal(swings[i]! - swings[i - 1]!, 21, `swings at ${swings.join(',')}`);
  }
  // Never true off the work clip.
  crew.setRoster([entry({ id: 'w', status: 'waiting', known: true, site: { x: 5, y: 0, z: 5 } })], world);
  run(crew, 2, t);
  assert.equal(w.workSwing, false);
});

test('crossesDownbeat fires once on the way past half, wrap included', () => {
  assert.equal(crossesDownbeat(0.4, 0.6), true);
  assert.equal(crossesDownbeat(0.6, 0.7), false);
  assert.equal(crossesDownbeat(0.0, 0.1), false);
  // Wrapped from before the mark: passed it on the way round.
  assert.equal(crossesDownbeat(0.4, 0.1), true);
  // Wrapped from after the mark: not passed again yet.
  assert.equal(crossesDownbeat(0.9, 0.1), false);
  // Wrapped and already past it again.
  assert.equal(crossesDownbeat(0.9, 0.6), true);
});

test('headOf hands out the same vector every time', () => {
  const crew = build();
  crew.setRoster([entry({ id: 'a', known: true, site: { x: 3, y: 0, z: 3 } })], world);
  const head = crew.headOf('a');
  assert.ok(head);
  assert.equal(crew.headOf('a'), head, 'the same object, not a copy');
  const a = crew.byId.get('a');
  assert.ok(a);
  assert.equal(a.head, head);
  run(crew, 1);
  assert.equal(crew.headOf('a'), head, 'still the same object after a second of updates');
  // No rig yet: a metre up.
  assert.equal(head.x, a.pos.x);
  assert.equal(head.z, a.pos.z);
  assert.ok(Math.abs(head.y - (a.pos.y + 1.0)) < 1e-9);
  // With a rig the badge follows the head bone, scaled to the little-guy size.
  // (The attachment table is float32, so the neck height comes back a hair off.)
  crew.setRig(fakeRig());
  run(crew, DT);
  assert.ok(Math.abs(head.y - (a.pos.y + (1.23 + 0.46) * 0.56)) < 1e-6, `head at ${head.y}`);
  assert.equal(crew.headOf('nobody'), null);
});

test('celebrate is temporary', () => {
  const crew = build();
  crew.setRig(fakeRig());
  crew.setRoster([entry({ id: 'c', status: 'idle', known: true, site: { x: 3, y: 0, z: 3 } })], world);
  const c = crew.byId.get('c');
  assert.ok(c);
  let t = run(crew, 0.5);
  crew.celebrate('c', 1);
  assert.equal(c.status, 'celebrating');
  t = run(crew, 0.5, t);
  assert.equal(c.status, 'celebrating');
  assert.equal(c.clipKey, 'cheer');
  t = run(crew, 0.7, t);
  assert.equal(c.status, 'idle', 'back to what the roster says');
  // A roster change during the cheer waits for it to end.
  crew.celebrate('c', 1);
  crew.setRoster([entry({ id: 'c', status: 'working', known: true, site: { x: 3, y: 0, z: 3 } })], world);
  t = run(crew, 0.5, t);
  assert.equal(c.status, 'celebrating');
  run(crew, 0.7, t);
  assert.equal(c.status, 'working');
});

test('the trim says which tool works here; the eyes say how it is going', () => {
  const crew = build();
  crew.setRoster(
    [
      entry({ id: 'cl', provider: 'claude', status: 'working', known: true, site: { x: 0, y: 0, z: 0 } }),
      entry({ id: 'cx', provider: 'codex', status: 'working', known: true, site: { x: 6, y: 0, z: 0 } }),
    ],
    world,
  );
  run(crew, DT);
  const a = crew.byId.get('cl') as Agent;
  const b = crew.byId.get('cx') as Agent;
  assert.notEqual(a.index, b.index);
  assert.equal(crew.visibleCount, 2);
  // Read back off the instance colours the backpack (trim) and the face (eyes) were written with.
  const part = (name: string): THREE.InstancedMesh => {
    const m = crew.object3d.getObjectByName(name);
    assert.ok(m instanceof THREE.InstancedMesh, `no ${name}`);
    return m;
  };
  const rgb = (m: THREE.InstancedMesh, i: number): number[] => {
    const c = m.instanceColor;
    assert.ok(c);
    return [c.getX(i), c.getY(i), c.getZ(i)];
  };
  const hex = (v: number[]): number => new THREE.Color(v[0]!, v[1]!, v[2]!).getHex();
  assert.equal(hex(rgb(part('pack'), a.index)), PROVIDER_COLOR.claude);
  assert.equal(hex(rgb(part('pack'), b.index)), PROVIDER_COLOR.codex);
  assert.deepEqual(rgb(part('face'), a.index), rgb(part('face'), b.index), 'same status, same eyes');
});

test('an agent past the buffers is skipped rather than taking everyone off screen', () => {
  const settings = new Settings({ storage: null });
  const crew = new Astronauts(settings, null);
  const cap = crew.capacity;
  const many: RosterEntry[] = [];
  for (let i = 0; i < cap; i++) many.push(entry({ id: `s${i}`, known: true, site: { x: (i % 20) * 3, y: 0, z: Math.floor(i / 20) * 3 } }));
  crew.setRoster(many, world);
  assert.equal(crew.agents.length, cap);
  // Drop one and add another: the leaver still holds a slot while it walks home.
  const next = many.slice(1);
  next.push(entry({ id: 'extra', known: true, site: { x: 0, y: 0, z: 90 } }));
  crew.setRoster(next, world);
  assert.equal(crew.agents.length, cap + 1);
  run(crew, DT);
  assert.equal(crew.visibleCount, cap, 'writes exactly the buffer, never past it');
});

test('the hands follow the tool: reading inspects, a shell command works the console and still throws sparks', () => {
  const crew = build();
  crew.setRig(fakeRig(22));
  crew.setRoster([entry({ id: 'w', status: 'working', known: true, site: { x: 5, y: 0, z: 5 } })], world);
  const w = crew.byId.get('w');
  assert.ok(w);
  let t = run(crew, 2);
  assert.equal(w.clipKey, 'work', 'hammering before any call');
  crew.setGesture('w', 'inspect');
  t = run(crew, 0.5, t);
  assert.equal(w.gesture, 'inspect');
  assert.equal(w.clipKey, 'interact');
  // Inside the hold the next call waits its turn.
  crew.setGesture('w', 'operate');
  t = run(crew, 0.5, t);
  assert.equal(w.clipKey, 'interact');
  let swung = false;
  for (let k = 0; k < 150; k++) {
    t += DT;
    crew.update(DT, t);
    swung ||= w.workSwing;
  }
  assert.equal(w.clipKey, 'workAlt');
  assert.ok(swung, 'the console is work: it has a downbeat to throw sparks on');
});

test('a cue stops the astronaut where it stands, plays once, and hands back to its status', () => {
  const crew = build();
  crew.setRig(fakeRig());
  crew.setRoster([entry({ id: 'c', status: 'working', known: true, site: { x: 3, y: 0, z: 3 }, anchor: { x: 3, y: 0, z: 6 } })], world);
  const c = crew.byId.get('c');
  assert.ok(c);
  let t = run(crew, 3);
  crew.cue('c', 'hop');
  const at = c.pos.clone();
  t = run(crew, DT * 2, t);
  assert.equal(c.clipKey, 'jump');
  assert.ok(c.cueLeft > 0);
  assert.ok(c.pos.distanceTo(at) < 0.05, 'walked on through its own hop');
  t = run(crew, 1.5, t);
  assert.equal(c.cueLeft, 0);
  assert.notEqual(c.clipKey, 'jump', 'stuck in the cue');

  // Going home, it is past listening.
  crew.setRoster([], world);
  crew.cue('c', 'heed');
  assert.equal(c.cueLeft, 0);
});

test('a prompt turns the astronaut to face the ship', () => {
  const crew = build();
  crew.setRig(fakeRig());
  crew.setRoster([entry({ id: 'p', status: 'idle', known: true, site: { x: 0, y: 0, z: 10 } })], world);
  const p = crew.byId.get('p');
  assert.ok(p);
  let t = run(crew, 1);
  crew.cue('p', 'heed');
  t = run(crew, 1, t);
  assert.equal(p.clipKey, 'interact');
  // The door is straight down -Z from here.
  const toDoor = Math.atan2(DOOR.x - p.pos.x, DOOR.z - p.pos.z);
  const off = Math.abs(Math.atan2(Math.sin(p.yaw - toDoor), Math.cos(p.yaw - toDoor)));
  assert.ok(off < 0.2, `looking ${off} rad away from the ship`);
});

test('an astronaut with a home comes out of it and goes back into it, without queueing at the ship', () => {
  const crew = build();
  const home = { x: 20, y: 0, z: 20 };
  // A full entrance quota of sessions first: the subagent must not wait behind them.
  const sessions = Array.from({ length: MAX_ENTRANCE }, (_, i) => entry({ id: `s${i}`, site: { x: 10 + i, y: 0, z: 0 } }));
  crew.setRoster([...sessions, entry({ id: 'sub', status: 'working', site: { x: 22, y: 0, z: 22 }, home, size: 0.7 })], world);
  const s = crew.byId.get('sub');
  assert.ok(s);
  assert.equal(s.state, 'spawning', 'placed instead of coming out');
  assert.ok(dist2d(s.pos, home) < 0.5, `came out ${dist2d(s.pos, home)} from its home`);
  assert.equal(s.size, 0.7);

  let t = run(crew, 5);
  assert.ok(Math.abs(s.head.y - (s.pos.y + 1.0 * 0.7)) < 1e-6, 'the helmet is not at its own height');
  crew.setRoster(sessions, world);
  assert.equal(s.state, 'leaving');
  for (let k = 0; k < 30 * 20 && s.state !== 'gone'; k++) {
    t += DT;
    crew.update(DT, t);
  }
  assert.equal(s.state, 'gone');
  assert.ok(dist2d(s.pos, home) < 1.5, `went home to ${s.pos.x},${s.pos.z}, not to ${home.x},${home.z}`);
});
