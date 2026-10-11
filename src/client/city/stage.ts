import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BG, FOG } from './palette.ts';
import { createGround } from './ground.ts';

export interface Layer {
  readonly object3d: THREE.Object3D;
  update(dt: number, now: number): void;
  dispose(): void;
}

const CITY_SIZE = 1400;

/**
 * The city's scene: one renderer, one canvas, one rAF, which is also why
 * `pagehide` calls `dispose()`: the WebGL contexts a browser grants are few.
 * There is no HQ here; the room inside the ship belongs to the colony's
 * stage (`world/stage.ts`), which draws on a canvas of its own.
 *
 * Only one of the two views runs a frame loop. `start`/`stop` say whether the
 * city is the view on screen; a hidden tab or a lost context only pauses it,
 * and coming back resumes it only if it was wanted: otherwise a tab brought
 * forward while the colony is on screen would start drawing the city again,
 * behind it, for nobody.
 */
export class Stage {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  #layers: Layer[] = [];
  #lastT = 0;
  #raf = 0;
  #running = false;
  /** The city is the view on screen. */
  #wanted = false;
  #onResize: () => void;
  #onVisibility: () => void;

  // fps counter with a moving average, shown in the HUD
  #frames = 0;
  #fpsAccum = 0;
  fps = 0;

  onContextLost: (() => void) | undefined;
  onContextRestored: (() => void) | undefined;
  #userMovedCamera = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(BG, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(FOG, 260, 1100);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.5, 2000);
    this.camera.position.set(0, 70, 190);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxPolarAngle = Math.PI * 0.495; // do not go below ground
    this.controls.minDistance = 6;
    this.controls.maxDistance = 1200;
    this.controls.target.set(0, 9, 0);

    this.scene.add(createGround(CITY_SIZE));
    this.scene.add(new THREE.AmbientLight(0x9fd8ff, 0.55));
    const key = new THREE.DirectionalLight(0xbfe4ff, 0.6);
    key.position.set(60, 120, 40);
    this.scene.add(key);

    // The WebGL context can be lost (GPU switch, suspend, too many contexts
    // open in the browser): better to stop and resume explicitly than keep
    // calling render() on a dead context.
    const gl = this.renderer.domElement;
    gl.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.#halt();
      this.onContextLost?.();
    });
    gl.addEventListener('webglcontextrestored', () => {
      if (this.#wanted) this.#run();
      this.onContextRestored?.();
    });

    // As soon as the user moves the camera we stop framing on our own:
    // repositioning their view under their fingers is the fastest way to annoy them.
    this.controls.addEventListener('start', () => {
      this.#userMovedCamera = true;
    });

    this.#onResize = () => this.resize();
    this.#onVisibility = () => {
      // rAF paused when the tab is not visible: no wasted work
      if (document.hidden) this.#halt();
      else if (this.#wanted) this.#run();
    };
    window.addEventListener('resize', this.#onResize);
    document.addEventListener('visibilitychange', this.#onVisibility);
    // Without this, reloading the page multiple times leaves orphaned WebGL
    // contexts until the browser stops granting new ones.
    window.addEventListener('pagehide', () => this.dispose(), { once: true });
    this.resize();
  }

  /**
   * Frames the city. It widens with each new project, and a fixed camera
   * would end up showing only a piece of it. It adjusts on its own until the
   * user touches the controls: from that moment the view is theirs and it is
   * not repositioned under their fingers anymore.
   */
  frameCity(box: { cx: number; cz: number; radius: number }, maxHeight: number, force = false): void {
    const { cx, cz, radius } = box;
    if (this.#userMovedCamera && !force) return;
    // Returning to the city is as explicit a gesture as zooming in: from
    // here on the view stays yours, and it does not reposition itself
    // anymore.
    if (force) this.#userMovedCamera = true;
    // Need to fit both width and height: with towers seventy units tall,
    // framing only the footprint leaves the skyscrapers cut off at the top.
    const span = Math.max(radius * 1.45, maxHeight * 1.15, 52);
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(fovRad / 2) * this.camera.aspect);
    const distance = span / Math.tan(Math.min(fovRad, hFov) / 2);
    // Three-quarter view: a city seen head-on loses all depth.
    this.camera.position.set(cx + distance * 0.46, Math.max(maxHeight * 1.25, span * 0.72), cz + distance * 0.72);
    this.controls.target.set(cx, maxHeight * 0.42, cz);
    this.controls.update();
  }

  /**
   * Go somewhere you asked for: one tower seen up close.
   *
   * Unlike `frameCity` this does NOT defer to `#userMovedCamera`: it is an
   * explicit gesture -- you asked to go there -- and ignoring it because you
   * had moved the camera in the past would be a command that does not respond.
   */
  frameSpot(at: { x: number; y: number; z: number }, span: number): void {
    this.#userMovedCamera = true; // from here on the view is yours
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(fovRad / 2) * this.camera.aspect);
    const distance = span / Math.tan(Math.min(fovRad, hFov) / 2);
    // You arrive from +Z, the side the whole city is seen from: arriving
    // from the opposite side disorients.
    this.camera.position.set(at.x + distance * 0.34, at.y + span * 0.62, at.z + distance * 0.78);
    this.controls.target.set(at.x, at.y, at.z);
    this.controls.update();
  }

  addLayer(layer: Layer): void {
    this.#layers.push(layer);
    this.scene.add(layer.object3d);
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  start(): void {
    this.#wanted = true;
    if (!document.hidden) this.#run();
  }

  stop(): void {
    this.#wanted = false;
    this.#halt();
  }

  #run(): void {
    if (this.#running) return;
    this.#running = true;
    this.#lastT = performance.now() / 1000;
    const loop = (): void => {
      if (!this.#running) return;
      this.#raf = requestAnimationFrame(loop);
      this.#frame();
    };
    this.#raf = requestAnimationFrame(loop);
  }

  #halt(): void {
    this.#running = false;
    if (this.#raf) cancelAnimationFrame(this.#raf);
    this.#raf = 0;
  }

  #frame(): void {
    const now = performance.now() / 1000;
    const dt = Math.min(now - this.#lastT, 0.1);
    this.#lastT = now;

    this.#fpsAccum += dt;
    this.#frames++;
    if (this.#fpsAccum >= 0.5) {
      this.fps = Math.round(this.#frames / this.#fpsAccum);
      this.#frames = 0;
      this.#fpsAccum = 0;
    }

    this.controls.update();
    for (const layer of this.#layers) layer.update(dt, now);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.#onResize);
    document.removeEventListener('visibilitychange', this.#onVisibility);
    for (const layer of this.#layers) layer.dispose();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
