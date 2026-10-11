import * as THREE from 'three';
import type { Layer } from './stage.ts';
import { part, atlasTexture, kitReady } from '../assets/kit.ts';
import { RING_COLOR } from './palette.ts';
import { TILE } from '../../shared/layout.ts';

/**
 * The crates: one per commit, stacked beside the habitat.
 *
 * The city stacked a ring above the roof for every move of HEAD; a habitat
 * from the kit has no roof to stack on, so history lands on the ground
 * instead, as cargo. Newest on top, twelve at most per project, and the
 * oldest goes when a thirteenth arrives: a pile is a recent history, not an
 * archive. Switching branch adds nothing, because it is not new history --
 * the caller filters `checkout` out, as it did for the rings.
 *
 * One InstancedMesh for the whole colony, tinted per crate by the kind of
 * move: the same colours the legend shows for the rings.
 */

export type CrateKind = keyof typeof RING_COLOR;

/** Crates a project keeps on show. */
export const MAX_CRATES = 12;
const CAP = 512;
/** Crates per layer of the pile, in a two-by-two. */
const PER_LAYER = 4;
/**
 * Where the pile stands on the root tile: on a corner direction, which is the
 * gap between two building spots, and just inside the corner lamp. Measured:
 * at 0.61 of the tile the nearest spot centre is 2.35 away and the lamp 0.8,
 * which clears the widest small structure (1.85) plus a crate.
 */
const PILE_RADIUS = TILE * 0.61;
const PILE_ANGLE = (Math.PI / 3) * 4;
/**
 * Kit models are authored small and the clutter scales them by 1.35; the
 * pile stays at 1.0 so a two-by-two of them (1.6 across) fits between two
 * building spots without leaning on either.
 */
const CRATE_SCALE = 1.0;

/** How far above its resting place a new crate is let go. About a habitat and a half. */
const DROP_HEIGHT = 6;
/** Stronger than real gravity: at 9.8 the fall takes over a second and reads as floating. */
const DROP_GRAVITY = 14;
/** How much of the impact speed comes back as a bounce: one small hop, not a ball. */
const DROP_BOUNCE = 0.18;
const FALL_S = Math.sqrt((2 * DROP_HEIGHT) / DROP_GRAVITY);
const BOUNCE_V = DROP_GRAVITY * FALL_S * DROP_BOUNCE;
/** From letting go to resting for good: the fall, then the hop. */
export const DROP_SETTLE_S = FALL_S + (2 * BOUNCE_V) / DROP_GRAVITY;

/**
 * How high above its resting place a dropped crate is, `t` seconds after it
 * was let go, and whether it has hit the pile yet.
 *
 * A crate that pops into existence on the pile is easy to miss, and a commit
 * is the one event worth not missing; one falling out of the sky is not. Pure,
 * so the curve is tested without a scene.
 */
export function dropOffset(t: number): { y: number; landed: boolean } {
  if (!Number.isFinite(t) || t <= 0) return { y: DROP_HEIGHT, landed: false };
  if (t < FALL_S) return { y: DROP_HEIGHT - 0.5 * DROP_GRAVITY * t * t, landed: false };
  const b = t - FALL_S;
  return { y: Math.max(0, BOUNCE_V * b - 0.5 * DROP_GRAVITY * b * b), landed: true };
}

/** One crate on a pile: what it records, and how far through its fall it is. */
interface Crate {
  kind: CrateKind;
  /** Seconds since it was let go; null once it rests, or for one that never fell. */
  fall: number | null;
  /** Whether `onLand` has been told, so a bounce is not a second landing. */
  told: boolean;
}

export interface CratesOptions {
  /** A dropped crate hit the pile, at its resting place: where the dust goes up. */
  onLand?: (x: number, y: number, z: number, kind: CrateKind) => void;
}

export class Crates implements Layer {
  readonly object3d = new THREE.Group();

  #mesh: THREE.InstancedMesh | null = null;
  #size = new THREE.Vector3(0.6, 0.6, 0.6);
  #piles = new Map<string, Crate[]>();
  #matrix = new THREE.Matrix4();
  #color = new THREE.Color();
  #rest = new THREE.Vector3();
  #dirty = false;
  #rootOf: ((projectId: string) => THREE.Vector3 | null) | null = null;
  #onLand: CratesOptions['onLand'];

  constructor(opts: CratesOptions = {}) {
    this.object3d.name = 'crates';
    this.#onLand = opts.onLand;
  }

  /**
   * A commit landed: one more crate on the project's pile. `drop` lets it
   * fall onto the pile; without it the crate is simply there, which is what
   * the history replayed at startup wants -- a dozen crates raining down on
   * every reload would be news that is not news.
   */
  add(projectId: string, kind: CrateKind, drop = false): void {
    let pile = this.#piles.get(projectId);
    if (!pile) {
      pile = [];
      this.#piles.set(projectId, pile);
    }
    pile.push({ kind, fall: drop ? 0 : null, told: !drop });
    while (pile.length > MAX_CRATES) pile.shift();
    this.#dirty = true;
  }

  /** Every pile goes: the page is about to rebuild them from the ledger. */
  clear(): void {
    if (this.#piles.size === 0) return;
    this.#piles.clear();
    this.#dirty = true;
  }

  /** The project left the map: its pile goes with it. */
  forget(projectId: string): void {
    if (this.#piles.delete(projectId)) this.#dirty = true;
  }

  /** How many crates a project shows. */
  count(projectId: string): number {
    return this.#piles.get(projectId)?.length ?? 0;
  }

  /** Where every pile stands. The lookup is kept and re-run whenever a pile changes. */
  place(rootOf: (projectId: string) => THREE.Vector3 | null): void {
    this.#rootOf = rootOf;
    this.#dirty = true;
  }

  update(dt = 0, _now = 0): void {
    // The fall runs whether or not the kit is in: a crate is news for a few
    // seconds, and a kit that arrives late should not replay the drop.
    const falling = this.#advance(dt);
    if (!this.#dirty && !falling) return;
    if (!this.#ensureMesh()) return; // the kit is not in yet: try again next frame
    this.#dirty = false;
    this.#write();
  }

  /**
   * Move every falling crate on by `dt`, tell whoever listens about the ones
   * that just hit the pile, and say whether anything was still in the air at
   * the start of this frame -- the frame a crate comes to rest has to be
   * written too, or it would freeze a hair above the pile.
   */
  #advance(dt: number): boolean {
    let any = false;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    for (const [projectId, pile] of this.#piles) {
      pile.forEach((crate, i) => {
        if (crate.fall === null) return;
        any = true;
        crate.fall += step;
        if (!crate.told && dropOffset(crate.fall).landed) {
          crate.told = true;
          // Where it rests NOW, not where it was let go: if the pile shifted
          // under it, the dust goes up on the slot it actually landed on.
          if (this.#restOf(projectId, i, this.#rest)) {
            this.#onLand?.(this.#rest.x, this.#rest.y, this.#rest.z, crate.kind);
          }
        }
        if (crate.fall >= DROP_SETTLE_S) crate.fall = null;
      });
    }
    return any;
  }

  /** Where crate `i` of a pile rests, or false when its project has no ground on the map. */
  #restOf(projectId: string, i: number, out: THREE.Vector3): boolean {
    const root = this.#rootOf?.(projectId) ?? null;
    if (!root) return false;
    const w = this.#size.x + 0.05;
    const d = this.#size.z + 0.05;
    const h = this.#size.y;
    const cx = root.x + PILE_RADIUS * Math.cos(PILE_ANGLE);
    const cz = root.z + PILE_RADIUS * Math.sin(PILE_ANGLE);
    const layer = Math.floor(i / PER_LAYER);
    const within = i % PER_LAYER;
    out.set(
      cx + (within % 2 - 0.5) * w,
      root.y + layer * h,
      cz + (Math.floor(within / 2) - 0.5) * d,
    );
    return true;
  }

  #ensureMesh(): boolean {
    if (this.#mesh) return true;
    if (!kitReady('base')) return false;
    const geometry = part('cargo_A_packed');
    geometry.scale(CRATE_SCALE, CRATE_SCALE, CRATE_SCALE);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    box.getSize(this.#size);
    // Stand on the deck: the pile is measured from the crate's own floor.
    geometry.translate(0, -box.min.y, 0);
    const atlas = atlasTexture();
    const material = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.05 });
    if (atlas) material.map = atlas;
    const mesh = new THREE.InstancedMesh(geometry, material, CAP);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#mesh = mesh;
    this.object3d.add(mesh);
    return true;
  }

  #write(): void {
    const mesh = this.#mesh;
    if (!mesh || !this.#rootOf) return;
    let n = 0;
    for (const [projectId, pile] of this.#piles) {
      pile.forEach((crate, i) => {
        if (n >= CAP) return;
        if (!this.#restOf(projectId, i, this.#rest)) return;
        const layer = Math.floor(i / PER_LAYER);
        // Every other layer turns, the way a real stack is laid to hold.
        const yaw = layer % 2 ? Math.PI / 2 : 0;
        const lift = crate.fall === null ? 0 : dropOffset(crate.fall).y;
        this.#matrix.makeRotationY(yaw);
        this.#matrix.setPosition(this.#rest.x, this.#rest.y + lift, this.#rest.z);
        mesh.setMatrixAt(n, this.#matrix);
        mesh.setColorAt(n, this.#color.set(RING_COLOR[crate.kind]));
        n++;
      });
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** The crates on show, for tests: world position and kind of each. */
  inspect(): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    const mesh = this.#mesh;
    if (!mesh) return out;
    const p = new THREE.Vector3();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, this.#matrix);
      p.setFromMatrixPosition(this.#matrix);
      out.push({ x: p.x, y: p.y, z: p.z });
    }
    return out;
  }

  dispose(): void {
    if (this.#mesh) {
      this.#mesh.geometry.dispose();
      (this.#mesh.material as THREE.Material).dispose();
      this.#mesh.dispose();
      this.#mesh = null;
    }
    this.#piles.clear();
  }
}
