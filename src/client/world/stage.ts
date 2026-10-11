import * as THREE from 'three';
import { Engine } from '../core/engine.ts';
import { CameraRig } from '../core/camera.ts';
import { Sky } from './sky.ts';
import { PLANETS, createTerrain, createScatter, terrainHeight, GROUND_SIZE } from './planet.ts';
import type { Planet } from './planet.ts';
import type { Settings, SettingKey, ChangeScope } from '../core/settings.ts';

export interface Layer {
  readonly object3d: THREE.Object3D;
  update(dt: number, now: number): void;
  dispose(): void;
}

/** A circle on the ground that the scatter must leave clear: a deck, the ship's apron. */
export interface ClearZone {
  x: number;
  z: number;
  r: number;
}

/**
 * A second scene drawn by the same renderer: the ship's interior. It brings
 * its own camera because inside you walk, and the orbiting rig is the
 * colony's; `focusDistance` is what the depth of field should keep sharp.
 */
export interface View {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly focusDistance: number;
  update(dt: number, now: number): void;
}

/**
 * The scene: the colony, and the ship's interior when you walk in.
 *
 * What used to be a renderer, a camera and a grid of ground is now a world:
 * the engine (renderer, post chain, quality governor), the camera rig, the
 * sky (which is also the light and the environment map), and the planet's
 * terrain with its scatter. Layers plug in exactly as before -- an
 * `object3d`, an `update`, a `dispose` -- so what the colony draws does not
 * need to know any of this exists.
 *
 * One renderer, one canvas, one animation loop: the WebGL contexts a
 * browser grants are few, which is also why `pagehide` disposes. The
 * interior is a `View` switched in on that same renderer, never a second
 * one; what you decide in there is decided on the Board panel, the same one
 * the HUD opens, so a second scene is not a second copy of the CEOs' state.
 */
export class Stage {
  readonly engine: Engine;
  readonly rig: CameraRig;
  readonly sky: Sky;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  #settings: Settings;
  #layers: Layer[] = [];
  #planet: Planet;
  #terrain: THREE.Mesh | null = null;
  #scatter: THREE.Group | null = null;
  #keepClear: ClearZone[] = [];
  #world = new THREE.Group();
  #view: View | null = null;

  // Moving-average fps counter, shown in the HUD.
  #frames = 0;
  #fpsAccum = 0;
  fps = 0;

  onContextLost: (() => void) | undefined;
  onContextRestored: (() => void) | undefined;
  #userMovedCamera = false;

  constructor(canvas: HTMLCanvasElement, settings: Settings) {
    this.#settings = settings;
    this.engine = new Engine(settings, canvas);
    this.scene = this.engine.scene;
    this.camera = this.engine.camera;
    this.renderer = this.engine.renderer;
    this.rig = new CameraRig(this.camera, canvas, settings);
    // The moment the user moves the camera we stop framing on their behalf:
    // repositioning the view under their fingers is the quickest way to
    // annoy them.
    this.rig.onUserInput = () => {
      this.#userMovedCamera = true;
    };

    this.#world.name = 'world';
    this.scene.add(this.#world);

    this.sky = new Sky(this.scene, settings, this.renderer);
    this.#planet = PLANETS[settings.get('planet')];
    this.sky.setPlanet(this.#planet);
    // Pushed in explicitly: `settings.set` is a no-op when the value has not
    // changed, so a colony restored at dusk would otherwise open in the
    // morning and stay there until something touched the slider.
    this.sky.setTime(settings.get('timeOfDay'));
    this.rebuildWorld();

    this.engine.onContextLost = () => this.onContextLost?.();
    this.engine.onContextRestored = () => this.onContextRestored?.();

    settings.onChange((changed, scope) => this.#onSettings(changed, scope));

    // Without this, reloading the page a few times leaves orphaned WebGL
    // contexts until the browser stops granting new ones.
    window.addEventListener('pagehide', () => this.dispose(), { once: true });
  }

  get planet(): Planet {
    return this.#planet;
  }

  /** How dark it is, 0 (day) to 1 (night): what lamps and windows read. */
  get night(): number {
    return this.sky.night;
  }

  /** The ground under a point, deck or not: the planet's own surface. */
  groundHeight(x: number, z: number): number {
    return terrainHeight(x, z, this.#planet);
  }

  /**
   * Where the scatter must not go. Kept separate from the terrain because of
   * WHEN it has to run: the world is built before the first roster arrives,
   * so at that moment there are no decks to avoid, and boulders would end up
   * under decks laid on top of them afterwards. So the scatter alone is
   * rebuilt whenever a zone's footprint changes -- cheap, because it no
   * longer drags the terrain mesh along with it.
   */
  setKeepClear(zones: readonly ClearZone[]): void {
    this.#keepClear = [...zones];
    this.#rebuildScatter();
  }

  /** Terrain and scatter for the current planet. Also what `onAssetsReady` calls. */
  rebuildWorld(): void {
    if (this.#terrain) {
      this.#world.remove(this.#terrain);
      this.#terrain.geometry.dispose();
      disposeMaterial(this.#terrain.material);
    }
    this.#terrain = createTerrain(this.#planet, this.#settings.get('groundDetail'));
    this.#world.add(this.#terrain);
    this.#rebuildScatter();
  }

  /** Called after every scatter rebuild: the crew routes around it, so a new scatter is a new grid. */
  onScatterRebuilt: (() => void) | undefined;

  #rebuildScatter(): void {
    if (this.#scatter) {
      this.#world.remove(this.#scatter);
      disposeTree(this.#scatter);
    }
    this.#scatter = createScatter(this.#planet, this.#settings.get('scatterDensity'), this.#keepClear);
    this.#world.add(this.#scatter);
    this.onScatterRebuilt?.();
  }

  /**
   * The ground scatter as obstacles, read straight off the instance matrices.
   *
   * A boulder an astronaut can walk through is the same bug as a habitat it
   * can walk through. Only what an astronaut would visibly stand INSIDE
   * counts: blocking every pebble and sprig would fence the corridors
   * between zones, which is exactly where the crew walks to get anywhere.
   */
  scatterObstacles(): { x: number; z: number; r: number }[] {
    const out: { x: number; z: number; r: number }[] = [];
    if (!this.#scatter) return out;
    const m = this.#navMatrix;
    for (const child of this.#scatter.children) {
      if (!(child instanceof THREE.InstancedMesh) || child.count === 0) continue;
      if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
      const box = child.geometry.boundingBox;
      if (!box) continue;
      const spread = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.5;
      for (let i = 0; i < child.count; i++) {
        child.getMatrixAt(i, m);
        const e = m.elements;
        const scale = Math.hypot(e[0]!, e[1]!, e[2]!);
        const r = spread * scale * 0.65;
        if (r < 0.55) continue;
        out.push({ x: e[12]!, z: e[14]!, r });
      }
    }
    return out;
  }

  #navMatrix = new THREE.Matrix4();

  #onSettings(changed: ReadonlySet<SettingKey>, scope: ChangeScope): void {
    if (changed.has('planet')) {
      this.#planet = PLANETS[this.#settings.get('planet')];
      this.sky.setPlanet(this.#planet);
    }
    if (scope.world) this.rebuildWorld();
    if (scope.render || changed.has('fov')) this.engine.applySettings();
    if (changed.has('timeOfDay')) this.sky.setTime(this.#settings.get('timeOfDay'));
  }

  /**
   * Frame the colony. It widens with every new project, and a fixed camera
   * would end up showing only a piece of it. It adjusts on its own until the
   * user touches the controls: from then on the view is theirs and it is not
   * moved under their fingers any more.
   */
  frameCity(box: { cx: number; cz: number; radius: number }, force = false): void {
    if (this.#userMovedCamera && !force) return;
    // Coming back to the colony is as explicit a gesture as going to the
    // ship: from here on the view is yours, and it never reframes itself.
    if (force) this.#userMovedCamera = true;
    const span = Math.max(box.radius * 1.35, 24);
    this.rig.focus({ x: box.cx, y: 0, z: box.cz }, { distance: this.#distanceFor(span) });
  }

  /**
   * Go somewhere you asked for: the ship, north of the colony, or one project
   * seen up close.
   *
   * Unlike `frameCity` this does NOT yield to `#userMovedCamera`: it is an
   * explicit gesture -- you asked to go there -- and ignoring it because the
   * camera was moved in the past would be a command that does not answer.
   */
  frameSpot(at: { x: number; y: number; z: number }, span: number): void {
    this.#userMovedCamera = true; // from here on the view is yours
    this.rig.focus(at, { distance: this.#distanceFor(span) });
  }

  /** How far back the rig has to sit to fit `span` world units on screen. */
  #distanceFor(span: number): number {
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(fovRad / 2) * this.camera.aspect);
    return span / Math.tan(Math.min(fovRad, hFov) / 2);
  }

  addLayer(layer: Layer): void {
    this.#layers.push(layer);
    this.scene.add(layer.object3d);
  }

  /**
   * Walk into a second scene, or back out to the colony with null.
   *
   * The rig is switched off while inside: left on, it would keep reading the
   * mouse to move a camera nobody is looking through, and you would come
   * back out to a colony turned by gestures that seemed to be about
   * something else. The colony's layers keep stepping: a session that ended
   * while you were in there has walked home by the time you come out, rather
   * than all at once when you do.
   */
  setView(view: View | null): void {
    this.#view = view;
    this.rig.enabled = view === null;
    this.engine.setView(view);
  }

  /** The scene being drawn instead of the colony, if any. */
  get view(): View | null {
    return this.#view;
  }

  resize(): void {
    this.engine.resize();
  }

  start(): void {
    this.engine.start((dt, elapsed) => this.#frame(dt, elapsed));
  }

  stop(): void {
    this.engine.stop();
  }

  #frame(dt: number, elapsed: number): void {
    this.#fpsAccum += dt;
    this.#frames++;
    if (this.#fpsAccum >= 0.5) {
      this.fps = Math.round(this.#frames / this.#fpsAccum);
      this.#frames = 0;
      this.#fpsAccum = 0;
    }

    this.rig.update(dt);
    this.sky.setFocus(this.rig.target);
    // The dome, the stars and the companion ride with the camera: at their
    // radius a camera that wanders off would otherwise see their edge.
    if (this.sky.update(dt, this.camera)) {
      // The sky moved the clock itself: written straight into the values,
      // bypassing `set`, so a running cycle does not emit and save thirty
      // times a second.
      this.#settings.values.timeOfDay = this.sky.time;
    }
    // Whatever the camera is orbiting is what should be in focus.
    this.engine.setFocusDistance(this.rig.distance);
    for (const layer of this.#layers) layer.update(dt, elapsed);
    const view = this.#view;
    if (view) {
      view.update(dt, elapsed);
      this.engine.setFocusDistance(view.focusDistance);
    }
  }

  #disposed = false;

  dispose(): void {
    // The engine disposes itself on `pagehide` too; whoever comes second
    // must find nothing left to do.
    if (this.#disposed) return;
    this.#disposed = true;
    this.stop();
    for (const layer of this.#layers) layer.dispose();
    if (this.#scatter) disposeTree(this.#scatter);
    if (this.#terrain) {
      this.#terrain.geometry.dispose();
      disposeMaterial(this.#terrain.material);
    }
    this.sky.dispose();
    this.rig.dispose();
    this.engine.dispose();
  }
}

/** The extent of the ground, for anything that wants to stay on it. */
export const WORLD_EXTENT = GROUND_SIZE / 2;

function disposeMaterial(m: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(m)) for (const x of m) x.dispose();
  else m.dispose();
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      disposeMaterial(o.material);
    }
  });
}
