import * as THREE from 'three';
import type { Settings } from './settings.ts';

const ISO_POLAR = THREE.MathUtils.degToRad(56);
const MIN_POLAR = THREE.MathUtils.degToRad(6);
const MAX_POLAR = THREE.MathUtils.degToRad(84);
const MIN_DIST = 4;
// Bot Crossing stops at 150 over a colony 82 units across; this city is bigger.
const MAX_DIST = 320;
const WORLD_LIMIT = 220;
/** Orbit mode's rate: about two minutes a revolution, slow enough to watch. */
const ORBIT_RATE = 0.055;
/** How long after you stop working the camera before the sweep picks itself back up. */
const ORBIT_RESUME_DELAY = 2.0;
/**
 * Ramp rates for the sweep's blend, quicker to stop than to start. Grabbing the ground
 * should feel like the camera handing control straight over, while the pick-up afterwards
 * wants to be slow enough that you are not sure of the exact moment it began.
 */
const ORBIT_RAMP_DOWN = 3.5;
const ORBIT_RAMP_UP = 1.1;

/** The four clean isometric headings. Resting snaps to whichever you are nearest. */
const iso = (i: number): number => (i * Math.PI) / 2 + Math.PI / 4;
const ISO_AZIMUTHS = [iso(0), iso(1), iso(2), iso(3)] as const;

const damp = (current: number, target: number, lambda: number, dt: number): number =>
  THREE.MathUtils.damp(current, target, lambda, dt);

type DragMode = 'pan' | 'orbit' | 'pinch';

interface Pointer {
  x: number;
  y: number;
}

/** A cursor-anchored dolly in flight: the world point to hold, and where on screen it was. */
interface ZoomAnchor {
  world: THREE.Vector3;
  sx: number;
  sy: number;
}

export interface FocusOptions {
  distance?: number;
}

/**
 * Google Earth's navigation model, over a camera that wants to be isometric.
 *
 * Ported from Bot Crossing (MIT).
 *
 * The two things that make Earth feel like Earth are both *anchoring* behaviours, and both
 * are here:
 *
 * - **Left-drag grabs the ground.** Not a pixels-to-metres pan -- the world point you put the
 *   cursor on is projected onto the ground plane at mouse-down and then pinned under the
 *   cursor for the whole drag. Panning is applied at 1:1 with no smoothing, because any
 *   damping at all makes the ground visibly lag the hand that is dragging it.
 * - **The wheel zooms at the cursor, not at the screen centre.** The ground point under the
 *   pointer is held still while the camera dollies, so zooming into a corner of the colony
 *   pulls that corner in rather than diving through the middle of the screen. The correction
 *   is re-applied every frame while the dolly eases, so the zoom stays smooth *and* anchored.
 *
 * Right-drag (also middle-, ctrl- and shift-drag) tilts and rotates: horizontal turns the
 * heading, vertical tilts between overhead and the horizon, matching Earth's directions.
 *
 * On top of that, and unlike Earth, letting go eventually eases the *heading and tilt* back
 * to the nearest clean isometric angle. Position and zoom are never touched by that -- going
 * home on its own would fight you; tidying the angle after you stop does not.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly dom: HTMLElement;
  readonly settings: Settings;

  readonly target: THREE.Vector3;
  readonly desiredTarget: THREE.Vector3;

  azimuth: number;
  desiredAzimuth: number;
  polar: number;
  desiredPolar: number;
  distance: number;
  desiredDistance: number;

  idleFor: number;
  interacting: boolean;
  enabled: boolean;
  /** Google Earth's auto-rotate: a slow continuous sweep around whatever is centred. */
  orbiting: boolean;
  /** 0..1 share of ORBIT_RATE currently being applied -- see `update`. */
  orbitBlend: number;
  /** Set by the picker when a drag started on something clickable, so it does not pan. */
  suppressed: boolean;

  /**
   * Fired whenever the user takes the camera in hand: once per drag or pinch, the moment
   * it actually moves the view, and on every wheel step. Not on a bare click, and not on a
   * drag the picker suppressed: neither of those moved anything, and the caller uses this
   * to stop framing the city on its own, which it should only do once the view is yours.
   */
  onUserInput?: () => void;

  readonly #pointers = new Map<number, Pointer>();
  #mode: DragMode | null = null;
  readonly #last = new THREE.Vector2();
  #pinch = 0;
  #moved = 0;
  readonly #panAnchor = new THREE.Vector3();
  #hasAnchor = false;
  #zoom: ZoomAnchor | null = null;
  #announced = false;

  readonly #plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  readonly #ray = new THREE.Raycaster();
  readonly #ndc = new THREE.Vector2();
  readonly #hit = new THREE.Vector3();
  readonly #hit2 = new THREE.Vector3();
  #shake = 0;

  readonly #onDown = (e: PointerEvent): void => this.#pointerDown(e);
  readonly #onMove = (e: PointerEvent): void => this.#pointerMove(e);
  readonly #onUp = (e: PointerEvent): void => this.#pointerUp(e);
  readonly #onWheel = (e: WheelEvent): void => this.#wheel(e);
  readonly #onMenu = (e: Event): void => e.preventDefault();
  /**
   * A pinch is the camera's, never the page's. On a Mac trackpad it arrives as
   * ctrl+wheel, and only the canvas cancelled it: over a name, a badge or the
   * HUD -- or with the camera disabled -- the browser zoomed the whole page, and
   * the corners slid off the screen with it. Safari pinches with gesture events.
   */
  readonly #onPagePinch = (e: Event): void => {
    if (e instanceof WheelEvent ? e.ctrlKey : true) e.preventDefault();
  };

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement, settings: Settings) {
    this.camera = camera;
    this.dom = domElement;
    this.settings = settings;

    this.target = new THREE.Vector3(0, 0, 0);
    this.desiredTarget = this.target.clone();

    this.azimuth = ISO_AZIMUTHS[0];
    this.desiredAzimuth = this.azimuth;
    this.polar = ISO_POLAR;
    this.desiredPolar = ISO_POLAR;
    this.distance = 62;
    this.desiredDistance = 62;

    this.idleFor = 0;
    this.interacting = false;
    this.enabled = true;
    this.orbiting = false;
    this.orbitBlend = 0;
    this.suppressed = false;

    this.#bind();
    this.#sync();
  }

  #bind(): void {
    const dom = this.dom;
    dom.style.touchAction = 'none';
    dom.addEventListener('pointerdown', this.#onDown);
    window.addEventListener('pointermove', this.#onMove, { passive: false });
    window.addEventListener('pointerup', this.#onUp);
    window.addEventListener('pointercancel', this.#onUp);
    dom.addEventListener('wheel', this.#onWheel, { passive: false });
    dom.addEventListener('contextmenu', this.#onMenu);
    window.addEventListener('wheel', this.#onPagePinch, { passive: false });
    window.addEventListener('gesturestart', this.#onPagePinch);
    window.addEventListener('gesturechange', this.#onPagePinch);
  }

  dispose(): void {
    const dom = this.dom;
    dom.removeEventListener('pointerdown', this.#onDown);
    window.removeEventListener('pointermove', this.#onMove);
    window.removeEventListener('pointerup', this.#onUp);
    window.removeEventListener('pointercancel', this.#onUp);
    dom.removeEventListener('wheel', this.#onWheel);
    dom.removeEventListener('contextmenu', this.#onMenu);
    window.removeEventListener('wheel', this.#onPagePinch);
    window.removeEventListener('gesturestart', this.#onPagePinch);
    window.removeEventListener('gesturechange', this.#onPagePinch);
  }

  // -- input ------------------------------------------------------------------------------

  #pointerDown(e: PointerEvent): void {
    if (!this.enabled) return;
    this.#pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.#moved = 0;
    this.#zoom = null;
    this.#announced = false;

    if (this.#pointers.size === 2) {
      this.#mode = 'pinch';
      this.#pinch = this.#pinchDistance();
      const [cx, cy] = this.#pinchCentre();
      this.#grab(cx, cy);
      return;
    }

    // Right, middle, ctrl or shift all mean "tilt and rotate", as in Earth.
    const orbit = e.button === 2 || e.button === 1 || e.ctrlKey || e.shiftKey || e.altKey;
    this.#mode = orbit ? 'orbit' : 'pan';
    this.#last.set(e.clientX, e.clientY);
    this.interacting = true;
    this.idleFor = 0;
    if (!orbit) this.#grab(e.clientX, e.clientY);
  }

  /** Remember the world point under the cursor: the thing a drag has to keep pinned. */
  #grab(clientX: number, clientY: number): void {
    this.#hasAnchor = Boolean(this.groundPoint(clientX, clientY, this.#panAnchor));
  }

  /** Tell the caller once per gesture, and only once the gesture has moved the view. */
  #announce(): void {
    if (this.#announced) return;
    this.#announced = true;
    this.onUserInput?.();
  }

  #pointerMove(e: PointerEvent): void {
    if (!this.#mode) return;
    const p = this.#pointers.get(e.pointerId);
    if (p) {
      p.x = e.clientX;
      p.y = e.clientY;
    }
    this.idleFor = 0;

    if (this.#mode === 'pinch') {
      e.preventDefault();
      this.#announce();
      const d = this.#pinchDistance();
      const [cx, cy] = this.#pinchCentre();
      if (this.#pinch > 0 && d > 0) {
        this.desiredDistance = THREE.MathUtils.clamp(this.desiredDistance * (this.#pinch / d), MIN_DIST, MAX_DIST);
        this.distance = this.desiredDistance;
        this.#sync();
      }
      this.#pinch = d;
      // Two fingers pan as well as zoom, both anchored on the point between them.
      this.#dragGround(cx, cy);
      return;
    }

    const dx = e.clientX - this.#last.x;
    const dy = e.clientY - this.#last.y;
    this.#last.set(e.clientX, e.clientY);
    this.#moved += Math.abs(dx) + Math.abs(dy);

    if (this.#mode === 'orbit') {
      e.preventDefault();
      this.#announce();
      this.desiredAzimuth -= dx * 0.006;
      // Mouse up tilts toward the horizon, mouse down returns to overhead -- Earth's sense.
      this.desiredPolar = THREE.MathUtils.clamp(this.desiredPolar - dy * 0.005, MIN_POLAR, MAX_POLAR);
      return;
    }

    if (this.suppressed) return;
    e.preventDefault();
    this.#announce();
    this.#dragGround(e.clientX, e.clientY);
  }

  /**
   * Move the world so the anchored point sits back under the cursor. Applied straight to
   * the live target rather than the damped one: a grabbed surface that eases into place
   * reads as slipping, however small the lag.
   */
  #dragGround(clientX: number, clientY: number): void {
    if (!this.#hasAnchor) return;
    if (!this.groundPoint(clientX, clientY, this.#hit)) return;

    const dx = this.#panAnchor.x - this.#hit.x;
    const dz = this.#panAnchor.z - this.#hit.z;
    // A ray that grazes the horizon lands absurdly far away; ignore those rather than
    // teleporting the camera across the world on one stray pixel.
    if (!Number.isFinite(dx) || !Number.isFinite(dz) || Math.hypot(dx, dz) > this.distance * 2) return;

    this.desiredTarget.x += dx;
    this.desiredTarget.z += dz;
    this.#clampTarget();
    this.target.copy(this.desiredTarget);
    this.#sync();
  }

  #pointerUp(e: PointerEvent): void {
    this.#pointers.delete(e.pointerId);
    if (this.#pointers.size === 0) {
      this.#mode = null;
      this.interacting = false;
      this.suppressed = false;
      this.#hasAnchor = false;
    } else if (this.#pointers.size === 1) {
      this.#mode = 'pan';
      const [only] = this.#pointers.values();
      if (only) {
        this.#last.set(only.x, only.y);
        this.#grab(only.x, only.y);
      }
    }
  }

  #wheel(e: WheelEvent): void {
    if (!this.enabled) return;
    e.preventDefault();
    this.onUserInput?.();
    // Trackpads report tiny per-event deltas and mice report ~100, so both are normalised
    // to the same felt zoom step. A pinch on a trackpad arrives as ctrl+wheel.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    const raw = (e.deltaY * unit) / 100;
    const step = Math.sign(raw) * Math.min(Math.abs(raw), 2.5) * (e.ctrlKey ? 1.6 : 1);

    this.desiredDistance = THREE.MathUtils.clamp(this.desiredDistance * (1 + step * 0.16), MIN_DIST, MAX_DIST);
    // Hold the point under the pointer still for as long as the dolly takes to settle.
    if (this.groundPoint(e.clientX, e.clientY, this.#hit2)) {
      this.#zoom = { world: this.#hit2.clone(), sx: e.clientX, sy: e.clientY };
    }
    this.idleFor = 0;
  }

  /** The two touches of a pinch, or null while there are not two of them. */
  #pair(): [Pointer, Pointer] | null {
    const [a, b] = this.#pointers.values();
    return a && b ? [a, b] : null;
  }

  #pinchDistance(): number {
    const pair = this.#pair();
    if (!pair) return 0;
    const [a, b] = pair;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  #pinchCentre(): [number, number] {
    const pair = this.#pair();
    if (!pair) return [this.#last.x, this.#last.y];
    const [a, b] = pair;
    return [(a.x + b.x) / 2, (a.y + b.y) / 2];
  }

  #clampTarget(): void {
    const t = this.desiredTarget;
    const len = Math.hypot(t.x, t.z);
    if (len > WORLD_LIMIT) {
      t.x = (t.x / len) * WORLD_LIMIT;
      t.z = (t.z / len) * WORLD_LIMIT;
    }
    t.y = 0;
  }

  /** True when the pointer went down and up without really moving -- a click, not a drag. */
  get wasClick(): boolean {
    return this.#moved < 6;
  }

  /** Glide the view to a world point without yanking it -- used when you pick a building. */
  focus(point: THREE.Vector3Like, { distance }: FocusOptions = {}): void {
    this.desiredTarget.copy(point);
    this.desiredTarget.y = 0;
    this.#clampTarget();
    if (distance) this.desiredDistance = THREE.MathUtils.clamp(distance, MIN_DIST, MAX_DIST);
    this.#zoom = null;
    this.idleFor = 99; // settle to isometric right away rather than after a pause
  }

  resetView(): void {
    this.orbiting = false;
    this.desiredTarget.set(0, 0, 0);
    this.desiredDistance = 62;
    this.desiredPolar = ISO_POLAR;
    this.desiredAzimuth = this.#nearestIso();
    this.#zoom = null;
    this.idleFor = 99;
  }

  /**
   * Toggle the slow automatic sweep. It drives the heading only, so you can still drag,
   * tilt and zoom while it runs -- and it suppresses the rest-to-isometric easing, which
   * would otherwise pull the heading straight back to a corner it just left.
   */
  setOrbit(on: boolean): boolean {
    this.orbiting = on;
    // Switching it on deliberately should start the ramp now rather than after the pause
    // that follows a drag -- the blend still eases it in from a standstill.
    if (on) this.idleFor = ORBIT_RESUME_DELAY;
    return this.orbiting;
  }

  toggleOrbit(): boolean {
    return this.setOrbit(!this.orbiting);
  }

  /** A small camera kick, for a rocket landing or a launch. */
  shake(amount = 0.5): void {
    if (this.settings.get('reducedMotion')) return;
    this.#shake = Math.min(1.4, this.#shake + amount);
  }

  #nearestIso(): number {
    let best: number = ISO_AZIMUTHS[0];
    let bestDelta = Infinity;
    for (const base of ISO_AZIMUTHS) {
      // Compare in the same revolution as the current heading, so easing home never takes
      // the long way round the compass.
      const wrapped = base + Math.round((this.desiredAzimuth - base) / (Math.PI * 2)) * Math.PI * 2;
      const delta = Math.abs(wrapped - this.desiredAzimuth);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = wrapped;
      }
    }
    return best;
  }

  // -- frame ------------------------------------------------------------------------------

  update(dt: number): void {
    if (!this.interacting) this.idleFor += dt;

    // The sweep yields while you are working the camera and eases back in a couple of
    // seconds after you let go. Cutting it in and out at full rate reads as a glitch -- and
    // fighting a drag for the whole drag reads as the camera arguing with you.
    if (this.orbiting) {
      const wants = !this.interacting && this.idleFor >= ORBIT_RESUME_DELAY ? 1 : 0;
      this.orbitBlend = damp(this.orbitBlend, wants, wants ? ORBIT_RAMP_UP : ORBIT_RAMP_DOWN, dt);
      const rate = ORBIT_RATE * this.orbitBlend;
      this.desiredAzimuth += rate * dt;
      this.azimuth += rate * dt; // move both, so the sweep never lags behind itself
    } else {
      this.orbitBlend = 0;
    }

    // Rest back to isometric: after a beat of no input the heading walks to the nearest
    // clean 45 degrees and the tilt returns to the iso angle. Position and zoom are left alone.
    if (!this.orbiting && this.settings.get('autoFrame') && this.idleFor > 2.2 && !this.interacting) {
      const ease = Math.min(1.4, (this.idleFor - 2.2) * 0.7);
      this.desiredAzimuth = damp(this.desiredAzimuth, this.#nearestIso(), ease, dt);
      this.desiredPolar = damp(this.desiredPolar, ISO_POLAR, ease, dt);
    }

    const lambda = this.settings.get('reducedMotion') ? 40 : 9;
    this.azimuth = damp(this.azimuth, this.desiredAzimuth, lambda, dt);
    this.polar = damp(this.polar, this.desiredPolar, lambda, dt);
    this.distance = damp(this.distance, this.desiredDistance, 12, dt);
    if (!this.interacting) {
      this.target.x = damp(this.target.x, this.desiredTarget.x, lambda, dt);
      this.target.y = damp(this.target.y, this.desiredTarget.y, lambda, dt);
      this.target.z = damp(this.target.z, this.desiredTarget.z, lambda, dt);
    }

    this.#sync();
    this.#holdZoomAnchor();

    if (this.#shake > 0.001) {
      this.#shake = damp(this.#shake, 0, 3.2, dt);
      const t = performance.now() * 0.001;
      const a = this.#shake * 0.35;
      this.camera.position.x += Math.sin(t * 41) * a;
      this.camera.position.y += Math.sin(t * 57) * a;
      this.camera.position.z += Math.cos(t * 47) * a;
      this.camera.lookAt(this.target);
      this.camera.updateMatrixWorld();
    }
  }

  /**
   * Keep the wheel's anchor point under the cursor while the dolly eases in. Without this
   * the zoom is only anchored on the frame the wheel fired and then drifts as the distance
   * animates, which is exactly the wrong half of the effect.
   */
  #holdZoomAnchor(): void {
    if (!this.#zoom) return;
    if (Math.abs(this.distance - this.desiredDistance) < 0.02) {
      this.#zoom = null;
      return;
    }
    if (!this.groundPoint(this.#zoom.sx, this.#zoom.sy, this.#hit)) {
      this.#zoom = null;
      return;
    }
    const dx = this.#zoom.world.x - this.#hit.x;
    const dz = this.#zoom.world.z - this.#hit.z;
    if (Math.hypot(dx, dz) > this.distance * 2) {
      this.#zoom = null;
      return;
    }
    this.desiredTarget.x += dx;
    this.desiredTarget.z += dz;
    this.#clampTarget();
    this.target.x = this.desiredTarget.x;
    this.target.z = this.desiredTarget.z;
    this.#sync();
  }

  /** Place the camera from the current spherical state and make its matrices current. */
  #sync(): void {
    const sinP = Math.sin(this.polar);
    this.camera.position.set(
      this.target.x + this.distance * sinP * Math.sin(this.azimuth),
      this.target.y + this.distance * Math.cos(this.polar),
      this.target.z + this.distance * sinP * Math.cos(this.azimuth),
    );
    this.camera.lookAt(this.target);
    // Raycasts during a drag read these directly, so they cannot wait for the render pass.
    this.camera.updateMatrixWorld();
  }

  /** Where a screen point lands on the ground plane, or null if the ray never gets there. */
  groundPoint(clientX: number, clientY: number, out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 | null {
    const rect = this.dom.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.#ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.#ray.setFromCamera(this.#ndc, this.camera);
    return this.#ray.ray.intersectPlane(this.#plane, out) ? out : null;
  }
}
