/**
 * Deterministic layout of the city view. Pure functions, no state.
 *
 * The city is the lighter of the two ways of drawing the same world: one
 * tower per project on a square grid, shoulder to shoulder, windows lit by
 * the work. It is the project's first drawing, set aside when the colony
 * arrived and brought back as the view the page opens on -- without its streets.
 *
 * It lives here and not in `shared/layout.ts` on purpose. The colony's
 * geography is frozen there, and the server reads it; this one only draws.
 * It keeps the same rule, though: a building's place depends on its `slot`
 * alone, the slot the server assigned once, so switching views never moves
 * a project relative to its neighbours' order, and nothing that changes over
 * time moves a building.
 */
import { floorsForSize, WINDOW_COLS, WINDOW_COLS_PER_FACE } from '../../shared/layout.ts';

export { floorsForSize, WINDOW_COLS, WINDOW_COLS_PER_FACE };

/* ───────────────────────── lots ───────────────────────── */

/** The side of a lot: no building grows past it. */
export const LOT_SIZE = 15;
/**
 * Distance between two lot centres, the same in every direction: the one the
 * city opens on. How far apart the towers stand is yours to say (the
 * `citySpacing` setting, the slider under City), and this is only where the
 * slider starts.
 *
 * There are no streets (the user's call, 2026-09-28): the lots were 52 apart
 * with a 30-unit avenue every two of them, so two neighbours stood 37 to 67
 * units from wall to wall, and a dozen projects were a dozen towers each on
 * its own in the dark. Now one pitch everywhere and no avenue: two towers of
 * the widest kind keep 33 units between them -- inside the narrowest street
 * there was, and the city is even.
 *
 * The gap was looked for on the real page, from the three-quarter view the
 * city opens on. At 3 (a pitch of 18) towers a hundred units tall closed it
 * completely: one block, "totally attached". At 9 (24) the bases came apart
 * but the volumes still read as one mass. At 15 (30) every tower stood on
 * its own, and the user asked for more three times: 21, 27, 33. A number
 * asked for four times is a taste, not a measure, which is why it became a
 * setting.
 */
export const CELL_PITCH = 48;
/** The closest the towers can be set: below it they read as one block. */
export const MIN_PITCH = 24;
/** The farthest: about what an avenue used to put between two blocks (82). */
export const MAX_PITCH = 84;
/**
 * The spacing moves by the floor grid's cell (`GRID_CELL` in `ground.ts`), so
 * at every setting each tower meets the lines under it the same way.
 */
export const PITCH_STEP = 6;

/** A spacing the city can be drawn at: on the grid, inside the range. */
export function clampPitch(pitch: number): number {
  // A stored setting is a number somebody else wrote: NaN would place every
  // tower nowhere, and without a single error.
  if (!Number.isFinite(pitch)) return CELL_PITCH;
  const stepped = Math.round(pitch / PITCH_STEP) * PITCH_STEP;
  return Math.max(MIN_PITCH, Math.min(MAX_PITCH, stepped));
}

export interface Cell {
  gx: number;
  gz: number;
}

export interface Placement {
  slot: number;
  x: number;
  z: number;
}

/* ───────────────────────── the order ───────────────────────── */

/**
 * The street grid the lot order was computed on, and still is.
 *
 * The city used to be DRAWN on it too: lots 52 apart, an avenue every two,
 * and north of them the plaza of the octagonal HQ, which this view stopped
 * drawing on 2026-09-24. The streets went the same way, but the ORDER is
 * still worked out here, in these units. A lot's cost is a distance, the
 * avenues stretched those distances unevenly, and on an even grid the same
 * sort hands the slots out differently: measured, the lot north of the
 * centre drops from slot 6 to slot 13, and the seven projects in between all
 * change neighbours. Same rule as the colony's `ORDER_SIZE`: drawn closer,
 * but who stands next to whom stays. A fingerprint of all 1024 slots in
 * `test/cityLayout.test.ts` defends it.
 *
 * None of these is a size of anything on screen, so none is exported.
 */
const ORDER_PITCH = 52;
const ORDER_BLOCK_CELLS = 2;
const ORDER_STREET_EXTRA = 30;
const ORDER_LOT_SIZE = 15;
const ORDER_HQ_Z = -200;
const ORDER_PLAZA_RADIUS = 62;

/**
 * How much more a lot costs for every unit it lies towards the plaza. The
 * city grows away from it, so the first projects do not crowd its edge.
 */
const NORTH_PENALTY = 1.5;

/** Grid index to the units of the order, with the avenues crossed on the way. */
function orderAxis(g: number): number {
  const streetsCrossed = Math.trunc(g / ORDER_BLOCK_CELLS);
  return g * ORDER_PITCH + streetsCrossed * ORDER_STREET_EXTRA;
}

/** The plaza and a lot's half-width around it: no building there. */
function hqExcludes(gx: number, gz: number): boolean {
  const guard = ORDER_PLAZA_RADIUS + ORDER_LOT_SIZE / 2;
  return Math.abs(orderAxis(gx)) < guard && Math.abs(orderAxis(gz) - ORDER_HQ_Z) < guard;
}

/**
 * Every lot, cheapest first. Computed once: the order is what keeps a slot
 * on the same corner from one load to the next.
 */
function buildLots(count: number): Cell[] {
  const out: { cell: Cell; cost: number }[] = [];
  const reach = 20; // 41x41 cells: more than 1600 remain after the exclusions
  for (let gx = -reach; gx <= reach; gx++) {
    for (let gz = -reach; gz <= reach; gz++) {
      if (hqExcludes(gx, gz)) continue;
      const x = orderAxis(gx);
      const z = orderAxis(gz);
      const toward = Math.max(0, Math.sign(ORDER_HQ_Z) * z);
      out.push({ cell: { gx, gz }, cost: Math.hypot(x, z) + NORTH_PENALTY * toward });
    }
  }
  // Ties broken on the coordinates: a sort that is not total would let the
  // engine decide, and the engine is not part of the frozen order.
  out.sort((a, b) => a.cost - b.cost || a.cell.gx - b.cell.gx || a.cell.gz - b.cell.gz);
  return out.slice(0, count).map((o) => o.cell);
}

const LOTS = buildLots(1024);

export function slotToCell(slot: number): Cell {
  // A NaN slot would not draw a crooked building, it would draw none, and
  // without a single error: the origin is at least visible.
  if (!Number.isFinite(slot) || slot < 0) return { gx: 0, gz: 0 };
  return LOTS[Math.min(Math.trunc(slot), LOTS.length - 1)]!;
}

/** Grid index to world units: one pitch per cell, no street to cross. */
export function axisToWorld(g: number, pitch = CELL_PITCH): number {
  return g * pitch;
}

/* ───────────────────────── the north plaza ───────────────────────── */

/**
 * Empty ground north of the city: the three-by-three block of cells the order
 * skips, as it is drawn. The first drawing put an octagonal HQ here; this view draws no HQ
 * (the user's call, 2026-09-24), but the plaza stays out of the lot order: it
 * is what the order was computed around, and dropping it would move every
 * building past slot 0 to another corner.
 */
export const HQ_CELL: Cell = { gx: 0, gz: -3 };
/** At the spacing the city opens on; the cells are the same at any other. */
export const HQ_Z = axisToWorld(HQ_CELL.gz);
/** From the centre to the far wall of the outer lots; their half-width is the guard around it. */
export const HQ_PLAZA_RADIUS = 1.5 * CELL_PITCH - LOT_SIZE / 2;

/**
 * Where a slot's tower stands. The cell comes from the slot alone; `pitch`
 * only says how far apart the cells are drawn, so changing it spreads the
 * city out or pulls it in without any tower changing neighbours.
 */
export function placeSlot(slot: number, pitch = CELL_PITCH): Placement {
  const cell = slotToCell(slot);
  return { slot, x: axisToWorld(cell.gx, pitch), z: axisToWorld(cell.gz, pitch) };
}

/** How far from the origin the first `count` lots reach, on either axis. */
export function cityRadius(count: number, pitch = CELL_PITCH): number {
  let max = 0;
  for (let slot = 0; slot < Math.max(1, count); slot++) {
    const p = placeSlot(slot, pitch);
    max = Math.max(max, Math.abs(p.x), Math.abs(p.z));
  }
  return max;
}

/* ───────────────────────── building ───────────────────────── */

export const FLOOR_HEIGHT = 3.4;

export function buildingHeight(fileCount: number): number {
  return floorsForSize(fileCount) * FLOOR_HEIGHT;
}

/** Footprint on the ground: it grows with the project, never past the lot. */
export function buildingFootprint(fileCount: number): number {
  if (!Number.isFinite(fileCount) || fileCount <= 0) return 9;
  const grow = 9 + 3.2 * Math.log2(1 + Math.max(0, fileCount)) / 2.2;
  return Math.min(LOT_SIZE, grow);
}

/* ───────────────────────── windows ───────────────────────── */

export interface WindowPlacement {
  /** Local position, relative to the centre of the building's base. */
  x: number;
  y: number;
  z: number;
  /** Normal of the facade the window sits on. */
  nx: number;
  nz: number;
}

/**
 * Where a window physically is. The columns wrap around the building: four
 * facades, so even a project with many directories stays readable without
 * towers reaching the sky.
 */
export function windowPlacement(
  floor: number,
  col: number,
  floors: number,
  footprint: number,
  height: number,
): WindowPlacement {
  const face = Math.floor(col / WINDOW_COLS_PER_FACE) % 4;
  const withinFace = col % WINDOW_COLS_PER_FACE;

  const half = footprint / 2;
  // A margin from the edge, so the windows never touch the neon corners. It
  // must match `windowSize`: if the two drift apart, the windows are placed
  // on one grid and drawn on another.
  const span = footprint * 0.84;
  const step = span / WINDOW_COLS_PER_FACE;
  const offset = -span / 2 + step * (withinFace + 0.5);

  const floorHeight = height / Math.max(1, floors);
  const y = floorHeight * (floor + 0.5);

  // Just off the wall: flush with it, z-fighting makes it flicker.
  const out = half + 0.06;
  switch (face) {
    case 0:
      return { x: offset, y, z: out, nx: 0, nz: 1 };
    case 1:
      return { x: out, y, z: -offset, nx: 1, nz: 0 };
    case 2:
      return { x: -offset, y, z: -out, nx: 0, nz: -1 };
    default:
      return { x: -out, y, z: offset, nx: -1, nz: 0 };
  }
}

/** A window's size, in proportion to the column pitch. */
export function windowSize(footprint: number, floors: number, height: number): { w: number; h: number } {
  // Wider than the geometry asks for, and for a measured reason: from afar a
  // two-unit window is four pixels, and a four-pixel flash goes unseen. The
  // glass matters more than the frame.
  const span = footprint * 0.84;
  const w = (span / WINDOW_COLS_PER_FACE) * 0.9;
  const h = Math.min(w * 1.25, (height / Math.max(1, floors)) * 0.74);
  return { w, h };
}

/** How many window seats a building has: every floor, all four facades. */
export function windowCapacity(floors: number): number {
  return Math.max(1, floors) * WINDOW_COLS;
}

/**
 * From a seat on the facade to a floor and a column.
 *
 * A seat past the capacity -- the building got shorter after the window lit
 * up -- folds back onto the floors that exist, instead of hanging above the
 * roof.
 */
export function windowCell(slot: number, floors: number): { floor: number; col: number } {
  return {
    floor: Math.floor(slot / WINDOW_COLS) % Math.max(1, floors),
    col: slot % WINDOW_COLS,
  };
}
