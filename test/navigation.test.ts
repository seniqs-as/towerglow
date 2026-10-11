import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Navigation, NAV_CELL } from '../src/client/agents/navigation.ts';
import type { Obstacle } from '../src/client/agents/navigation.ts';
import { mulberry32 } from '../src/shared/hash.ts';

/**
 * The two promises of the navigation grid: a route goes AROUND a building, and a step
 * never goes THROUGH one. Both are checked against the bitmap itself, cell by cell, not
 * against the pathfinder's own idea of what it did.
 */

/** A handful of buildings, inflated the way the colony does it, inside a 40 m square. */
function someObstacles(rand: () => number, count: number): Obstacle[] {
  const out: Obstacle[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: (rand() - 0.5) * 80, z: (rand() - 0.5) * 80, r: 2 + rand() * 5 });
  }
  return out;
}

/** A free point inside the obstacle field, by rejection. */
function freePoint(nav: Navigation, rand: () => number): { x: number; z: number } {
  for (;;) {
    const x = (rand() - 0.5) * 90;
    const z = (rand() - 0.5) * 90;
    if (!nav.isBlocked(x, z)) return { x, z };
  }
}

/** Walk a segment at a fifth of a cell and report the first blocked cell, if any. */
function firstBlockedAlong(nav: Navigation, x0: number, z0: number, x1: number, z1: number): { x: number; z: number } | null {
  const dist = Math.hypot(x1 - x0, z1 - z0);
  const steps = Math.max(1, Math.ceil(dist / (NAV_CELL / 5)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const z = z0 + (z1 - z0) * t;
    if (nav.isBlocked(x, z)) return { x, z };
  }
  return null;
}

test('a path never crosses a blocked cell', () => {
  const rand = mulberry32(7);
  const nav = new Navigation();
  nav.rebuild(someObstacles(rand, 24));

  let found = 0;
  for (let n = 0; n < 60; n++) {
    const a = freePoint(nav, rand);
    const b = freePoint(nav, rand);
    const path = nav.findPath(a.x, a.z, b.x, b.z);
    assert.ok(path, `no route from (${a.x.toFixed(1)}, ${a.z.toFixed(1)}) to (${b.x.toFixed(1)}, ${b.z.toFixed(1)})`);
    found++;

    // The path excludes the start and ends exactly on the goal.
    const last = path[path.length - 1];
    assert.ok(last);
    assert.equal(last.x, b.x);
    assert.equal(last.z, b.z);

    let from = a;
    for (const p of path) {
      const hit = firstBlockedAlong(nav, from.x, from.z, p.x, p.z);
      assert.equal(hit, null, `leg (${from.x.toFixed(2)}, ${from.z.toFixed(2)}) -> (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) crosses a wall at (${hit?.x.toFixed(2)}, ${hit?.z.toFixed(2)})`);
      from = p;
    }
  }
  assert.equal(found, 60);
});

test('a path threads the gap between two buildings rather than going through either', () => {
  const nav = new Navigation();
  // Two circles with a corridor of two cells between them, and the route has to cross it.
  nav.rebuild([
    { x: -3.5, z: 0, r: 3 },
    { x: 3.5, z: 0, r: 3 },
  ]);
  const path = nav.findPath(0, -8, 0, 8);
  assert.ok(path);
  let from = { x: 0, z: -8 };
  for (const p of path) {
    assert.equal(firstBlockedAlong(nav, from.x, from.z, p.x, p.z), null);
    from = p;
  }
});

test('slide refuses a step into a wall and lets the agent slide along it', () => {
  const nav = new Navigation();
  // A wall to the east of the agent: a big circle whose western edge is at x = 5.
  nav.rebuild([{ x: 25, z: 0, r: 20 }]);
  const pos = { x: 4.6, z: 0 };
  assert.equal(nav.isBlocked(pos.x, pos.z), false);

  // Head-on: refused, and the agent does not move.
  assert.equal(nav.slide(pos, 1, 0), false);
  assert.deepEqual(pos, { x: 4.6, z: 0 });

  // Diagonally into the wall: the east component is dropped, the north one goes through.
  assert.equal(nav.slide(pos, 1, 0.5), true);
  assert.equal(pos.x, 4.6);
  assert.equal(pos.z, 0.5);
  assert.equal(nav.isBlocked(pos.x, pos.z), false);

  // Away from the wall: free.
  assert.equal(nav.slide(pos, -1, 0), true);
  assert.ok(Math.abs(pos.x - 3.6) < 1e-9);
});

test('slide walks an agent that a building landed on back out of it', () => {
  const nav = new Navigation();
  const pos = { x: 0, z: 0 };
  nav.rebuild([{ x: 0, z: 0, r: 2 }]);
  assert.equal(nav.isBlocked(pos.x, pos.z), true);
  // Not a legal move, but each call carries the agent towards the nearest free cell.
  let steps = 0;
  while (nav.isBlocked(pos.x, pos.z) && steps < 200) {
    assert.equal(nav.slide(pos, 0.1, 0), false);
    steps++;
  }
  assert.ok(steps > 0 && steps < 200, `took ${steps} steps`);
  assert.equal(nav.isBlocked(pos.x, pos.z), false);
});

test('nearestFree returns the closest walkable cell', () => {
  const rand = mulberry32(11);
  const nav = new Navigation();
  nav.rebuild(someObstacles(rand, 12));

  // Brute force over a generous window around the point: the true nearest, by distance
  // between cell indices, which is what the ring search measures.
  const oracle = (x: number, z: number): number => {
    const cx = nav.toCell(x);
    const cz = nav.toCell(z);
    let best = Infinity;
    for (let iz = cz - 30; iz <= cz + 30; iz++) {
      for (let ix = cx - 30; ix <= cx + 30; ix++) {
        if (!nav.inBounds(ix, iz) || nav.blocked[iz * nav.size + ix] === 1) continue;
        const d = (ix - cx) ** 2 + (iz - cz) ** 2;
        if (d < best) best = d;
      }
    }
    return best;
  };

  let insideChecked = 0;
  for (const o of nav.rebuild.length ? someObstacles(mulberry32(11), 12) : []) {
    // A grid of probes over each obstacle, so points deep inside are covered too.
    for (let k = 0; k < 25; k++) {
      const x = o.x + (((k % 5) - 2) / 2) * o.r;
      const z = o.z + ((Math.floor(k / 5) - 2) / 2) * o.r;
      const cell = nav.nearestFree(x, z);
      assert.ok(cell, `no free cell near (${x}, ${z})`);
      assert.equal(nav.blocked[cell.iz * nav.size + cell.ix], 0);
      const d = (cell.ix - nav.toCell(x)) ** 2 + (cell.iz - nav.toCell(z)) ** 2;
      assert.equal(d, oracle(x, z), `nearestFree(${x.toFixed(2)}, ${z.toFixed(2)}) picked a cell at ${d}, nearest is ${oracle(x, z)}`);
      if (nav.isBlocked(x, z)) insideChecked++;
    }
  }
  assert.ok(insideChecked > 50, `only ${insideChecked} probes were inside an obstacle`);

  // A free point is its own nearest cell.
  const free = freePoint(nav, rand);
  assert.deepEqual(nav.nearestFree(free.x, free.z), { ix: nav.toCell(free.x), iz: nav.toCell(free.z) });
});

test('the version bumps on every rebuild, so cached paths can be invalidated', () => {
  const nav = new Navigation();
  assert.equal(nav.version, 0);
  const obstacles: Obstacle[] = [{ x: 0, z: 0, r: 3 }];
  nav.rebuild(obstacles);
  assert.equal(nav.version, 1);
  // The same list again still counts: the caller does not diff, the agents do.
  nav.rebuild(obstacles);
  assert.equal(nav.version, 2);
  nav.rebuild([]);
  assert.equal(nav.version, 3);
  assert.equal(nav.isBlocked(0, 0), false);
});

test('outside the grid counts as blocked, and a goal inside a wall resolves to its edge', () => {
  const nav = new Navigation();
  nav.rebuild([{ x: 10, z: 0, r: 4 }]);
  assert.equal(nav.isBlocked(nav.half + 1, 0), true);
  assert.equal(nav.isBlocked(-nav.half - 1, 0), true);
  const path = nav.findPath(0, 0, 10, 0);
  assert.ok(path);
  const end = path[path.length - 1];
  assert.ok(end);
  assert.equal(nav.isBlocked(end.x, end.z), false);
  assert.ok(Math.hypot(end.x - 10, end.z) <= 4 + NAV_CELL, 'the path ends at the wall, not somewhere else');
});

test('a wall is solid along its whole length, and a route goes round the end of it', () => {
  const nav = new Navigation();
  nav.rebuild([], [{ x0: -10, z0: 0, x1: 10, z1: 0, r: 0.5 }]);
  // Solid from end to end, not only where a circle would have been drawn.
  for (let x = -9.75; x <= 9.75; x += NAV_CELL) assert.equal(nav.isBlocked(x, 0), true, `open at x=${x}`);
  assert.equal(nav.isBlocked(0, 1), false, 'as thick as it was asked, no thicker');
  const path = nav.findPath(0, -5, 0, 5);
  assert.ok(path);
  let from = { x: 0, z: -5 };
  let wide = 0;
  for (const p of path) {
    assert.equal(firstBlockedAlong(nav, from.x, from.z, p.x, p.z), null);
    wide = Math.max(wide, Math.abs(p.x));
    from = p;
  }
  assert.ok(wide > 10, `the route went through the wall rather than round it: widest ${wide}`);
});

test('flood finds what a route can reach: through a door, not through a wall, never past its bound', () => {
  const nav = new Navigation();
  const room = (door: boolean): void => {
    nav.rebuild([], [
      { x0: -5, z0: -5, x1: 5, z1: -5, r: 0.4 },
      { x0: 5, z0: -5, x1: 5, z1: 5, r: 0.4 },
      { x0: -5, z0: 5, x1: -5, z1: -5, r: 0.4 },
      // The south wall, with a door in the middle of it or without.
      ...(door
        ? [{ x0: -5, z0: 5, x1: -1.5, z1: 5, r: 0.4 }, { x0: 1.5, z0: 5, x1: 5, z1: 5, r: 0.4 }]
        : [{ x0: -5, z0: 5, x1: 5, z1: 5, r: 0.4 }]),
    ]);
  };
  const near = (x: number, z: number): boolean => Math.abs(x) < 20 && Math.abs(z) < 20;

  room(false);
  const shut = nav.flood(0, 0, near);
  assert.ok(shut.size > 200, `a room ten metres across is more than ${shut.size} cells`);
  assert.equal(shut.has(nav.indexOf(0, 8)), false, 'a closed room does not reach the yard');

  room(true);
  const open = nav.flood(0, 0, near);
  assert.equal(open.has(nav.indexOf(0, 8)), true, 'the door leads out');
  assert.equal(open.has(nav.indexOf(0, 30)), false, 'and the bound holds');
  // What the flood reaches, a route reaches; what it does not, no route does.
  assert.ok(nav.findPath(0, 0, 0, 8));

  assert.equal(nav.flood(5, 0, near).size, 0, 'from inside a wall there is nowhere to go');
  assert.equal(nav.indexOf(nav.half + 1, 0), -1);
});
