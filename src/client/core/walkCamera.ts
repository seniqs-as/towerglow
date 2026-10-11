import * as THREE from 'three';

/**
 * The camera inside the ship: behind you and over your shoulder, always
 * facing the far wall, where the desk is.
 *
 * It is not the colony's rig with a mode switch. That one is Google Earth --
 * grab the ground, zoom at the cursor, ease back to an isometric heading --
 * and every one of those behaviours is wrong in a room you walk through. So
 * the rig is left exactly as it is, switched off while you are in here, and
 * this is the whole of the camera you get inside.
 *
 * The heading never turns. The keys walk you relative to the screen (up is
 * towards the desk) and a camera that swung round behind you would turn
 * those same keys into different directions mid-stride. It also means the
 * wall behind you is always behind the camera: the room is built with its
 * walls facing in, so the one between you and the lens is culled and never
 * hides you (the dollhouse cut).
 *
 * Nothing here reads the DOM: it is a point that follows another point, and
 * a test can walk it.
 */

/** How far behind you the lens sits, and how high. */
export const FOLLOW_BACK = 4.6;
export const FOLLOW_UP = 2.4;
/**
 * Where it looks: a little ahead of you and about waist high. Ahead, so what
 * you are walking towards has more of the frame than what you left behind;
 * low, so the desk and the CEOs sitting behind it are held in frame without
 * the lens tipping down at the floor.
 */
const LOOK_AHEAD = 1.4;
const LOOK_UP = 0.9;
/** How quickly it catches up: fast enough to feel held, slow enough not to jolt with every step. */
const FOLLOW_RATE = 6;
/** With reduced motion it keeps up at once rather than gliding. */
const FOLLOW_RATE_REDUCED = 40;

/** Where you stand, on the floor: the height is the lens's own business. */
export interface FloorPoint {
  readonly x: number;
  readonly z: number;
}

export class WalkCamera {
  readonly camera: THREE.PerspectiveCamera;
  /** The point followed, eased: where you were a moment ago, never a jump behind. */
  readonly #at = new THREE.Vector3();
  readonly #look = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.#sync();
  }

  /** Straight to `at`: coming through the door is a cut, not a glide from wherever it was last time. */
  snap(at: FloorPoint): void {
    this.#at.set(at.x, 0, at.z);
    this.#sync();
  }

  /** Follow `at` for one frame. */
  update(at: FloorPoint, dt: number, reducedMotion = false): void {
    const rate = reducedMotion ? FOLLOW_RATE_REDUCED : FOLLOW_RATE;
    this.#at.x = THREE.MathUtils.damp(this.#at.x, at.x, rate, dt);
    this.#at.z = THREE.MathUtils.damp(this.#at.z, at.z, rate, dt);
    this.#sync();
  }

  /** From the lens to what it looks at: where the depth of field keeps things sharp. */
  get distance(): number {
    return this.camera.position.distanceTo(this.#look);
  }

  #sync(): void {
    const at = this.#at;
    this.camera.position.set(at.x, FOLLOW_UP, at.z + FOLLOW_BACK);
    this.#look.set(at.x, LOOK_UP, at.z - LOOK_AHEAD);
    this.camera.lookAt(this.#look);
    this.camera.updateMatrixWorld();
  }
}
