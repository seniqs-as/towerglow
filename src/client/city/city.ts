import * as THREE from 'three';
import type { AgentInfo, DeltaEvent, ProjectInfo, SessionInfo } from '../../shared/protocol.ts';
import { Lights } from '../state/lights.ts';
import type { Light } from '../state/lights.ts';
import { Stage } from './stage.ts';
import type { Layer } from './stage.ts';
import { Buildings } from './buildings.ts';
import { Pulses } from './pulses.ts';
import { Windows } from './windows.ts';
import type { GitEvent } from '../../shared/rings.ts';
import { Towers } from './towers.ts';
import { PROVIDER_BOTH, PROVIDER_COLOR } from './palette.ts';
import {
  buildingHeight, CELL_PITCH, cityRadius, clampPitch, floorsForSize, placeSlot, windowCapacity,
} from './layout.ts';

/** Where a nameplate or a badge hangs: a point, and how far above it. */
export interface Anchor {
  position: THREE.Vector3;
  offsetY: number;
}

/**
 * The city view: one tower per project, its windows lit by the work, the
 * history in rings on the roof. Towers and nothing else: no HQ (the user's
 * call, 2026-09-24), and no figure for a session either (2026-09-28). A
 * capsule stood at a desk inside, and from any distance it was a dot at the
 * foot of every tower with somebody in it -- first read as a lit window, then,
 * once its glow was round, as "that sort of dot at the base". The tower's
 * tint already says who is in, and its badge what they are doing.
 *
 * It is the project's first drawing, brought back as the view the page opens on:
 * a few hundred triangles where the colony draws a whole planet, so it runs
 * on any machine. It reads the same store as the colony and decides nothing;
 * whatever the colony does besides drawing -- the ship you walk into, the
 * desk that opens Planning -- stays the colony's.
 *
 * What that first drawing also had and this does not, all dropped by the user's call on
 * 2026-09-24: the traffic, coloured trails running along the streets beside
 * every busy building; the octagonal HQ north of the city; and the turrets on
 * its roof, one per CEO worker -- here a worker is a session on its own lot,
 * in the city as in the colony.
 *
 * It has its own canvas and its own renderer. Two views on one WebGL context
 * would mean two sets of GL state fighting in one three.js renderer; a second
 * context costs one of the few the browser grants, and only the view on
 * screen runs a frame loop.
 */
export class City {
  readonly stage: Stage;
  /**
   * The city's own lights. Same events as the colony's, different seats: a
   * tower has sixteen windows a floor, a zone has eleven lamps. One `Lights`
   * for both would have to choose, and either one would lose.
   */
  readonly lights: Lights;

  #buildings = new Buildings();
  #ray = new THREE.Raycaster();
  #ndc = new THREE.Vector2();
  #pulses = new Pulses();
  #windows = new Windows();
  #towers = new Towers();
  #sizeOf: (projectId: string) => number;
  #sessions: () => Iterable<SessionInfo>;
  #dirty = false;
  #from = new THREE.Vector3();
  #to = new THREE.Vector3();
  /** How far apart the towers stand: the setting, as it is drawn. */
  #pitch = CELL_PITCH;
  /** The projects on the map, kept to place them again when the spacing changes. */
  #projects: readonly ProjectInfo[] = [];

  constructor(
    canvas: HTMLCanvasElement,
    opts: {
      /** A project's size in files: how tall its tower is. */
      sizeOf: (projectId: string) => number;
      sessions: () => Iterable<SessionInfo>;
      /** Distance between two towers, centre to centre. The layout's own if left out. */
      pitch?: number;
    },
  ) {
    this.#sizeOf = opts.sizeOf;
    this.#sessions = opts.sessions;
    if (opts.pitch !== undefined) this.#pitch = clampPitch(opts.pitch);
    this.stage = new Stage(canvas);
    this.lights = new Lights((projectId) => windowCapacity(floorsForSize(this.#sizeOf(projectId))));
    this.stage.addLayer(this.#buildings);
    this.stage.addLayer(this.#windows);
    this.stage.addLayer(this.#towers);
    this.stage.addLayer(this.#pulses);
    // Windows are redrawn once per frame at most: a burst of calls arrives in
    // a single batch, and redrawing on every event would redo the facade ten
    // times to show one.
    this.stage.addLayer({
      object3d: new THREE.Group(),
      update: () => {
        if (!this.#dirty) return;
        this.#dirty = false;
        this.#windows.setLights(this.lights.values(), (id) => this.#metrics(id));
      },
      dispose: () => {},
    });
  }

  /** Something that has to run every frame the city is drawn. */
  addLayer(layer: Layer): void {
    this.stage.addLayer(layer);
  }

  get camera(): THREE.PerspectiveCamera {
    return this.stage.camera;
  }

  /**
   * The buildings, after the projects on the map changed. `projects` carries
   * the compacted slots, the same ones the colony draws with.
   */
  setProjects(projects: readonly ProjectInfo[]): void {
    this.#projects = projects;
    this.#buildings.setProjects(projects, (id) => this.#tint(id), this.#pitch);
    this.#towers.place((id) => this.#metrics(id));
    // Windows hang on the facades: if the city moved, they go back on the right ones.
    this.#dirty = true;
    this.setPresence(projects);
  }

  get pitch(): number {
    return this.#pitch;
  }

  /**
   * Spread the towers out or pull them in. Every tower keeps its cell, so it
   * keeps its neighbours: only the distance between the cells moves. True if
   * the city moved, so whoever hangs things on the towers knows to hang them
   * again.
   */
  setPitch(pitch: number): boolean {
    const next = clampPitch(pitch);
    if (next === this.#pitch) return false;
    this.#pitch = next;
    this.setProjects(this.#projects);
    return true;
  }

  /** Who is in: the building's tint, and the pulse of a waiting one. */
  setPresence(projects: Iterable<ProjectInfo>): void {
    const waiting = new Set<string>();
    for (const s of this.#sessions()) if (s.status === 'waiting') waiting.add(s.projectId);
    for (const p of projects) {
      this.#buildings.setActive(p.id, this.#tint(p.id), !p.exists);
      this.#buildings.setWaiting(p.id, waiting.has(p.id));
    }
  }

  /** Every delta the colony sees: a pulse, a ring, a window. */
  apply(event: DeltaEvent, sessions: ReadonlyMap<string, SessionInfo>): void {
    if (event.t === 'tool.start') this.#pulse(event, sessions);
    // The rings come whole from `setRings`, decided by the ledger: an event
    // drawn here as it arrived was a history replayed after every restart.
    if (event.t === 'git') return;
    if (this.lights.apply(event, sessions)) this.#dirty = true;
  }

  /**
   * The rings on the towers, as the ledger has them (`shared/rings.ts`).
   *
   * Each ring is born at the instant of its COMMIT, moved onto the shader's
   * clock: otherwise a history already on disk would pulse as if it had just
   * happened.
   */
  setRings(events: readonly GitEvent[]): void {
    const nowSec = performance.now() / 1000;
    const nowMs = Date.now();
    this.#towers.set(events, (at) => nowSec - (nowMs - at) / 1000);
    this.#towers.place((id) => this.#metrics(id));
  }

  /** Turns and agents on and off according to the state, as the colony's lights do. */
  sync(sessions: ReadonlyMap<string, SessionInfo>, agents: ReadonlyMap<string, AgentInfo>, now: number): void {
    if (this.lights.sync(sessions, agents, now)) this.#dirty = true;
  }

  /** A window goes dark when its time is up, not when an event arrives. */
  prune(now: number): void {
    if (this.lights.prune(now)) this.#dirty = true;
  }

  /** The lit window under the pointer, if any. */
  pick(x: number, y: number): Light | null {
    return this.#windows.pick(x, y, this.stage.camera, window.innerWidth, window.innerHeight);
  }

  /** The project whose tower is under the pointer, in client pixels. */
  pickProject(x: number, y: number): string | null {
    this.#ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
    this.#ray.setFromCamera(this.#ndc, this.stage.camera);
    return this.#buildings.pick(this.#ray);
  }

  /** Where a project's nameplate hangs: over its roof. */
  anchorOf(projectId: string): Anchor | null {
    const position = this.#buildings.positionOf(projectId);
    if (!position) return null;
    return { position, offsetY: this.#buildings.heightOf(projectId) + NAME_GAP };
  }

  /**
   * Frame where the work is. It gives up once you have moved the camera,
   * unless `force`: then it is a key you pressed.
   */
  frame(visible: readonly ProjectInfo[], active: ReadonlySet<string>, force = false): void {
    const tallest = visible.reduce((max, p) => Math.max(max, buildingHeight(p.size)), 0);
    this.stage.frameCity(framingBox(visible, force ? null : active, this.#pitch), tallest, force);
  }

  /** One building up close: its lot and its full height. */
  zoomTo(projectId: string): boolean {
    const at = this.#buildings.positionOf(projectId);
    if (!at) return false;
    const height = this.#buildings.heightOf(projectId);
    const span = (this.#buildings.footprintOf(projectId) * 2 + height * 0.6) * 1.1;
    this.stage.frameSpot({ x: at.x, y: height * 0.45, z: at.z }, span);
    return true;
  }

  start(): void {
    this.stage.start();
  }

  stop(): void {
    this.stage.stop();
  }

  /** What the windows and the rings need to find their facade. */
  #metrics(projectId: string): { position: THREE.Vector3 | null; height: number; footprint: number; size: number } {
    return {
      position: this.#buildings.positionOf(projectId),
      height: this.#buildings.heightOf(projectId),
      footprint: this.#buildings.footprintOf(projectId),
      size: this.#sizeOf(projectId),
    };
  }

  /**
   * An occupied building's colour: its tool's, or a neutral one when both
   * work there -- then neither should look like the landlord, and the badges
   * say who is in.
   */
  #tint(projectId: string): number | null {
    let claude = false;
    let codex = false;
    for (const s of this.#sessions()) {
      if (s.projectId !== projectId) continue;
      if (s.provider === 'claude') claude = true;
      else codex = true;
    }
    if (claude && codex) return PROVIDER_BOTH;
    if (claude) return PROVIDER_COLOR.claude;
    if (codex) return PROVIDER_COLOR.codex;
    return null;
  }

  /**
   * From tool call to pulse. The direction tells the kind of work: up for
   * what leaves the city, across to the neighbour when one agent talks to
   * another.
   *
   * A shell command sends none (the user's call, 2026-10-14). Its spark left
   * the tower at mid-height and fell below the ground, and through the glass
   * it read as a lit window dropping down the facade -- the most common call
   * there is, and for Codex nearly every one. Its window already says it.
   */
  #pulse(event: Extract<DeltaEvent, { t: 'tool.start' }>, sessions: ReadonlyMap<string, SessionInfo>): void {
    if (event.cat === 'exec') return;
    const session = sessions.get(event.sessionId);
    if (!session) return;
    const base = this.#buildings.positionOf(session.projectId);
    if (!base) return;
    const height = this.#buildings.heightOf(session.projectId);
    const now = performance.now() / 1000;
    this.#from.set(base.x, height * 0.45, base.z);

    const target = event.target;
    if (target?.kind === 'peer') {
      // A message to another agent really crosses the city.
      let peer: SessionInfo | undefined;
      for (const s of sessions.values()) if (s.label === target.name) { peer = s; break; }
      const peerBase = peer ? this.#buildings.positionOf(peer.projectId) : null;
      if (peer && peerBase) {
        this.#to.set(peerBase.x, this.#buildings.heightOf(peer.projectId) * 0.5, peerBase.z);
        this.#pulses.spawn(this.#from, this.#to, event.cat, now, { size: 18, arc: 14, duration: 1.6 });
        return;
      }
    }
    switch (event.cat) {
      case 'net':
        // To the antenna on the roof and beyond: the one place where
        // something crosses the city's border.
        this.#to.set(base.x, height + 55, base.z);
        break;
      case 'agent':
        // Out to the corner where four lots meet, wherever the spacing puts
        // it: a fixed 14 units landed inside the neighbour across the
        // diagonal as soon as the towers stood close.
        this.#to.set(base.x + this.#pitch / 2, height * 0.8, base.z + this.#pitch / 2);
        break;
      default:
        this.#to.set(base.x, height + 9, base.z);
        break;
    }
    this.#pulses.spawn(this.#from, this.#to, event.cat, now);
  }
}

/** How far above the roof a project's name floats. */
const NAME_GAP = 2.4;

/**
 * What to frame: how wide the city is AND where its centre is -- the
 * rectangle that really holds it, not the origin, since the city grows away
 * from the north plaza. With `active`, the live sessions first: they are the centre of
 * attention, and framing fifteen projects means seeing all of them badly.
 */
export function framingBox(
  visible: readonly ProjectInfo[],
  active: ReadonlySet<string> | null,
  pitch = CELL_PITCH,
): { cx: number; cz: number; radius: number } {
  const passes: ((p: ProjectInfo) => boolean)[] = active
    ? [(p) => active.has(p.id), () => true]
    : [() => true];
  for (const wanted of passes) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let any = false;
    for (const p of visible) {
      if (!wanted(p)) continue;
      const at = placeSlot(p.slot, pitch);
      minX = Math.min(minX, at.x); maxX = Math.max(maxX, at.x);
      minZ = Math.min(minZ, at.z); maxZ = Math.max(maxZ, at.z);
      any = true;
    }
    if (!any) continue;
    const half = Math.max(maxX - minX, maxZ - minZ) / 2;
    return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, radius: Math.max(half + pitch, pitch * 2) };
  }
  return { cx: 0, cz: 0, radius: cityRadius(1, pitch) };
}
