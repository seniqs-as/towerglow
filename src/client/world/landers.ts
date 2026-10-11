import * as THREE from 'three';
import type { Layer } from './stage.ts';
import { part, atlasTexture, hasPart, kitReady } from '../assets/kit.ts';
import { fnv1a32 } from '../../shared/hash.ts';
import type { DeltaEvent } from '../../shared/protocol.ts';

/**
 * The supply landers: at most one over every project, whenever something
 * reaches the project from outside it.
 *
 * A skill is instructions loaded into the session, not a worker of its own,
 * so it gets no astronaut. What it looks like instead is a delivery: a lander
 * comes down out of the sky and holds station over the habitat for as long as
 * the skill is in play, then climbs away. The same delivery marks the other
 * things that come from off the deck: the prompt you send, and a call out to
 * the web or an MCP server. With the skill tool alone it came down nine times
 * in a month of real transcripts, against 415 turns: a sign that never shows
 * is not a sign. Those are visits (`visit`), not a state: they last
 * `VISIT_S`, and more of them while it is there only keep it there longer.
 *
 * Whatever brought it, it stays at least `MIN_HOVER_S` once it has settled:
 * a skill in a turn that ends two seconds later used to turn it round before
 * the descent was over, and a lander you only see leaving did not arrive.
 *
 * It HOVERS rather than landing on
 * purpose -- the gaps on a one-hex deck are already taken by clutter, crates
 * and building spots, and something hanging over the habitat needs no room on
 * the deck and no obstacle in the navigation grid.
 *
 * The flight is simulated whether or not the kit is loaded, so it runs under
 * `node --test`; the mesh is built the first frame the kit is there. Particles
 * are the caller's: `onThrust` says where the engine is washing, nothing here
 * knows what a particle is.
 */

/** Where a lander enters, above the habitat's summit. High enough to come from off screen at the resting zoom. */
export const ENTRY_HEIGHT = 14;
/** Where it holds station, above the summit: clear of a mast's rotor, low enough to belong to that habitat. */
export const HOVER_HEIGHT = 1.8;
export const DESCEND_S = 2.5;
export const LIFT_S = 2;
/** How far it climbs over `LIFT_S` before it is gone: back out of the top of the frame. */
const LIFT_CLIMB = 16;
const LIFT_ACCEL = (2 * LIFT_CLIMB) / (LIFT_S * LIFT_S);
/** The kit's lander is 1.4 across; a little smaller keeps it from hiding the habitat it serves. */
const LANDER_SCALE = 0.9;
const CAP = 64;
/** The engine washes this often while it is moving, and this often while it only holds station. */
const THRUST_EVERY_S = 0.12;
const HOVER_WASH_EVERY_S = 0.6;
/** How many washes mark the moment it settles: a burst, so arriving reads as a touch of the brakes. */
const SETTLE_BURSTS = 3;
/** Once it holds station it stays at least this long, whatever brought it and however soon that ended. */
export const MIN_HOVER_S = 10;
/** How long one visit keeps a project wanted, from the event that asked for it. Wall-clock seconds. */
export const VISIT_S = 10;

/**
 * Whether an event brings the lander down over its session's project: the
 * prompt you send, and a call that goes outside the colony (web, MCP). Not
 * the session's own tools -- those are the crew's hands -- and not a skill,
 * which is a state the store keeps (`set`), not a moment.
 */
export function summonsLander(event: DeltaEvent): event is Extract<DeltaEvent, { t: 'prompt' | 'tool.start' }> {
  if (event.t === 'prompt') return true;
  return event.t === 'tool.start' && (event.cat === 'net' || event.cat === 'mcp');
}

export type LanderPhase = 'descending' | 'hovering' | 'lifting';

interface Lander {
  projectId: string;
  phase: LanderPhase;
  /** Seconds in the current phase. */
  t: number;
  /** Height above the summit at which the current phase started. */
  from: number;
  /** Height above the summit right now. */
  offset: number;
  /** The last summit it was over: a lander whose habitat vanished climbs away from where it was. */
  base: THREE.Vector3;
  yaw: number;
  /** Per lander, so two of them in view never bob in step. */
  bobPhase: number;
  thrustIn: number;
}

export interface LandersOptions {
  /** The engine is washing: the point just under the lander, in world units. */
  onThrust?: (x: number, y: number, z: number) => void;
  /** Epoch ms, for when a visit runs out; injected so a test can hold it still. */
  clock?: () => number;
}

export class Landers implements Layer {
  readonly object3d = new THREE.Group();

  #landers = new Map<string, Lander>();
  #wanted = new Set<string>();
  /**
   * Visits by project: until when, in epoch ms. On the wall clock, not on the
   * frames: a tab in the background draws nothing, and a visit counted in
   * frames would wait for it and bring the lander down, on the way back, for a
   * call made an hour ago. Measured the other way round too: in a headless
   * page at one frame a second a ten-second visit lasted over two minutes.
   */
  #visits = new Map<string, number>();
  #clock: () => number;
  #summitOf: (projectId: string) => THREE.Vector3 | null = () => null;
  #onThrust: LandersOptions['onThrust'];
  #mesh: THREE.InstancedMesh | null = null;
  #matrix = new THREE.Matrix4();
  #q = new THREE.Quaternion();
  #v = new THREE.Vector3();
  #up = new THREE.Vector3(0, 1, 0);
  #one = new THREE.Vector3(1, 1, 1);

  constructor(opts: LandersOptions = {}) {
    this.object3d.name = 'landers';
    this.#onThrust = opts.onThrust;
    this.#clock = opts.clock ?? Date.now;
  }

  /**
   * The projects with a skill in use right now. `summitOf` is kept and read
   * every frame: the summit is a live vector that rises with the habitat, and
   * a project with no summit yet gets its lander once it has one.
   */
  set(projectIds: Iterable<string>, summitOf: (projectId: string) => THREE.Vector3 | null): void {
    this.#wanted = new Set(projectIds);
    this.#summitOf = summitOf;
  }

  /**
   * Something reached the project from outside: its lander comes down, or
   * stays, for `VISIT_S` more. A project with no summit yet lets the visit
   * run out rather than keeping it for later: that moment has passed.
   */
  visit(projectId: string): void {
    this.#visits.set(projectId, Math.max(this.#visits.get(projectId) ?? 0, this.#clock() + VISIT_S * 1000));
  }

  #wants(projectId: string, clock: number): boolean {
    return this.#wanted.has(projectId) || (this.#visits.get(projectId) ?? -1) > clock;
  }

  update(dt: number, now: number): void {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const clock = this.#clock();
    for (const [id, until] of this.#visits) {
      if (until <= clock) this.#visits.delete(id);
    }
    for (const id of new Set([...this.#wanted, ...this.#visits.keys()])) {
      if (this.#landers.has(id)) continue;
      const summit = this.#summitOf(id);
      if (!summit) continue;
      this.#landers.set(id, {
        projectId: id,
        phase: 'descending',
        t: 0,
        from: ENTRY_HEIGHT,
        offset: ENTRY_HEIGHT,
        base: summit.clone(),
        yaw: hashAngle(id),
        bobPhase: hashAngle(`${id}#bob`),
        thrustIn: 0,
      });
    }

    for (const [id, lander] of this.#landers) {
      const summit = this.#summitOf(id);
      const wanted = this.#wants(id, clock);
      if (summit) lander.base.copy(summit);
      if (!summit) {
        if (lander.phase !== 'lifting') this.#enter(lander, 'lifting');
      } else if (wanted && lander.phase === 'lifting') {
        // Called back while climbing away: it comes down again from where it is,
        // rather than a second lander appearing out of the sky beside it.
        this.#enter(lander, 'descending');
      } else if (!wanted && lander.phase === 'hovering' && lander.t >= MIN_HOVER_S) {
        // Not while it is still coming down: it settles, holds, then leaves.
        this.#enter(lander, 'lifting');
      }
      lander.t += step;
      this.#fly(lander, step, now);
      if (lander.phase === 'lifting' && lander.t >= LIFT_S) this.#landers.delete(id);
    }
    this.#write();
  }

  #enter(lander: Lander, phase: LanderPhase): void {
    lander.phase = phase;
    lander.t = 0;
    lander.from = lander.offset;
    lander.thrustIn = 0;
  }

  #fly(lander: Lander, dt: number, now: number): void {
    switch (lander.phase) {
      case 'descending': {
        const k = Math.min(1, lander.t / DESCEND_S);
        // Ease-out: fast out of the sky, braking into the hover.
        const eased = 1 - (1 - k) * (1 - k) * (1 - k);
        lander.offset = lander.from + (HOVER_HEIGHT - lander.from) * eased;
        lander.yaw += dt * 0.6 * (1 - k);
        this.#wash(lander, dt, THRUST_EVERY_S);
        if (k >= 1) {
          this.#enter(lander, 'hovering');
          for (let i = 0; i < SETTLE_BURSTS; i++) this.#thrust(lander);
          lander.thrustIn = HOVER_WASH_EVERY_S;
        }
        break;
      }
      case 'hovering':
        // The bob fades in over the first second: at full swing from the start
        // the lander would jump up to a tenth of a unit the frame it settled.
        lander.offset = HOVER_HEIGHT + Math.sin(now * 1.7 + lander.bobPhase) * 0.12 * Math.min(1, lander.t);
        lander.yaw += dt * 0.25;
        this.#wash(lander, dt, HOVER_WASH_EVERY_S);
        break;
      case 'lifting':
        // Accelerating, so leaving reads as a take-off rather than a lift going up.
        lander.offset = lander.from + 0.5 * LIFT_ACCEL * lander.t * lander.t;
        lander.yaw += dt * 0.4;
        this.#wash(lander, dt, THRUST_EVERY_S);
        break;
    }
  }

  #wash(lander: Lander, dt: number, every: number): void {
    lander.thrustIn -= dt;
    if (lander.thrustIn > 0) return;
    lander.thrustIn += every;
    // A long frame is one wash, not a backlog of them fired at once.
    if (lander.thrustIn < 0) lander.thrustIn = every;
    this.#thrust(lander);
  }

  #thrust(lander: Lander): void {
    this.#onThrust?.(lander.base.x, lander.base.y + lander.offset - 0.1, lander.base.z);
  }

  #ensureMesh(): boolean {
    if (this.#mesh) return true;
    if (!kitReady('base') || !hasPart('lander_A')) return false;
    const geometry = part('lander_A');
    geometry.scale(LANDER_SCALE, LANDER_SCALE, LANDER_SCALE);
    geometry.computeBoundingBox();
    // Hung by its feet: `offset` is the height of the underside, where the engine is.
    const box = geometry.boundingBox;
    if (box) geometry.translate(0, -box.min.y, 0);
    const material = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.1 });
    material.map = atlasTexture('base');
    const mesh = new THREE.InstancedMesh(geometry, material, CAP);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#mesh = mesh;
    this.object3d.add(mesh);
    return true;
  }

  #write(): void {
    if (!this.#ensureMesh()) return;
    const mesh = this.#mesh!;
    let n = 0;
    for (const lander of this.#landers.values()) {
      if (n >= CAP) break;
      this.#q.setFromAxisAngle(this.#up, lander.yaw);
      this.#v.set(lander.base.x, lander.base.y + lander.offset, lander.base.z);
      this.#matrix.compose(this.#v, this.#q, this.#one);
      mesh.setMatrixAt(n++, this.#matrix);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Every lander in flight, for tests: whose it is, its height in world units, what it is doing. */
  inspect(): { projectId: string; y: number; phase: LanderPhase }[] {
    return [...this.#landers.values()].map((l) => ({ projectId: l.projectId, y: l.base.y + l.offset, phase: l.phase }));
  }

  dispose(): void {
    if (this.#mesh) {
      this.#mesh.geometry.dispose();
      (this.#mesh.material as THREE.Material).dispose();
      this.#mesh.dispose();
      this.#mesh = null;
    }
    this.#landers.clear();
    this.#wanted.clear();
    this.#visits.clear();
  }
}

/** A stable angle from an id, so a project's lander always turns up facing the same way. */
function hashAngle(id: string): number {
  return (fnv1a32(id) % 3600) * (Math.PI / 1800);
}
