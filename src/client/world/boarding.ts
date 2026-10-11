import * as THREE from 'three';
import { Astronauts } from '../agents/astronauts.ts';
import type { CrewWorld, RosterEntry } from '../agents/astronauts.ts';
import { Visitor } from '../agents/visitor.ts';
import type { CrewRig } from '../assets/crew.ts';
import type { VillagerBody } from '../assets/villager.ts';
import type { Settings } from '../core/settings.ts';
import type { Layer } from './stage.ts';
import { YOUR_TRIM } from './interior.ts';
import { fnv1a32 } from '../../shared/hash.ts';

/**
 * You, going up the ramp: the one walk in the colony that is not a session's.
 *
 * It is the crew's own way home, played once for you. You rise out of the
 * ground at the foot of the ramp like any astronaut coming out of the ship,
 * and are then dropped from the roster -- which is what sends an astronaut
 * up the ramp, along `Ship.wayIn`, through the hatch and out of sight. What
 * is past that hatch is the interior, and `onAboard` is the moment you get
 * there.
 *
 * A crew of one with its own roster, so the colony's never has to know
 * about you: you are not a session, and a colony that counted you would be
 * wrong about everything it counts.
 *
 * What is drawn is the villager (`agents/visitor.ts`), not the astronaut:
 * the crew of one walks the ramp and the figure wears the walk, so you are
 * the same person out here as at the desk inside.
 */

/** How long you stand at the foot of the ramp, rising out of the ground, before you start up it. */
const RISE_S = 0.8;
const YOU = 'you';

export interface BoardingWorld extends CrewWorld {
  /** The ramp's lights answer anyone using it. */
  ping(): void;
}

export class Boarding implements Layer {
  readonly object3d: THREE.Group;
  /** You went through the hatch. */
  onAboard: (() => void) | undefined;

  readonly #crew: Astronauts;
  readonly #settings: Settings;
  /** You, in person. Null until the model pack has been decoded. */
  #visitor: Visitor | null = null;
  readonly #world: BoardingWorld;
  #phase: 'idle' | 'rising' | 'climbing' = 'idle';
  #age = 0;

  constructor(settings: Settings, faceTexture: THREE.Texture | null, world: BoardingWorld) {
    this.#crew = new Astronauts(settings, faceTexture);
    this.#settings = settings;
    this.#world = world;
    // The crew of one and the figure that wears it, under one switch.
    this.object3d = new THREE.Group();
    this.object3d.add(this.#crew.object3d);
    this.object3d.name = 'boarding';
    // Nothing to draw between two visits, and nothing drawn is cheaper than
    // nine instanced meshes with no instances.
    this.object3d.visible = false;
  }

  /** On the way in: from the ground at the foot of the ramp to the hatch. */
  get busy(): boolean {
    return this.#phase !== 'idle';
  }

  setRig(rig: CrewRig): void {
    this.#crew.setRig(rig);
  }

  setFaceTexture(tex: THREE.Texture | null): void {
    this.#crew.setFaceTexture(tex);
  }

  /** The body you walk up the ramp in. See `Interior.setVillager`. */
  setVillager(body: VillagerBody): void {
    this.#visitor?.dispose();
    this.#visitor = new Visitor(body);
    this.object3d.add(this.#visitor.object3d);
  }

  /** Start the walk. Ignored while one is already going. */
  start(): void {
    if (this.#phase !== 'idle') return;
    const door = this.#world.shipDoor(new THREE.Vector3());
    const you: RosterEntry = {
      id: YOU,
      status: 'idle',
      provider: 'claude',
      trim: YOUR_TRIM,
      site: { x: door.x, y: door.y, z: door.z },
      anchor: null,
      // Not known: you come up out of the ground the way the crew does.
      known: false,
      seed: fnv1a32(YOU),
      hidden: this.#visitor !== null,
    };
    this.#crew.setRoster([you], this.#world);
    this.#phase = 'rising';
    this.#age = 0;
    this.object3d.visible = true;
    this.#world.ping();
  }

  update(dt: number, now: number): void {
    if (this.#phase === 'idle') return;
    this.#age += dt;
    if (this.#phase === 'rising' && this.#age >= RISE_S) {
      // Off the roster is home, and home is up the ramp.
      this.#crew.setRoster([], this.#world);
      this.#phase = 'climbing';
      this.#world.ping();
    }
    this.#crew.update(dt, now);
    const visitor = this.#visitor;
    if (visitor) {
      const you = this.#crew.byId.get(YOU);
      if (you) visitor.follow(you);
      else visitor.object3d.visible = false;
      visitor.update(dt, this.#settings.get('reducedMotion') ? 0.35 : 1);
    }
    if (this.#phase === 'climbing' && this.#crew.agents.length === 0) {
      this.#phase = 'idle';
      this.object3d.visible = false;
      this.onAboard?.();
    }
  }

  dispose(): void {
    this.#crew.dispose();
    this.#visitor?.dispose();
  }
}
