import * as THREE from 'three';
import { clone as cloneRig } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Agent } from './astronauts.ts';
import { VILLAGER_SCALE } from '../assets/villager.ts';
import type { VillagerBody } from '../assets/villager.ts';

/**
 * You, drawn: the villager wearing whatever the crew says you are doing.
 *
 * It decides nothing. Where you stand, which way you face, how much of you
 * has come out of the ship and whether you are walking are all the crew's
 * (`astronauts.ts`), because the ramp is on rails and the room has walls and
 * both of those live there. The entry that carries you is marked `hidden`,
 * so the astronaut that does the walking is never drawn -- one figure, one
 * position, two meshes would be the beginning of two answers.
 *
 * The two clips cross-fade rather than switch. A step that starts and stops
 * inside half a second -- which is most of what walking round a room is --
 * would otherwise be a snap into a stride and a snap back out of it.
 */

/** How fast the walk fades in and out of the stand. */
const BLEND_RATE = 12;
/** Below this the figure is not drawn at all: it is inside the ship, or not out of it yet. */
const MIN_SCALE = 0.001;

export class Visitor {
  readonly object3d: THREE.Object3D;

  readonly #mixer: THREE.AnimationMixer;
  readonly #idle: THREE.AnimationAction;
  readonly #walk: THREE.AnimationAction;
  /** 0 standing, 1 walking; eased, never jumped. */
  #blend = 0;
  #walking = false;
  #pace = 1;

  constructor(body: VillagerBody) {
    this.object3d = cloneRig(body.root);
    this.object3d.name = 'visitor';
    this.object3d.scale.setScalar(VILLAGER_SCALE);
    this.object3d.visible = false;
    this.#mixer = new THREE.AnimationMixer(this.object3d);
    this.#idle = this.#mixer.clipAction(body.idle);
    this.#walk = this.#mixer.clipAction(body.walk);
    // Both always running, weighted: an action started on the frame it is
    // first needed starts on its first frame, which is a foot planted.
    this.#idle.play();
    this.#walk.play();
    this.#weigh();
  }

  /**
   * Wear one frame of an astronaut: its place, its heading, and how much of
   * it there is. The stand-in is scaled from nothing as it rises out of the
   * ground at the foot of the ramp and back to nothing as it goes in through
   * the hatch, and that is the whole of both moves.
   */
  follow(agent: Agent): void {
    const out = agent.scale;
    this.object3d.visible = out > MIN_SCALE;
    if (!this.object3d.visible) return;
    this.object3d.position.set(agent.pos.x, agent.pos.y, agent.pos.z);
    this.object3d.rotation.set(0, agent.yaw, 0);
    this.object3d.scale.setScalar(VILLAGER_SCALE * out * agent.size);
    this.#walking = agent.clipKey === 'walk' || agent.clipKey === 'run';
    // How fast the stride runs, from how fast the astronaut is actually
    // travelling: the crew's own rule, so you keep step with the crew.
    this.#pace = this.#walking ? Math.max(0.4, agent.walkAmp) : 1;
  }

  /** One frame of animation. `anim` is the colony's motion setting, 1 unless it is reduced. */
  update(dt: number, anim = 1): void {
    if (!this.object3d.visible) return;
    this.#blend = THREE.MathUtils.damp(this.#blend, this.#walking ? 1 : 0, BLEND_RATE, dt);
    this.#weigh();
    this.#mixer.update(dt * anim);
  }

  #weigh(): void {
    this.#walk.setEffectiveWeight(this.#blend);
    this.#idle.setEffectiveWeight(1 - this.#blend);
    this.#walk.setEffectiveTimeScale(this.#pace);
  }

  /**
   * The geometry and the materials belong to the body this was cloned from,
   * which every visitor shares: only the mixer is this one's own.
   */
  dispose(): void {
    this.#mixer.stopAllAction();
    this.#mixer.uncacheRoot(this.object3d);
    this.object3d.removeFromParent();
  }
}
