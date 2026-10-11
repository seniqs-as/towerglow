import * as THREE from 'three';
import type { Layer, ClearZone } from './stage.ts';
import { Zone } from './zones.ts';
import type { ZoneSurfaces } from './zones.ts';
import { createBuilding, buildingUniforms, SMALL_KINDS } from './habitats.ts';
import type { Building } from './habitats.ts';
import { kitReady } from '../assets/kit.ts';
import { SHIP_APRON_RADIUS, SHIP_OBSTACLE_RADIUS } from './ship.ts';
import type { Ship } from './ship.ts';
import { ZONE_PALETTE, RUIN, RING_COLOR, TOOL_COLOR } from './palette.ts';
import type { Astronauts, RosterEntry, Agent } from '../agents/astronauts.ts';
import type { Navigation, Obstacle, Wall } from '../agents/navigation.ts';
import type { Particles } from '../agents/particles.ts';
import { gestureFor } from '../agents/gestures.ts';
import { Pace, chaseSpeed } from '../state/pace.ts';
import { subagentStatus, helperStatus } from '../state/status.ts';
import {
  levelsForSize, worldToHex, cellKey, HEX_DIRS, HEX_SIZE, hqPlacement, onTile, ZONE_SPOTS, RAMP_WIDTH, rampAxis,
  rampHead,
} from '../../shared/layout.ts';
import { fnv1a32 } from '../../shared/hash.ts';
import type { ProviderId, ToolCategory } from '../../shared/protocol.ts';
import type { CrewStatus } from '../state/status.ts';

/**
 * The colony: everything that turns the store into a place.
 *
 * Ported from Bot Crossing's `Colony`, but the mapping is this project's:
 *
 *   zone       <- a project: one hex at the project's frozen slot, with as
 *                 many decks stacked on it as its file count earns. Nothing
 *                 else moves it, and nothing makes it wider.
 *   habitat    <- the project itself: one building per zone, seeded by the
 *                 project id, in the zone's accent. Permanent.
 *   structure  <- a live session: a small building on a spot of its own,
 *                 rising out of the deck when the session starts, growing
 *                 with the tool calls it makes, and sinking back into the
 *                 deck when the session exits.
 *   cadet      <- a subagent: a smaller astronaut that comes out of the
 *                 habitat, works beside it, and goes back in when it delivers.
 *   helper     <- a session calling tools: a smaller astronaut that comes out
 *                 of the habitat on the turn's first call, works the same
 *                 structure with the same hands, and goes back in once the
 *                 turn is over. One session a project is the usual case, and
 *                 one figure alone does not look like work being done.
 *
 * The astronauts come later and stand at these structures. The badge of a
 * session is the project's business, not the astronaut's: it sits over the
 * habitat, above the project's name (`summitAt`), whoever is walking around.
 *
 * Keyed by stable ids -- project id for zones, session id for structures --
 * so a snapshot that changes nothing moves nothing on screen.
 */

/** What the colony needs to know about a project. `slot` is the compacted one. */
export interface ColonyProject {
  id: string;
  slot: number;
  size: number;
  exists: boolean;
}

/** What the colony needs to know about a live session. */
export interface ColonySession {
  id: string;
  projectId: string;
  provider: ProviderId;
  status: CrewStatus;
  toolCalls: number;
  /** Already on the map when the page opened: its astronaut appears in place, no entrance. */
  known: boolean;
  /**
   * What it was last calling, when the page opened mid-work: the hands start
   * on the right gesture instead of waiting for the next call. Live calls
   * arrive through `toolStart`.
   */
  activity?: ToolCategory | null;
}

/** What the colony needs to know about a running subagent. */
export interface ColonySubagent {
  id: string;
  /** The session that launched it: where its trim, and its habitat, come from. */
  sessionId: string;
  projectId: string;
  /** Already running when the page opened: it is simply there, no walking out. */
  known: boolean;
}

/** What the lamps need to place a light on a zone. */
export interface ZoneMetrics {
  /** The centre of the top deck. Live: it rises with the stack. */
  root: THREE.Vector3;
  levels: number;
}

/** What the crew needs from the rest of the world, handed in once it exists. */
export interface CrewAttachment {
  astronauts: Astronauts;
  nav: Navigation;
  particles: Particles;
  ship: Ship;
  /** The ground scatter as obstacles: read off the stage, which owns it. */
  scatterObstacles: () => readonly Obstacle[];
  /** Whether the particle setting is at `full`: boot dust is the first thing to drop. */
  full: () => boolean;
}

export interface ColonyOptions {
  /** Canvas-drawn deck and kerb textures, or null where there is no canvas. */
  surfaces: ZoneSurfaces | null;
  /** The planet's own surface, for anything standing off a deck. */
  groundHeight: (x: number, z: number) => number;
  /** Called with the ground the scatter must leave clear whenever it changes. */
  onFootprint: (clear: readonly ClearZone[]) => void;
  /** Epoch ms, for the pace of tool calls; injected so a test can hold it still. */
  clock?: () => number;
}

interface Habitat {
  building: Building;
  target: number;
  /** The top of the habitat as it stands right now: what the name and its badges sit on. */
  summit: THREE.Vector3;
  /** How fast its rotors turn right now, eased towards what the project is doing. */
  spin: number;
}

interface Structure {
  building: Building;
  projectId: string;
  provider: ProviderId;
  known: boolean;
  /** The building spot on the zone, frozen for the life of the session. */
  slot: number;
  status: CrewStatus;
  /** The reveal it moves towards: 1 while the session lives, 0 once it is retiring. */
  target: number;
  /** The scale it moves towards, from the work done so far (`structureSize`). */
  size: number;
  retiring: boolean;
  /** The top of the structure: what a badge follows until an astronaut exists. */
  head: THREE.Vector3;
  /** The category of the last tool it called; null before the first. */
  activity: ToolCategory | null;
  spin: number;
  /** The construction band after a file was written, 1 fading to 0. */
  band: number;
  /**
   * The helper out on the deck, or null. `until` is the epoch ms before which
   * it stays even once the session stops working; `gen` is part of its roster
   * id, one more every time one comes out.
   */
  helper: { gen: number; until: number } | null;
  /** How many helpers this session has sent out so far. */
  helperGen: number;
}

/** A deck the stack just gained, pushing everything on top up into place. */
interface Lift {
  /** Where the top started, relative to the new top: negative. */
  from: number;
  t: number;
  offset: number;
}

/** The kerb's running light on a zone. */
interface Chase {
  amount: number;
  head: number;
}

/** The scale of a structure that has done no work yet: small, but a whole building. */
export const STRUCTURE_MIN_SIZE = 0.6;

/**
 * How big a session's structure stands, from the work it has done.
 *
 * A scale, not a reveal. It used to be how far the structure had risen out
 * of the deck, which left a live session's mast three quarters under the
 * plate at its first call and still a third under after twenty: on a deck
 * with a solid edge that reads as buried, not as going up. Rising and
 * sinking are left to the moments a session starts and ends; while it
 * lives, the building stands whole on the deck and grows. Same curve as
 * before: full size at about five hundred calls.
 */
export function structureSize(toolCalls: number): number {
  if (!Number.isFinite(toolCalls) || toolCalls <= 0) return STRUCTURE_MIN_SIZE;
  return Math.min(1, STRUCTURE_MIN_SIZE + (1 - STRUCTURE_MIN_SIZE) * Math.log2(1 + toolCalls) / 9);
}

/** A stable colour per project: hashed, never probed, so it is part of the frozen map. */
export function accentOf(projectId: string): number {
  return ZONE_PALETTE[fnv1a32(projectId) % ZONE_PALETTE.length]!;
}

/** Radius the scatter keeps from a decked cell: the tile, and a strip of the ring around it. */
const CELL_CLEAR = 8.6;
/**
 * The discs the scatter keeps off a ramp: as wide as the ramp and a boulder's
 * width either side, one every `RAMP_CLEAR_STEP` from the rim to a little
 * past the foot, where the crew turns onto it.
 */
const RAMP_CLEAR = RAMP_WIDTH / 2 + 1.5;
const RAMP_CLEAR_STEP = 2.5;
/** How fast a building moves towards its target progress. */
const GROW_DAMP = 1.8;
/** Below this a retiring structure is gone, and its spot is free again. */
const GONE = 0.02;
/** How wide an astronaut is, for the purpose of not fitting through gaps it should not. */
const AGENT_RADIUS = 0.26;
/** Sparks off the hammer, when nothing says what the work is. */
const SPARK = 0x9fe8c0;
/** How long a commit is cheered for. */
const CHEER_S = 5;
/** How big a subagent's astronaut stands next to its session's. */
export const CADET_SIZE = 0.72;
/** How big a session's helper stands: smaller than the session, bigger than a subagent. */
export const HELPER_SIZE = 0.8;
/**
 * Small astronauts on one project: the sessions' helpers first, then the
 * subagents. Past this the subagents are lamps only: a fan-out of twelve is
 * still readable as five figures and a row of violet lamps, and a deck one
 * hex wide has no room for twelve more walkers.
 */
export const MAX_CADETS = 5;
/** Roster ids of subagents carry this, so one can never collide with a session id. */
export const CADET_PREFIX = 'sub:';
/** Roster ids of helpers: `aid:<sessionId>#<gen>`. */
export const HELPER_PREFIX = 'aid:';
/**
 * How long a helper stays after the last tool call once its session stops
 * working. Codex reports a call only when it is over, often in the same breath
 * as the end of the turn: without this its helper would come out and turn
 * straight back.
 */
export const HELPER_LINGER_MS = 8_000;
/** At the end of a turn the helper stays at least this long: long enough to be seen hopping. */
const HELPER_HOP_MS = 2_000;
/**
 * How fast rotors turn, as a multiple of their authored half-minute turn, by
 * what the sessions on a project are doing. Working spins them up so a busy
 * project moves from across the colony; asleep, they stop.
 */
const ROTOR_RATE: Readonly<Record<CrewStatus | 'none', number>> = {
  working: 6, waiting: 1, idle: 1, blocked: 0.3, sleeping: 0, none: 1,
};
/** How briskly a rotor spools up or down: a second or two, like something with mass. */
const ROTOR_DAMP = 0.8;
/** How long the construction band stays lit after a file is written. */
const BAND_S = 0.9;
/** How long a new deck takes to push the stack up into place. */
export const LIFT_S = 1.6;
/** How fast the kerb light fades in when work starts and out when it stops. */
const CHASE_DAMP = 2.5;

export class Colony implements Layer {
  readonly object3d = new THREE.Group();

  #zones = new Map<string, Zone>();
  #pickRay = new THREE.Raycaster();
  #pickNdc = new THREE.Vector2();
  /** The centre of every zone's top deck: what labels, crates and lamps anchor to. */
  #roots = new Map<string, THREE.Vector3>();
  #signatures = new Map<string, string>();
  #habitats = new Map<string, Habitat>();
  #structures = new Map<string, Structure>();
  /** The height of the top deck of every zone, lift included, by the key of its cell. */
  #decked = new Map<string, number>();
  /**
   * Every zone whose deck reaches into a cell, by cell key: its own cell and
   * the six around it, which its rim overhangs (`CELL_SIZE`). A cell between
   * three decks lists all three.
   */
  #over = new Map<string, Zone[]>();
  /** The zone whose ramp comes down into a cell, by cell key. */
  #ramps = new Map<string, Zone>();
  /** The deck a zone's crew can reach from the top of its ramp, per navigation grid. */
  #reach = new Map<string, { version: number; cells: Set<number> }>();
  #urgent = new Set<string>();
  #surfaces: ZoneSurfaces | null;
  #groundHeight: (x: number, z: number) => number;
  #onFootprint: (clear: readonly ClearZone[]) => void;
  #footprint = '';
  #night = 0;
  /**
   * The last inputs, kept so the colony can be built once the kit lands.
   * The store speaks before the model pack has been decoded, and a habitat
   * cannot be built out of parts that are not there yet.
   */
  #projects: readonly ColonyProject[] = [];
  #sessions: readonly ColonySession[] = [];
  #crew: CrewAttachment | null = null;
  #stepped = new Set<string>();
  #color = new THREE.Color();
  #dustTint = new THREE.Color(0x8e8a80);
  #handAt = new THREE.Vector3();
  #subagents: readonly ColonySubagent[] = [];
  #pace = new Pace();
  #clock: () => number;
  #chase = new Map<string, Chase>();
  #lifts = new Map<string, Lift>();
  /** Per frame: the rotor rate each project asks for, and whether anyone there is working. */
  #busy = new Map<string, { rate: number; working: boolean }>();

  constructor(opts: ColonyOptions) {
    this.object3d.name = 'colony';
    this.#surfaces = opts.surfaces;
    this.#groundHeight = opts.groundHeight;
    this.#onFootprint = opts.onFootprint;
    this.#clock = opts.clock ?? Date.now;
  }

  /* ───────────────────────── projects ───────────────────────── */

  /**
   * Reshape the zones around the projects on the map.
   *
   * A zone is rebuilt only when its own signature -- slot, levels, whether
   * the folder still exists -- changed, and left completely alone otherwise.
   * The cell never moves, so a rebuild for a new deck keeps the habitat
   * exactly where it was, one plate higher.
   */
  setProjects(projects: readonly ColonyProject[]): void {
    this.#projects = projects;
    if (!kitReady('base')) return; // replayed by `onAssetsReady`
    const seen = new Set<string>();
    let reshaped = false;
    for (const p of projects) {
      seen.add(p.id);
      const levels = levelsForSize(p.size);
      const signature = `${p.slot}:${levels}:${p.exists ? 1 : 0}`;
      if (this.#signatures.get(p.id) === signature) continue;
      reshaped = true;

      const accent = p.exists ? accentOf(p.id) : RUIN;
      const old = this.#zones.get(p.id);
      // Where the top deck stands on screen right now, a lift in progress included.
      const was = old ? old.top + (this.#lifts.get(p.id)?.offset ?? 0) : null;
      if (old) {
        this.object3d.remove(old.group);
        old.dispose();
      }
      const zone = new Zone({ id: p.id, slot: p.slot, levels, accent }, this.#surfaces);
      this.#zones.set(p.id, zone);
      this.#signatures.set(p.id, signature);
      this.object3d.add(zone.group);
      // The same vector survives a rebuild: the cell never moves, and whoever
      // holds it (a label, a lamp) must not be handed a new one. Only its
      // height changes, when the stack does.
      const root = this.#roots.get(p.id) ?? new THREE.Vector3();
      root.set(zone.center.x, zone.top, zone.center.z);
      this.#roots.set(p.id, root);
      // A stack that grew does not jump: the new plate slides in underneath
      // and pushes everything on top up into place. One that shrank (files
      // evicted) just settles; nobody needs to watch a project lose a deck.
      if (was !== null && zone.top > was + 1e-6) {
        this.#lifts.set(p.id, { from: was - zone.top, t: 0, offset: was - zone.top });
      } else {
        this.#lifts.delete(p.id);
      }

      // The habitat: new projects get one that rises; a project whose folder
      // went is rebuilt in the ruin tint, whole, because it was whole before.
      const had = this.#habitats.get(p.id);
      if (had) {
        this.object3d.remove(had.building.mesh);
        had.building.dispose();
      }
      const building = createBuilding({ seed: fnv1a32(p.id), accent, kind: null });
      zone.worldSlot(0, building.mesh.position);
      building.mesh.rotation.y = ((fnv1a32(p.id) >>> 8) % 360) * (Math.PI / 180);
      building.setProgress(had ? had.building.progress : 0);
      const summit = had?.summit ?? new THREE.Vector3();
      this.#habitats.set(p.id, { building, target: 1, summit, spin: had?.spin ?? ROTOR_RATE.none });
      placeSummit(building, summit);
      this.object3d.add(building.mesh);

      // Structures standing on a rebuilt zone follow their spot: same cell,
      // same index, but the stack under them may have grown.
      for (const s of this.#structures.values()) {
        if (s.projectId === p.id) zone.worldSlot(s.slot, s.building.mesh.position);
      }
    }

    for (const id of [...this.#zones.keys()]) {
      if (seen.has(id)) continue;
      reshaped = true;
      const zone = this.#zones.get(id)!;
      this.object3d.remove(zone.group);
      zone.dispose();
      this.#zones.delete(id);
      this.#roots.delete(id);
      this.#signatures.delete(id);
      this.#lifts.delete(id);
      this.#chase.delete(id);
      this.#pace.forget(id);
      const habitat = this.#habitats.get(id);
      if (habitat) {
        this.object3d.remove(habitat.building.mesh);
        habitat.building.dispose();
        this.#habitats.delete(id);
      }
      // A session on a zone that left the map sinks with it.
      for (const [sid, s] of this.#structures) {
        if (s.projectId === id) this.#retire(sid, s);
      }
    }

    this.#decked.clear();
    this.#over.clear();
    this.#ramps.clear();
    this.#reach.clear();
    for (const zone of this.#zones.values()) {
      this.#decked.set(zone.key, zone.top);
      this.#ramps.set(cellKey(zone.rampCell), zone);
      this.#file(zone.cell.q, zone.cell.r, zone);
      for (const [dq, dr] of HEX_DIRS) this.#file(zone.cell.q + dq, zone.cell.r + dr, zone);
    }
    // Whatever was just rebuilt at the new height goes back where the lift has it.
    for (const [id, lift] of this.#lifts) this.#applyLift(id, lift.offset);
    // A stack that settled lower, or a zone gone, moved the ground too: the
    // crew parked on it would stand on the air where the old top was.
    if (reshaped) this.#crew?.astronauts.groundMoved();

    const footprint = [...this.#signatures.entries()].map(([id, s]) => `${id}=${s}`).sort().join('|');
    if (footprint !== this.#footprint) {
      this.#footprint = footprint;
      this.#onFootprint(this.clearZones());
    }
    this.rebuildNavigation();
  }

  /**
   * The model pack is in: build what the store already said. Zones built
   * before it (none today, but a rebuilt kit is the same case) are redone so
   * their clutter and habitats come from real parts.
   */
  onAssetsReady(): void {
    this.#signatures.clear();
    this.setProjects(this.#projects);
    this.setSessions(this.#sessions);
  }

  /** The ground the scatter must leave clear: every decked cell and its ramp, and the ship's apron. */
  clearZones(): ClearZone[] {
    const clear: ClearZone[] = [];
    const head = rampHead();
    const axis = rampAxis();
    for (const zone of this.#zones.values()) {
      clear.push({ x: zone.center.x, z: zone.center.z, r: CELL_CLEAR });
      // A boulder on the ramp would stand in the only way up.
      for (let along = RAMP_CLEAR_STEP; along < zone.rampRun + RAMP_CLEAR; along += RAMP_CLEAR_STEP) {
        clear.push({ x: zone.center.x + head.x + axis.x * along, z: zone.center.z + head.z + axis.z * along, r: RAMP_CLEAR });
      }
    }
    const hq = hqPlacement();
    clear.push({ x: hq.x, z: hq.z, r: SHIP_APRON_RADIUS + 2 });
    return clear;
  }

  /* ───────────────────────── sessions ───────────────────────── */

  /**
   * Reconcile the structures against the live sessions: newcomers get a spot
   * of their own and rise, the ones still here follow their work, and
   * anything that vanished sinks back into the deck rather than blinking out.
   */
  setSessions(sessions: readonly ColonySession[]): void {
    this.#sessions = sessions;
    if (!kitReady('base')) return; // replayed by `onAssetsReady`
    const seen = new Set<string>();
    const fresh: string[] = [];
    this.#urgent.clear();
    for (const s of sessions) {
      const zone = this.#zones.get(s.projectId);
      // A hidden project has no zone, and a session without a zone has
      // nowhere to stand: it is simply not on the map.
      if (!zone) continue;
      seen.add(s.id);
      if (s.status === 'waiting' || s.status === 'blocked') this.#urgent.add(s.projectId);

      let structure = this.#structures.get(s.id);
      if (!structure) {
        const seed = fnv1a32(s.id);
        const slot = this.#claimSlot(s.projectId);
        const building = createBuilding({
          seed,
          accent: zone.accent,
          kind: SMALL_KINDS[seed % SMALL_KINDS.length]!,
        });
        zone.worldSlot(slot, building.mesh.position);
        building.mesh.rotation.y = ((seed >>> 8) % 360) * (Math.PI / 180);
        building.setProgress(0);
        // Born at the size its work so far earns: a page opened mid-session
        // does not watch every structure swell up from the smallest.
        const size = structureSize(s.toolCalls);
        building.mesh.scale.setScalar(size);
        this.object3d.add(building.mesh);
        structure = {
          building, projectId: s.projectId, provider: s.provider, known: s.known, slot, status: s.status,
          target: 1, size, retiring: false, head: new THREE.Vector3(),
          activity: s.activity ?? null, spin: ROTOR_RATE.none, band: 0,
          helper: null, helperGen: 0,
        };
        this.#structures.set(s.id, structure);
        this.#placeHead(structure, undefined);
        if (structure.activity) fresh.push(s.id);
      } else {
        structure.status = s.status;
        structure.target = 1;
        structure.size = structureSize(s.toolCalls);
        structure.retiring = false;
        if (structure.projectId !== s.projectId) {
          // A session does not change project; if the store says so, it is
          // a new life in a new place and it starts over there.
          this.#drop(s.id, structure);
          seen.delete(s.id);
          continue;
        }
      }
    }
    for (const [id, s] of this.#structures) {
      if (!seen.has(id) && !s.retiring) this.#retire(id, s);
    }
    this.rebuildNavigation();
    this.#syncRoster();
    // After the roster, so the astronaut exists to be told.
    for (const id of fresh) {
      const activity = this.#structures.get(id)?.activity;
      if (activity) this.#crew?.astronauts.setGesture(id, gestureFor(activity));
    }
  }

  /**
   * The subagents running right now. Each gets a smaller astronaut that comes
   * out of its project's habitat, works beside it and goes back in when it
   * delivers -- up to `MAX_CADETS` a project.
   */
  setSubagents(subagents: readonly ColonySubagent[]): void {
    this.#subagents = subagents;
    this.#syncRoster();
  }

  /** The subagent behind a roster id, or null for a session's astronaut. */
  subagentOf(rosterId: string): ColonySubagent | null {
    if (!rosterId.startsWith(CADET_PREFIX)) return null;
    const id = rosterId.slice(CADET_PREFIX.length);
    return this.#subagents.find((a) => a.id === id) ?? null;
  }

  /** The session a helper's roster id works for, or null for anybody else. */
  helperOf(rosterId: string): string | null {
    if (!rosterId.startsWith(HELPER_PREFIX)) return null;
    const cut = rosterId.lastIndexOf('#');
    return cut > HELPER_PREFIX.length ? rosterId.slice(HELPER_PREFIX.length, cut) : null;
  }

  /** The session a roster id belongs to: its own, the one it helps, or the one that launched the subagent. */
  sessionOf(rosterId: string): string | null {
    if (rosterId.startsWith(HELPER_PREFIX)) return this.helperOf(rosterId);
    if (!rosterId.startsWith(CADET_PREFIX)) return rosterId;
    return this.subagentOf(rosterId)?.sessionId ?? null;
  }

  /* ───────────────────────── the crew ───────────────────────── */

  /** The crew exists: from now on every session has an astronaut as well as a structure. */
  attachCrew(crew: CrewAttachment): void {
    this.#crew = crew;
    crew.astronauts.setNavigation(crew.nav);
    this.rebuildNavigation();
    this.#syncRoster();
  }

  /** The planet changed: what boot dust looks like changes with it. */
  setPlanet(planet: { ground: { high: number } }): void {
    this.#dustTint.set(planet.ground.high);
  }

  /**
   * Reconcile the astronauts against the structures: one per session that is
   * standing, at a spot just outside its structure. Sessions already in the
   * store's first snapshot are `known` and appear in place; anything that
   * arrives later walks out of the ship. The store decides, not this file:
   * the first roster here can be empty for reasons that have nothing to do
   * with when a session started (the kit was not in yet).
   */
  #syncRoster(): void {
    const crew = this.#crew;
    if (!crew) return;
    const entries: RosterEntry[] = [];
    for (const [id, s] of this.#structures) {
      if (s.retiring) continue;
      const zone = this.#zones.get(s.projectId);
      if (!zone) continue;
      entries.push({
        id,
        status: s.status,
        provider: s.provider,
        site: this.#workSite(zone, s),
        // Where the work actually is. A working astronaut circles it rather
        // than standing at one spot, so it needs the structure, not just a
        // place to stand near it.
        anchor: s.building.mesh.position,
        known: s.known,
        seed: fnv1a32(id),
      });
    }
    // Small astronauts per project. Helpers go first: a session's own work
    // is what the deck is showing, and a helper never outnumbers its sessions.
    const small = new Map<string, number>();
    for (const [sessionId, s] of this.#structures) {
      if (s.retiring || !s.helper) continue;
      const zone = this.#zones.get(s.projectId);
      const habitat = this.#habitats.get(s.projectId);
      if (!zone || !habitat) continue;
      const count = small.get(s.projectId) ?? 0;
      if (count >= MAX_CADETS) continue;
      small.set(s.projectId, count + 1);
      const id = `${HELPER_PREFIX}${sessionId}#${s.helper.gen}`;
      const b = s.building.mesh.position;
      // Beside the same structure as its session's astronaut, a quarter turn
      // round from where that one stands first: two figures at one job.
      const site = this.#standBeside(zone, b, s.building.footprint, this.#outOf(zone, s) + Math.PI / 2);
      entries.push({
        id,
        status: helperStatus(),
        provider: s.provider,
        site,
        anchor: b,
        // Never `known`: it only comes out on a live call, so it always walks out.
        known: false,
        seed: fnv1a32(id),
        size: HELPER_SIZE,
        home: this.#doorOf(habitat, site),
      });
    }
    for (const sub of this.#subagents) {
      const parent = this.#structures.get(sub.sessionId);
      // A subagent stands with its session: no session on the map, no subagent.
      if (!parent || parent.retiring || parent.projectId !== sub.projectId) continue;
      const zone = this.#zones.get(sub.projectId);
      const habitat = this.#habitats.get(sub.projectId);
      if (!zone || !habitat) continue;
      const count = small.get(sub.projectId) ?? 0;
      if (count >= MAX_CADETS) continue;
      small.set(sub.projectId, count + 1);
      const id = CADET_PREFIX + sub.id;
      const seed = fnv1a32(id);
      const at = habitat.building.mesh.position;
      const site = this.#standBeside(zone, at, habitat.building.footprint, ((seed >>> 5) % 360) * (Math.PI / 180));
      entries.push({
        id,
        status: subagentStatus(),
        provider: parent.provider,
        site,
        anchor: at,
        known: sub.known,
        seed,
        size: CADET_SIZE,
        home: this.#doorOf(habitat, site),
      });
    }
    crew.astronauts.setRoster(entries, {
      shipDoor: (out) => crew.ship.shipDoor(out),
      shipWayIn: (out) => crew.ship.wayIn(out),
      groundAt: (x, z) => this.groundAt(x, z),
    });
  }

  /**
   * Where the astronaut stands: beside its structure, on the top deck, facing in.
   *
   * The deck is one hex, so "just outside the structure" can easily mean off
   * the edge -- and on a stack, off the edge is a drop to the ground, working
   * on a project from the dirt beside it. So the spot is chosen among four:
   * outward from the middle first, which fans the crew around the habitat;
   * then either way along the ring of spots; then inward. The first one that
   * is on the deck with room to stand and not walled in wins. Clear of the
   * structure's own footprint rather than a fixed distance: a standing spot
   * inside that radius is one the crew can never reach, and the astronaut
   * walks at the wall for as long as the session lives.
   */
  #workSite(zone: Zone, s: Structure): { x: number; y: number; z: number } {
    return this.#standBeside(zone, s.building.mesh.position, s.building.footprint, this.#outOf(zone, s));
  }

  /** The direction from the middle of the deck out through a structure. */
  #outOf(zone: Zone, s: Structure): number {
    const b = s.building.mesh.position;
    const dx = b.x - zone.center.x;
    const dz = b.z - zone.center.z;
    const len = Math.hypot(dx, dz);
    // A structure at the very middle has no outward direction: fan by spot.
    return len > 0.2 ? Math.atan2(dz, dx) : (s.slot * 2.4) % (Math.PI * 2);
  }

  /**
   * Where a small astronaut comes out of the habitat and goes back into it.
   *
   * The habitat's wall on the side of its site, a step outside what the grid
   * blocks: born inside the obstacle, it could never walk out of it.
   */
  #doorOf(habitat: Habitat, site: { x: number; z: number }): { x: number; y: number; z: number } {
    const at = habitat.building.mesh.position;
    const reach = habitat.building.footprint * 0.8 + AGENT_RADIUS + 0.2;
    const dx = site.x - at.x;
    const dz = site.z - at.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: at.x + (dx / len) * reach, y: 0, z: at.z + (dz / len) * reach };
  }

  /**
   * A spot on the top deck beside something `footprint` wide, tried from direction `out` first.
   *
   * "Free" means reachable from the ramp, not just not built on. With the kerb a wall, two
   * wide structures on neighbouring spots can close off the stretch of deck between them,
   * and a site in there is one its astronaut walks at, from outside, for as long as the
   * session lives.
   */
  #standBeside(zone: Zone, b: THREE.Vector3, footprint: number, out: number): { x: number; y: number; z: number } {
    const blocked = footprint * 0.8 + AGENT_RADIUS;
    const stand = Math.max(2.35, blocked + 0.5);
    const nav = this.#crew?.nav;
    const reach = nav ? this.#reachable(zone, nav) : null;
    const free = (x: number, z: number): boolean =>
      !nav || (!nav.isBlocked(x, z) && (!reach || reach.has(nav.indexOf(x, z))));
    let fallback: { x: number; z: number } | null = null;
    for (const a of [out, out + Math.PI / 2, out - Math.PI / 2, out + Math.PI]) {
      const x = b.x + Math.cos(a) * stand;
      const z = b.z + Math.sin(a) * stand;
      if (!zone.holds(x, z)) continue;
      if (free(x, z)) return { x, y: 0, z };
      fallback ??= { x, z };
    }
    // Everything around it is taken: nudge the best candidate to the nearest
    // ground the ramp leads to. A trap on the deck is better than a free spot
    // on the ground beside it, and neither is as good as a spot you can get to.
    const at = fallback ?? { x: b.x + Math.cos(out + Math.PI) * stand, z: b.z + Math.sin(out + Math.PI) * stand };
    if (nav && reach) {
      let best = -1;
      let bestD = Infinity;
      for (const i of reach) {
        const d = Math.hypot(nav.toWorld(i % nav.size) - at.x, nav.toWorld(Math.floor(i / nav.size)) - at.z);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best >= 0) return { x: nav.toWorld(best % nav.size), y: 0, z: nav.toWorld(Math.floor(best / nav.size)) };
    }
    const near = nav?.nearestFree(at.x, at.z);
    if (nav && near) {
      const x = nav.toWorld(near.ix);
      const z = nav.toWorld(near.iz);
      if (zone.holds(x, z, 0.4)) return { x, y: 0, z };
    }
    return { x: at.x, y: 0, z: at.z };
  }

  /**
   * The cells of a zone's deck its crew can walk to from the top of the ramp, for the
   * current grid; null if the landing itself is walled in, which leaves the old rule --
   * anywhere not built on -- rather than no site at all.
   */
  #reachable(zone: Zone, nav: Navigation): Set<number> | null {
    const had = this.#reach.get(zone.id);
    if (had && had.version === nav.version) return had.cells.size ? had.cells : null;
    const landing = zone.landing(new THREE.Vector3());
    const cells = nav.flood(landing.x, landing.z, (x, z) => zone.holds(x, z, 0));
    this.#reach.set(zone.id, { version: nav.version, cells });
    return cells.size ? cells : null;
  }

  /**
   * Hand the navigation grid the colony's current footprint.
   *
   * The blocking radius is a building's footprint trimmed a little, plus the
   * astronaut's own width. The trim matters: the footprint already
   * over-covers anything that is not round, and blocking the full extent
   * closes the gaps between structures, which is exactly where the crew
   * needs to walk. Clutter and scatter count too: a crate is only knee-high,
   * but an astronaut walking straight through one is exactly as wrong as one
   * walking through a habitat.
   */
  rebuildNavigation(): void {
    const crew = this.#crew;
    if (!crew) return;
    const obstacles: Obstacle[] = [];
    for (const h of this.#habitats.values()) {
      const p = h.building.mesh.position;
      obstacles.push({ x: p.x, z: p.z, r: h.building.footprint * 0.8 + AGENT_RADIUS });
    }
    for (const s of this.#structures.values()) {
      if (s.retiring) continue;
      const p = s.building.mesh.position;
      obstacles.push({ x: p.x, z: p.z, r: s.building.footprint * 0.8 + AGENT_RADIUS });
    }
    const walls: Wall[] = [];
    for (const zone of this.#zones.values()) {
      const { x, z } = zone.center;
      for (const spot of zone.clutterSpots) {
        obstacles.push({ x: x + spot.x, z: z + spot.z, r: spot.r + AGENT_RADIUS });
      }
      // The kerb is the edge of the stack: the way on and off it is the ramp.
      for (const k of zone.kerbLines) {
        walls.push({ x0: x + k.x0, z0: z + k.z0, x1: x + k.x1, z1: z + k.z1, r: k.r + AGENT_RADIUS });
      }
    }
    for (const o of crew.scatterObstacles()) obstacles.push({ x: o.x, z: o.z, r: o.r + AGENT_RADIUS });
    const hq = hqPlacement();
    obstacles.push({ x: hq.x, z: hq.z, r: SHIP_OBSTACLE_RADIUS + AGENT_RADIUS });
    crew.nav.rebuild(obstacles, walls);
  }

  /**
   * A tool call started. The project's pace goes up (the kerb light runs
   * faster), the astronaut's hands change to the shape of the work, and
   * sparks fly in its colour, the same colour as the lamp that lit for it.
   */
  toolStart(sessionId: string, cat: ToolCategory, at: number): void {
    const s = this.#structures.get(sessionId);
    if (!s || s.retiring) return;
    s.activity = cat;
    this.#pace.hit(s.projectId, at);
    // The first call brings the helper out; the rest only keep it out. From
    // when the call reached us, if that is later: an event can be up to
    // `LIVE_EVENT_MS` old, and a linger already spent would send the helper
    // back in the frame after it came out.
    const until = Math.max(at, this.#clock()) + HELPER_LINGER_MS;
    if (s.helper) {
      s.helper.until = Math.max(s.helper.until, until);
    } else {
      s.helper = { gen: ++s.helperGen, until };
      this.#syncRoster();
    }
    const gesture = gestureFor(cat);
    const helper = this.#helperId(sessionId, s);
    this.#crew?.astronauts.setGesture(sessionId, gesture);
    if (helper) this.#crew?.astronauts.setGesture(helper, gesture);
    this.#spark(sessionId, TOOL_COLOR[cat]);
    if (helper) this.#spark(helper, TOOL_COLOR[cat]);
  }

  /** A file was written: the structure lights its construction band, one more course laid. */
  fileWritten(sessionId: string): void {
    const s = this.#structures.get(sessionId);
    if (s && !s.retiring) s.band = 1;
  }

  /** A turn ended: the astronaut hops once, then goes on with whatever it does now. */
  turnEnd(sessionId: string): void {
    this.#crew?.astronauts.cue(sessionId, 'hop');
    const s = this.#structures.get(sessionId);
    const helper = s ? this.#helperId(sessionId, s) : null;
    if (!s?.helper || !helper) return;
    // The helper hops with it before it goes back in, not while it is already walking.
    s.helper.until = Math.max(s.helper.until, this.#clock() + HELPER_HOP_MS);
    this.#crew?.astronauts.cue(helper, 'hop');
  }

  /** You sent a prompt: the astronaut stops and looks back at the ship it came from. */
  prompt(sessionId: string): void {
    this.#crew?.astronauts.cue(sessionId, 'heed');
  }

  /** Flash the kerb of whichever zone stands at a world point: a crate just landed there. */
  flashAt(x: number, z: number, color: number): void {
    this.#deckAt(x, z)?.flash(color);
  }

  /** Whether a stack is still rising into place: what stands on its root has to follow it. */
  get lifting(): boolean {
    return this.#lifts.size > 0;
  }

  /** The roster id of a session's helper while one is out, or null. */
  #helperId(sessionId: string, s: Structure): string | null {
    return s.helper && !s.retiring ? `${HELPER_PREFIX}${sessionId}#${s.helper.gen}` : null;
  }

  /** The structure a roster id works at: its session's for a session or a helper, none for a subagent. */
  #structureOf(rosterId: string): Structure | undefined {
    if (rosterId.startsWith(CADET_PREFIX)) return undefined;
    return this.#structures.get(this.helperOf(rosterId) ?? rosterId);
  }

  #spark(rosterId: string, color: number): void {
    const crew = this.#crew;
    if (!crew || !crew.particles.enabled) return;
    const agent = crew.astronauts.byId.get(rosterId);
    if (!agent || agent.state !== 'at-site' || agent.scale < 0.5) return;
    this.#handOf(agent);
    crew.particles.weld(this.#handAt.x, this.#handAt.y, this.#handAt.z, this.#color.set(color), agent.groundY);
  }

  /** A commit landed on the project: everybody at that zone cheers, in the kind's colour. */
  commit(projectId: string, kind: keyof typeof RING_COLOR): void {
    const crew = this.#crew;
    if (!crew) return;
    for (const [sessionId, s] of this.#structures) {
      if (s.projectId !== projectId || s.retiring) continue;
      for (const id of [sessionId, this.#helperId(sessionId, s)]) {
        const agent = id === null ? undefined : crew.astronauts.byId.get(id);
        if (!id || !agent || agent.state !== 'at-site') continue;
        crew.astronauts.celebrate(id, CHEER_S);
        // The confetti goes up the moment the cheer starts. The source waited
        // for the hop, but the hop is in the clip now and the agent never
        // reports one: a trigger that never fires is the bug this replaces.
        if (crew.particles.enabled) {
          crew.particles.cheer(agent.pos.x, agent.pos.y, agent.pos.z, this.#color.set(RING_COLOR[kind]), agent.groundY);
        }
      }
    }
  }

  /** The astronaut under a screen point, if any. */
  pick(ndcX: number, ndcY: number, aspect: number, camera: THREE.Camera): string | null {
    return this.#crew?.astronauts.pick(ndcX, ndcY, aspect, camera)?.id ?? null;
  }

  /**
   * The project whose top deck is under a screen point, if any.
   *
   * Analytic, not a raycast of the kit: the ray meets each stack's top face
   * as a plane, and the deck says whether the point is on it (`onTile`, the
   * same rule that tells where a point stands). Cheap enough for every
   * pointer move; the sides of a tall stack do not count, the face does.
   */
  pickProject(ndcX: number, ndcY: number, camera: THREE.Camera): string | null {
    this.#pickRay.setFromCamera(this.#pickNdc.set(ndcX, ndcY), camera);
    const { origin, direction } = this.#pickRay.ray;
    if (direction.y >= 0) return null;
    let best: string | null = null;
    let nearest = Infinity;
    for (const [id, zone] of this.#zones) {
      const top = this.#decked.get(zone.key) ?? zone.top;
      const t = (top - origin.y) / direction.y;
      if (t <= 0 || t >= nearest) continue;
      const x = origin.x + direction.x * t;
      const z = origin.z + direction.z * t;
      if (!onTile(x - zone.center.x, z - zone.center.z)) continue;
      nearest = t;
      best = id;
    }
    return best;
  }

  setHover(sessionId: string | null): void {
    const crew = this.#crew;
    if (!crew) return;
    crew.astronauts.setHover(sessionId === null ? null : crew.astronauts.byId.get(sessionId) ?? null);
  }

  setSelected(sessionId: string | null): void {
    const crew = this.#crew;
    if (!crew) return;
    crew.astronauts.setSelected(sessionId === null ? null : crew.astronauts.byId.get(sessionId) ?? null);
  }

  #handOf(agent: Agent): void {
    this.#handAt.set(
      agent.pos.x + Math.sin(agent.yaw) * 0.55,
      agent.pos.y + 0.55,
      agent.pos.z + Math.cos(agent.yaw) * 0.55,
    );
  }

  /** Particle emission, driven by what each astronaut is doing. */
  #emit(dt: number): void {
    const crew = this.#crew;
    if (!crew || !crew.particles.enabled) return;
    const p = crew.particles;
    const full = crew.full();
    for (const agent of crew.astronauts.agents) {
      if (agent.scale < 0.5) continue;
      // What this one is standing on, which on a zone is the deck rather than
      // the terrain under it: everything thrown off an astronaut has to land
      // back on the same surface.
      const ground = agent.groundY;
      const atSite = agent.state === 'at-site';

      if (atSite && agent.status === 'working') {
        const color = this.#workColor(agent.id);
        // Sparks on the downbeat of the swing, not every frame, in the
        // colour of what the session last called.
        if (agent.workSwing) {
          this.#handOf(agent);
          p.weld(this.#handAt.x, this.#handAt.y, this.#handAt.z, this.#color.set(color), ground);
          // A shell command: the structure lets off steam on every blow.
          const b = agent.gesture === 'operate' ? this.#structureOf(agent.id)?.building : undefined;
          if (b) p.steam(b.mesh.position.x, b.mesh.position.y + risen(b) * 0.7, b.mesh.position.z, b.mesh.position.y);
        }
        // The network: a thread of light leaving the top of the structure.
        if (agent.gesture === 'uplink' && Math.random() < dt * 2.5) {
          const b = this.#structureOf(agent.id)?.building;
          if (b) p.uplink(b.mesh.position.x, b.mesh.position.y + risen(b), b.mesh.position.z, this.#color.set(color));
        }
      }

      if (atSite && agent.status === 'sleeping' && Math.random() < dt * 0.35) {
        p.snooze(agent.pos.x + 0.2, agent.pos.y + 1.05, agent.pos.z + 0.15);
      }

      // Boot dust, on the footfall.
      if (full && agent.walkAmp > 0.4) {
        const step = Math.sin(agent.phase);
        if (step < -0.9 && !this.#stepped.has(agent.id)) {
          this.#stepped.add(agent.id);
          p.step(agent.pos.x, agent.pos.y, agent.pos.z, this.#dustTint, ground);
        } else if (step > 0) {
          this.#stepped.delete(agent.id);
        }
      }

      // The ramp notices anyone stepping on or off it. Not a helper or a
      // subagent: they use the habitat's door, and a helper comes out every
      // turn, which would keep the ship's lights twitching at nothing.
      const small = agent.id.startsWith(HELPER_PREFIX) || agent.id.startsWith(CADET_PREFIX);
      if (!small && (agent.state === 'spawning' || agent.state === 'boarding')) {
        if (Math.random() < dt * 3) crew.ship.ping();
      }
    }
  }

  /** The colour of an astronaut's work: its last tool's, violet for a subagent, mint before any. */
  #workColor(rosterId: string): number {
    if (rosterId.startsWith(CADET_PREFIX)) return TOOL_COLOR.agent;
    const cat = this.#structureOf(rosterId)?.activity;
    return cat ? TOOL_COLOR[cat] : SPARK;
  }

  #file(q: number, r: number, zone: Zone): void {
    const key = cellKey({ q, r });
    const list = this.#over.get(key);
    if (list) list.push(zone);
    else this.#over.set(key, [zone]);
  }

  /** The zone whose top deck is under a world point, rim included, or null over bare ground. */
  #deckAt(x: number, z: number, key = cellKey(worldToHex(x, z))): Zone | null {
    const zones = this.#over.get(key);
    if (!zones) return null;
    for (const zone of zones) {
      if (onTile(x - zone.center.x, z - zone.center.z)) return zone;
    }
    return null;
  }

  /** Move a zone's stack, and everything standing on it, `offset` below its real top. */
  #applyLift(projectId: string, offset: number): void {
    const zone = this.#zones.get(projectId);
    if (!zone) return;
    const y = zone.top + offset;
    zone.group.position.y = zone.center.y + offset;
    this.#roots.get(projectId)?.setY(y);
    const habitat = this.#habitats.get(projectId);
    if (habitat) habitat.building.mesh.position.y = y;
    for (const s of this.#structures.values()) {
      if (s.projectId === projectId) s.building.mesh.position.y = y;
    }
    this.#decked.set(zone.key, y);
    // The crew reads the deck through `groundAt`, and only after taking a
    // step: told, whoever stands on it rides the push instead of staying down.
    this.#crew?.astronauts.groundMoved();
  }

  #stepLifts(dt: number): void {
    for (const [id, lift] of this.#lifts) {
      lift.t += dt;
      const k = Math.min(1, lift.t / LIFT_S);
      // Ease-out: the push is quick, the last centimetres settle.
      lift.offset = lift.from * Math.pow(1 - k, 3);
      this.#applyLift(id, lift.offset);
      if (k >= 1) this.#lifts.delete(id);
    }
  }

  /**
   * The first free spot of a zone from index 1 up, frozen for the session:
   * a spot stays taken until the structure on it has sunk out of sight, so
   * a session that came back while its structure was still retiring finds
   * its own spot, not a sibling's.
   */
  #claimSlot(projectId: string): number {
    const taken = new Set<number>();
    for (const s of this.#structures.values()) {
      if (s.projectId === projectId) taken.add(s.slot);
    }
    const spots = ZONE_SPOTS;
    for (let i = 1; i < spots; i++) if (!taken.has(i)) return i;
    // Every spot taken: double up on the least used, wrapping as the layout does.
    return 1 + (taken.size % Math.max(1, spots - 1));
  }

  #retire(id: string, s: Structure): void {
    s.retiring = true;
    s.target = 0;
    if (s.building.progress <= GONE) this.#drop(id, s);
  }

  #drop(id: string, s: Structure): void {
    this.object3d.remove(s.building.mesh);
    s.building.dispose();
    this.#structures.delete(id);
    this.#stepped.delete(id);
  }

  #placeHead(s: Structure, agent: Agent | undefined): void {
    // On the helmet once there is an astronaut on the surface; on the top of
    // the structure before that. The vector is the same object either way,
    // so whoever holds it never has to be told which.
    if (agent && agent.state !== 'gone' && agent.scale > 0.5) {
      s.head.copy(agent.head);
      return;
    }
    const p = s.building.mesh.position;
    s.head.set(p.x, p.y + risen(s.building) + 0.35, p.z);
  }

  /* ───────────────────────── anchors ───────────────────────── */

  /** The centre of a project's top deck. Live: the same vector every time. */
  positionOf(projectId: string): THREE.Vector3 | null {
    return this.#roots.get(projectId) ?? null;
  }

  /** How tall the habitat stands right now. */
  heightOf(projectId: string): number {
    const h = this.#habitats.get(projectId);
    return h ? risen(h.building) : 0;
  }

  /** How wide the zone is: what a camera frame measures against. */
  footprintOf(projectId: string): number {
    const zone = this.#zones.get(projectId);
    return zone ? zone.radius : HEX_SIZE;
  }

  zoneMetrics(projectId: string): ZoneMetrics | null {
    const zone = this.#zones.get(projectId);
    const root = this.#roots.get(projectId);
    return zone && root ? { root, levels: zone.levels } : null;
  }

  /**
   * The top of a project's habitat, as it stands right now: where its name
   * sits, and the badges of its sessions above the name. LIVE, like `headOf`:
   * it is moved every frame as the habitat rises, so the caller keeps it and
   * never asks again. The label used to take `heightOf` once, when
   * it was built -- and it is built as the kit lands, with the habitat still
   * at zero, and rebuilt every second only while a session is busy. On a quiet
   * colony the names stayed down inside the buildings they were rising out of.
   */
  summitAt(projectId: string): THREE.Vector3 | null {
    return this.#habitats.get(projectId)?.summit ?? null;
  }

  /**
   * The top of a session: its structure as it rises, then the astronaut's
   * helmet once there is one. LIVE: the caller keeps it and reads it every
   * frame. Never a copy.
   */
  headOf(sessionId: string): THREE.Vector3 | null {
    return this.#structures.get(sessionId)?.head ?? null;
  }

  zoneOf(projectId: string): Zone | null {
    return this.#zones.get(projectId) ?? null;
  }

  get zones(): Iterable<Zone> {
    return this.#zones.values();
  }

  /**
   * How fast the rotors turn right now, as a multiple of their authored pace:
   * a session's structure by session id, a habitat by project id.
   */
  rotorRate(id: string): number | null {
    return this.#structures.get(id)?.spin ?? this.#habitats.get(id)?.spin ?? null;
  }

  /** Whether a session has a structure that is not on its way out. */
  standing(sessionId: string): boolean {
    const s = this.#structures.get(sessionId);
    return Boolean(s && !s.retiring);
  }

  /**
   * How high the ground is at a world point: the surface anything walking
   * stands on. Over a deck it is the top of that stack; on a ramp, the
   * ramp, as long as it is above the terrain -- at the foot the ground takes
   * over wherever it rises past the slab; everywhere else the terrain.
   */
  groundAt(x: number, z: number): number {
    const key = cellKey(worldToHex(x, z));
    const on = this.#deckAt(x, z, key);
    if (on) return this.#decked.get(on.key) ?? on.top;
    const ground = this.#groundHeight(x, z);
    const zone = this.#ramps.get(key);
    const ramp = zone ? zone.rampHeight(x, z) : null;
    if (!zone || ramp === null) return ground;
    // A stack still rising carries its ramp with it.
    const lift = (this.#decked.get(zone.key) ?? zone.top) - zone.top;
    return Math.max(ground, ramp + lift);
  }

  /* ───────────────────────── per frame ───────────────────────── */

  setNight(night: number): void {
    this.#night = night;
  }

  update(dt: number, now: number): void {
    buildingUniforms.uNight.value = this.#night;
    this.#stepLifts(dt);

    // What every project asks of its rotors and its kerb, from its live sessions.
    const busy = this.#busy;
    busy.clear();
    for (const s of this.#structures.values()) {
      if (s.retiring) continue;
      const rate = ROTOR_RATE[s.status];
      const had = busy.get(s.projectId);
      busy.set(s.projectId, {
        rate: Math.max(rate, had?.rate ?? 0),
        working: s.status === 'working' || (had?.working ?? false),
      });
    }

    for (const [id, h] of this.#habitats) {
      grow(h.building, h.target, dt);
      placeSummit(h.building, h.summit);
      h.spin = THREE.MathUtils.damp(h.spin, busy.get(id)?.rate ?? ROTOR_RATE.none, ROTOR_DAMP, dt);
      if (h.building.hasRotor) h.building.turn(dt * h.spin);
    }

    for (const [id, s] of this.#structures) {
      grow(s.building, s.target, dt);
      const scale = s.building.mesh.scale;
      const size = THREE.MathUtils.damp(scale.x, s.size, GROW_DAMP, dt);
      if (Math.abs(size - scale.x) > 0.0005) scale.setScalar(size);
      if (s.retiring && s.building.progress <= GONE) {
        this.#drop(id, s);
        continue;
      }
      this.#placeHead(s, this.#crew?.astronauts.byId.get(id));
      s.spin = THREE.MathUtils.damp(s.spin, s.retiring ? 0 : ROTOR_RATE[s.status], ROTOR_DAMP, dt);
      if (s.building.hasRotor) s.building.turn(dt * s.spin);
      if (s.band > 0) {
        s.band = Math.max(0, s.band - dt / BAND_S);
        s.building.setBand(s.band);
      }
    }
    this.#emit(dt);

    const clock = this.#clock();
    // A helper goes back in once its session stopped working and the last
    // call has lingered long enough to be seen. The whole turn, not a timer
    // per call: a Bash that runs for minutes is still the turn's work.
    let helpersLeft = false;
    for (const s of this.#structures.values()) {
      if (!s.helper) continue;
      if (s.retiring || (s.status !== 'working' && clock >= s.helper.until)) {
        s.helper = null;
        helpersLeft = true;
      }
    }
    if (helpersLeft) this.#syncRoster();

    for (const zone of this.#zones.values()) {
      let chase = this.#chase.get(zone.id);
      if (!chase) {
        // Each kerb starts its light somewhere of its own, so two busy
        // neighbours never run in lockstep.
        chase = { amount: 0, head: (fnv1a32(zone.id) % 628) / 100 };
        this.#chase.set(zone.id, chase);
      }
      const working = busy.get(zone.id)?.working ?? false;
      chase.amount = THREE.MathUtils.damp(chase.amount, working ? 1 : 0, CHASE_DAMP, dt);
      if (chase.amount < 0.005) chase.amount = 0;
      if (chase.amount > 0) {
        chase.head = (chase.head + dt * chaseSpeed(this.#pace.perMinute(zone.id, clock))) % (Math.PI * 2);
      }
      zone.setChase(chase.amount, chase.head);
      zone.setNight(this.#night, this.#urgent.has(zone.id), now);
    }
  }

  dispose(): void {
    for (const zone of this.#zones.values()) zone.dispose();
    for (const h of this.#habitats.values()) h.building.dispose();
    for (const s of this.#structures.values()) s.building.dispose();
    this.#zones.clear();
    this.#habitats.clear();
    this.#structures.clear();
  }
}

function grow(building: Building, target: number, dt: number): void {
  const next = THREE.MathUtils.damp(building.progress, target, GROW_DAMP, dt);
  if (Math.abs(next - building.progress) > 0.0005) building.setProgress(next);
}

/** How far a building stands above its foot right now: out of the deck, at its current size. */
function risen(building: Building): number {
  return building.height * building.progress * building.mesh.scale.y;
}

/** The summit of a building as it stands: its foot plus its risen height. */
function placeSummit(building: Building, summit: THREE.Vector3): void {
  const p = building.mesh.position;
  summit.set(p.x, p.y + risen(building), p.z);
}
