/**
 * Deterministic layout of the colony. Pure functions, no state.
 *
 * The requirement is the same geography across restarts: the mental map you
 * build ("project X is the zone just east of the ship") must stay valid.
 *
 * A zone's position depends ONLY on its slot, which the server assigns once
 * and then freezes (`~/.towerglow/layout.json`). Nothing that changes over
 * time -- recency, activity, file count -- enters that computation, so
 * nothing that changes over time can move a zone. A zone is ONE hex, always:
 * the file count decides how many decks are stacked on it, never how much
 * ground it takes, so a project that grows gets taller in place.
 *
 * Two readers: the client, for everything it draws, and the server, which
 * files touched files by floor and column (`floorOfDir`, `windowColumn`) for
 * the `file.touch` events.
 *
 * Units are Bot Crossing's: one deck is a hex 7.6 from centre to corner and
 * an astronaut stands about 1.1 tall. Every ported constant is tuned in them.
 * The lattice the decks are placed on is tighter than the decks themselves
 * (`CELL_SIZE`), so a deck is a question for the deck (`onTile`), never for
 * the cell it is filed under.
 */

import { fnv1a32 } from './hash.ts';

/* ───────────────────────── the hex lattice ───────────────────────── */

/** A deck's hex, centre to corner: Bot Crossing's tile, and what every spot, lamp and ramp on it is measured in. */
export const HEX_SIZE = 7.6;
/**
 * The lattice, centre to corner: the size cells tile exactly at, which is not
 * a deck's.
 *
 * At 7.6 decks and cells were the same hex, and on the index-3 sub-lattice
 * that left a whole bare hex between two neighbours: seen from the camera, a
 * colony of islands a hex apart. The lattice is pulled in and the decks are
 * not, so a deck overhangs its cell and the walkway between two facing
 * corners is 3.2 instead of 7.7.
 *
 * 6.1 is as tight as the walkway allows: at 6.03 two facing corners are
 * `RAMP_WIDTH` apart, and past that two astronauts no longer pass. It was
 * 6.4 first, held there by the tallest ramp; the ramp got steeper
 * (`RAMP_GRADE`) so the lattice could come in. At seven decks it now comes
 * down 1.2 from the next deck over, and the one that points straight at the
 * ship (slot 51, two cells away) stops 0.4 short of a mast pad.
 */
export const CELL_SIZE = 6.1;
/** Radius of a deck prism: pulled in a hair so neighbouring decks never z-fight. */
export const TILE = HEX_SIZE * 0.992;
/**
 * The top face of a ground-level deck, and the thickness of every deck
 * stacked on it. Measured in Bot Crossing: inside the colony the terrain runs
 * from about -0.3 to +0.24 on the Moon, and a lower deck had the ground
 * coming through it. What stands on a zone stands on `deckTop(levels)`.
 */
export const DECK_TOP = 0.45;

/** Axial coordinates of a flat-top hex cell. */
export interface Cell {
  q: number;
  r: number;
}

/** The six neighbours of a cell, counter-clockwise from +q. */
export const HEX_DIRS: readonly (readonly [number, number])[] = [
  [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1],
];

/** Flat-top axial hex to world. Linear, so it also converts offsets. */
export function hexToWorld(q: number, r: number, size = CELL_SIZE): { x: number; z: number } {
  return { x: size * 1.5 * q, z: size * Math.sqrt(3) * (r + q / 2) };
}

/**
 * The inverse: which cell a world point falls in. Exact containment rather
 * than nearest centre: the cell is the key every lookup files a zone and its
 * ramp under, and a point filed under the wrong one finds nobody there.
 */
export function worldToHex(x: number, z: number, size = CELL_SIZE): Cell {
  const q = x / (size * 1.5);
  const r = z / (size * Math.sqrt(3)) - q / 2;
  return cubeRound(q, r);
}

/** Round fractional axial coordinates to the cell that actually contains the point. */
function cubeRound(q: number, r: number): Cell {
  const y = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const ry = Math.round(y);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const dy = Math.abs(ry - y);
  // Whichever axis drifted furthest is the one recomputed from the other two.
  if (dq > dr && dq > dy) rq = -rr - ry;
  else if (dr > dy) rr = -rq - ry;
  // `Math.round(-0.3)` is -0, and so is `-rr - ry` when both are 0: adding
  // +0 folds it back, so a cell key never reads "0,-0".
  return { q: rq + 0, r: rr + 0 };
}

/** Hex distance in axial coordinates: the cube distance, halved. */
export function hexDistance(a: Cell, b: Cell): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

/** The cells at exactly `radius` from the origin, walked around once. */
export function hexRing(radius: number): Cell[] {
  if (radius <= 0) return [{ q: 0, r: 0 }];
  const out: Cell[] = [];
  const [sq, sr] = HEX_DIRS[4]!;
  let q = sq * radius;
  let r = sr * radius;
  for (let i = 0; i < 6; i++) {
    const [dq, dr] = HEX_DIRS[i]!;
    for (let j = 0; j < radius; j++) {
      out.push({ q, r });
      q += dq;
      r += dr;
    }
  }
  return out;
}

/** Corner `i` of a flat-top hex, at 60 degrees times `i`. */
export function hexCorner(i: number, radius = TILE): { x: number; z: number } {
  const a = (Math.PI / 3) * i;
  return { x: radius * Math.cos(a), z: radius * Math.sin(a) };
}

export function cellKey(c: Cell): string {
  return `${c.q},${c.r}`;
}

/**
 * Whether a point, relative to a deck's centre, is on that deck: `margin` in
 * from its rim, on all three pairs of edges.
 *
 * The cell cannot say: a deck is wider than its cell (`CELL_SIZE`), and its
 * rim reaches into the six around it. Filed by cell, a boot on that strip was
 * on bare ground and sank into the plate it was standing on.
 */
export function onTile(x: number, z: number, margin = 0): boolean {
  const apothem = TILE * Math.cos(Math.PI / 6) - margin;
  for (let edge = 0; edge < 3; edge++) {
    const a = (Math.PI / 3) * edge + Math.PI / 6;
    if (Math.abs(x * Math.cos(a) + z * Math.sin(a)) > apothem) return false;
  }
  return true;
}

/* ───────────────────────── the ship ─────────────────────────
 *
 * Its measures sit here, among the lattice's, and not lower down: the zone
 * spiral must know them to keep clear, and a constant declared at the bottom
 * of the file would still be in TDZ when the roots are built.
 */

/**
 * The lattice cell the ship lands on. Nothing else may be placed there.
 *
 * Two cells north of the centre: the deep hole between three zone roots,
 * `(0,0)`, `(2,-4)` and `(-2,-2)`, all 21 units away. It was four cells out,
 * and the ship read as a landmark somewhere off the colony rather than as the
 * place its crew walks out of. One bare cell stays between the ramp and the
 * first zone, which is as close as it gets without the ramp landing on a deck.
 */
export const SHIP_CELL: Cell = { q: 0, r: -2 };

/**
 * Where the ship stands, on the -Z axis. A CONSTANT, for the same reason the
 * zones are: if it depended on the number of projects, the ship would move
 * with every new zone and the mental map would break -- exactly what this
 * file forbids to the colony.
 */
export const HQ_Z = hexToWorld(SHIP_CELL.q, SHIP_CELL.r).z;

/** The plaza: the ship's cell plus every cell this close to it. No zone may stand there. */
export const HQ_PLAZA_CELLS = 1;
/**
 * World radius that encloses the plaza flower; what the camera frames.
 *
 * A neighbouring cell's centre sits sqrt(3) cell sizes away and the cell
 * itself reaches one more: a disc of this radius contains every cell of the
 * flower whole, corners included.
 */
export const HQ_PLAZA_RADIUS = CELL_SIZE * (Math.sqrt(3) + 1);
/**
 * Radius of the ship's apron: no ramp comes down closer than this.
 *
 * It was the ring the CEO masts stood on. The masts are gone -- a worker is
 * an astronaut on its project's lot now -- but the ring stays as clearance:
 * the lattice was tightened around it, and the geography does not move.
 */
export const HQ_RADIUS = 6.5;
/** Top of the ship's beacon: what `frameSpot` has to keep in the frame. */
export const HQ_HEIGHT = 7.2;

export interface Placement {
  slot: number;
  x: number;
  z: number;
}

/**
 * How much more a zone towards the ship costs.
 *
 * The colony grows AWAY from the ship: without this penalty the spiral would
 * wrap the plaza within a couple of dozen projects. At 1.5 a northern root
 * "costs" like one two and a half times as far south, so everything else
 * fills first. Not a barrier: past a hundred projects the colony reaches
 * north anyway and surrounds the ship. It never lands ON the plaza -- that is
 * what `hqExcludes` guarantees -- but the promontory stops being isolated,
 * and rightly so: by then it is the colony that has grown around it.
 */
const NORTH_PENALTY = 1.5;

/**
 * The lattice size the order of the roots is worked out at: the one it was
 * frozen at, when decks tiled the lattice. Not `CELL_SIZE`.
 *
 * Roots at the same distance are told apart by q and r, but only when their
 * costs come out equal, and in floating point that depends on the scale: seen
 * when the lattice was pulled in to 6.4, slots 1, 2 and 3 swapped cells, and
 * projects that had always stood side by side were a hex apart. No rounding
 * of the cost gives the old order back either -- slot 14 is decided by the
 * last bit -- so the order stays where it was computed.
 */
const ORDER_SIZE = 7.6;

/**
 * Would a zone rooted here stand on the plaza?
 *
 * A zone is its root cell and nothing else, so the test is on the root alone.
 * With the ship on `(0,-2)` this takes out the three roots around it, which
 * is what leaves the ship a clearing of its own.
 */
function hqExcludes(root: Cell): boolean {
  return hexDistance(root, SHIP_CELL) <= HQ_PLAZA_CELLS;
}

/**
 * The zone roots, in assignment order.
 *
 * Roots live on the index-3 sub-lattice `a*(1,1) + b*(2,-1)`: any two are at
 * least two cells apart, so no two decks ever touch. A deck overhangs its
 * cell (`CELL_SIZE`), so the six cells around it are not all bare ground;
 * what is left between two decks is the walkway, and it has to stay: one hex
 * per project with nothing between them would read as one carpet, not as a
 * colony of places.
 *
 * Slot 0 is the centre and the rest widen from there: assigned by recency,
 * the most recent project stays in the middle and the oldest end up on the
 * outskirts. The distance grows like the square root of the count, so the
 * colony stays compact. Two things bend it away from a perfect disc, both
 * about the ship: flowers on its plaza do not exist (`hqExcludes`), and those
 * on its side cost more (`NORTH_PENALTY`).
 *
 * Sorted ONCE, at construction: a filter applied later would move a zone
 * already placed, which is the thing this file promises never to do.
 */
function buildZoneRoots(count: number): Cell[] {
  const out: { cell: Cell; cost: number }[] = [];
  // 61x61 lattice points. A parallelogram, so what matters is the disc it
  // contains: about 500 units, against the 400 that the 1024 cheapest roots
  // reach once the penalty has pushed them south.
  const reach = 30;
  for (let a = -reach; a <= reach; a++) {
    for (let b = -reach; b <= reach; b++) {
      const cell = { q: a + 2 * b, r: a - b };
      if (hqExcludes(cell)) continue;
      const { x, z } = hexToWorld(cell.q, cell.r, ORDER_SIZE);
      // On the ship's side? `HQ_Z` is negative, so `sign(HQ_Z) * z` is
      // positive only for the roots heading towards it.
      const toward = Math.max(0, Math.sign(HQ_Z) * z);
      out.push({ cell, cost: Math.hypot(x, z) + NORTH_PENALTY * toward });
    }
  }
  // q and r in the comparison are not a nicety: without them two roots of
  // equal cost would swap places between one Node version and the next.
  out.sort((p, q) => p.cost - q.cost || p.cell.q - q.cell.q || p.cell.r - q.cell.r);
  return out.slice(0, count).map((o) => o.cell);
}

const ROOTS = buildZoneRoots(1024);

/** Distance between two neighbouring zone roots: two cells, across a shared bare pair. */
export const ZONE_PITCH = Math.hypot(hexToWorld(1, 1).x, hexToWorld(1, 1).z);

export function slotToCell(slot: number): Cell {
  // A missing or non-numeric slot would produce NaN, and a zone at NaN
  // vanishes without a single error message: better the centre than nothing.
  if (!Number.isFinite(slot) || slot < 0) return ROOTS[0]!;
  return ROOTS[Math.min(Math.trunc(slot), ROOTS.length - 1)]!;
}

export function placeSlot(slot: number): Placement {
  const cell = slotToCell(slot);
  const { x, z } = hexToWorld(cell.q, cell.r);
  return { slot, x, z };
}

/** Radius of the occupied part: what the camera has to frame. */
export function colonyRadius(count: number): number {
  let max = 0;
  for (let slot = 0; slot < Math.max(1, count); slot++) {
    const p = placeSlot(slot);
    max = Math.max(max, Math.abs(p.x), Math.abs(p.z));
  }
  return max;
}

/* ───────────────────────── levels of a zone ───────────────────────── */

/** The tallest stack a project gets. */
export const MAX_LEVELS = 7;

/**
 * How many decks a project stacks, from its file count.
 *
 * Logarithmic, like the old floor count, and for the same reason: the
 * difference between 20 and 40 files must show, but 20,000 cannot be a
 * thousand times taller. Divided by 2.3 so real projects spread over the
 * whole range: 0-3 files is one deck, 4-23 two, 24-118 three, 119-587 four,
 * 588-2895 five, up to 14262 six, beyond that seven. The same thresholds the
 * tiles of a spread-out zone had, so a project keeps its size when it goes up
 * instead of out.
 */
export function levelsForSize(fileCount: number): number {
  if (!Number.isFinite(fileCount) || fileCount <= 0) return 1;
  const levels = 1 + Math.floor(Math.log2(1 + fileCount) / 2.3);
  return clampLevels(levels);
}

/** Any level count, made drawable: a NaN stack is one deck, never none and never NaN tall. */
function clampLevels(levels: number): number {
  return Number.isFinite(levels) ? Math.max(1, Math.min(MAX_LEVELS, Math.trunc(levels))) : 1;
}

/**
 * The top face of a stack of `levels` decks: where everything on the zone stands.
 *
 * Every deck is exactly as thick as the one on the ground, so a stack reads as
 * the same plate laid down again rather than as a taller plinth, and a
 * project's size can be counted in plates.
 */
export function deckTop(levels: number): number {
  return DECK_TOP * clampLevels(levels);
}

/* ───────────────────────── the ramp ───────────────────────── */

/**
 * The edge of every zone its ramp comes down from, as an index into `HEX_DIRS`.
 *
 * The same edge on every zone, and not the one facing the ship: a fixed
 * direction is a translation, so no two ramps can ever come down into the
 * same bare cell, and the cell a ramp lands in is never a zone root (roots
 * sit on the index-3 sub-lattice, and one step is never a sub-lattice step).
 * Edge 0 points at +x+z, which is where the camera rests (`iso(0)`): the ramp,
 * and whoever is climbing it, faces the viewer instead of hiding behind a
 * stack seven decks tall.
 */
export const RAMP_EDGE = 0;
/** Kerb to kerb. Two astronauts pass on it: `SEPARATION` in the crew is 1.15. */
export const RAMP_WIDTH = 3;
/**
 * Rise over run, about 24 degrees. A seven-deck stack gets a ramp 7.2 long,
 * which is what decides how tight the lattice can be (`CELL_SIZE`).
 *
 * It was 0.38, 21 degrees and 8.3 long: at a 6.1 lattice that ramp came 0.6
 * from the next deck and covered a mast pad by the ship. 0.42 still fits, by
 * five centimetres at the pad; 0.44 leaves room for rounding.
 */
export const RAMP_GRADE = 0.44;
/**
 * The shortest ramp. A one-deck zone at the grade would get a wedge barely
 * longer than an astronaut, which reads as a doorstep rather than as the way
 * up; the low stacks take a gentler ramp instead.
 */
export const RAMP_MIN_RUN = 2;
/** The cell a zone's ramp comes down into: one step off `RAMP_EDGE`. */
export function rampCell(cell: Cell): Cell {
  const [dq, dr] = HEX_DIRS[RAMP_EDGE]!;
  return { q: cell.q + dq, r: cell.r + dr };
}

/** Unit vector out through the ramp edge, zone-local. The edge's normal, not a corner. */
export function rampAxis(): { x: number; z: number } {
  const a = (Math.PI / 3) * RAMP_EDGE + Math.PI / 6;
  return { x: Math.cos(a), z: Math.sin(a) };
}

/** Where the ramp leaves the deck: the middle of the ramp edge, on the rim of the tile. */
export function rampHead(): { x: number; z: number } {
  const axis = rampAxis();
  const apothem = TILE * Math.cos(Math.PI / 6);
  return { x: axis.x * apothem, z: axis.z * apothem };
}

/** How far out from the rim the ramp reaches the ground (y = 0), for a stack of `levels`. */
export function rampRun(levels: number): number {
  return Math.max(RAMP_MIN_RUN, deckTop(levels) / RAMP_GRADE);
}

/**
 * The ramp's walking surface at a zone-local point, or null off the ramp.
 *
 * Measured along the axis from the rim (`along`) and across it (`across`):
 * the deck top at the rim, falling straight to zero at `rampRun`, and past
 * that below zero, where the slab carries on under the terrain. Negative is
 * a height like any other -- the caller takes the higher of this and the
 * ground, which is what makes the foot meet a planet that rolls.
 */
export function rampSurface(levels: number, x: number, z: number): number | null {
  const head = rampHead();
  const axis = rampAxis();
  const dx = x - head.x;
  const dz = z - head.z;
  const along = dx * axis.x + dz * axis.z;
  const across = dz * axis.x - dx * axis.z;
  if (along < 0 || Math.abs(across) > RAMP_WIDTH / 2) return null;
  const top = deckTop(levels);
  return top - along * (top / rampRun(levels));
}

/** Building spots on a zone: one in the middle and one in front of every edge but the ramp's. */
export const ZONE_SPOTS = 6;

/**
 * Where building spot `index` stands, relative to the zone's centre.
 *
 * Spot 0 is the centre, the habitat's. The others sit on a ring well inside
 * the tile, clear of the kerb band where the lamps stand, each in front of an
 * edge -- every edge but the ramp's. A structure there would stand across the
 * top of the ramp, the one way onto the deck, and a session on it would wall
 * its own project off. Fixed, never random: a session keeps its spot as its
 * siblings come and go. Past the last spot they wrap, which is Bot Crossing's
 * rule for a deck that ran out.
 */
export function zoneSlot(index: number): { x: number; z: number } {
  const i = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
  const within = i % ZONE_SPOTS;
  if (within === 0) return { x: 0, z: 0 };
  const a = (Math.PI / 3) * (RAMP_EDGE + within) + Math.PI / 6;
  const ring = TILE * 0.58;
  return { x: ring * Math.cos(a), z: ring * Math.sin(a) };
}

/* ───────────────────────── lamps ───────────────────────── */

/** Lamp seats on a zone: one at each corner and one on every edge of its top deck but the ramp's. */
export const LAMP_SEATS = 11;

/**
 * Where lamp seat `seat` stands, relative to the zone's centre.
 *
 * Corners at 0.72 of the tile and edge midpoints at 0.85: the kerb band, just
 * inside the apothem (0.866), where Bot Crossing plants its posts. Both rings
 * stay clear of the building spots at 0.58. The ramp's edge has no seat: its
 * midpoint is the top of the ramp, and a post there stands in the doorway.
 * A seat past the last folds back, like a building spot does.
 */
export function lampSpot(seat: number): { x: number; z: number } {
  const s = Number.isFinite(seat) ? Math.max(0, Math.trunc(seat)) : 0;
  const k = s % LAMP_SEATS;
  const corner = k < 6;
  const a = corner ? (Math.PI / 3) * k : (Math.PI / 3) * (RAMP_EDGE + k - 5) + Math.PI / 6;
  const ring = corner ? TILE * 0.72 : TILE * 0.85;
  return { x: ring * Math.cos(a), z: ring * Math.sin(a) };
}

/* ───────────────────── the ship: position ───────────────────── */

export function hqPlacement(): { x: number; z: number } {
  return { x: 0, z: HQ_Z };
}

/* ────────────── floors and columns: the server's filing ──────────────
 *
 * The world model still assigns every touched file a floor and a column
 * (`world.ts`), and the `file.touch` events carry them. Nothing in the colony
 * draws them any more, but the contract is the server's and it stays. */

export const MIN_FLOORS = 4;
export const MAX_FLOORS = 34;

/**
 * Floors based on the project's size, counted in files.
 *
 * Logarithmic scale: between a 20-file project and a 40-file one the
 * difference must show, but a 20,000-file one cannot be a thousand times
 * taller or it would not fit on screen. The cap keeps the skyline readable.
 */
export function floorsForSize(fileCount: number): number {
  if (!Number.isFinite(fileCount) || fileCount <= 0) return MIN_FLOORS;
  // The subtracted base spreads them apart: without it, a 50-file project and
  // a 300-file one ended up at 17 and 26 floors, and the skyline all looked
  // the same.
  const floors = Math.round((Math.log2(1 + fileCount) - 2.5) * 3.6);
  return Math.max(MIN_FLOORS, Math.min(MAX_FLOORS, floors));
}

/** Window columns per facade. Four facades: 16 places per floor. */
export const WINDOW_COLS_PER_FACE = 4;
export const WINDOW_COLS = WINDOW_COLS_PER_FACE * 4;

/**
 * A file's floor, from its top-level directory.
 *
 * A hash and not an index into a sorted list: a new directory that slots in
 * earlier in alphabetical order would shift all the others, and windows
 * already lit would jump floors. Two directories can end up on the same
 * floor -- that is the price of stability, and it barely shows.
 */
export function floorOfDir(dir: string, floors: number): number {
  if (floors <= 0) return 0;
  return fnv1a32(dir) % floors;
}

/**
 * A file's column on its floor, with linear probing over the free places.
 * Assigning in order of arrival does NOT move whoever is already there: the
 * same rule as the lots in the city.
 */
export function windowColumn(relPath: string, taken: ReadonlySet<number>): number {
  const start = fnv1a32(relPath) % WINDOW_COLS;
  for (let k = 0; k < WINDOW_COLS; k++) {
    const col = (start + k) % WINDOW_COLS;
    if (!taken.has(col)) return col;
  }
  return start; // floor full: the overlap is accepted
}
