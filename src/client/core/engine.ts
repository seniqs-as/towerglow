import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { SHADOW_SIZES, type Settings } from './settings.ts';
import { createTiltShift, type TiltShift } from './tiltshift.ts';

/** Safari and friends -- not Chrome, which also says "Safari" in its user agent. */
const IS_WEBKIT =
  typeof navigator !== 'undefined' &&
  /apple/i.test(navigator.vendor || '') &&
  !/chrome|chromium|edg\//i.test(navigator.userAgent || '');

/** CSS size of the window, buffer size of the drawing surface, and the ratio between them. */
export interface Viewport {
  w: number;
  h: number;
  bw: number;
  bh: number;
  scale: number;
}

/** What the frame loop calls before it renders: the step, and the clock since `start()`. */
export type FrameCallback = (dt: number, elapsed: number) => void;

/** The two numbers `PerfMonitor` reads off `renderer.info` -- kept structural so a test can fake it. */
export interface RenderInfo {
  render: { calls: number; triangles: number };
}

/**
 * Renderer, post chain, and the frame loop.
 *
 * Ported from Bot Crossing (MIT). The canvas is handed in rather than created, and it is
 * sized by CSS to the window, so the drawing buffer follows `window.innerWidth/innerHeight`
 * rather than a parent element.
 *
 * Two things here are load-bearing for performance:
 *
 * 1. **The post chain is built lazily and torn down when off.** With bloom disabled the
 *    composer is not merely skipped -- it is disposed, so its float render targets stop
 *    costing memory and bandwidth. Turning HDR off on a weak machine has to actually
 *    give the memory back, not just stop drawing.
 * 2. **Render scale is separate from device pixel ratio.** `setPixelRatio` alone cannot go
 *    below 1 usefully on a retina panel, so the drawing buffer is sized directly. That is
 *    the single biggest lever there is, and it is what the auto-quality governor pulls.
 *
 *    The setting is a fraction of *the display's own resolution*, not of CSS pixels: 100%
 *    on a retina panel is 2 buffer pixels per CSS pixel. Reading it as CSS pixels is what
 *    the earlier version did, and it quietly rendered every retina machine at half
 *    resolution -- text on the name plates and the badge glyphs magnify hardest, so they
 *    are where a soft buffer shows up first.
 */
export class Engine {
  readonly settings: Settings;
  readonly timer: THREE.Timer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly perf = new PerfMonitor();
  viewport: Viewport = { w: 1, h: 1, bw: 1, bh: 1, scale: 1 };
  elapsed = 0;
  running = false;
  /** True while the governor is holding the buffer below the scale the user asked for. */
  autoScaled = false;

  onContextLost: (() => void) | undefined;
  onContextRestored: (() => void) | undefined;

  #composer: EffectComposer | null = null;
  #renderPass: RenderPass | null = null;
  /** What is drawn instead of `scene`, or null for the colony. See `setView`. */
  #view: { scene: THREE.Scene; camera: THREE.PerspectiveCamera } | null = null;
  #bloomPass: UnrealBloomPass | null = null;
  #smaaPass: SMAAPass | null = null;
  #tiltShift: TiltShift | null = null;
  /** How far the view is orbiting; the focal plane sits here. Fed by the frame loop. */
  #focusDistance = 30;
  #shadowSize = -1;
  #onFrame: FrameCallback | null = null;

  #lastGovern = 0;
  #slow = 0;
  #fast = 0;
  #climbAt = 0;

  readonly #dprQuery: MediaQueryList;
  readonly #onResize = (): void => this.resize();
  readonly #onWake = (): void => {
    if (document.hidden || !this.running) return;
    this.resize();
    this.renderFrame();
  };
  readonly #onContextLost = (e: Event): void => {
    e.preventDefault();
    this.stop();
    this.onContextLost?.();
  };
  readonly #onContextRestored = (): void => {
    this.start();
    this.onContextRestored?.();
  };
  readonly #onPageHide = (): void => this.dispose();

  constructor(settings: Settings, canvas: HTMLCanvasElement) {
    this.settings = settings;
    // Timer replaces the deprecated Clock. Connecting it to the document means a tab that
    // has been in the background reports a zero delta rather than one enormous catch-up
    // frame, so nothing in the city teleports when you come back to it.
    this.timer = new THREE.Timer();
    this.timer.connect(document);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(settings.get('fov'), 1, 0.5, 1500);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // handled by SMAA in the post chain, or not at all
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      /**
       * Off everywhere it can be: preserving the buffer costs a full copy on every frame,
       * forever, and the screenshot path already works around needing it.
       *
       * On WebKit it has to be on. Safari treats a window with another app in front of it
       * as *hidden*, stops driving `requestAnimationFrame`, and then composites the canvas
       * anyway -- and a drawing buffer nobody has drawn into since the last composite is
       * transparent black. The symptom is the whole city blinking out for a frame every
       * few seconds, but only while something is layered over the window, which is exactly
       * the case where nothing is repainting it.
       */
      preserveDrawingBuffer: IS_WEBKIT,
    });
    this.renderer.setPixelRatio(1); // the drawing buffer is sized by hand, see resize()
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = settings.get('exposure');
    // PCFSoftShadowMap is deprecated and silently downgraded by three anyway.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;

    this.canvas = canvas;

    // The WebGL context can go away (GPU switch, suspend, too many contexts open in the
    // browser): better to stop and resume explicitly than keep calling render() on a dead one.
    canvas.addEventListener('webglcontextlost', this.#onContextLost);
    canvas.addEventListener('webglcontextrestored', this.#onContextRestored);

    window.addEventListener('resize', this.#onResize);
    // A window dragged between a retina and a non-retina display changes DPR with no resize.
    this.#dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.#dprQuery.addEventListener('change', this.#onResize);

    // Coming back from hidden -- a tab switch, or another window moving off this one -- the
    // compositor can ask for the canvas before the frame loop has run once. Drawing here
    // rather than waiting for the next animation frame is what stops that moment being a
    // black flash.
    document.addEventListener('visibilitychange', this.#onWake);
    window.addEventListener('focus', this.#onWake);
    window.addEventListener('pageshow', this.#onWake);
    // Without this, reloading the page a few times leaves orphaned WebGL contexts behind
    // until the browser stops granting new ones.
    window.addEventListener('pagehide', this.#onPageHide, { once: true });

    this.applySettings();
  }

  /** Rebuilds only what a settings change actually invalidated. */
  applySettings(): void {
    const s = this.settings;
    const renderer = this.renderer;

    const size = SHADOW_SIZES[s.get('shadows')] || 0;
    renderer.shadowMap.enabled = size > 0;
    // A shadow map that changes size has to be thrown away or three keeps the old target.
    if (this.#shadowSize !== size) {
      this.#shadowSize = size;
      this.scene.traverse((o) => {
        const shadow = shadowOf(o);
        if (shadow?.map) {
          shadow.map.dispose();
          shadow.map = null;
          if (size) shadow.mapSize.setScalar(size);
        }
      });
      renderer.shadowMap.needsUpdate = true;
    }

    renderer.toneMappingExposure = s.get('exposure');
    this.camera.fov = s.get('fov');
    this.camera.updateProjectionMatrix();

    if (this.#wantsPost()) this.#ensureComposer();
    else this.#disposeComposer();

    if (this.#composer) {
      if (this.#bloomPass) {
        this.#bloomPass.enabled = s.get('bloom');
        this.#bloomPass.strength = s.get('bloomStrength');
      }
      if (this.#smaaPass) this.#smaaPass.enabled = s.get('antialias');
      if (this.#tiltShift) {
        this.#tiltShift.enabled = s.get('tiltShift');
        this.#tiltShift.setStrength(s.get('tiltShiftStrength'));
        this.#tiltShift.setAngle(s.get('tiltShiftAngle'));
        this.#tiltShift.setCamera(this.#drawCamera);
      }
    }

    this.resize();
  }

  /** Any pass at all means the composer must exist and must be the thing that draws. */
  #wantsPost(): boolean {
    const s = this.settings;
    return s.get('bloom') || s.get('antialias') || s.get('tiltShift');
  }

  #ensureComposer(): void {
    if (this.#composer) return;
    // A depth texture on the target is what lets tilt-shift be a real depth of field rather
    // than a screen-space smear. It costs one attachment, where asking three's own BokehPass
    // for the same thing costs a second pass over the entire scene.
    const depthTexture = new THREE.DepthTexture(1, 1);
    depthTexture.type = THREE.UnsignedIntType;
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, // HDR: values above 1 survive to the bloom pass
      colorSpace: THREE.LinearSRGBColorSpace,
      samples: 0,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture,
    });
    const composer = new EffectComposer(this.renderer, target);
    this.#renderPass = new RenderPass(this.#drawScene, this.#drawCamera);
    composer.addPass(this.#renderPass);

    // A high threshold is what keeps this an accent rather than a haze: only the eyes,
    // lamps, sparks and the sun's disc clear it, so lit surfaces stay crisp.
    this.#bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), this.settings.get('bloomStrength'), 0.55, 0.92);
    composer.addPass(this.#bloomPass);

    // After bloom, so an out-of-focus lamp keeps its glow and the glow goes soft with it
    // -- blurring first would drop those pixels under the bloom threshold and switch the
    // glow off exactly where the eye expects the most of it. Still before OutputPass, so
    // the blur averages linear HDR values rather than tone-mapped ones.
    this.#tiltShift = createTiltShift();
    for (const pass of this.#tiltShift.passes) composer.addPass(pass);
    // RenderPass and the bloom pass both leave their result in the composer's *read* buffer
    // and neither asks for a swap, so renderTarget2 is what actually holds the scene -- and
    // its depth texture is the clone that got written, not the one handed in above.
    // Deliberately not bound to a fixed target here -- see `#syncDepthTexture`.
    this.#tiltShift.enabled = this.settings.get('tiltShift');
    this.#tiltShift.setStrength(this.settings.get('tiltShiftStrength'));
    this.#tiltShift.setAngle(this.settings.get('tiltShiftAngle'));
    this.#tiltShift.setCamera(this.#drawCamera);
    this.#tiltShift.setFocusDistance(this.#focusDistance);

    // OutputPass is what applies tone mapping + sRGB once, at the end of the chain.
    composer.addPass(new OutputPass());

    // three 0.185's SMAAPass takes no size: the composer's setSize reaches it like any pass.
    this.#smaaPass = new SMAAPass();
    composer.addPass(this.#smaaPass);

    this.#composer = composer;
  }

  #disposeComposer(): void {
    if (!this.#composer) return;
    // The composer's own dispose covers its two targets and the copy pass it made for
    // itself; the passes we added are ours to free.
    this.#composer.dispose();
    for (const pass of this.#composer.passes) pass.dispose();
    this.#composer = null;
    this.#renderPass = null;
    this.#bloomPass = null;
    this.#smaaPass = null;
    this.#tiltShift = null;
  }

  resize(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // The view drawn instead is sized too: a window resized while inside the
    // ship would otherwise come back out through a stretched lens.
    if (this.#view) {
      this.#view.camera.aspect = w / h;
      this.#view.camera.updateProjectionMatrix();
    }

    const scale = this.#targetScale();
    const bw = Math.max(1, Math.round(w * scale));
    const bh = Math.max(1, Math.round(h * scale));

    // Only the drawing buffer is sized here. The element's own size is left to the CSS
    // (`position: absolute; inset: 0`), because a hand-written width is a second opinion
    // about how big the canvas is -- and the moment the two disagree, the scene is drawn to
    // one rectangle while every panel is positioned against the other.
    this.renderer.setSize(bw, bh, false);
    this.#composer?.setSize(bw, bh);
    this.#tiltShift?.setSize(bw, bh);
    this.#tiltShift?.setCamera(this.#drawCamera);
    this.viewport = { w, h, bw, bh, scale };
  }

  /**
   * Draw another scene through another camera, or the colony again with null.
   *
   * The ship's interior is a second scene on THIS renderer, through THIS post
   * chain: a second `WebGLRenderer` would be a second context, and the
   * browser grants few of them -- the same reason `pagehide` disposes. Only
   * what is drawn changes; the colony keeps being stepped by whoever owns it.
   */
  setView(view: { scene: THREE.Scene; camera: THREE.PerspectiveCamera } | null): void {
    this.#view = view;
    if (this.#renderPass) {
      this.#renderPass.scene = this.#drawScene;
      this.#renderPass.camera = this.#drawCamera;
    }
    this.resize();
  }

  get #drawScene(): THREE.Scene {
    return this.#view?.scene ?? this.scene;
  }

  get #drawCamera(): THREE.PerspectiveCamera {
    return this.#view?.camera ?? this.camera;
  }

  /**
   * Point the depth-of-field pass at the depth that was actually just written.
   *
   * This cannot be wired once at build time. `EffectComposer` keeps its read/write buffers
   * between frames, and this chain performs an odd number of swaps, so the two targets trade
   * places every frame -- and `RenderPass` always draws into whichever is currently the *read*
   * buffer. Binding one target's depth texture permanently therefore samples the previous
   * frame's depth on every other frame, which shows up as the whole picture strobing between
   * sharp and smeared rather than as anything recognisable as a depth-of-field bug.
   */
  #syncDepthTexture(): void {
    if (this.#tiltShift && this.#composer) {
      this.#tiltShift.setDepthTexture(this.#composer.readBuffer.depthTexture);
    }
  }

  /** What the view is looking at, so the plane of focus can sit on it. */
  setFocusDistance(distance: number): void {
    this.#focusDistance = distance;
    this.#tiltShift?.setFocusDistance(distance);
  }

  /**
   * Buffer pixels per CSS pixel. `renderScale` is a share of what the display can actually
   * show, so 100% is native on any panel and 50% is half of it either way.
   */
  #targetScale(): number {
    return this.settings.get('renderScale') * (window.devicePixelRatio || 1);
  }

  /**
   * Run the loop. The callback is remembered, so a restart after a lost context -- or a
   * bare `start()` from anywhere else -- keeps stepping the same world.
   */
  start(onFrame?: FrameCallback): void {
    if (onFrame) this.#onFrame = onFrame;
    if (this.running) return;
    this.running = true;
    this.timer.reset();
    this.renderer.setAnimationLoop(this.#loop);
  }

  stop(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  readonly #loop = (): void => {
    this.timer.update();
    // The timer already zeroes the delta across a hidden tab; the clamp is the backstop for
    // an ordinary long frame, so one stalled frame never jumps the whole city forward.
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.elapsed += dt;

    this.#onFrame?.(dt, this.elapsed);

    // Before the draw, never after it. Resizing the drawing buffer throws away what is in
    // it, and the browser composites the canvas at the end of this callback: a governor step
    // taken after the draw handed it an empty buffer, which is the whole screen going black
    // for as long as the new render targets take to come up. Taken before, this same frame
    // is drawn into the new buffer and the old picture stays up until it is ready.
    if (this.settings.get('autoQuality')) this.#governQuality();

    this.renderer.info.reset();
    if (this.#composer && this.#wantsPost()) {
      this.#syncDepthTexture();
      this.#composer.render(dt);
    } else {
      this.renderer.render(this.#drawScene, this.#drawCamera);
    }

    this.perf.sample(dt, this.renderer.info);
  };

  /**
   * Draw one frame without stepping the simulation. Used by the screenshot path, which has
   * to read the drawing buffer in the same task as the draw that filled it -- the alternative
   * is `preserveDrawingBuffer`, which costs a full copy on every frame forever.
   */
  renderFrame(): void {
    this.renderer.info.reset();
    if (this.#composer && this.#wantsPost()) {
      this.#syncDepthTexture();
      this.#composer.render(0);
    } else {
      this.renderer.render(this.#drawScene, this.#drawCamera);
    }
  }

  /**
   * Adaptive render scale. Never touches the setting the user chose; it scales *under* it.
   *
   * Every move resizes the drawing buffer and rebuilds the post chain's render targets,
   * which is a visible event -- on WebKit it can cost a black frame outright. So the bar for
   * moving is deliberately high: a full second between samples, several consecutive samples
   * agreeing before anything changes, and a long cooldown before it climbs back after a
   * drop. A governor that reacts to one bad second finds the boundary and then sits on it,
   * resizing back and forth for as long as you leave the window open.
   */
  #governQuality(): void {
    const now = performance.now();
    if (now - this.#lastGovern < 1000) return;
    this.#lastGovern = now;

    const fps = this.perf.fps;
    if (fps <= 0) return;
    const ceiling = this.#targetScale();
    const current = this.viewport.scale;
    // The floor is half the display's own resolution, not half a CSS pixel: on a retina
    // panel the old absolute 0.5 was a quarter-resolution buffer, which reads as broken
    // rather than as a machine having a hard time.
    const floor = 0.35 * (window.devicePixelRatio || 1);

    // Sustained evidence, not one sample: 3 slow seconds to drop, 8 fast ones to climb.
    this.#slow = fps < 45 ? this.#slow + 1 : 0;
    this.#fast = fps > 58 ? this.#fast + 1 : 0;
    const dpr = window.devicePixelRatio || 1;

    let next = current;
    if (this.#slow >= 3) {
      next = Math.max(floor, current - 0.15 * dpr);
      this.#slow = 0;
      // Having just proved this machine cannot hold the higher scale, do not go back and
      // ask it again ten seconds later -- that is the oscillation.
      this.#climbAt = now + 30000;
    } else if (this.#fast >= 8 && current < ceiling && now >= this.#climbAt) {
      next = Math.min(ceiling, current + 0.1 * dpr);
      this.#fast = 0;
    }

    if (Math.abs(next - current) > 0.01) {
      const bw = Math.max(1, Math.round(this.viewport.w * next));
      const bh = Math.max(1, Math.round(this.viewport.h * next));
      this.renderer.setSize(bw, bh, false);
      this.#composer?.setSize(bw, bh);
      this.#tiltShift?.setSize(bw, bh);
      this.#tiltShift?.setCamera(this.#drawCamera);
      this.viewport = { ...this.viewport, bw, bh, scale: next };
      this.autoScaled = next < ceiling - 0.01;
    }
  }

  dispose(): void {
    this.stop();
    this.timer.dispose();
    window.removeEventListener('resize', this.#onResize);
    this.#dprQuery.removeEventListener('change', this.#onResize);
    document.removeEventListener('visibilitychange', this.#onWake);
    window.removeEventListener('focus', this.#onWake);
    window.removeEventListener('pageshow', this.#onWake);
    window.removeEventListener('pagehide', this.#onPageHide);
    this.canvas.removeEventListener('webglcontextlost', this.#onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.#onContextRestored);
    this.#disposeComposer();
    this.renderer.dispose();
  }
}

/**
 * The shadow of a light, if it is a light and it casts one. `Light` itself is typed without
 * `shadow` -- only these three concrete lights carry it -- so the traverse asks rather than
 * assumes. Ambient, hemisphere and rect-area lights cast none and fall through.
 */
function shadowOf(o: THREE.Object3D): THREE.LightShadow | null {
  if (o instanceof THREE.DirectionalLight || o instanceof THREE.SpotLight || o instanceof THREE.PointLight) {
    return o.shadow;
  }
  return null;
}

/** Rolling frame stats -- an EMA so the readout does not flicker on a single slow frame. */
export class PerfMonitor {
  fps = 0;
  frameMs = 0;
  drawCalls = 0;
  triangles = 0;
  #frames = 0;

  sample(dt: number, info: RenderInfo): void {
    const ms = dt * 1000;
    const k = this.#frames < 10 ? 0.3 : 0.06;
    this.frameMs += (ms - this.frameMs) * k;
    this.fps = this.frameMs > 0 ? 1000 / this.frameMs : 0;
    this.#frames++;
    if (this.#frames % 10 === 0) {
      this.drawCalls = info.render.calls;
      this.triangles = info.render.triangles;
    }
  }
}
