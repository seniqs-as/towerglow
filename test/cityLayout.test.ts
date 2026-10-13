/**
 * Ported from the first city's layout tests: only the city-grid geometry that
 * moved into src/client/city/layout.ts. Turrets, floorOfDir and windowColumn
 * stay out on purpose -- the first has no equivalent here, and the other two
 * remain in src/shared/layout.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  placeSlot, slotToCell, cityRadius, axisToWorld, CELL_PITCH, LOT_SIZE,
  clampPitch, MIN_PITCH, MAX_PITCH, PITCH_STEP,
  buildingFootprint, buildingHeight, floorsForSize,
  windowPlacement, windowSize, WINDOW_COLS,
  windowCapacity, windowCell,
  HQ_CELL, HQ_Z, HQ_PLAZA_RADIUS,
} from '../src/client/city/layout.ts';
import { GRID_CELL } from '../src/client/city/ground.ts';
// MIN_FLOORS/MAX_FLOORS describe floorsForSize's bounds; city/layout.ts only
// re-exports the function, so the bounds still come from where it is defined.
import { MIN_FLOORS, MAX_FLOORS } from '../src/shared/layout.ts';
import { fnv1a32 } from '../src/shared/hash.ts';

test('slot 0 sits at the centre of the city', () => {
  assert.deepEqual(placeSlot(0), { slot: 0, x: 0, z: 0 });
});

test('the spiral gives every slot its own lot', () => {
  const seen = new Set<string>();
  for (let slot = 0; slot < 400; slot++) {
    const p = placeSlot(slot);
    const key = `${p.x},${p.z}`;
    assert.equal(seen.has(key), false, `slot ${slot} collides at ${key}`);
    seen.add(key);
  }
});

test('no two towers are closer than one cell pitch', () => {
  const points = Array.from({ length: 120 }, (_, i) => placeSlot(i));
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!, b = points[j]!;
      const gap = Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
      assert.ok(gap >= CELL_PITCH - 1e-9, `slots ${i} and ${j} are ${gap} apart`);
    }
  }
});

test('blocks stay compact: the radius grows like a square root, not linearly', () => {
  // This is the point of laying things out in blocks: 100 projects must not
  // sit a hundred times farther out than one.
  const r16 = cityRadius(16);
  const r64 = cityRadius(64);
  assert.ok(r64 < r16 * 3, `radius exploded: ${r16} -> ${r64}`);
  // Tied to the grid pitch, not a fixed number: the spacing gets retouched by
  // eye, and what must stay true is that a dozen projects sit within a few
  // rings of the centre.
  assert.ok(
    cityRadius(14) <= 3 * CELL_PITCH,
    `14 projects occupy a radius of ${cityRadius(14)}, beyond three rings`,
  );
});

test('no street runs between the towers: every lot is one pitch from the next', () => {
  // The city had a 30-unit avenue every two lots, on top of a pitch of 52:
  // the user asked for the streets gone and the projects closer together.
  for (let g = -20; g < 20; g++) {
    assert.equal(axisToWorld(g + 1) - axisToWorld(g), CELL_PITCH, `a wider gap after cell ${g}`);
  }
});

test('two neighbours keep a gap you can see, and never a street', () => {
  // The near end was seen on the real page: with 3 units between the widest
  // towers, and then with 9, towers a hundred units tall read as one block
  // from the three-quarter view, "totally attached". The far end is the
  // narrowest street the city had, 52 from centre to centre: at that gap the
  // streets are back, which is what was taken out.
  const gap = CELL_PITCH - LOT_SIZE;
  const narrowestStreet = 52 - LOT_SIZE;
  assert.ok(gap > 9, `${gap} units between two towers: they read as one block`);
  assert.ok(gap < narrowestStreet, `${gap} units between two towers is a street again`);
});

test('every tower meets the floor grid the same way, at every spacing', () => {
  assert.equal(PITCH_STEP, GRID_CELL, 'the slider has to move by the cell of the floor');
  for (const pitch of [CELL_PITCH, MIN_PITCH, MAX_PITCH]) {
    assert.equal(pitch % GRID_CELL, 0, `at ${pitch} the lines cross each tower at a different place`);
  }
});

test('the spacing you pick moves the towers apart and changes no neighbour', () => {
  // Asked for four times in a row, a little more each time: the distance
  // between the towers is a taste, so it is a setting. What it may not do is
  // what the order forbids: hand a slot to another cell.
  for (const pitch of [MIN_PITCH, 36, 60, MAX_PITCH]) {
    for (let slot = 0; slot < 200; slot++) {
      const cell = slotToCell(slot);
      assert.deepEqual(
        placeSlot(slot, pitch),
        { slot, x: cell.gx * pitch, z: cell.gz * pitch },
        `slot ${slot} at a spacing of ${pitch}`,
      );
    }
  }
  assert.equal(cityRadius(16, 60), (cityRadius(16, 30) / 30) * 60, 'the city scales, it does not reshape');
});

test('left alone, the city is drawn at the spacing it opens on', () => {
  for (const slot of [0, 1, 7, 42]) assert.deepEqual(placeSlot(slot), placeSlot(slot, CELL_PITCH));
});

test('a spacing out of range, off the grid or not a number is pulled back', () => {
  assert.equal(clampPitch(3), MIN_PITCH, 'below the range the towers read as one block');
  assert.equal(clampPitch(5000), MAX_PITCH);
  assert.equal(clampPitch(40), 42, 'off the grid: the nearest stop');
  assert.equal(clampPitch(Number.NaN), CELL_PITCH, 'a stored NaN would place every tower nowhere');
  assert.equal(clampPitch(Number.POSITIVE_INFINITY), CELL_PITCH);
  assert.equal(clampPitch(CELL_PITCH), CELL_PITCH);
  assert.ok(MIN_PITCH > LOT_SIZE, 'at the closest stop two towers still do not share a wall');
});

test('the frozen order: every slot keeps the cell it had on the street grid', () => {
  // Seen when the streets were removed: the order is a sort by distance, the
  // avenues stretched the distances unevenly, and the same sort on an even
  // grid drops the lot north of the centre from slot 6 to slot 13. The towers
  // may be drawn closer; which project stands next to which may not change.
  const first = [
    [0, 0], [-1, 0], [0, 1], [1, 0], [-1, 1], [1, 1], [0, -1], [-2, 0], [0, 2], [2, 0], [-2, 1], [-1, 2],
    [1, 2], [2, 1], [-1, -1], [1, -1], [-3, 0], [0, 3], [3, 0], [-2, 2], [2, 2], [-3, 1], [-1, 3], [1, 3],
  ];
  first.forEach(([gx, gz], slot) => assert.deepEqual(slotToCell(slot), { gx, gz }, `slot ${slot} moved`));
  // All 1024, as a fingerprint of the list the city has always been placed by.
  const all = Array.from({ length: 1024 }, (_, slot) => {
    const c = slotToCell(slot);
    return `${c.gx},${c.gz}`;
  }).join('|');
  assert.equal(fnv1a32(all).toString(16), '2ddd2c2a', 'a slot past the first two dozen moved');
});

test('towers never move: position depends ONLY on the slot', () => {
  for (const slot of [0, 1, 7, 42]) {
    assert.deepEqual(placeSlot(slot), placeSlot(slot));
  }
});

test('the largest footprint never spills out of its lot', () => {
  const maxFootprint = buildingFootprint();
  assert.ok(maxFootprint <= LOT_SIZE, `footprint ${maxFootprint} exceeds lot ${LOT_SIZE}`);
  assert.ok(maxFootprint < CELL_PITCH, 'a tower must not touch its neighbour');
});

test('a new project has the same base as every other tower', () => {
  // The base used to widen as the project grew; only the height may.
  assert.equal(buildingFootprint(), LOT_SIZE);
  assert.ok(floorsForSize(1) < floorsForSize(500), 'height still tracks size');
});

test('tower height tracks project size, within bounds', () => {
  // Bigger projects must read as taller, but a huge one cannot dwarf the city.
  assert.equal(floorsForSize(0), MIN_FLOORS);
  assert.equal(floorsForSize(-5), MIN_FLOORS);
  assert.equal(floorsForSize(Number.NaN), MIN_FLOORS);
  assert.ok(floorsForSize(500) > floorsForSize(50));
  assert.ok(floorsForSize(50) > floorsForSize(5));
  assert.equal(floorsForSize(10_000_000), MAX_FLOORS, 'the skyline needs a ceiling');
  for (const n of [0, 1, 10, 1000, 100000]) {
    const f = floorsForSize(n);
    assert.ok(f >= MIN_FLOORS && f <= MAX_FLOORS, `floors out of range for ${n}: ${f}`);
  }
});

test('a big project is visibly taller, and the ceiling holds', () => {
  const small = buildingHeight(20);
  const large = buildingHeight(2000);
  assert.ok(large > small * 1.4, 'the difference must be visible');
  // The limit is not an arbitrary ratio between two projects: it is
  // MAX_FLOORS, which is what actually keeps the skyline inside the frame.
  assert.equal(buildingHeight(1e9), MAX_FLOORS * (buildingHeight(1e9) / MAX_FLOORS));
  assert.ok(large <= MAX_FLOORS * 3.4 + 1e-9);
});

/* --------------------------- windows --------------------------- */

test('windows sit outside the wall, on all four faces', () => {
  const footprint = 12;
  const height = 40;
  const floors = 10;
  const faces = new Set<string>();
  for (let col = 0; col < WINDOW_COLS; col++) {
    const p = windowPlacement(3, col, floors, footprint, height);
    faces.add(`${p.nx},${p.nz}`);
    // Outside the wall, otherwise z-fighting makes it flicker.
    const outward = Math.max(Math.abs(p.x), Math.abs(p.z));
    assert.ok(outward > footprint / 2, `window inside the wall: ${outward}`);
    assert.ok(p.y > 0 && p.y < height, `window outside the building: ${p.y}`);
  }
  assert.equal(faces.size, 4, 'columns must wrap around the building');
});

test('a window fits inside its floor and its column', () => {
  const footprint = 12;
  const floors = 10;
  const height = 40;
  const { w, h } = windowSize(footprint, floors, height);
  const columnStep = (footprint * 0.78) / 4;
  assert.ok(w < columnStep, 'two adjacent windows would touch');
  assert.ok(h < height / floors, 'the window would spill onto the floor above');
  assert.ok(w > 0 && h > 0);
});

test('every window slot maps to its own floor and column', () => {
  const floors = 7;
  const seen = new Set<string>();
  for (let slot = 0; slot < windowCapacity(floors); slot++) {
    const { floor, col } = windowCell(slot, floors);
    assert.ok(floor >= 0 && floor < floors, `slot ${slot} on floor ${floor}`);
    assert.ok(col >= 0 && col < WINDOW_COLS, `slot ${slot} in column ${col}`);
    seen.add(`${floor}:${col}`);
  }
  assert.equal(seen.size, floors * WINDOW_COLS, 'two slots share a window');
});

test('a slot beyond a shrunken building folds back onto its floors', () => {
  // The slot was assigned when the building was taller: it must land on a
  // real floor, not float above the roof.
  const { floor } = windowCell(windowCapacity(20) - 1, 4);
  assert.ok(floor < 4, `floor ${floor} of a 4-floor building`);
});

/* ------------------------- the north plaza ------------------------- */

test('no lot of the spiral ends up on the north plaza', () => {
  // The bug this test blocks: the HQ had been placed at z=-320, assuming the
  // spiral would never reach that far. It did, at slot 75, and a project
  // building would have popped up inside headquarters. The HQ is gone from
  // this view, but the plaza is what the lot order was computed around.
  const hq = { x: 0, z: HQ_Z };
  const guard = HQ_PLAZA_RADIUS + LOT_SIZE / 2;
  for (let slot = 0; slot < 1024; slot++) {
    const p = placeSlot(slot);
    const inside = Math.abs(p.x - hq.x) < guard && Math.abs(p.z - hq.z) < guard;
    assert.equal(inside, false, `slot ${slot} lands on the HQ, at ${p.x},${p.z}`);
  }
});

test('the city grows away from the HQ', () => {
  // Not aesthetics: the HQ sits at -200, and without this preference the city
  // would run into it by about sixty projects in. The bug this test already
  // caught once was the SIGN of the penalty, which made the city grow
  // straight towards headquarters.
  let toward = 0;
  let away = 0;
  for (let slot = 0; slot < 60; slot++) {
    const z = placeSlot(slot).z;
    if (z === 0) continue;
    if (Math.sign(z) === Math.sign(HQ_Z)) toward++;
    else away++;
  }
  assert.ok(away > toward * 3, `${toward} lots towards the HQ against ${away} the other way`);
});

test('with sixty projects the city does not reach the HQ yet', () => {
  // Counted in rows, not in units: with the streets gone the plaza is three
  // rows of lots away, not two hundred units, and what has to stay true is
  // that sixty projects fit without a tower in the rows the plaza stands in.
  const plazaSouthRow = HQ_CELL.gz + 1;
  for (let slot = 0; slot < 60; slot++) {
    const { gz } = slotToCell(slot);
    assert.ok(gz > plazaSouthRow, `slot ${slot} stands in row ${gz}, beside the HQ plaza`);
  }
});

test('slot zero stays the exact centre, whatever happens to the rest', () => {
  assert.deepEqual(placeSlot(0), { slot: 0, x: 0, z: 0 });
});

test('the spiral still gives every slot its own lot, even skipping the HQ', () => {
  const seen = new Set<string>();
  for (let slot = 0; slot < 400; slot++) {
    const p = placeSlot(slot);
    const key = `${p.x},${p.z}`;
    assert.equal(seen.has(key), false, `slot ${slot} overlaps at ${key}`);
    seen.add(key);
  }
});

test('the HQ sits north, outside the built area', () => {
  // The comparison is against the NORTHERNMOST point, not against
  // cityRadius: the radius also picks up the extent to the south, which
  // under oriented growth is the larger one, and the test would pass or
  // fail for the wrong reason.
  assert.ok(HQ_Z < 0, 'the HQ must sit on the -Z axis');
  let tip = 0;
  for (let slot = 0; slot < 15; slot++) tip = Math.min(tip, placeSlot(slot).z);
  assert.ok(Math.abs(HQ_Z) > Math.abs(tip) + HQ_PLAZA_RADIUS, 'the HQ touches the current city');
});
