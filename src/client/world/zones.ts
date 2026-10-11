import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  HEX_SIZE, TILE, DECK_TOP, RAMP_EDGE, RAMP_WIDTH, cellKey, deckTop, hexToWorld, onTile, rampAxis, rampCell,
  rampHead, rampRun, rampSurface, slotToCell, zoneSlot,
} from '../../shared/layout.ts';
import type { Cell } from '../../shared/layout.ts';
import { atlasTexture, hasPart, kitReady, part } from '../assets/kit.ts';
import { fnv1a32, mulberry32 } from '../../shared/hash.ts';

/**
 * Project zones -- one hex per repo, decks stacked by size.
 *
 * Ported from Bot Crossing's plots, which decked a project over as many cells
 * as its size earned it. Here a project never takes more ground than one
 * cell: a bigger one gets more decks laid on top of each other, each exactly
 * as thick as the one on the ground, and everything that happens there --
 * the habitat, the structures, the lamps, the crew -- happens on the top one.
 * A colony of single cells stays readable from close up, where a colony of
 * blobs had to be seen from far away to be seen whole.
 *
 * What differs from the source is WHO decides the cell. Bot Crossing handed
 * cells out with a spiral allocator that remembered the last layout; here the
 * geography is frozen by `layout.ts`: the cell is a pure function of the
 * zone's slot. The lamp posts are gone too -- this colony lights its zones
 * from its own lamp layer -- and so is the name plate: names show on hover.
 *
 * And what the source did not have: a ramp. A stack seven decks tall is
 * three metres of wall, and a crew that stepped onto it from any side was
 * floating up it. The kerb runs all the way round now, the navigation grid
 * treats it as a wall (`kerbLines`), and the one gap in it is at the top of
 * the ramp.
 */

/**
 * How far the slab's underside reaches below y=0.
 *
 * The prism used to stop dead at zero, and zero is *above* the ground over
 * most of a zone: the colony floor bottoms out near -0.36 on the roughest
 * planet, so about three fifths of every zone's edge had open air under it.
 * At the camera's shallowest tilt -- six degrees off the horizon -- you could
 * see straight through that gap, and even at the resting isometric angle it
 * read as a slab hovering a hand's width off the dirt.
 *
 * Buried by definition, so it only has to reach past the lowest ground a
 * zone can be dealt; it is never the surface anything is measured from. That
 * is still the deck top.
 */
const DECK_SKIRT = 0.4;
/**
 * The seam between two stacked decks: the upper plate starts this far above
 * the lower one, over a core pulled in by `SEAM_INSET`. Without it a stack of
 * four is one tall slab and the size it stands for cannot be counted.
 */
const SEAM = 0.07;
const SEAM_INSET = 0.35;
/** The kerb bar's cross-section, and how far inside the tile's edge it sits. */
const KERB_WIDTH = 0.32;
const KERB_HEIGHT = 0.14;
const KERB_INSET = 0.05;
/**
 * How far in from the rim of the ramp its rails run, centreline to edge: the
 * same as the kerb's, so a rail reads as the kerb turning the corner and
 * going down.
 */
const RAIL_INSET = KERB_INSET + KERB_WIDTH / 2;
/**
 * How far in from the top of the ramp nothing is placed, and how much wider
 * than the ramp that strip is. The props along the kerb land anywhere round
 * the rim, the ramp's gap included, and one there stands in the only way up.
 * Deep enough to take in the corner seats either side of the ramp edge too,
 * 2.5 to 3.2 in from the top: what comes up the ramp walks onto open deck.
 */
const LANDING_DEPTH = 3.4;
const LANDING_MARGIN = 1;
/**
 * Three builds a 6-sided cylinder with its first vertex on +Z, which puts its
 * corners at 30, 90, 150 degrees... -- a *pointy-top* hexagon. The lattice
 * and the kerb bars both assume a **flat-top**
 * hexagon with corners at 0, 60, 120... so every hexagonal prism has to be
 * turned by this much to agree with them. Without it the decks sit a
 * half-step out of phase and their corners poke through the kerbs.
 */
const HEX_PHASE = Math.PI / 6;

/*
 * Two numbers copied from `surfaces.ts`, which draws the textures on a canvas
 * and therefore cannot be imported here: this module has to run in
 * `node --test`, where there is no DOM. They describe the textures' layout,
 * so the UV rewrites below only agree with the drawings while these match.
 */

/** World units one tile of the deck texture covers. Same as `surfaces.ts`. */
const DECK_TEXTURE_SCALE = 4;
/**
 * Where on the kerb texture a face should look, given which way it points.
 * `top` is the lit dash strip; everything else lands on the plain patch.
 * Same as `KERB_UV` in `surfaces.ts`.
 */
const KERB_UV = {
  top: { v0: 0.04, v1: 0.46 },
  side: { u: 0.5, v: 0.75 },
} as const;

/**
 * How long a kerb flash takes to die away, in seconds. Long enough to catch
 * out of the corner of an eye, short enough that two commits a few seconds
 * apart read as two flashes rather than one long glow.
 */
export const FLASH_S = 1.4;

/** How many times the deck plate repeats around a tile's rim, at the deck's own scale. */
const PERIMETER_REPEATS = (6 * TILE) / DECK_TEXTURE_SCALE;

/** The kit props a zone scatters along its kerb, when the base kit is loaded. */
const CLUTTER_PROPS: readonly string[] = [
  'containers_A', 'containers_B', 'containers_C', 'containers_D',
  'cargo_A', 'cargo_B', 'cargo_A_packed', 'cargo_B_packed', 'lights',
];

/** The textures a zone dresses itself in: what `surfaces.ts` draws, handed in by the caller. */
export interface ZoneSurfaces {
  deck: { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture };
  kerb: { map: THREE.Texture; emissiveMap: THREE.Texture; normalMap: THREE.Texture };
}

export interface ZoneSpec {
  id: string;
  slot: number;
  /** Decks stacked on the cell; clamped the way `deckTop` clamps it. */
  levels: number;
  accent: number;
}

/** A ground footprint the navigation grid must route around, zone-local. */
export interface ClutterSpot {
  x: number;
  z: number;
  r: number;
}

/**
 * A kerb, as a line on the ground an astronaut may not cross: its centreline
 * and its half-width, zone-local. The colony adds the astronaut's own width,
 * the way it does for clutter.
 */
export interface KerbLine {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  r: number;
}

/**
 * Replace a geometry's UVs with a world-planar projection.
 *
 * A hex tile is a six-sided cylinder, and a cylinder's cap UVs are a disc --
 * which turns a tiling plate pattern into a medallion, one per tile.
 * Projecting from XZ instead makes the seams run straight across the deck,
 * so a plate reads as plating rather than as a target. Upright
 * faces get the rim treatment: the deck's edge is a shallow band next to the
 * zone it wraps, and a flat XZ projection smears it into streaks at exactly
 * the grazing angle it is seen from.
 *
 * `height` is the prism's own height, which is what the rim's texel density
 * is set against. It is not `DECK_TOP`: the slab reaches below the ground as
 * well as above it, and a rim scaled to only the part you can see would
 * stretch the plate over the part you cannot.
 */
function planarUv(geo: THREE.BufferGeometry, scale: number, offsetX = 0, offsetZ = 0, height = DECK_TOP): void {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const src = geo.getAttribute('uv');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    if (Math.abs(nrm.getY(i)) > 0.5) {
      // Top and bottom: straight down, in world space, so the pattern runs across tiles.
      uv[i * 2] = (x + offsetX) / scale;
      uv[i * 2 + 1] = (z + offsetZ) / scale;
    } else {
      // The rim keeps the cylinder's own unwrap, only rescaled to world density.
      //
      // Two simpler ideas both fail here. A fixed horizontal axis like `x + z`
      // is *constant* along two of every six sides of a hexagon, which leaves
      // those faces with no UV gradient, a degenerate tangent, and -- since
      // three builds the normal-mapped shading frame out of that -- solid
      // black. Arc length from `atan2` fixes the gradient but introduces a
      // seam: the face straddling +-pi jumps a full turn in one step, crushing
      // a dozen repeats of the texture into one panel, which reads as fine
      // stripes at the corners and as mud once mipmapping averages them. The
      // generated unwrap already solves both, because it duplicates the
      // vertices at the seam.
      uv[i * 2] = src.getX(i) * PERIMETER_REPEATS;
      // The cylinder's own v runs 0 at the foot of the prism to 1 at its top,
      // so scaling it by the prism's real height is what keeps the plate at
      // world density whatever the slab's total depth. Lifted off zero so a
      // rim this shallow samples the middle of a plate rather than straddling
      // the seam that runs along the texture's own edge.
      uv[i * 2 + 1] = 0.25 + src.getY(i) * (height / scale);
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/**
 * Point a kerb bar's upper face at the lit dash strip and every other face at
 * plain colour.
 *
 * A box hands all six of its faces the same 0..1 UV square, so one strip
 * drawn once is stretched down the sides and across the ends as well. On a
 * bar 14cm tall that squashes the dark gaps between dashes into what reads
 * as a solid black edge -- most visible exactly where two zones meet and six
 * of those edges gather at a corner.
 */
function kerbUv(geo: THREE.BufferGeometry): void {
  const nrm = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    if (nrm.getY(i) > 0.5) {
      uv.setY(i, KERB_UV.top.v0 + uv.getY(i) * (KERB_UV.top.v1 - KERB_UV.top.v0));
    } else {
      uv.setXY(i, KERB_UV.side.u, KERB_UV.side.v);
    }
  }
  uv.needsUpdate = true;
}

/** A flat-top hexagonal prism, phase-corrected. */
function hexPrism(radius: number, height: number): THREE.CylinderGeometry {
  const geo = new THREE.CylinderGeometry(radius, radius, height, 6);
  geo.rotateY(HEX_PHASE);
  return geo;
}

/** Merge and free the parts; a refusal is a bug in whoever built the parts, so it throws. */
function merge(parts: THREE.BufferGeometry[], what: string): THREE.BufferGeometry {
  const geo = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  if (!geo) throw new Error(`zone: could not merge the ${what}`);
  return geo;
}

// -- the zone -----------------------------------------------------------------------------

export class Zone {
  readonly id: string;
  readonly slot: number;
  /** How many decks are stacked on the cell: the project's size. */
  readonly levels: number;
  readonly accent: number;
  /** The one cell this zone stands on, decided by the slot and never by the zone. */
  readonly cell: Cell;
  /** Positioned at the cell's centre on the ground; everything inside is zone-local. */
  readonly group: THREE.Group;
  /** The cell's centre, in world coordinates, at ground level. */
  readonly center: THREE.Vector3;
  /** Height of the top deck's face: where everything on this zone stands. */
  readonly top: number;
  readonly radius: number;
  /** Zone-local footprints of the clutter, for the colony to hand to the navigation grid. */
  readonly clutterSpots: readonly ClutterSpot[];
  /** The kerb round the top deck and down both sides of the ramp, open only at the top of it. */
  readonly kerbLines: readonly KerbLine[];
  /** The bare cell the ramp comes down into. Never a zone's: see `RAMP_EDGE`. */
  readonly rampCell: Cell;
  /** How far out from the rim the ramp reaches the ground. */
  readonly rampRun: number;

  #borderMaterial: THREE.MeshStandardMaterial | null = null;
  /**
   * The kerb's own shader inputs. Held here, not looked up on the compiled
   * program: the program does not exist until the first frame draws it, and
   * the colony starts driving the chase before that.
   */
  #kerb = {
    uChase: { value: 0 },
    uHead: { value: 0 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color() },
    uKerbAccent: { value: new THREE.Color() },
  };
  /** When the current flash started on the `setNight` clock; NaN until that clock has spoken. */
  #flashAt = Number.NaN;
  #flashPending = false;

  constructor(spec: ZoneSpec, surfaces: ZoneSurfaces | null) {
    this.id = spec.id;
    this.slot = spec.slot;
    this.accent = spec.accent;
    this.cell = slotToCell(spec.slot);
    this.top = deckTop(spec.levels);
    // Read back off the height rather than trusted from the spec, so a NaN or a
    // stack past the ceiling means the same thing here as in `deckTop`.
    this.levels = Math.round(this.top / DECK_TOP);

    const { x, z } = hexToWorld(this.cell.q, this.cell.r);
    this.center = new THREE.Vector3(x, 0, z);
    this.radius = HEX_SIZE;

    this.group = new THREE.Group();
    this.group.position.copy(this.center);
    this.group.name = `zone:${spec.id}`;

    this.rampCell = rampCell(this.cell);
    this.rampRun = rampRun(this.levels);

    this.#buildDeck(surfaces);
    this.kerbLines = this.#buildBorder(surfaces);
    this.clutterSpots = this.#buildClutter();
  }

  /**
   * One merged mesh: a plate per level, and behind the seams a core.
   *
   * The ground plate reaches under the terrain like every deck did; each plate
   * above it starts a seam's height over the one below, and the core -- pulled
   * in, so it sits in the shadow of the plates -- closes the gap, so the seam
   * reads as a groove rather than as daylight through the stack.
   */
  #buildDeck(surfaces: ZoneSurfaces | null): void {
    const parts: THREE.BufferGeometry[] = [];
    for (let level = 0; level < this.levels; level++) {
      const bottom = level === 0 ? -DECK_SKIRT : level * DECK_TOP + SEAM;
      const topFace = (level + 1) * DECK_TOP;
      parts.push(slab(TILE, bottom, topFace));
    }
    if (this.levels > 1) parts.push(slab(TILE - SEAM_INSET, 0, this.top - DECK_TOP + SEAM));
    // Same plate, same material, same draw call: a ramp that read as a
    // different object would look bolted on rather than part of the stack.
    parts.push(rampSlab(this.levels));
    const geo = merge(parts, 'deck');

    // Dark, but not black. The deck is a backdrop and wants to sit under the
    // buildings rather than compete with them -- but its rim faces sideways,
    // so whatever the top reads as in full sun the edge reads as one stop
    // darker, and a backdrop that goes to nothing at the zone boundary just
    // looks like a hole. The accent belongs on the kerb, where it can outline
    // the zone without shouting; the plate pattern arrives as a texture and
    // this tints it, which is why the drawing is authored neutral grey.
    const color = new THREE.Color(this.accent).offsetHSL(0, -0.38, 0).multiplyScalar(0.9);
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.18 });
    if (surfaces) {
      material.map = surfaces.deck.map;
      material.normalMap = surfaces.deck.normalMap;
      material.roughnessMap = surfaces.deck.roughnessMap;
      material.normalScale.set(0.7, 0.7);
    }
    const deck = new THREE.Mesh(geo, material);
    deck.name = 'deck';
    deck.castShadow = this.levels > 1;
    deck.receiveShadow = true;
    this.group.add(deck);
  }

  /**
   * The glowing accent kerb, one bar per edge of the top deck, and a rail
   * down each side of the ramp. Hands back the lines it drew, for the
   * navigation grid: the kerb is what stops the crew stepping off a stack,
   * so the wall is wherever the kerb is and nowhere else.
   *
   * Two things here exist purely to stop the kerbs flickering. The bar is
   * inset so it lies wholly **inside** its tile: centred on the edge it would
   * poke past the deck's own rim, and an emissive slab straddling an edge
   * z-fights with whatever is behind it. And it sits **on top of** the deck
   * rather than straddling it, so no two surfaces in a zone are ever coplanar.
   */
  #buildBorder(surfaces: ZoneSurfaces | null): KerbLine[] {
    const parts: THREE.BufferGeometry[] = [];
    const lines: KerbLine[] = [];
    const r = KERB_WIDTH / 2;
    const apothem = TILE * Math.cos(Math.PI / 6);
    // Centreline of the bar, pulled inboard far enough to clear the tile edge entirely.
    const mid = apothem - KERB_INSET - KERB_WIDTH / 2;
    // The bars form a smaller regular hexagon, whose side equals its own circumradius.
    const side = mid / Math.cos(Math.PI / 6);
    const half = (side * 1.02) / 2;
    // Where a rail meets the ramp edge's kerb, measured along that edge from its middle.
    const rail = RAMP_WIDTH / 2 - RAIL_INSET;

    for (let edge = 0; edge < 6; edge++) {
      const angle = (Math.PI / 3) * edge + Math.PI / 6;
      const cx = Math.cos(angle) * mid;
      const cz = Math.sin(angle) * mid;
      // Along the edge, the direction the bar's own length runs once turned.
      const ax = -Math.sin(angle);
      const az = Math.cos(angle);
      // The ramp edge is two bars with the ramp between them. Each stops at
      // the rail's inner face, so the gap is exactly the ramp's walkway.
      const runs = edge === RAMP_EDGE ? [[-half, -(rail - r)], [rail - r, half]] : [[-half, half]];
      for (const [from, to] of runs as [number, number][]) {
        // Sits on the deck: bottom flush with the top face, never inside it.
        const geo = new THREE.BoxGeometry(KERB_WIDTH, KERB_HEIGHT, to - from);
        kerbUv(geo);
        geo.translate(0, 0, (from + to) / 2);
        geo.rotateY(-angle);
        geo.translate(cx, this.top + KERB_HEIGHT / 2, cz);
        parts.push(geo);
      }
      // The wall runs corner to corner on every other edge. On the ramp edge
      // it stops at the rails' centreline, where the rails' own walls start:
      // two segments meeting at a point leave no gap between them.
      const ends = edge === RAMP_EDGE ? [[-half, -rail], [rail, half]] : [[-half, half]];
      for (const [from, to] of ends as [number, number][]) {
        lines.push({ x0: cx + ax * from, z0: cz + az * from, x1: cx + ax * to, z1: cz + az * to, r });
      }
    }

    // The rails, from the top of the ramp down along its surface and on under
    // the ground as far as the slab goes, so neither end is left in the air
    // on a planet that rolls.
    const head = rampHead();
    const axis = rampAxis();
    const reach = rampReach(this.levels);
    const drop = this.top + DECK_SKIRT;
    const length = Math.hypot(reach, drop);
    for (const sign of [-1, 1]) {
      const across = sign * rail;
      const geo = new THREE.BoxGeometry(KERB_WIDTH, KERB_HEIGHT, length);
      kerbUv(geo);
      // Pivot on the bottom of the top end, then lay it down the slope and
      // turn its length onto the ramp's axis.
      geo.translate(0, KERB_HEIGHT / 2, length / 2);
      geo.rotateX(Math.atan2(drop, reach));
      geo.rotateY(Math.atan2(axis.x, axis.z));
      const x = head.x - axis.z * across;
      const z = head.z + axis.x * across;
      geo.translate(x, this.top, z);
      parts.push(geo);
      // The wall starts on the kerb's own centreline, where the edge's wall
      // stopped, and ends at the foot: past it the crew is on the ground.
      lines.push({
        x0: x - axis.x * RAIL_INSET, z0: z - axis.z * RAIL_INSET,
        x1: x + axis.x * this.rampRun, z1: z + axis.z * this.rampRun,
        r,
      });
    }

    const geo = merge(parts, 'kerb');
    // Every bar is the same length, so a box's own 0..1 UVs put the same run
    // of dashes on each one without any reprojection.
    const material = new THREE.MeshStandardMaterial({
      color: this.accent,
      emissive: this.accent,
      emissiveIntensity: 0.5,
      roughness: 0.55,
      metalness: 0.1,
    });
    if (surfaces) {
      material.map = surfaces.kerb.map;
      material.emissiveMap = surfaces.kerb.emissiveMap;
      material.normalMap = surfaces.kerb.normalMap;
      material.normalScale.set(0.5, 0.5);
    }
    this.#kerb.uKerbAccent.value.set(this.accent);
    decorateKerb(material, this.#kerb);
    this.#borderMaterial = material;
    const border = new THREE.Mesh(geo, material);
    border.name = 'kerb';
    border.receiveShadow = true;
    this.group.add(border);
    return lines;
  }

  /**
   * Ground clutter -- crates, drums and a floodlight or two, hugging the kerb.
   *
   * A zone with buildings on its spots and nothing anywhere else reads as a
   * car park. This fills the gap for one extra draw call: a merged mesh of
   * kit props on the top deck, placed where the crew's routes between spots
   * do not run, so nobody ends up walking through a barrel.
   *
   * Seeded off the zone's own id, so a repo's yard is laid out the same on
   * every reload.
   */
  #buildClutter(): ClutterSpot[] {
    const spots: ClutterSpot[] = [];
    if (!kitReady('base') || !CLUTTER_PROPS.every((n) => hasPart(n))) return spots;

    const rand = mulberry32(fnv1a32(this.id) + 17);
    const parts: THREE.BufferGeometry[] = [];

    // Two bands, both chosen to miss the buildings. The spot ring sits at
    // 0.58 of a tile and a building reaches about 1.5 units past it, so the
    // gaps *between* consecutive ring spots are clear -- and so is the strip
    // inside the kerb, past every spot.
    const seats: { a: number; r: number }[] = [];
    for (let i = 0; i < 6; i++) {
      if (rand() > 0.45) seats.push({ a: (Math.PI / 3) * i + Math.PI / 3, r: TILE * (0.52 + rand() * 0.1) });
    }
    for (let i = 0; i < 3; i++) {
      if (rand() > 0.35) seats.push({ a: rand() * Math.PI * 2, r: TILE * (0.78 + rand() * 0.07) });
    }

    for (const { a, r } of seats) {
      const name = CLUTTER_PROPS[Math.floor(rand() * CLUTTER_PROPS.length)] ?? 'lights';
      const turn = rand() * Math.PI * 2;
      const px = Math.cos(a) * r;
      const pz = Math.sin(a) * r;
      // Nothing on the landing. Skipped after the dice are thrown, so every
      // other prop in the yard keeps the model and the turn it had.
      if (onLanding(px, pz)) continue;
      const geo = part(name);
      const s = name === 'lights' ? 1.1 : 1.35;
      geo.scale(s, s, s);
      geo.rotateY(turn);
      // How much ground this prop actually covers, rather than a guess: a
      // stack of cargo containers is three times the footprint of a lamp,
      // and a radius that splits the difference is one an astronaut walks
      // into the corner of.
      geo.computeBoundingBox();
      const box = geo.boundingBox;
      const spread = box ? Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.5 : 0;
      geo.translate(px, this.top, pz);
      parts.push(geo);
      spots.push({ x: px, z: pz, r: Math.max(0.45, spread * 0.86) });
    }

    if (!parts.length) return spots;
    const geo = merge(parts, 'clutter');
    const material = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.05 });
    // Null in a test, where only the geometry matters.
    material.map = atlasTexture('base');
    const clutter = new THREE.Mesh(geo, material);
    clutter.name = 'clutter';
    clutter.castShadow = true;
    clutter.receiveShadow = true;
    this.group.add(clutter);
    return spots;
  }

  /**
   * Building spot `index`, in world coordinates, standing on the top deck.
   *
   * Fixed rather than random, so a session keeps its spot as siblings come
   * and go -- a building must never jump because a neighbour was archived.
   * The position itself is `layout.ts`'s: spot 0 is the centre, the
   * habitat's; the rest ring it.
   */
  worldSlot(index: number, out: THREE.Vector3): THREE.Vector3 {
    const s = zoneSlot(index);
    return out.set(this.center.x + s.x, this.top, this.center.z + s.z);
  }

  /**
   * The ramp's walking surface under a world point, as this zone is built --
   * a lift in progress is the caller's -- or null when the point is not over
   * the ramp. Below zero past the foot, where the slab runs under the ground.
   */
  rampHeight(x: number, z: number): number | null {
    return rampSurface(this.levels, x - this.center.x, z - this.center.z);
  }

  /**
   * The middle of the top of the ramp, a step in onto the deck, in world
   * coordinates: where anybody coming up the ramp first stands on the deck.
   */
  landing(out: THREE.Vector3, inset = 0.9): THREE.Vector3 {
    const head = rampHead();
    const axis = rampAxis();
    return out.set(this.center.x + head.x - axis.x * inset, this.top, this.center.z + head.z - axis.z * inset);
  }

  /**
   * Whether a world point is on the top deck with room to stand: inside the
   * kerb, not just over the plate. A point right at the rim is still over the
   * deck, but an astronaut there has one boot over the edge.
   */
  holds(x: number, z: number, margin = 0.9): boolean {
    return onTile(x - this.center.x, z - this.center.z, margin);
  }

  /**
   * Night lighting, plus a pulse on the kerb when this zone holds something
   * urgent. Also the clock the kerb flash decays on: the colony calls this
   * every frame, so a flash needs no timer of its own.
   */
  setNight(night: number, urgent: boolean, elapsed: number): void {
    if (this.#borderMaterial) {
      this.#borderMaterial.emissiveIntensity =
        0.3 + night * 1.4 + (urgent ? 0.4 + Math.sin(elapsed * 3.4) * 0.32 : 0);
    }
    if (!Number.isFinite(elapsed)) return;
    // A flash asked for between two frames starts on the next one: its start
    // is read off this clock rather than guessed, so a flash that arrives
    // before the first frame still runs its whole course.
    if (this.#flashPending) {
      this.#flashPending = false;
      this.#flashAt = elapsed;
    }
    const t = Number.isNaN(this.#flashAt) ? Infinity : (elapsed - this.#flashAt) / FLASH_S;
    // Squared, so it drops quickly off the peak and lingers faintly: a linear
    // fade reads as a lamp being dimmed, not as a flash.
    this.#kerb.uFlash.value = t >= 0 && t < 1 ? (1 - t) * (1 - t) : 0;
  }

  /**
   * Run a bright segment round the kerb: somebody is working here. `amount`
   * is how strongly (0 is off); `head` is where the segment's leading edge is,
   * as an angle round the zone's centre, and the colony advances it -- how
   * fast says how busy the project is, and that is not the zone's to know.
   */
  setChase(amount: number, head: number): void {
    this.#kerb.uChase.value = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0;
    if (Number.isFinite(head)) this.#kerb.uHead.value = head;
  }

  /** Flash the whole kerb once in `color`: something just landed here. Decays over `FLASH_S`. */
  flash(color: number): void {
    this.#kerb.uFlashColor.value.set(color);
    this.#flashPending = true;
  }

  /** What the kerb shader is being told, for tests: no GPU needed to check the colony drove it. */
  kerbState(): { chase: number; head: number; flash: number } {
    return { chase: this.#kerb.uChase.value, head: this.#kerb.uHead.value, flash: this.#kerb.uFlash.value };
  }

  /** The key the colony files this zone's cell under. */
  get key(): string {
    return cellKey(this.cell);
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m: unknown = o.material;
        if (m instanceof THREE.Material) m.dispose();
      }
    });
  }
}

interface KerbUniforms {
  uChase: THREE.IUniform<number>;
  uHead: THREE.IUniform<number>;
  uFlash: THREE.IUniform<number>;
  uFlashColor: THREE.IUniform<THREE.Color>;
  uKerbAccent: THREE.IUniform<THREE.Color>;
}

/**
 * The chase and the flash, added on top of the kerb's own emission.
 *
 * The bars are zone-local, so the angle of a fragment round the zone's centre
 * is `atan` of its local x and z: no world matrix, and the same program serves
 * every zone. The segment's leading edge is short and soft; behind it a tail
 * about a sixth of the way round fades out, which is what makes a moving light
 * read as moving -- a symmetric blob sliding along reads as a flicker.
 */
function decorateKerb(material: THREE.MeshStandardMaterial, uniforms: KerbUniforms): void {
  material.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms): void => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec2 vKerbXZ;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vKerbXZ = position.xz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec2 vKerbXZ;
         uniform float uChase;
         uniform float uHead;
         uniform float uFlash;
         uniform vec3 uFlashColor;
         uniform vec3 uKerbAccent;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         if ( uChase > 0.0 ) {
           float kerbAngle = atan( vKerbXZ.y, vKerbXZ.x );
           // mod() of a negative is still in [0, 2pi) in GLSL: how far this point is
           // behind the head, and how far in front of it, both going round one way.
           float behind = mod( uHead - kerbAngle, 6.2831853 );
           float ahead = mod( kerbAngle - uHead, 6.2831853 );
           float lead = 1.0 - smoothstep( 0.0, 0.14, ahead );
           float trail = pow( 1.0 - smoothstep( 0.0, 1.05, behind ), 1.6 );
           totalEmissiveRadiance += uKerbAccent * max( lead, trail ) * uChase * 2.2;
         }
         totalEmissiveRadiance += uFlashColor * uFlash * 2.6;`,
      );
  };
}

/** How far out from the rim the ramp's slab reaches, down to the bottom of the skirt. */
function rampReach(levels: number): number {
  return rampRun(levels) * (1 + DECK_SKIRT / deckTop(levels));
}

/**
 * Whether a zone-local point is on the landing: the strip of deck just in
 * from the top of the ramp, a little wider than the ramp itself.
 */
function onLanding(x: number, z: number): boolean {
  const head = rampHead();
  const axis = rampAxis();
  const dx = x - head.x;
  const dz = z - head.z;
  const along = dx * axis.x + dz * axis.z;
  const across = dz * axis.x - dx * axis.z;
  return along > -LANDING_DEPTH && Math.abs(across) < RAMP_WIDTH / 2 + LANDING_MARGIN;
}

/**
 * The ramp's slab, zone-local: a wedge off the ramp edge, from the top deck
 * at the rim down through the ground to the depth of the skirt.
 *
 * Three faces and no more. The end against the deck is inside the rim, and
 * the underside is under the planet; drawing either would only give the
 * rim something to z-fight with. Indexed, because the plates it is merged
 * with are, and UV-mapped the way `planarUv` maps a plate: the top straight
 * down in zone space, so the plating runs on off the deck without a seam,
 * and the sides at the rim's density.
 */
function rampSlab(levels: number): THREE.BufferGeometry {
  const top = deckTop(levels);
  const bottom = -DECK_SKIRT;
  const reach = rampReach(levels);
  const head = rampHead();
  const axis = rampAxis();
  const half = RAMP_WIDTH / 2;
  const scale = DECK_TEXTURE_SCALE;

  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  const at = (along: number, across: number, y: number): THREE.Vector3 =>
    new THREE.Vector3(head.x + axis.x * along - axis.z * across, y, head.z + axis.z * along + axis.x * across);

  /** A flat polygon, fanned, wound so that its front faces `n`. */
  const face = (corners: THREE.Vector3[], n: THREE.Vector3, uvOf: (p: THREE.Vector3) => [number, number]): void => {
    const base = position.length / 3;
    for (const p of corners) {
      position.push(p.x, p.y, p.z);
      normal.push(n.x, n.y, n.z);
      uv.push(...uvOf(p));
    }
    const a = corners[0]!;
    const e1 = new THREE.Vector3().subVectors(corners[1]!, a);
    const e2 = new THREE.Vector3().subVectors(corners[2]!, a);
    const flip = e1.cross(e2).dot(n) < 0;
    for (let i = 1; i + 1 < corners.length; i++) {
      if (flip) index.push(base, base + i + 1, base + i);
      else index.push(base, base + i, base + i + 1);
    }
  };

  // The slope: rises `top - bottom` over `reach`, so its normal leans out along the axis.
  const lean = (top - bottom) / reach;
  const up = new THREE.Vector3(axis.x * lean, 1, axis.z * lean).normalize();
  face([at(0, -half, top), at(0, half, top), at(reach, half, bottom), at(reach, -half, bottom)], up,
    (p) => [p.x / scale, p.z / scale]);

  for (const sign of [-1, 1]) {
    const n = new THREE.Vector3(-axis.z * sign, 0, axis.x * sign);
    const across = sign * half;
    face([at(0, across, top), at(reach, across, bottom), at(0, across, bottom)], n,
      (p) => {
        const along = (p.x - head.x) * axis.x + (p.z - head.z) * axis.z;
        return [along / scale, 0.25 + (p.y - bottom) / scale];
      });
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  return geo;
}

/**
 * A plate of the stack, from `bottom` to `top`, UV-mapped and in place.
 *
 * UVs are assigned before it is moved: the rim wraps around the prism's own
 * centre, so it has to be at the origin when that is worked out.
 */
function slab(radius: number, bottom: number, top: number): THREE.BufferGeometry {
  const height = top - bottom;
  const geo = hexPrism(radius, height);
  planarUv(geo, DECK_TEXTURE_SCALE, 0, 0, height);
  // Positioned by its *top* face rather than by its middle: everything on a
  // zone is measured from that face, so it is the end that has to stay put.
  geo.translate(0, top - height / 2, 0);
  return geo;
}
