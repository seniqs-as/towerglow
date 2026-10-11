/**
 * Where the astronauts are allowed to walk.
 *
 * Ported from Bot Crossing. The colony is a scattering of convex obstacles on flat ground,
 * which is the case a grid handles well and cheaply: buildings and the ship are rasterised
 * into a blocked bitmap whenever the roster changes, and agents route across it with A*.
 *
 * There are two independent guarantees here, and both matter:
 *
 * 1. **Routing** -- A* finds a way around a building rather than through it, including
 *    threading the gaps between a ring of them. Paths are string-pulled afterwards so an
 *    astronaut walks a straight line where it can rather than a visible staircase.
 * 2. **Collision** -- `slide()` is applied to every step regardless of whether the agent is
 *    following a path. Routing can fail (a site that got walled in between polls, a path
 *    budget that has not caught up yet); walking through a wall must not be what happens
 *    when it does.
 *
 * Search scratch is reused across calls and invalidated by a generation stamp rather than
 * being cleared, so a path costs no allocation and no 360k-element memset.
 *
 * This module never touches the DOM or three.js: it is arithmetic over typed arrays, so it
 * runs unchanged under `node --test`.
 *
 * Memory, measured: at 600x600 cells the bitmap is 0.36 MB and the six A* scratch buffers
 * add 7.56 MB (two Uint8, two Float32, three Int32 arrays of 360k entries), 7.92 MB in all.
 * The source's 224x224 grid was 1.1 MB. All of it is allocated once, here, and never again.
 */

/** Cell size, in metres. Small enough to resolve the gaps between neighbouring buildings. */
export const NAV_CELL = 0.5;
/**
 * Half-width of the navigable square. 56 in the source; this map is bigger (its buildable
 * colony alone has a 160 m radius), so the square has to reach the whole city.
 */
export const NAV_HALF = 150;
/**
 * Give up rather than stall the frame if a search goes pathological. 6000 in the source,
 * sized for its 224x224 grid; this one has 7.2x the cells, and at 6000 a dense field of
 * 200 obstacles routed only 68 of 200 cross-map pairs (200 of 200 at ten times that,
 * 5.3 ms each). A route that gives up sends the astronaut straight at the goal, sliding
 * along every wall on the way, which on a map this size is a long walk to watch.
 */
const MAX_EXPANSIONS = 40000;
/**
 * How close two edge crossings have to be, as a fraction of the segment, to count as one
 * corner. Cell centres are exact multiples of the cell size, so a diagonal between them
 * passes through a corner exactly -- and in floating point that "exactly" comes out an ulp
 * apart, which is enough to step around a corner the rule below is there to catch.
 */
const CORNER_EPS = 1e-9;

const SQRT2 = Math.SQRT2;

/**
 * A circle on the ground an astronaut may not enter, already inflated by the caller for
 * the astronaut's own width.
 */
export interface Obstacle {
  x: number;
  z: number;
  r: number;
}

/**
 * A straight band on the ground an astronaut may not cross: a segment and how far either
 * side of it is solid, already inflated like an `Obstacle`. The rim of a raised deck is
 * one -- a ring of circles along it would leave a gap wherever two of them met thinner
 * than an astronaut, and the gap would be a way up a wall.
 */
export interface Wall {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  r: number;
}

/** A grid cell, by index along each axis. */
export interface Cell {
  ix: number;
  iz: number;
}

/** A corner of a route, in world units. */
export interface Waypoint {
  x: number;
  z: number;
}

/** What `slide` moves: anything with a mutable `x` and `z`. A `THREE.Vector3` qualifies. */
export interface Position {
  x: number;
  z: number;
}

export class Navigation {
  readonly cell = NAV_CELL;
  readonly half = NAV_HALF;
  /** Cells along one side. */
  readonly size: number;
  /** 1 where an astronaut may not stand, row-major by `iz * size + ix`. */
  readonly blocked: Uint8Array;

  readonly #gScore: Float32Array;
  readonly #parent: Int32Array;
  /** Which search last touched this node. */
  readonly #stamp: Int32Array;
  readonly #closed: Uint8Array;

  readonly #heap: Int32Array;
  readonly #heapKey: Float32Array;
  #heapSize = 0;

  #generation = 0;
  /** Bumped on every rebuild; agents use it to notice their path is stale. */
  version = 0;

  constructor() {
    this.size = Math.ceil((NAV_HALF * 2) / NAV_CELL);
    const n = this.size * this.size;

    this.blocked = new Uint8Array(n);
    this.#gScore = new Float32Array(n);
    this.#parent = new Int32Array(n);
    this.#stamp = new Int32Array(n);
    this.#closed = new Uint8Array(n);

    this.#heap = new Int32Array(n);
    this.#heapKey = new Float32Array(n);
  }

  // -- grid <-> world -------------------------------------------------------------------

  toCell(v: number): number {
    return Math.floor((v + this.half) / this.cell);
  }

  toWorld(i: number): number {
    return i * this.cell - this.half + this.cell * 0.5;
  }

  inBounds(ix: number, iz: number): boolean {
    return ix >= 0 && iz >= 0 && ix < this.size && iz < this.size;
  }

  /** True where an astronaut may not stand. Outside the grid counts as blocked. */
  isBlocked(x: number, z: number): boolean {
    const ix = this.toCell(x);
    const iz = this.toCell(z);
    if (!this.inBounds(ix, iz)) return true;
    return this.blocked[iz * this.size + ix] === 1;
  }

  // -- building the map -----------------------------------------------------------------

  /**
   * Rasterise the obstacle list. Each is a circle `{ x, z, r }`, already inflated by the
   * caller for the astronaut's own width -- doing it here would hide the one number that
   * decides whether the gaps between buildings stay walkable. Walls are the same, drawn
   * along a segment instead of round a point.
   */
  rebuild(obstacles: readonly Obstacle[], walls: readonly Wall[] = []): void {
    this.blocked.fill(0);
    const { size } = this;

    for (const o of obstacles) {
      const r = o.r;
      if (!(r > 0)) continue;
      const minX = Math.max(0, this.toCell(o.x - r));
      const maxX = Math.min(size - 1, this.toCell(o.x + r));
      const minZ = Math.max(0, this.toCell(o.z - r));
      const maxZ = Math.min(size - 1, this.toCell(o.z + r));
      // Test against the cell's centre, so a cell is blocked when its middle is inside the
      // obstacle rather than when it merely touches it -- that is what keeps thin corridors.
      const r2 = r * r;
      for (let iz = minZ; iz <= maxZ; iz++) {
        const wz = this.toWorld(iz);
        const dz = wz - o.z;
        const row = iz * size;
        for (let ix = minX; ix <= maxX; ix++) {
          const dx = this.toWorld(ix) - o.x;
          if (dx * dx + dz * dz <= r2) this.blocked[row + ix] = 1;
        }
      }
    }

    for (const w of walls) {
      const r = w.r;
      if (!(r > 0)) continue;
      const minX = Math.max(0, this.toCell(Math.min(w.x0, w.x1) - r));
      const maxX = Math.min(size - 1, this.toCell(Math.max(w.x0, w.x1) + r));
      const minZ = Math.max(0, this.toCell(Math.min(w.z0, w.z1) - r));
      const maxZ = Math.min(size - 1, this.toCell(Math.max(w.z0, w.z1) + r));
      const ex = w.x1 - w.x0;
      const ez = w.z1 - w.z0;
      const len2 = ex * ex + ez * ez;
      const r2 = r * r;
      for (let iz = minZ; iz <= maxZ; iz++) {
        const pz = this.toWorld(iz) - w.z0;
        const row = iz * size;
        for (let ix = minX; ix <= maxX; ix++) {
          const px = this.toWorld(ix) - w.x0;
          // Same cell-centre rule as the circles, against the nearest point of the segment.
          const t = len2 > 0 ? Math.max(0, Math.min(1, (px * ex + pz * ez) / len2)) : 0;
          const dx = px - ex * t;
          const dz = pz - ez * t;
          if (dx * dx + dz * dz <= r2) this.blocked[row + ix] = 1;
        }
      }
    }
    this.version++;
  }

  /**
   * The nearest walkable cell to a point, searched in expanding rings. Used both for a goal
   * that has been built over and for an agent that a new building landed on top of.
   */
  nearestFree(x: number, z: number, maxRings = 24): Cell | null {
    const cx = this.toCell(x);
    const cz = this.toCell(z);
    if (this.inBounds(cx, cz) && this.blocked[cz * this.size + cx] === 0) return { ix: cx, iz: cz };

    let best: Cell | null = null;
    let bestD = Infinity;
    for (let ring = 1; ring <= maxRings; ring++) {
      // Every cell on ring R is at least R away, so once R*R cannot beat what we have the
      // search is over. The source returned the best of the FIRST ring with a free cell,
      // which from ring three on can be farther than a cell one ring out: (3,3) is at 18
      // while (4,0) is at 16. "Nearest" has to mean nearest, or an agent walked out of a
      // building would step further than it needed to.
      if (ring * ring >= bestD) break;
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          // Only the shell of the ring; the inside was covered by earlier iterations.
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const ix = cx + dx;
          const iz = cz + dz;
          if (!this.inBounds(ix, iz)) continue;
          if (this.blocked[iz * this.size + ix] === 1) continue;
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = { ix, iz };
          }
        }
      }
    }
    return best;
  }

  /** The grid index of the cell a world point falls in, or -1 off the grid. */
  indexOf(x: number, z: number): number {
    const ix = this.toCell(x);
    const iz = this.toCell(z);
    return this.inBounds(ix, iz) ? iz * this.size + ix : -1;
  }

  /**
   * Every walkable cell connected to a point without leaving `within`, by grid index: what
   * a route from there can reach. Four-connected, which is exactly A*'s connectivity -- its
   * diagonal step is only legal where both of the steps it stands for are.
   *
   * `within` bounds the fill, and has to: from the top of a ramp the walkable ground goes
   * on down the ramp and across the whole map.
   */
  flood(x: number, z: number, within: (x: number, z: number) => boolean): Set<number> {
    const out = new Set<number>();
    const start = this.indexOf(x, z);
    if (start < 0 || this.blocked[start] === 1) return out;
    const { size, blocked } = this;
    const stack = [start];
    out.add(start);
    while (stack.length) {
      const i = stack.pop()!;
      const cx = i % size;
      const cz = (i - cx) / size;
      for (let k = 0; k < 4; k++) {
        const nx = cx + (NEIGHBOURS[k * 2] ?? 0);
        const nz = cz + (NEIGHBOURS[k * 2 + 1] ?? 0);
        if (!this.inBounds(nx, nz)) continue;
        const n = nz * size + nx;
        if (out.has(n) || blocked[n] === 1) continue;
        if (!within(this.toWorld(nx), this.toWorld(nz))) continue;
        out.add(n);
        stack.push(n);
      }
    }
    return out;
  }

  // -- line of sight --------------------------------------------------------------------

  /**
   * True when the segment touches no blocked cell.
   *
   * A grid traversal (Amanatides & Woo) rather than the source's sampling at half-cell
   * steps: sampled, a smoothed leg could clip the corner of a blocked cell in the gap
   * between two samples, and an astronaut walking that leg would be stopped mid-way by
   * `slide` -- seen on a random field, leg (8.48, 41.75) -> (18.75, 37.25) through the
   * corner of a cell at (15.93, 38.48). Walking the cells the segment actually crosses
   * costs about the same and misses nothing. Passing exactly through a corner counts as
   * touching both cells beside it, the same no-corner-cutting rule A* applies.
   */
  lineOfSight(x0: number, z0: number, x1: number, z1: number): boolean {
    const { size, cell, half, blocked } = this;
    let ix = this.toCell(x0);
    let iz = this.toCell(z0);
    const ex = this.toCell(x1);
    const ez = this.toCell(z1);
    if (!this.inBounds(ix, iz) || !this.inBounds(ex, ez)) return false;
    if (blocked[iz * size + ix] === 1) return false;

    const dx = x1 - x0;
    const dz = z1 - z0;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    // Everything below is in units of the segment's own length (0 at the start, 1 at the
    // end): how far to the next cell edge on each axis, and how far one whole cell is.
    const tDeltaX = stepX === 0 ? Infinity : cell / Math.abs(dx);
    const tDeltaZ = stepZ === 0 ? Infinity : cell / Math.abs(dz);
    const edgeX = ix * cell - half + (stepX > 0 ? cell : 0);
    const edgeZ = iz * cell - half + (stepZ > 0 ? cell : 0);
    let tMaxX = stepX === 0 ? Infinity : (edgeX - x0) / dx;
    let tMaxZ = stepZ === 0 ? Infinity : (edgeZ - z0) / dz;

    // Each step moves one cell towards the end, so this many steps always get there; if a
    // rounding error at a corner ever left it one cell off, the answer is "no" rather than
    // a loop that never ends.
    let guard = Math.abs(ex - ix) + Math.abs(ez - iz);
    while (guard-- > 0 && (ix !== ex || iz !== ez)) {
      if (Math.abs(tMaxX - tMaxZ) <= CORNER_EPS) {
        // Straight through a corner: the two cells either side are touched as well. The
        // corner point itself belongs to one of them by `toCell`'s rounding, so an agent
        // stepping exactly onto it would be "inside" a cell the segment never entered.
        const sideX = ix + stepX;
        const sideZ = iz + stepZ;
        if (this.inBounds(sideX, iz) && blocked[iz * size + sideX] === 1) return false;
        if (this.inBounds(ix, sideZ) && blocked[sideZ * size + ix] === 1) return false;
        ix = sideX;
        iz = sideZ;
        tMaxX += tDeltaX;
        tMaxZ += tDeltaZ;
      } else if (tMaxX < tMaxZ) {
        ix += stepX;
        tMaxX += tDeltaX;
      } else {
        iz += stepZ;
        tMaxZ += tDeltaZ;
      }
      if (!this.inBounds(ix, iz)) return false;
      if (blocked[iz * size + ix] === 1) return false;
    }
    return ix === ex && iz === ez;
  }

  // -- A* -------------------------------------------------------------------------------

  /**
   * A route from one world point to another, as world-space waypoints, or `null` if there
   * is no way through. The returned path excludes the start and ends exactly on the goal.
   */
  findPath(sx: number, sz: number, tx: number, tz: number): Waypoint[] | null {
    const start = this.nearestFree(sx, sz);
    const goal = this.nearestFree(tx, tz);
    if (!start || !goal) return null;

    const size = this.size;
    const startIdx = start.iz * size + start.ix;
    const goalIdx = goal.iz * size + goal.ix;

    // A goal that has been built over -- a stand position a new building landed on, or a
    // point simply inside a wall -- resolves to the nearest walkable spot. Routing to the
    // requested point instead would end every such path with a leg through the obstacle.
    const reachableX = this.isBlocked(tx, tz) ? this.toWorld(goal.ix) : tx;
    const reachableZ = this.isBlocked(tx, tz) ? this.toWorld(goal.iz) : tz;

    // Straight shot: by far the common case in an open colony, and it skips the search.
    if (this.lineOfSight(sx, sz, reachableX, reachableZ)) return [{ x: reachableX, z: reachableZ }];

    const gen = ++this.#generation;
    const gScore = this.#gScore;
    const parent = this.#parent;
    const stamp = this.#stamp;
    const closed = this.#closed;
    const blocked = this.blocked;
    this.#heapSize = 0;

    gScore[startIdx] = 0;
    parent[startIdx] = -1;
    stamp[startIdx] = gen;
    closed[startIdx] = 0;
    this.#push(startIdx, this.#heuristic(start.ix, start.iz, goal.ix, goal.iz));

    let expansions = 0;
    let found = false;

    while (this.#heapSize > 0) {
      const current = this.#pop();
      if (closed[current] === 1) continue;
      closed[current] = 1;
      if (current === goalIdx) {
        found = true;
        break;
      }
      if (++expansions > MAX_EXPANSIONS) break;

      const cx = current % size;
      const cz = (current - cx) / size;
      // Stamped nodes always have a score; the fallback only satisfies the checked read.
      const g = gScore[current] ?? Infinity;

      for (let k = 0; k < 8; k++) {
        const nx = cx + (NEIGHBOURS[k * 2] ?? 0);
        const nz = cz + (NEIGHBOURS[k * 2 + 1] ?? 0);
        if (!this.inBounds(nx, nz)) continue;
        const nIdx = nz * size + nx;
        if (blocked[nIdx] === 1) continue;
        if (stamp[nIdx] === gen && closed[nIdx] === 1) continue;

        // No corner cutting: a diagonal is only legal when both of its orthogonal
        // neighbours are clear, or agents will clip the corners of buildings.
        const diagonal = k >= 4;
        if (diagonal) {
          if (blocked[cz * size + nx] === 1 || blocked[nz * size + cx] === 1) continue;
        }

        const tentative = g + (diagonal ? SQRT2 : 1);
        if (stamp[nIdx] === gen && tentative >= (gScore[nIdx] ?? Infinity)) continue;

        stamp[nIdx] = gen;
        closed[nIdx] = 0;
        gScore[nIdx] = tentative;
        parent[nIdx] = current;
        this.#push(nIdx, tentative + this.#heuristic(nx, nz, goal.ix, goal.iz));
      }
    }

    if (!found) return null;

    // Walk the parents back, then smooth.
    const cells: number[] = [];
    let node = goalIdx;
    while (node !== -1) {
      cells.push(node);
      node = parent[node] ?? -1;
    }
    cells.reverse();
    return this.#smooth(cells, sx, sz, reachableX, reachableZ);
  }

  /** Octile distance -- admissible for 8-connected movement, and never overestimates. */
  #heuristic(ax: number, az: number, bx: number, bz: number): number {
    const dx = Math.abs(ax - bx);
    const dz = Math.abs(az - bz);
    return dx + dz + (SQRT2 - 2) * Math.min(dx, dz);
  }

  /**
   * String-pulling: keep the furthest waypoint still visible from the last kept one. Turns
   * a staircase of grid cells into the handful of corners an astronaut actually needs.
   */
  #smooth(cells: readonly number[], sx: number, sz: number, tx: number, tz: number): Waypoint[] {
    const size = this.size;
    const pts: Waypoint[] = cells.map((idx) => {
      const ix = idx % size;
      const iz = (idx - ix) / size;
      return { x: this.toWorld(ix), z: this.toWorld(iz) };
    });
    // The true endpoints, not their cell centres.
    pts[pts.length - 1] = { x: tx, z: tz };

    const out: Waypoint[] = [];
    let fromX = sx;
    let fromZ = sz;
    let i = 0;
    while (i < pts.length) {
      // Keep the furthest waypoint still visible from here; `i` itself is the floor, and it
      // is always reachable because consecutive cells in an A* result are adjacent.
      let furthest = i;
      for (let j = pts.length - 1; j > i; j--) {
        const q = pts[j];
        if (q && this.lineOfSight(fromX, fromZ, q.x, q.z)) {
          furthest = j;
          break;
        }
      }
      const p = pts[furthest];
      if (!p) break;
      out.push(p);
      fromX = p.x;
      fromZ = p.z;
      if (furthest === pts.length - 1) break;
      i = furthest + 1;
    }
    return out.length ? out : [{ x: tx, z: tz }];
  }

  // -- movement -------------------------------------------------------------------------

  /**
   * Apply a step with collision. Blocked head-on, the move is retried on each axis alone so
   * the agent slides along the obstacle instead of stopping dead against it.
   *
   * This runs on every step whether or not a path is being followed, which is what makes
   * "never walks through a building" a property of the movement rather than a property of
   * the pathfinder having succeeded.
   */
  slide(pos: Position, dx: number, dz: number): boolean {
    // An agent a building was dropped on top of has no legal move at all; walk it out.
    if (this.isBlocked(pos.x, pos.z)) {
      const free = this.nearestFree(pos.x, pos.z);
      if (free) {
        const fx = this.toWorld(free.ix);
        const fz = this.toWorld(free.iz);
        const len = Math.hypot(fx - pos.x, fz - pos.z) || 1;
        const step = Math.min(len, Math.hypot(dx, dz) + 0.04);
        pos.x += ((fx - pos.x) / len) * step;
        pos.z += ((fz - pos.z) / len) * step;
      }
      return false;
    }

    const nx = pos.x + dx;
    const nz = pos.z + dz;
    if (!this.isBlocked(nx, nz)) {
      pos.x = nx;
      pos.z = nz;
      return true;
    }
    if (dx !== 0 && !this.isBlocked(nx, pos.z)) {
      pos.x = nx;
      return true;
    }
    if (dz !== 0 && !this.isBlocked(pos.x, nz)) {
      pos.z = nz;
      return true;
    }
    return false;
  }

  // -- heap -----------------------------------------------------------------------------

  #push(node: number, key: number): void {
    const heap = this.#heap;
    const heapKey = this.#heapKey;
    // Cannot happen -- 8 pushes per expansion against a heap the size of the grid -- but a
    // typed array drops an out-of-range write silently, and a heap whose count disagrees
    // with its contents would pop garbage nodes.
    if (this.#heapSize >= heap.length) return;
    let i = this.#heapSize++;
    heap[i] = node;
    heapKey[i] = key;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((heapKey[p] ?? -Infinity) <= (heapKey[i] ?? Infinity)) break;
      this.#swap(i, p);
      i = p;
    }
  }

  #pop(): number {
    const heap = this.#heap;
    const heapKey = this.#heapKey;
    // Only called on a non-empty heap; the fallback satisfies the checked read.
    const top = heap[0] ?? -1;
    const last = --this.#heapSize;
    heap[0] = heap[last] ?? 0;
    heapKey[0] = heapKey[last] ?? 0;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let small = i;
      if (l < this.#heapSize && (heapKey[l] ?? Infinity) < (heapKey[small] ?? Infinity)) small = l;
      if (r < this.#heapSize && (heapKey[r] ?? Infinity) < (heapKey[small] ?? Infinity)) small = r;
      if (small === i) break;
      this.#swap(i, small);
      i = small;
    }
    return top;
  }

  #swap(a: number, b: number): void {
    const heap = this.#heap;
    const heapKey = this.#heapKey;
    const n = heap[a] ?? 0;
    heap[a] = heap[b] ?? 0;
    heap[b] = n;
    const k = heapKey[a] ?? 0;
    heapKey[a] = heapKey[b] ?? 0;
    heapKey[b] = k;
  }
}

// Orthogonals first, then diagonals -- the loop relies on index >= 4 meaning diagonal.
const NEIGHBOURS = new Int8Array([1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1]);
