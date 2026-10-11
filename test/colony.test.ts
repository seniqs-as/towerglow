import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { parseGlb } from '../src/client/assets/glb.ts';
import { loadKit, kitReady } from '../src/client/assets/kit.ts';
import {
  Colony, structureSize, STRUCTURE_MIN_SIZE, accentOf, LIFT_S, MAX_CADETS, CADET_PREFIX, CADET_SIZE, HELPER_PREFIX,
  HELPER_SIZE, HELPER_LINGER_MS,
} from '../src/client/world/colony.ts';
import type { ColonyProject, ColonySession, ColonySubagent, CrewAttachment } from '../src/client/world/colony.ts';
import type { Cue } from '../src/client/agents/astronauts.ts';
import type { Gesture } from '../src/client/agents/gestures.ts';
import { Navigation } from '../src/client/agents/navigation.ts';
import { Astronauts } from '../src/client/agents/astronauts.ts';
import { Settings } from '../src/client/core/settings.ts';
import type { RosterEntry } from '../src/client/agents/astronauts.ts';
import type { ClearZone } from '../src/client/world/stage.ts';
import {
  DECK_TOP, MAX_LEVELS, TILE, deckTop, hexCorner, hqPlacement, levelsForSize, placeSlot, rampAxis, rampHead,
  worldToHex, zoneSlot,
} from '../src/shared/layout.ts';
import type { Obstacle } from '../src/client/agents/navigation.ts';
import { ZONE_PALETTE } from '../src/client/world/palette.ts';

function kits(): void {
  if (kitReady('base')) return;
  for (const [id, file] of [['base', 'spacebase'], ['forest', 'forest']] as const) {
    const buf = readFileSync(new URL(`../src/client/assets/${file}.glb`, import.meta.url));
    loadKit(id, parseGlb(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)), null);
  }
}

const GROUND = -0.1;

function colony(): { colony: Colony; clears: ClearZone[][] } {
  kits();
  const clears: ClearZone[][] = [];
  const c = new Colony({
    surfaces: null,
    groundHeight: () => GROUND,
    onFootprint: (clear) => {
      clears.push([...clear]);
    },
  });
  return { colony: c, clears };
}

function project(id: string, slot: number, size = 10, exists = true): ColonyProject {
  return { id, slot, size, exists };
}

function session(id: string, projectId: string, status: ColonySession['status'] = 'working', toolCalls = 0): ColonySession {
  return { id, projectId, provider: 'claude', status, toolCalls, known: false };
}

/** Step the colony for `seconds` of simulated time. */
function run(c: Colony, seconds: number): void {
  const dt = 1 / 30;
  for (let t = 0; t < seconds; t += dt) c.update(dt, t);
}

test('a project without a session has a habitat and no structure', () => {
  const { colony: c } = colony();
  c.setProjects([project('p1', 0)]);
  const at = c.positionOf('p1');
  assert.ok(at);
  assert.deepEqual({ x: at.x, y: at.y, z: at.z }, { x: placeSlot(0).x, y: deckTop(levelsForSize(10)), z: placeSlot(0).z });
  // The habitat rises from nothing: not tall yet, taller after a while.
  const h0 = c.heightOf('p1');
  run(c, 4);
  assert.ok(c.heightOf('p1') > h0 + 0.5, `habitat did not rise: ${h0} -> ${c.heightOf('p1')}`);
  assert.equal(c.headOf('s1'), null);
  assert.equal(c.standing('s1'), false);
});

test('a session raises a structure on its own spot and the spot stays while siblings come and go', () => {
  const { colony: c } = colony();
  c.setProjects([project('p1', 0)]);
  c.setSessions([session('s1', 'p1')]);
  const zone = c.zoneOf('p1')!;
  const spot = (i: number): THREE.Vector3 => zone.worldSlot(i, new THREE.Vector3());
  const headOf = (id: string): THREE.Vector3 => c.headOf(id)!;
  assert.ok(c.headOf('s1'), 's1 has a structure');
  // Spot 0 is the habitat's; the first session takes spot 1.
  const s1 = headOf('s1');
  assert.ok(Math.abs(s1.x - spot(1).x) < 1e-6 && Math.abs(s1.z - spot(1).z) < 1e-6, 's1 is not on spot 1');
  c.setSessions([session('s1', 'p1'), session('s2', 'p1')]);
  const s2 = headOf('s2');
  assert.ok(Math.abs(s2.x - spot(2).x) < 1e-6 && Math.abs(s2.z - spot(2).z) < 1e-6, 's2 is not on spot 2');
  // Let both rise: a structure that never rose has nothing to retract and
  // goes at once, which is right, but not what this test is about.
  run(c, 2);
  // s1 leaves, s3 arrives while s1 is still sinking: s3 must not take spot 1.
  c.setSessions([session('s2', 'p1'), session('s3', 'p1')]);
  assert.equal(c.standing('s1'), false, 's1 is on its way out');
  assert.ok(c.headOf('s1'), 's1 still stands while it sinks');
  const s3 = headOf('s3');
  assert.ok(Math.abs(s3.x - spot(3).x) < 1e-6 && Math.abs(s3.z - spot(3).z) < 1e-6, 's3 took a spot that was not free');
  // Once s1 has sunk out of sight its spot is free again.
  run(c, 6);
  assert.equal(c.headOf('s1'), null, 's1 should be gone by now');
  c.setSessions([session('s2', 'p1'), session('s3', 'p1'), session('s4', 'p1')]);
  const s4 = headOf('s4');
  assert.ok(Math.abs(s4.x - spot(1).x) < 1e-6 && Math.abs(s4.z - spot(1).z) < 1e-6, 's4 should have spot 1 back');
});

test('headOf hands the same vector every time, and it rises with the structure', () => {
  const { colony: c } = colony();
  c.setProjects([project('p1', 0)]);
  c.setSessions([session('s1', 'p1', 'working', 50)]);
  const head = c.headOf('s1')!;
  assert.equal(c.headOf('s1'), head, 'a copy would leave the badge behind');
  const y0 = head.y;
  run(c, 3);
  assert.equal(c.headOf('s1'), head);
  assert.ok(head.y > y0 + 0.2, `the head did not rise: ${y0} -> ${head.y}`);
});

test('a structure grows with the work, within bounds', () => {
  assert.equal(structureSize(0), STRUCTURE_MIN_SIZE);
  assert.equal(structureSize(Number.NaN), STRUCTURE_MIN_SIZE);
  let prev = 0;
  for (const calls of [1, 10, 100, 1000, 100000]) {
    const p = structureSize(calls);
    assert.ok(p >= prev && p <= 1, `size out of order or range at ${calls}: ${p}`);
    prev = p;
  }
  assert.equal(structureSize(1e9), 1);
});

test('a live structure stands whole on the deck, whatever little work it has done', () => {
  // Growing with the work used to mean rising out of the deck: at twenty-two
  // calls a relay mast still had a third of itself under the plate, and on
  // a stacked deck that reads as buried. The work now shows as size.
  const { colony: c } = colony();
  c.setProjects([project('p1', 0)]);
  c.setSessions([session('s1', 'p1', 'working', 0), session('s2', 'p1', 'working', 22)]);
  run(c, 6);
  const small = c.object3d.children.filter((o) => o.name.startsWith('building:') && o.scale.x < 1);
  assert.equal(small.length, 2, 'both structures stand, each at its own size');
  const [a, b] = small.sort((x, y) => x.scale.x - y.scale.x);
  assert.ok(Math.abs(a!.scale.x - STRUCTURE_MIN_SIZE) < 1e-3, `no work, smallest size: ${a!.scale.x}`);
  assert.ok(b!.scale.x > a!.scale.x + 0.1, `more work, bigger: ${b!.scale.x}`);
  for (const id of ['s1', 's2']) {
    const head = c.headOf(id)!;
    assert.ok(head.y > c.positionOf('p1')!.y + 0.5, `${id} is still under the deck: ${head.y}`);
  }
});

test('a zone that gains a deck stays on its cell, one plate higher, and never gets wider', () => {
  const { colony: c } = colony();
  c.setProjects([project('p1', 3, 10)]);
  assert.equal(c.zoneMetrics('p1')!.levels, levelsForSize(10));
  const vector = c.positionOf('p1')!;
  const root = vector.clone();
  const radius = c.footprintOf('p1');
  c.setSessions([session('s1', 'p1')]);
  const head = c.headOf('s1')!.clone();
  c.setProjects([project('p1', 3, 5000)]);
  const levels = c.zoneMetrics('p1')!.levels;
  assert.ok(levels > levelsForSize(10), 'the stack should have grown');
  assert.equal(c.positionOf('p1'), vector, 'the same vector: whoever holds it rises with the stack');
  assert.deepEqual([vector.x, vector.z], [root.x, root.z], 'the cell moved');
  // The new plate slides in underneath: the top starts where it was and is
  // pushed up into place, rather than jumping there.
  assert.ok(Math.abs(vector.y - root.y) < 1e-9, `the top jumped: ${root.y} -> ${vector.y}`);
  assert.equal(c.lifting, true);
  assert.ok(c.groundAt(root.x, root.z) < deckTop(levels), 'the crew stands on the stack as it is, not as it will be');
  run(c, LIFT_S / 2);
  assert.ok(vector.y > root.y && vector.y < deckTop(levels), `half way up: ${vector.y}`);
  run(c, LIFT_S);
  assert.equal(c.lifting, false);
  assert.ok(Math.abs(vector.y - deckTop(levels)) < 1e-9, 'the root is on the new top deck');
  assert.equal(c.groundAt(root.x, root.z), deckTop(levels));
  assert.equal(c.footprintOf('p1'), radius, 'one hex, whatever the size');
  const spot1 = zoneSlot(1);
  const after = c.headOf('s1')!;
  assert.ok(Math.abs(after.x - (root.x + spot1.x)) < 1e-6 && Math.abs(after.z - (root.z + spot1.z)) < 1e-6);
  assert.ok(Math.abs(after.x - head.x) < 1e-6 && Math.abs(after.z - head.z) < 1e-6, 'spot 1 must not move');
});

test('the summit the name and the badges share is the habitat\'s, not the crew\'s', () => {
  const { colony: c } = colony();
  c.setProjects([project('p1', 0, 300)]);
  const summit = c.summitAt('p1')!;
  const root = c.positionOf('p1')!;
  assert.deepEqual([summit.x, summit.z], [root.x, root.z], 'on the habitat, at the centre of the deck');
  run(c, 4);
  // A session does not move it: the glyph is the building's, and a glyph
  // riding a helmet wandered off with every walk.
  const before = summit.clone();
  c.setSessions([session('s1', 'p1')]);
  run(c, 1);
  assert.equal(c.summitAt('p1'), summit);
  assert.ok(summit.distanceTo(before) < 1e-6, 'a session moved the summit');
  assert.equal(c.summitAt('nowhere'), null);
});

test('the name sits on the summit it rises to, not at the height it had when the label was built', () => {
  // The label was built once as the kit landed, with the habitat still at
  // zero, and rebuilt only while a session was busy: on a quiet colony the
  // names stayed down inside their buildings.
  const { colony: c } = colony();
  c.setProjects([project('p1', 0, 300)]);
  const summit = c.summitAt('p1')!;
  const root = c.positionOf('p1')!;
  const before = summit.y;
  run(c, 4);
  assert.equal(c.summitAt('p1'), summit, 'a copy would leave the name at the old height');
  assert.ok(Math.abs(summit.y - (root.y + c.heightOf('p1'))) < 1e-6, `not on the summit: ${summit.y}`);
  assert.ok(summit.y > before + 0.5, 'the habitat rose and the summit with it');
  // A new deck rebuilds the habitat: the vector is the same, one plate higher.
  const risen = summit.y;
  c.setProjects([project('p1', 0, 5000)]);
  assert.equal(c.summitAt('p1'), summit);
  run(c, LIFT_S + 0.5);
  assert.ok(summit.y > risen, 'the name stayed on the old deck');
  assert.equal(c.summitAt('nowhere'), null);
});

test('the crew works on the top deck, never on the ground beside the stack', () => {
  const { colony: c } = colony();
  const nav = new Navigation();
  let roster: readonly RosterEntry[] = [];
  const crew = {
    astronauts: {
      byId: new Map(), agents: [],
      setNavigation: () => {},
      groundMoved: () => {},
      setRoster: (entries: readonly RosterEntry[]) => { roster = entries; return entries.length; },
      celebrate: () => {},
    },
    nav,
    particles: { enabled: false },
    ship: { shipDoor: (out: THREE.Vector3) => out, ping: () => {} },
    scatterObstacles: () => [],
    full: () => false,
  } as unknown as CrewAttachment;
  c.attachCrew(crew);
  c.setProjects([project('p1', 4, 5000)]);
  const sessions = Array.from({ length: 6 }, (_, i) => session(`s${i}`, 'p1'));
  c.setSessions(sessions);
  run(c, 3);
  c.setSessions(sessions);
  const zone = c.zoneOf('p1')!;
  assert.equal(roster.length, 6);
  for (const entry of roster) {
    assert.ok(zone.holds(entry.site.x, entry.site.z, 0), `${entry.id} works off its zone, at ${entry.site.x}, ${entry.site.z}`);
    assert.equal(c.groundAt(entry.site.x, entry.site.z), zone.top, `${entry.id} stands below the top deck`);
  }
});

test('groundAt answers the deck over a deck, rim included, and the terrain elsewhere', () => {
  const { colony: c } = colony();
  c.setProjects([project('p1', 0, 10)]);
  const root = c.positionOf('p1')!;
  assert.equal(c.groundAt(root.x, root.z), deckTop(levelsForSize(10)));
  // A deck is wider than its cell: its corners stand over the cells around
  // it. Asked by cell, a boot there sank into the plate it was standing on.
  for (let k = 0; k < 6; k++) {
    const corner = hexCorner(k, TILE * 0.97);
    const x = root.x + corner.x;
    const z = root.z + corner.z;
    assert.notDeepEqual(worldToHex(x, z), c.zoneOf('p1')!.cell, `corner ${k} is not over another cell: nothing tested`);
    assert.equal(c.groundAt(x, z), root.y, `corner ${k} of the deck is bare ground`);
  }
  // Past the rim is bare ground, however tall the stack next to it.
  assert.equal(c.groundAt(root.x + TILE + 0.3, root.z), GROUND);
  assert.ok(DECK_TOP < root.y, 'a project of ten files stands on more than the ground deck');
  assert.equal(c.groundAt(root.x + 200, root.z + 200), GROUND);
});

test('the scatter is told what to keep clear, once per change: every zone, all of its ramp, and the ship', () => {
  const { colony: c, clears } = colony();
  c.setProjects([project('p1', 0, 10), project('p2', 1, 20000)]);
  assert.equal(clears.length, 1);
  const covered = (x: number, z: number, clear: readonly ClearZone[]): boolean =>
    clear.some((d) => Math.hypot(x - d.x, z - d.z) <= d.r);
  for (const id of ['p1', 'p2']) {
    const zone = c.zoneOf(id)!;
    assert.ok(covered(zone.center.x, zone.center.z, clears[0]!), `${id}: the deck is not kept clear`);
    // A boulder anywhere on the ramp, or where the crew steps onto it, stands in the only way up.
    const head = rampHead();
    const axis = rampAxis();
    for (let along = 0; along <= zone.rampRun + 1; along += 0.25) {
      for (const across of [-1.5, 0, 1.5]) {
        const x = zone.center.x + head.x + axis.x * along - axis.z * across;
        const z = zone.center.z + head.z + axis.z * along + axis.x * across;
        assert.ok(covered(x, z, clears[0]!), `${id}: the ramp is open to the scatter ${along} out`);
      }
    }
  }
  const before = clears[0]!.length;
  c.setProjects([project('p1', 0, 10), project('p2', 1, 20000)]);
  assert.equal(clears.length, 1, 'nothing changed, nothing rebuilt');
  c.setProjects([project('p1', 0, 10)]);
  assert.equal(clears.length, 2);
  assert.ok(clears[1]!.length < before, 'a zone that left takes its clearing with it');
});

/** A colony with a real navigation grid and a crew that only records the roster. */
function crewed(scatter: () => readonly Obstacle[] = () => []): {
  colony: Colony; nav: Navigation; roster: () => readonly RosterEntry[];
} {
  const { colony: c } = colony();
  const nav = new Navigation();
  let roster: readonly RosterEntry[] = [];
  const crew = {
    astronauts: {
      byId: new Map(), agents: [],
      setNavigation: () => {},
      groundMoved: () => {},
      setRoster: (entries: readonly RosterEntry[]) => { roster = entries; return entries.length; },
      celebrate: () => {},
    },
    nav,
    particles: { enabled: false },
    ship: { shipDoor: (out: THREE.Vector3) => out, ping: () => {} },
    scatterObstacles: scatter,
    full: () => false,
  } as unknown as CrewAttachment;
  c.attachCrew(crew);
  return { colony: c, nav, roster: () => roster };
}

test('the way onto a stack is its ramp: a route from the far side walks round and up it, never up a wall', () => {
  // The bug this is here for: the kerb was paint, the grid knew nothing of the
  // stack, and an astronaut walked straight at its site and rose three metres
  // through the side of the deck.
  for (const size of [2, 50, 20000]) {
    const { colony: c, nav, roster } = crewed();
    c.setProjects([project('p1', 0, size)]);
    c.setSessions([session('s1', 'p1')]);
    const zone = c.zoneOf('p1')!;
    const site = roster()[0]!.site;
    const axis = rampAxis();
    // Behind the stack, as seen from the ramp.
    const from = { x: zone.center.x - axis.x * 12, z: zone.center.z - axis.z * 12 };
    const path = nav.findPath(from.x, from.z, site.x, site.z);
    assert.ok(path, `levels ${zone.levels}: no way up`);

    let x = from.x;
    let z = from.z;
    let y = c.groundAt(x, z);
    let onDeck = false;
    let climbed = 0;
    for (const p of path) {
      const steps = Math.ceil(Math.hypot(p.x - x, p.z - z) / 0.1);
      const x0 = x;
      const z0 = z;
      for (let i = 1; i <= steps; i++) {
        const nx = x0 + ((p.x - x0) * i) / steps;
        const nz = z0 + ((p.z - z0) * i) / steps;
        const ny = c.groundAt(nx, nz);
        // A walk, never a jump: every tenth of a metre rises by a slope's worth at most.
        assert.ok(Math.abs(ny - y) < 0.1, `levels ${zone.levels}: a ${(ny - y).toFixed(2)} step at ${nx.toFixed(2)}, ${nz.toFixed(2)}`);
        const nowOnDeck = zone.holds(nx, nz, 0);
        if (nowOnDeck && !onDeck) {
          assert.notEqual(zone.rampHeight(x, z), null, `levels ${zone.levels}: stepped onto the deck from off the ramp`);
        }
        if (zone.rampHeight(nx, nz) !== null) climbed++;
        onDeck = nowOnDeck;
        x = nx;
        z = nz;
        y = ny;
      }
    }
    assert.ok(onDeck, `levels ${zone.levels}: the route ends off the deck`);
    assert.ok(climbed > 0, `levels ${zone.levels}: the route never touched the ramp`);
    assert.equal(y, zone.top);
  }
});

test('on the ramp the crew stands on the ramp, and a rising stack carries its ramp up with it', () => {
  const { colony: c } = colony();
  c.setProjects([project('p1', 0, 20000)]);
  const zone = c.zoneOf('p1')!;
  assert.equal(zone.levels, MAX_LEVELS);
  const head = rampHead();
  const axis = rampAxis();
  const on = (along: number): number =>
    c.groundAt(zone.center.x + head.x + axis.x * along, zone.center.z + head.z + axis.z * along);
  assert.ok(Math.abs(on(0.05) - zone.top) < 0.05, 'the top of the ramp is level with the deck');
  assert.ok(Math.abs(on(zone.rampRun / 2) - zone.top / 2) < 1e-9, 'half way down is half the height');
  assert.equal(on(zone.rampRun + 0.5), GROUND, 'past the foot the ground takes over');
  // Off to the side of the ramp, in the same cell, is ground.
  const side = { x: zone.center.x + head.x + axis.x * 3 - axis.z * 3, z: zone.center.z + head.z + axis.z * 3 + axis.x * 3 };
  assert.equal(c.groundAt(side.x, side.z), GROUND);

  // A smaller stack, grown: the deck slides up, and the ramp under it with it.
  const { colony: g } = colony();
  g.setProjects([project('p1', 0, 50)]);
  g.setProjects([project('p1', 0, 20000)]);
  const grown = g.zoneOf('p1')!;
  const mid = { x: grown.center.x + head.x + axis.x * grown.rampRun / 2, z: grown.center.z + head.z + axis.z * grown.rampRun / 2 };
  const deckNow = g.groundAt(grown.center.x, grown.center.z);
  assert.ok(deckNow < grown.top, 'the lift has only just started');
  assert.ok(Math.abs(g.groundAt(mid.x, mid.z) - Math.max(GROUND, grown.top / 2 + deckNow - grown.top)) < 1e-9);
  run(g, LIFT_S * 1.5);
  assert.ok(Math.abs(g.groundAt(mid.x, mid.z) - grown.top / 2) < 1e-9, 'settled, the ramp is where it was built');
});

test('a site is only ever handed out where the ramp leads, however the deck is walled up', () => {
  // Two walls of rock across the deck, either side of the ramp, meeting in
  // the middle: the stretch of deck the ramp comes up on is cut off from the
  // rest. Before, the fallback took the nearest free cell to a site that was
  // built over, and on the far side of a wall that cell was one nobody could
  // get to.
  let centre = { x: 0, z: 0 };
  const rocks = (): readonly Obstacle[] => [90, 330].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return { x: centre.x + Math.cos(a) * 3.5, z: centre.z + Math.sin(a) * 3.5, r: 3 };
  });
  const { colony: c, nav, roster } = crewed(rocks);
  c.setProjects([project('p1', 0, 5000)]);
  const zone = c.zoneOf('p1')!;
  centre = { x: zone.center.x, z: zone.center.z };
  const sessions = Array.from({ length: 5 }, (_, i) => session(`s${i}`, 'p1'));
  c.setSessions(sessions);
  const landing = zone.landing(new THREE.Vector3());
  const reach = nav.flood(landing.x, landing.z, (x, z) => zone.holds(x, z, 0));
  assert.ok(reach.size > 20, 'the landing is open');
  const across = new THREE.Vector3(zone.center.x - 3.5, 0, zone.center.z - 2);
  assert.equal(reach.has(nav.indexOf(across.x, across.z)), false, 'and the far side of the deck is walled off from it');
  assert.equal(roster().length, 5);
  for (const entry of roster()) {
    assert.ok(reach.has(nav.indexOf(entry.site.x, entry.site.z)), `${entry.id} was sent somewhere the ramp does not lead`);
    assert.ok(nav.findPath(landing.x, landing.z, entry.site.x, entry.site.z), `${entry.id}: no route from the ramp`);
  }
});

test('a crew that walks out of the ship gets up its ramp: nobody is left at the foot', () => {
  // Seen on the colony: an astronaut standing in the dirt at the foot of a
  // ramp, against the rail, for good. Three ways there, one case each:
  // - a tall stack: the corner of the route round the rail's end counted as
  //   reached from the wrong side of the rail, and the walker was pinned
  //   against it heading for the next leg;
  // - a crowd on a low stack: shoved off its leg and against the rail, the
  //   walker slid a millimetre a frame, never counted as blocked, and never
  //   asked for a route that started where it stood;
  // - a far project: 45 seconds of honest walking was "stuck", and the
  //   slowest walker gave up just short of the ramp.
  kits();
  const hq = hqPlacement();
  const cases = [
    { slot: 1, size: 20000, crew: 1 },
    { slot: 8, size: 2, crew: 5 },
    { slot: 14, size: 2, crew: 2 },
  ];
  for (const { slot, size, crew: count } of cases) {
    const { colony: c } = colony();
    const nav = new Navigation();
    const astronauts = new Astronauts(new Settings({ storage: null }), null);
    c.attachCrew({
      astronauts, nav,
      particles: { enabled: false },
      ship: { shipDoor: (out: THREE.Vector3) => out.set(hq.x, 0, hq.z + 6.7), ping: () => {} },
      scatterObstacles: () => [],
      full: () => false,
    } as unknown as CrewAttachment);
    c.setProjects([project('p1', slot, size)]);
    c.setSessions(Array.from({ length: count }, (_, i) => session(`s${i}`, 'p1', 'waiting')));
    const zone = c.zoneOf('p1')!;
    const dt = 1 / 30;
    for (let t = dt; t < 70; t += dt) {
      c.update(dt, t);
      astronauts.update(dt, t);
    }
    assert.equal(astronauts.agents.length, count);
    for (const a of astronauts.agents) {
      const where = `slot ${slot}, ${zone.levels} decks, ${a.id} at ${(a.pos.x - zone.center.x).toFixed(2)}, ${(a.pos.z - zone.center.z).toFixed(2)}`;
      assert.ok(zone.holds(a.pos.x, a.pos.z, 0), `${where}: never got onto the deck`);
      assert.equal(a.state, 'at-site', `${where}: still walking`);
    }
  }
});

test('a crew parked on a stack rides it up when it gains decks, and down when it loses them', () => {
  // Seen on the colony: a project pushed up four decks, and the crew working
  // on it stood where the old top had been, buried to the chest in the new
  // plates. The crew samples the ground only after a step, and a parked
  // astronaut takes none.
  kits();
  const hq = hqPlacement();
  const { colony: c } = colony();
  const astronauts = new Astronauts(new Settings({ storage: null }), null);
  c.attachCrew({
    astronauts, nav: new Navigation(),
    particles: { enabled: false },
    ship: { shipDoor: (out: THREE.Vector3) => out.set(hq.x, 0, hq.z + 6.7), ping: () => {} },
    scatterObstacles: () => [],
    full: () => false,
  } as unknown as CrewAttachment);
  c.setProjects([project('p1', 0, 2)]);
  // Known: they are already at their sites, not walking out of the ship.
  c.setSessions([0, 1].map((i) => ({ ...session(`s${i}`, 'p1', 'waiting'), known: true })));
  const dt = 1 / 30;
  const frames = (seconds: number, each: () => void = () => {}): void => {
    for (let t = 0; t < seconds; t += dt) {
      c.update(dt, t);
      astronauts.update(dt, t);
      each();
    }
  };
  frames(2);
  const deck = c.positionOf('p1')!;
  assert.equal(astronauts.agents.length, 2);
  for (const a of astronauts.agents) assert.equal(a.state, 'at-site');

  c.setProjects([project('p1', 0, 5000)]);
  const top = c.zoneOf('p1')!.top;
  let worst = 0;
  frames(LIFT_S + 0.2, () => {
    for (const a of astronauts.agents) worst = Math.max(worst, deck.y - a.pos.y);
  });
  assert.ok(worst < 1e-6, `an astronaut sank ${worst.toFixed(2)} into the rising stack`);
  for (const a of astronauts.agents) assert.ok(Math.abs(a.pos.y - top) < 1e-6, `${a.id} stayed at ${a.pos.y}, the deck is at ${top}`);

  c.setProjects([project('p1', 0, 2)]);
  frames(0.2);
  const low = c.zoneOf('p1')!.top;
  for (const a of astronauts.agents) assert.ok(Math.abs(a.pos.y - low) < 1e-6, `${a.id} stands on air at ${a.pos.y}, the deck is at ${low}`);
});

test('a project off the map takes its zone and its sessions with it', () => {
  const { colony: c } = colony();
  c.setProjects([project('p1', 0), project('p2', 1)]);
  c.setSessions([session('s1', 'p1'), session('s2', 'p2')]);
  c.setProjects([project('p2', 1)]);
  assert.equal(c.positionOf('p1'), null);
  assert.equal(c.standing('s1'), false, 's1 sinks with its zone');
  assert.equal(c.standing('s2'), true);
  run(c, 6);
  assert.equal(c.headOf('s1'), null);
  // A session on a project that has no zone is simply not on the map.
  c.setSessions([session('s2', 'p2'), session('s9', 'nowhere')]);
  assert.equal(c.headOf('s9'), null);
});

test('a project that left the disk keeps its ground in the ruin tint', () => {
  const { colony: c } = colony();
  c.setProjects([project('p1', 0, 10, true)]);
  assert.equal(c.zoneOf('p1')!.accent, accentOf('p1'));
  assert.ok(ZONE_PALETTE.includes(accentOf('p1')));
  c.setProjects([project('p1', 0, 10, false)]);
  assert.notEqual(c.zoneOf('p1')!.accent, accentOf('p1'));
  assert.deepEqual(c.positionOf('p1')!.toArray(), [placeSlot(0).x, deckTop(levelsForSize(10)), placeSlot(0).z]);
});

/** A crew that records what the colony tells it, and nothing else. */
function recordingCrew(): {
  crew: CrewAttachment;
  roster: () => readonly RosterEntry[];
  gestures: [string, Gesture][];
  cues: [string, Cue][];
} {
  let roster: readonly RosterEntry[] = [];
  const gestures: [string, Gesture][] = [];
  const cues: [string, Cue][] = [];
  const crew = {
    astronauts: {
      byId: new Map(), agents: [],
      setNavigation: () => {},
      groundMoved: () => {},
      setRoster: (entries: readonly RosterEntry[]) => { roster = entries; return entries.length; },
      celebrate: () => {},
      setGesture: (id: string, g: Gesture) => { gestures.push([id, g]); },
      cue: (id: string, cue: Cue) => { cues.push([id, cue]); },
    },
    nav: new Navigation(),
    particles: { enabled: false },
    ship: { shipDoor: (out: THREE.Vector3) => out, ping: () => {} },
    scatterObstacles: () => [],
    full: () => false,
  } as unknown as CrewAttachment;
  return { crew, roster: () => roster, gestures, cues };
}

function sub(id: string, sessionId: string, projectId: string, known = false): ColonySubagent {
  return { id, sessionId, projectId, known };
}

test('a subagent is a smaller astronaut that comes out of the habitat, and there are never more than the deck holds', () => {
  const { colony: c } = colony();
  const rec = recordingCrew();
  c.attachCrew(rec.crew);
  c.setProjects([project('p1', 0, 300)]);
  c.setSessions([session('s1', 'p1')]);
  c.setSubagents([sub('a1', 's1', 'p1')]);
  const cadet = rec.roster().find((e) => e.id === CADET_PREFIX + 'a1');
  assert.ok(cadet, 'no astronaut for the subagent');
  assert.ok((cadet.size ?? 1) < 1, 'as big as a session');
  assert.equal(cadet.status, 'working');
  assert.ok(cadet.home, 'it must come out of the habitat, not the ship');
  const zone = c.zoneOf('p1')!;
  const habitat = zone.worldSlot(0, new THREE.Vector3());
  assert.ok(Math.hypot(cadet.home.x - habitat.x, cadet.home.z - habitat.z) < 4, 'its door is not by the habitat');
  assert.ok(zone.holds(cadet.site.x, cadet.site.z, 0), 'it works off its deck');
  // Clicks and hovers find their way back.
  assert.equal(c.sessionOf(CADET_PREFIX + 'a1'), 's1');
  assert.equal(c.subagentOf(CADET_PREFIX + 'a1')?.id, 'a1');
  assert.equal(c.sessionOf('s1'), 's1');
  assert.equal(c.subagentOf('s1'), null);

  const many = Array.from({ length: MAX_CADETS + 3 }, (_, i) => sub(`a${i}`, 's1', 'p1'));
  c.setSubagents(many);
  assert.equal(rec.roster().filter((e) => e.id.startsWith(CADET_PREFIX)).length, MAX_CADETS);
  // No session on the map, no subagent: it has nobody to stand with.
  c.setSubagents([sub('lost', 'nobody', 'p1')]);
  assert.equal(rec.roster().filter((e) => e.id.startsWith(CADET_PREFIX)).length, 0);
});

/** A colony on a clock the test holds, with a crew that records. */
function clocked(): { c: Colony; rec: ReturnType<typeof recordingCrew>; clock: { now: number } } {
  kits();
  const clock = { now: 1_000_000 };
  const c = new Colony({ surfaces: null, groundHeight: () => GROUND, onFootprint: () => {}, clock: () => clock.now });
  const rec = recordingCrew();
  c.attachCrew(rec.crew);
  c.setProjects([project('p1', 0, 300)]);
  return { c, rec, clock };
}

const helpers = (roster: readonly RosterEntry[]): RosterEntry[] => roster.filter((e) => e.id.startsWith(HELPER_PREFIX));

test('a tool call brings a smaller helper out of the habitat to work beside its session, one however many calls', () => {
  const { c, rec, clock } = clocked();
  c.setSessions([session('s1', 'p1')]);
  // With one session a project, the deck used to show one figure however hard it worked.
  assert.equal(helpers(rec.roster()).length, 0, 'no helper before any call');
  c.toolStart('s1', 'edit', clock.now);
  const [helper] = helpers(rec.roster());
  assert.ok(helper, 'no helper after a tool call');
  assert.ok((helper.size ?? 1) > CADET_SIZE && (helper.size ?? 1) < 1, `between a subagent and a session: ${helper.size}`);
  assert.equal(helper.size, HELPER_SIZE);
  assert.equal(helper.status, 'working');
  assert.equal(helper.known, false, 'it always walks out');
  const zone = c.zoneOf('p1')!;
  const habitat = zone.worldSlot(0, new THREE.Vector3());
  assert.ok(helper.home, 'it must come out of the habitat, not the ship');
  assert.ok(Math.hypot(helper.home.x - habitat.x, helper.home.z - habitat.z) < 4, 'its door is not by the habitat');
  assert.ok(zone.holds(helper.site.x, helper.site.z, 0), 'it works off its deck');
  const own = rec.roster().find((e) => e.id === 's1')!;
  assert.deepEqual(helper.anchor, own.anchor, 'the same structure as its session');
  assert.ok(Math.hypot(helper.site.x - own.site.x, helper.site.z - own.site.z) > 0.5, 'not on the same spot as its session');
  assert.equal(c.helperOf(helper.id), 's1');
  assert.equal(c.sessionOf(helper.id), 's1', 'a click on it opens its session');
  assert.equal(c.helperOf('s1'), null);
  assert.deepEqual(rec.gestures.filter(([id]) => id === helper.id), [[helper.id, 'hammer']], 'the same hands');

  for (let i = 0; i < 20; i++) c.toolStart('s1', 'read', clock.now + i * 100);
  assert.equal(helpers(rec.roster()).length, 1, 'one helper a session');
  assert.equal(helpers(rec.roster())[0]!.id, helper.id, 'the same one, not a new one each call');
  c.toolStart('nobody', 'read', clock.now);
  assert.equal(helpers(rec.roster()).length, 1, 'no helper without a session');
});

test('the helper stays for the whole turn and goes back in only once the work has stopped and lingered', () => {
  const { c, rec, clock } = clocked();
  c.setSessions([session('s1', 'p1', 'working')]);
  c.toolStart('s1', 'exec', clock.now);
  // A Bash that runs for minutes is still the turn's work.
  clock.now += 5 * 60_000;
  c.update(1 / 30, 0);
  assert.equal(helpers(rec.roster()).length, 1, 'gone in the middle of a long call');

  c.toolStart('s1', 'edit', clock.now);
  c.turnEnd('s1');
  assert.ok(rec.cues.some(([id, cue]) => id.startsWith(HELPER_PREFIX) && cue === 'hop'), 'it hops with its session');
  c.setSessions([session('s1', 'p1', 'waiting')]);
  clock.now += HELPER_LINGER_MS - 1_000;
  c.update(1 / 30, 0);
  assert.equal(helpers(rec.roster()).length, 1, 'gone before it could be seen');
  clock.now += 1_001;
  c.update(1 / 30, 0);
  assert.equal(helpers(rec.roster()).length, 0, 'still out after the turn and the linger');
});

test('a call that arrives with the end of the turn still shows its helper for the linger', () => {
  const { c, rec, clock } = clocked();
  // Codex reports a call when it is over, often in the same batch as the turn's end.
  c.setSessions([session('s1', 'p1', 'waiting')]);
  c.toolStart('s1', 'exec', clock.now - 10_000);
  c.turnEnd('s1');
  c.update(1 / 30, 0);
  assert.equal(helpers(rec.roster()).length, 1, 'turned straight back');
  clock.now += HELPER_LINGER_MS + 1;
  c.update(1 / 30, 0);
  assert.equal(helpers(rec.roster()).length, 0);
});

test('a helper called back while it walks in is a new one out of the door', () => {
  const { c, rec, clock } = clocked();
  c.setSessions([session('s1', 'p1', 'waiting')]);
  c.toolStart('s1', 'read', clock.now);
  const first = helpers(rec.roster())[0]!.id;
  clock.now += HELPER_LINGER_MS + 1;
  c.update(1 / 30, 0);
  assert.equal(helpers(rec.roster()).length, 0);
  // Reusing the id would hand the roster an astronaut already on its way in, and it would never come back out.
  c.setSessions([session('s1', 'p1', 'working')]);
  c.toolStart('s1', 'read', clock.now);
  const second = helpers(rec.roster())[0]!.id;
  assert.notEqual(second, first);
  assert.equal(c.sessionOf(second), 's1');
});

test('helpers and subagents share the small places on a deck, helpers first', () => {
  const { c, rec, clock } = clocked();
  c.setSessions([session('s1', 'p1'), session('s2', 'p1')]);
  c.setSubagents(Array.from({ length: MAX_CADETS + 2 }, (_, i) => sub(`a${i}`, 's1', 'p1')));
  c.toolStart('s1', 'edit', clock.now);
  c.toolStart('s2', 'read', clock.now);
  const small = rec.roster().filter((e) => e.id.startsWith(HELPER_PREFIX) || e.id.startsWith(CADET_PREFIX));
  assert.equal(small.length, MAX_CADETS);
  assert.equal(helpers(rec.roster()).length, 2, 'a subagent took a helper\'s place');
  // A retiring session takes its helper with it.
  c.setSessions([session('s1', 'p1')]);
  assert.deepEqual(helpers(rec.roster()).map((e) => c.helperOf(e.id)), ['s1']);
});

test('a tool call changes the hands, a turn end hops, a prompt looks back at the ship', () => {
  const { colony: c } = colony();
  const rec = recordingCrew();
  c.attachCrew(rec.crew);
  c.setProjects([project('p1', 0, 300)]);
  c.setSessions([session('s1', 'p1')]);
  c.toolStart('s1', 'read', 1000);
  c.toolStart('s1', 'exec', 1100);
  c.toolStart('nobody', 'edit', 1200);
  // The session's own astronaut; its helper gets the same hands, tested on its own.
  const own = <T>(list: [string, T][]): [string, T][] => list.filter(([id]) => !id.startsWith(HELPER_PREFIX));
  assert.deepEqual(own(rec.gestures), [['s1', 'inspect'], ['s1', 'operate']]);
  c.turnEnd('s1');
  c.prompt('s1');
  assert.deepEqual(own(rec.cues), [['s1', 'hop'], ['s1', 'heed']]);
  // A page opened mid-work starts on the gesture of the last call.
  c.setSessions([session('s1', 'p1'), { ...session('s2', 'p1'), activity: 'net' }]);
  assert.deepEqual(rec.gestures.at(-1), ['s2', 'uplink']);
});

test('the kerb light runs only while somebody on the project works, and faster the busier it is', () => {
  const now = 1_000_000;
  kits();
  const c = new Colony({ surfaces: null, groundHeight: () => GROUND, onFootprint: () => {}, clock: () => now });
  c.setProjects([project('busy', 0, 300), project('calm', 1, 300), project('quiet', 2, 300)]);
  c.setSessions([session('b', 'busy', 'working'), session('m', 'calm', 'working'), session('q', 'quiet', 'idle')]);
  for (let i = 0; i < 60; i++) c.toolStart('b', 'edit', now - i * 500);
  c.toolStart('m', 'edit', now);

  const head = (id: string): number => c.zoneOf(id)!.kerbState().head;
  run(c, 2);
  assert.ok(c.zoneOf('busy')!.kerbState().chase > 0.9, 'a working project has its light on');
  assert.equal(c.zoneOf('quiet')!.kerbState().chase, 0, 'an idle one has none');
  const busy0 = head('busy');
  const calm0 = head('calm');
  const dt = 1 / 30;
  for (let i = 0; i < 10; i++) c.update(dt, 2 + i * dt);
  const turned = (a: number, b: number): number => (b - a + Math.PI * 2) % (Math.PI * 2);
  assert.ok(turned(busy0, head('busy')) > turned(calm0, head('calm')) * 1.5, 'sixty calls a minute ran no faster than one');

  // The work stops: the light fades out rather than blinking off.
  c.setSessions([session('b', 'busy', 'idle'), session('m', 'calm', 'working'), session('q', 'quiet', 'idle')]);
  c.update(dt, 3);
  assert.ok(c.zoneOf('busy')!.kerbState().chase > 0.5, 'went out at once');
  run(c, 4);
  assert.equal(c.zoneOf('busy')!.kerbState().chase, 0);
});

test('rotors spin up while their session works and stop when it sleeps', () => {
  const { colony: c } = colony();
  c.setProjects([project('p1', 0, 300)]);
  c.setSessions([session('s1', 'p1', 'working')]);
  assert.equal(c.rotorRate('s1'), 1, 'a new structure starts at the authored pace');
  run(c, 0.3);
  const early = c.rotorRate('s1')!;
  assert.ok(early > 1 && early < 6, `spools up rather than jumping: ${early}`);
  run(c, 8);
  assert.ok(c.rotorRate('s1')! > 5.5, 'working spins fast');
  assert.ok(c.rotorRate('p1')! > 5.5, 'and so does the habitat of the project it works on');
  c.setSessions([session('s1', 'p1', 'sleeping')]);
  run(c, 10);
  assert.ok(c.rotorRate('s1')! < 0.05, 'asleep, the rotors stop');
  assert.equal(c.rotorRate('nothing'), null);
});

test('a click on a lot finds its project from the top deck, and bare ground finds none', () => {
  const { colony: c } = colony();
  c.setProjects([project('p1', 0, 10), project('p2', 1, 400)]);
  run(c, 3);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  const aim = (x: number, z: number): string | null => {
    // Straight down from above: the screen centre is the point under the camera.
    camera.position.set(x, 300, z + 0.001);
    camera.lookAt(x, 0, z);
    camera.updateMatrixWorld();
    return c.pickProject(0, 0, camera);
  };
  for (const id of ['p1', 'p2']) {
    const at = c.zoneOf(id)!.center;
    assert.equal(aim(at.x, at.z), id);
  }
  const p1 = c.zoneOf('p1')!.center;
  assert.equal(aim(p1.x + 500, p1.z + 500), null);
});
