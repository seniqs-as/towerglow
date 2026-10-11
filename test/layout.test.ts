import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  placeSlot, slotToCell, colonyRadius, ZONE_PITCH, CELL_SIZE, TILE, HEX_DIRS, DECK_TOP,
  hexToWorld, worldToHex, hexDistance, hexCorner, cellKey, onTile,
  levelsForSize, deckTop, MAX_LEVELS, zoneSlot, ZONE_SPOTS, lampSpot, LAMP_SEATS,
  floorsForSize, MIN_FLOORS, MAX_FLOORS, floorOfDir, windowColumn, WINDOW_COLS,
  hqPlacement,
  HQ_Z, SHIP_CELL, HQ_PLAZA_CELLS, HQ_PLAZA_RADIUS, HQ_RADIUS,
  RAMP_EDGE, RAMP_WIDTH, RAMP_GRADE, RAMP_MIN_RUN, rampAxis, rampCell, rampHead, rampRun, rampSurface,
} from '../src/shared/layout.ts';
import { fnv1a32 } from '../src/shared/hash.ts';

/* ───────────────────────── the lattice ───────────────────────── */

/** How far a point, relative to a deck's centre, is from that deck: 0 on it. */
function fromTile(x: number, z: number): number {
  if (onTile(x, z)) return 0;
  let best = Infinity;
  for (let i = 0; i < 6; i++) {
    const a = hexCorner(i);
    const b = hexCorner(i + 1);
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / (ex * ex + ez * ez)));
    best = Math.min(best, Math.hypot(x - a.x - ex * t, z - a.z - ez * t));
  }
  return best;
}

/** How far a point, relative to a deck's centre, is from the ramp of a stack of `levels`: 0 on it. */
function fromRamp(levels: number, x: number, z: number): number {
  const head = rampHead();
  const axis = rampAxis();
  const dx = x - head.x;
  const dz = z - head.z;
  const along = dx * axis.x + dz * axis.z;
  const across = dz * axis.x - dx * axis.z;
  return Math.hypot(Math.max(0, -along, along - rampRun(levels)), Math.max(0, Math.abs(across) - RAMP_WIDTH / 2));
}

const ROOTS = Array.from({ length: 1024 }, (_, slot) => placeSlot(slot));

test('worldToHex is the exact inverse of hexToWorld, on centres and near the edges', () => {
  for (let q = -6; q <= 6; q++) {
    for (let r = -6; r <= 6; r++) {
      const c = hexToWorld(q, r);
      assert.deepEqual(worldToHex(c.x, c.z), { q, r }, `centre of ${q},${r}`);
      // Just inside the corner, still the same cell: containment, not nearest centre.
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k;
        const x = c.x + CELL_SIZE * 0.96 * Math.cos(a);
        const z = c.z + CELL_SIZE * 0.96 * Math.sin(a);
        assert.deepEqual(worldToHex(x, z), { q, r }, `corner ${k} of ${q},${r}`);
      }
    }
  }
});

test('slot 0 sits at the centre of the colony', () => {
  assert.deepEqual(placeSlot(0), { slot: 0, x: 0, z: 0 });
});

test('every slot gets a zone root of its own', () => {
  const seen = new Set<string>();
  for (let slot = 0; slot < 400; slot++) {
    const key = cellKey(slotToCell(slot));
    assert.equal(seen.has(key), false, `slot ${slot} collides at ${key}`);
    seen.add(key);
  }
});

test('no two zone roots are closer than one zone pitch', () => {
  const points = Array.from({ length: 120 }, (_, i) => placeSlot(i));
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!, b = points[j]!;
      const gap = Math.hypot(a.x - b.x, a.z - b.z);
      assert.ok(gap >= ZONE_PITCH - 1e-9, `slots ${i} and ${j} are ${gap} apart`);
    }
  }
});

test('no two zones ever touch: every deck is ringed by bare ground', () => {
  // The whole point of the index-3 sub-lattice: one hex per project, and
  // between any two of them at least one cell nobody decks -- the walkway
  // that keeps a colony of places from reading as one carpet.
  const cells = Array.from({ length: 200 }, (_, slot) => slotToCell(slot));
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const d = hexDistance(cells[i]!, cells[j]!);
      assert.ok(d >= 2, `slots ${i} and ${j} are ${d} cells apart`);
    }
  }
});

test('between two decks there is always a walkway two astronauts pass on, rim to rim', () => {
  // The lattice is tighter than the decks (`CELL_SIZE`), so two cells apart
  // no longer says how much ground is left between them: the rims do. Two
  // convex plates are as close as the nearest corner of one to the other.
  let narrowest = Infinity;
  for (let i = 0; i < ROOTS.length; i++) {
    for (let j = i + 1; j < ROOTS.length; j++) {
      const a = ROOTS[i]!, b = ROOTS[j]!;
      // Farther than this, even corner to corner the gap is past what is checked.
      if (Math.hypot(a.x - b.x, a.z - b.z) > 2 * TILE + 8) continue;
      for (let k = 0; k < 6; k++) {
        const c = hexCorner(k);
        narrowest = Math.min(narrowest, fromTile(a.x + c.x - b.x, a.z + c.z - b.z), fromTile(b.x + c.x - a.x, b.z + c.z - a.z));
      }
    }
  }
  assert.ok(narrowest >= RAMP_WIDTH, `two decks are ${narrowest.toFixed(2)} apart`);
  // And the colony did come together: it was 7.7 when decks tiled the
  // lattice, and 4.1 at the first pull, before the ramps got steeper.
  assert.ok(narrowest < 3.5, `the walkway is ${narrowest.toFixed(2)} wide`);
});

test('the colony stays compact: the radius grows like a square root, not linearly', () => {
  const r16 = colonyRadius(16);
  const r64 = colonyRadius(64);
  assert.ok(r64 < r16 * 3, `radius exploded: ${r16} -> ${r64}`);
  // Tied to the pitch, not to a fixed number: what has to stay true is that a
  // dozen projects sit within a few rings of the centre.
  assert.ok(
    colonyRadius(14) <= 3 * ZONE_PITCH,
    `14 projects span a radius of ${colonyRadius(14)}, beyond three rings`,
  );
});

test('the frozen map: every slot keeps the cell it has always had, whatever the lattice size', () => {
  // Seen when the lattice was pulled in from 7.6 to 6.4: three roots at the
  // same distance from the centre were told apart by rounding, rounding
  // depends on the scale, and slots 1, 2 and 3 swapped cells. The positions
  // may be drawn tighter; which project stands next to which may not change.
  const first = [
    [0, 0], [-2, 1], [-1, 2], [1, 1], [2, -1], [-3, 3], [0, 3], [3, 0], [-4, 2], [-2, 4], [2, 2], [4, -2],
    [-5, 4], [-4, 5], [4, 1], [5, -1], [-1, 5], [1, 4], [-6, 3], [-3, 6], [3, 3], [6, -3], [-3, 0], [3, -3],
  ];
  first.forEach(([q, r], slot) => assert.deepEqual(slotToCell(slot), { q, r }, `slot ${slot} moved`));
  // All 1024, as a fingerprint of the list the colony has always been placed by.
  const all = Array.from({ length: 1024 }, (_, slot) => cellKey(slotToCell(slot))).join('|');
  assert.equal(fnv1a32(all).toString(16), '29cb4c94', 'a slot past the first two dozen moved');
});

test('zones never move: position depends ONLY on the slot', () => {
  for (const slot of [0, 1, 7, 42]) {
    assert.deepEqual(placeSlot(slot), placeSlot(slot));
    assert.deepEqual(slotToCell(slot), slotToCell(slot));
  }
});

test('a slot that is not a number lands at the centre, never at NaN', () => {
  for (const slot of [Number.NaN, -3, Number.POSITIVE_INFINITY]) {
    const p = placeSlot(slot);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z), `slot ${slot} produces NaN`);
  }
});

/* ───────────────────────── levels ───────────────────────── */

test('levels grow with the number of files, one to seven', () => {
  assert.equal(levelsForSize(0), 1);
  assert.equal(levelsForSize(-5), 1);
  assert.equal(levelsForSize(Number.NaN), 1);
  let prev = levelsForSize(0);
  for (const n of [1, 5, 30, 200, 1000, 5000, 20000, 1e7]) {
    const l = levelsForSize(n);
    assert.ok(l >= prev, `${n} files give fewer levels than before`);
    assert.ok(l >= 1 && l <= MAX_LEVELS, `levels out of range for ${n}: ${l}`);
    prev = l;
  }
  assert.ok(levelsForSize(500) > levelsForSize(50), 'a big project must read taller');
  assert.equal(levelsForSize(1e9), MAX_LEVELS, 'the stack has a ceiling');
});

test('a stack is counted in decks as thick as the one on the ground', () => {
  // The request was literal: bigger projects stack hexes "following the
  // current thickness". A taller plinth would say "bigger" without saying
  // how much; plates can be counted.
  assert.equal(deckTop(1), DECK_TOP);
  for (let levels = 1; levels <= MAX_LEVELS; levels++) {
    assert.ok(Math.abs(deckTop(levels) - levels * DECK_TOP) < 1e-9, `level ${levels}`);
  }
  assert.equal(deckTop(Number.NaN), DECK_TOP, 'a NaN stack is one deck, not a NaN height');
  assert.equal(deckTop(0), DECK_TOP);
  assert.equal(deckTop(MAX_LEVELS + 20), MAX_LEVELS * DECK_TOP);
});

test('every building spot of a zone is on its tile, and none coincide', () => {
  const seen = new Set<string>();
  for (let i = 0; i < ZONE_SPOTS; i++) {
    const p = zoneSlot(i);
    const key = `${p.x.toFixed(4)},${p.z.toFixed(4)}`;
    assert.equal(seen.has(key), false, `spot ${i} coincides with another`);
    seen.add(key);
    assert.ok(onTile(p.x, p.z, 1), `spot ${i} is off the tile`);
  }
  // Spot 0 is the centre: the habitat's.
  assert.deepEqual(zoneSlot(0), { x: 0, z: 0 });
});

test('a building spot past the last folds back onto the ones there are', () => {
  assert.deepEqual(zoneSlot(ZONE_SPOTS * 5 + 3), zoneSlot(3));
  const q = zoneSlot(Number.NaN);
  assert.ok(Number.isFinite(q.x) && Number.isFinite(q.z));
});

/* ───────────────────────── the ramp ───────────────────────── */

test('the tallest ramp stops short of every other deck and of the ship', () => {
  // What decides how tight the lattice can be. The ramp of slot 51 points
  // straight at the ship, two cells away, and one lattice step tighter its
  // foot covered a mast pad (the masts are gone, the lattice stays); a little
  // more and every seven-deck ramp reaches the deck across the hole it comes
  // down into.
  const hq = hqPlacement();
  const along = rampRun(MAX_LEVELS);
  const head = rampHead();
  const axis = rampAxis();
  // The outline of the ramp, zone-local, every 10 cm.
  const outline: { x: number; z: number }[] = [];
  for (let t = 0; t <= along; t += 0.1) {
    for (const across of [-RAMP_WIDTH / 2, RAMP_WIDTH / 2]) {
      outline.push({ x: head.x + axis.x * t - axis.z * across, z: head.z + axis.z * t + axis.x * across });
    }
  }
  for (let across = -RAMP_WIDTH / 2; across <= RAMP_WIDTH / 2; across += 0.1) {
    outline.push({ x: head.x + axis.x * along - axis.z * across, z: head.z + axis.z * along + axis.x * across });
  }
  for (let slot = 0; slot < ROOTS.length; slot++) {
    const root = ROOTS[slot]!;
    for (let other = 0; other < ROOTS.length; other++) {
      const o = ROOTS[other]!;
      if (other === slot || Math.hypot(o.x - root.x, o.z - root.z) > 2 * TILE + along) continue;
      let gap = Infinity;
      for (const p of outline) gap = Math.min(gap, fromTile(root.x + p.x - o.x, root.z + p.z - o.z));
      // One astronaut fits between the kerb and the next deck.
      assert.ok(gap >= 1, `the ramp of slot ${slot} comes ${gap.toFixed(2)} from the deck of slot ${other}`);
    }
    const ship = fromRamp(MAX_LEVELS, hq.x - root.x, hq.z - root.z);
    assert.ok(ship >= HQ_RADIUS, `the ramp of slot ${slot} is ${ship.toFixed(2)} from the ship`);
  }
});

test('every ramp comes down on bare ground: never a zone, never the ship, never another ramp', () => {
  const roots = new Set<string>();
  for (let slot = 0; slot < 1024; slot++) roots.add(cellKey(slotToCell(slot)));
  const shipFoot = cellKey({ q: SHIP_CELL.q, r: SHIP_CELL.r + 1 });
  const ramps = new Set<string>();
  for (let slot = 0; slot < 1024; slot++) {
    const cell = slotToCell(slot);
    const under = rampCell(cell);
    const key = cellKey(under);
    assert.equal(hexDistance(cell, under), 1, `the ramp of slot ${slot} does not start at its edge`);
    assert.equal(roots.has(key), false, `the ramp of slot ${slot} comes down on a zone at ${key}`);
    assert.notEqual(key, cellKey(SHIP_CELL), `the ramp of slot ${slot} comes down on the ship`);
    assert.notEqual(key, shipFoot, `the ramp of slot ${slot} blocks the foot of the ship's ramp`);
    assert.equal(ramps.has(key), false, `two ramps come down into ${key}`);
    ramps.add(key);
  }
});

test('the ramp meets the deck at the rim and the ground at its foot, and stays in its own cell', () => {
  const head = rampHead();
  const axis = rampAxis();
  const [dq, dr] = HEX_DIRS[RAMP_EDGE]!;
  const out = hexToWorld(dq, dr);
  assert.ok(Math.abs(Math.atan2(out.z, out.x) - Math.atan2(axis.z, axis.x)) < 1e-9, 'the axis points at the ramp cell');
  for (let levels = 1; levels <= MAX_LEVELS; levels++) {
    const run = rampRun(levels);
    const top = deckTop(levels);
    assert.ok(run >= RAMP_MIN_RUN && top / run <= RAMP_GRADE + 1e-9, `level ${levels}: too steep`);
    const at = (along: number, across = 0): number | null =>
      rampSurface(levels, head.x + axis.x * along - axis.z * across, head.z + axis.z * along + axis.x * across);
    assert.ok(Math.abs(at(0)! - top) < 1e-9, `level ${levels}: the top of the ramp is not the top deck`);
    assert.ok(Math.abs(at(run)!) < 1e-9, `level ${levels}: the foot is not at the ground`);
    // Downhill all the way, the same across its whole width, and nothing past its sides or behind the rim.
    let prev = Infinity;
    // From a hair past the rim: exactly on it, a point off the centreline rounds to either side.
    for (let along = run / 40; along <= run; along += run / 20) {
      const h = at(along)!;
      assert.ok(h < prev + 1e-12, `level ${levels}: uphill at ${along}`);
      assert.ok(Math.abs(at(along, RAMP_WIDTH / 2 - 0.01)! - h) < 1e-9);
      prev = h;
    }
    assert.equal(at(run / 2, RAMP_WIDTH / 2 + 0.01), null, 'off the side of the ramp');
    assert.equal(at(-0.01), null, 'behind the rim is the deck, not the ramp');
    // The visible ramp, corners included, is on the zone's cell or the one it
    // comes down into: that cell is where the colony looks a ramp up.
    for (const along of [0.01, run]) {
      for (const across of [-RAMP_WIDTH / 2, RAMP_WIDTH / 2]) {
        const x = head.x + axis.x * along - axis.z * across;
        const z = head.z + axis.z * along + axis.x * across;
        const cell = cellKey(worldToHex(x, z));
        assert.ok(cell === '0,0' || cell === cellKey({ q: dq, r: dr }), `level ${levels}: the ramp reaches ${cell}`);
      }
    }
  }
});

test('nothing stands at the top of the ramp: no building spot, no lamp', () => {
  // The widest small structure reaches 1.85 from its spot (`SMALL_FOOTPRINT`),
  // so a spot has to be that far from the walk in off the ramp, and a lamp
  // at least off the walkway itself.
  const head = rampHead();
  const axis = rampAxis();
  const fromWalk = (p: { x: number; z: number }): number => {
    let best = Infinity;
    for (let along = -2; along <= 0; along += 0.05) {
      best = Math.min(best, Math.hypot(p.x - (head.x + axis.x * along), p.z - (head.z + axis.z * along)));
    }
    return best;
  };
  for (let i = 1; i < ZONE_SPOTS; i++) {
    const d = fromWalk(zoneSlot(i));
    assert.ok(d > RAMP_WIDTH / 2 + 1.85, `spot ${i} is ${d.toFixed(2)} from the way in`);
  }
  for (let seat = 0; seat < LAMP_SEATS; seat++) {
    const d = fromWalk(lampSpot(seat));
    assert.ok(d > RAMP_WIDTH / 2, `lamp seat ${seat} is ${d.toFixed(2)} from the way in`);
  }
});

/* ───────────────────────── lamps ───────────────────────── */

test('every lamp seat has its own spot on the deck, clear of the building spots', () => {
  const seen = new Set<string>();
  const spots = Array.from({ length: ZONE_SPOTS }, (_, i) => zoneSlot(i));
  for (let seat = 0; seat < LAMP_SEATS; seat++) {
    const p = lampSpot(seat);
    const key = `${p.x.toFixed(4)},${p.z.toFixed(4)}`;
    assert.equal(seen.has(key), false, `seat ${seat} coincides with another lamp`);
    seen.add(key);
    // On the kerb band: inside the tile, outside the ring of building spots.
    assert.ok(onTile(p.x, p.z), `seat ${seat} is off the tile`);
    assert.ok(Math.hypot(p.x, p.z) < TILE * 0.87, `seat ${seat} is off the deck`);
    for (const s of spots) {
      const gap = Math.hypot(p.x - s.x, p.z - s.z);
      assert.ok(gap >= 2, `seat ${seat} is ${gap} from a building spot`);
    }
  }
});

test('a lamp seat past the last folds back, and a bad seat never goes to NaN', () => {
  assert.deepEqual(lampSpot(LAMP_SEATS + 1), lampSpot(1));
  const p = lampSpot(Number.NaN);
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z));
});

/* ─────────────── floors and columns: the server's filing ─────────────── */

test('floors for size stay within bounds: the server still files windows by floor', () => {
  assert.equal(floorsForSize(0), MIN_FLOORS);
  assert.equal(floorsForSize(-5), MIN_FLOORS);
  assert.equal(floorsForSize(Number.NaN), MIN_FLOORS);
  assert.ok(floorsForSize(500) > floorsForSize(50));
  assert.ok(floorsForSize(50) > floorsForSize(5));
  assert.equal(floorsForSize(10_000_000), MAX_FLOORS, 'the filing needs a ceiling');
  for (const n of [0, 1, 10, 1000, 100000]) {
    const f = floorsForSize(n);
    assert.ok(f >= MIN_FLOORS && f <= MAX_FLOORS, `floors out of range for ${n}: ${f}`);
  }
});

test('a directory always lands on the same floor', () => {
  // A hash and not an index in a sorted list: a new directory that slots in
  // earlier in the alphabet would move every window already lit.
  for (const dir of ['src', 'test', 'docs', '.']) {
    assert.equal(floorOfDir(dir, 12), floorOfDir(dir, 12));
    assert.ok(floorOfDir(dir, 12) >= 0 && floorOfDir(dir, 12) < 12);
  }
  assert.equal(floorOfDir('src', 0), 0, 'no floors: must not divide by zero');
});

test('window columns never collide while free slots remain', () => {
  const taken = new Set<number>();
  const seen = new Set<number>();
  for (let i = 0; i < WINDOW_COLS; i++) {
    const col = windowColumn(`src/file-${i}.ts`, taken);
    assert.equal(seen.has(col), false, `column ${col} assigned twice`);
    seen.add(col);
    taken.add(col);
  }
  assert.equal(seen.size, WINDOW_COLS, 'probing must fill the whole floor');
});

test('adding a window does not move the ones already placed', () => {
  const taken = new Set<number>();
  const first = windowColumn('src/app.ts', taken);
  taken.add(first);
  windowColumn('src/other.ts', taken);
  assert.equal(windowColumn('src/app.ts', new Set()), first);
});

/* ───────────────────────── the ship ───────────────────────── */

test('no zone ends up on the ship plaza', () => {
  // The bug this test blocks: the HQ had been placed on the assumption that
  // the spiral would never reach it. It did, and a project building would
  // have sprouted inside the headquarters. A zone is one cell
  // now, so every cell a zone can take is its root: the check is on all 1024.
  for (let slot = 0; slot < 1024; slot++) {
    const cell = slotToCell(slot);
    const d = hexDistance(cell, SHIP_CELL);
    assert.ok(d > HQ_PLAZA_CELLS, `slot ${slot} sits at ${cellKey(cell)}, on the plaza`);
  }
});

test('the colony grows away from the ship', () => {
  // Not aesthetics: without this preference the colony ended up on top of
  // the ship with a few dozen projects. The bug this test has already caught
  // once is the SIGN of the penalty, which made the city grow straight
  // towards the headquarters.
  let toward = 0;
  let away = 0;
  for (let slot = 1; slot < 60; slot++) {
    const z = placeSlot(slot).z;
    if (Math.abs(z) < 1e-9) continue;
    if (Math.sign(z) === Math.sign(HQ_Z)) toward++;
    else away++;
  }
  assert.ok(away > toward * 2, `${toward} zones toward the ship against ${away} on the other side`);
});

test('nobody builds in front of the ramp: the cell south of the ship stays free', () => {
  // The ship sits two cells from the centre, and the first zone is right
  // past the foot of the ramp by design. What has to stay true is that the
  // cell the ramp comes down on -- towards +Z, the one every astronaut walks
  // -- is never decked, however many projects there are.
  const foot = cellKey({ q: SHIP_CELL.q, r: SHIP_CELL.r + 1 });
  for (let slot = 0; slot < 1024; slot++) {
    const cell = cellKey(slotToCell(slot));
    assert.notEqual(cell, foot, `slot ${slot} covers the ramp at ${cell}`);
  }
  // And the whole plaza fits inside the radius the camera frames.
  for (const cell of [SHIP_CELL, ...Array.from({ length: 6 }, (_, i) => ({
    q: SHIP_CELL.q + HEX_DIRS[i]![0], r: SHIP_CELL.r + HEX_DIRS[i]![1],
  }))]) {
    const c = hexToWorld(cell.q, cell.r);
    const far = Math.hypot(c.x, c.z - HQ_Z) + CELL_SIZE;
    assert.ok(far <= HQ_PLAZA_RADIUS + 1e-9, `cell ${cellKey(cell)} sticks out of the plaza: ${far}`);
  }
});

test('the ship sits right against the colony: a single cell between the ramp and the first lot', () => {
  // It stood four cells out, and the first thing anyone asked was to bring it
  // closer: from the ship, slot 0 is the next cell but one.
  assert.equal(hexDistance(SHIP_CELL, slotToCell(0)), 2);
  // And nothing else crowds it: the ring around the plaza is bare ground or
  // the three zones of the hole it sits in, never a deck against its apron.
  for (let slot = 0; slot < 1024; slot++) {
    assert.ok(hexDistance(SHIP_CELL, slotToCell(slot)) >= 2, `slot ${slot} sits right against the ship`);
  }
});

test('no deck spills onto the plaza: a ramp still fits between its rim and the ship\'s apron', () => {
  // A deck is wider than its cell (`CELL_SIZE`): that no root stands on the
  // plaza is no longer enough to say the rim stays off it.
  const hq = hqPlacement();
  for (let slot = 0; slot < ROOTS.length; slot++) {
    const root = ROOTS[slot]!;
    const gap = fromTile(hq.x - root.x, hq.z - root.z);
    assert.ok(gap >= HQ_RADIUS + RAMP_WIDTH, `the deck of slot ${slot} is ${gap.toFixed(2)} from the ship`);
  }
});

test('slot 0 stays the exact centre, whatever is done to the rest', () => {
  assert.deepEqual(placeSlot(0), { slot: 0, x: 0, z: 0 });
});

test('the ship does not depend on how many projects there are', () => {
  // If one day the distance became a function of the colony, the ship would
  // move with every new project: exactly what layout.ts forbids.
  assert.deepEqual(hqPlacement(), { x: 0, z: HQ_Z });
  assert.deepEqual(hqPlacement(), hqPlacement());
  assert.deepEqual(hqPlacement(), { x: hexToWorld(SHIP_CELL.q, SHIP_CELL.r).x, z: hexToWorld(SHIP_CELL.q, SHIP_CELL.r).z });
});

test('the ship sits to the north, outside the settlement', () => {
  assert.ok(HQ_Z < 0, 'the ship must sit on the -Z axis');
  let tip = 0;
  for (let slot = 0; slot < 15; slot++) tip = Math.min(tip, placeSlot(slot).z);
  assert.ok(Math.abs(HQ_Z) > Math.abs(tip) + HQ_PLAZA_RADIUS, 'the ship touches the current colony');
});
