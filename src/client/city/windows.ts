import * as THREE from 'three';
import { FADE_MS, offAt } from '../state/lights.ts';
import type { Light } from '../state/lights.ts';
import { floorsForSize, windowCell, windowPlacement, windowSize } from './layout.ts';
import { PROVIDER_COLOR, SKILL_COLOR, TOOL_COLOR } from './palette.ts';
import { categoryOf } from '../../shared/toolCategories.ts';
import type { Layer } from './stage.ts';

const CAP = 2048;
/**
 * How long it takes for the light to come fully on.
 *
 * Not a duration: how long it stays lit is decided by the light model, and
 * this is only the rise time. An instant switch-on reads as a glitch, not
 * as a light.
 */
const RISE_S = 0.35;

/**
 * Sentinel for an instance never used: far lower than any real instant, so
 * it can never be mistaken for a real switch-on.
 */
const NEVER = -1e6;

/** A window that does not yet have a switch-off time: far in the future. */
const NOT_YET = 1e9;

/**
 * Minimum radius, in pixels, within which the pointer picks up a window.
 *
 * From afar a window is a few pixels wide: without a margin, reading its
 * name would mean centering it under the mouse like a target.
 */
const PICK_MIN_PX = 10;

/** A drawn window: whose it is, and where it stands. */
interface Placed {
  light: Light;
  center: THREE.Vector3;
  /** Half the horizontal side, along the facade. */
  across: THREE.Vector3;
  /** Half the vertical side. */
  up: THREE.Vector3;
}

export interface BuildingMetrics {
  position: THREE.Vector3 | null;
  height: number;
  footprint: number;
  size: number;
}

/**
 * The facade's windows: someone working inside the building.
 *
 * A lit window is a piece of work: a session's running turn, a call to a
 * tool, a subagent, a skill. How long it stays lit -- at least the minimum,
 * then for as long as the work lasts -- is decided by `Lights`; here it is
 * only drawn.
 *
 * No dark windows, and no frames either: a window exists only if someone is
 * working inside it, so drawing an empty one would say nothing.
 */
export class Windows implements Layer {
  readonly object3d: THREE.Group;
  #mesh: THREE.InstancedMesh;
  /** The same facade drawn BEFORE the buildings: seen through the glass. */
  #through: THREE.InstancedMesh;
  #material: THREE.ShaderMaterial;
  #color: THREE.InstancedBufferAttribute;
  #t0: THREE.InstancedBufferAttribute;
  #t1: THREE.InstancedBufferAttribute;
  #dummy = new THREE.Object3D();
  #placed: Placed[] = [];
  #v = new THREE.Vector3();
  #corner = new THREE.Vector3();

  constructor() {
    this.object3d = new THREE.Group();
    this.object3d.name = 'windows';

    const geometry = new THREE.PlaneGeometry(1, 1);
    const colors = new Float32Array(CAP * 3);
    this.#color = new THREE.InstancedBufferAttribute(colors, 3);
    this.#t0 = new THREE.InstancedBufferAttribute(new Float32Array(CAP).fill(NEVER), 1);
    this.#t1 = new THREE.InstancedBufferAttribute(new Float32Array(CAP).fill(NOT_YET), 1);
    geometry.setAttribute('aColor', this.#color);
    geometry.setAttribute('aT0', this.#t0);
    geometry.setAttribute('aT1', this.#t1);

    this.#material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Normal blending, not additive: added to the facade, the light took
      // on its tint, and on Claude's orange building the window's orange
      // came out yellow. Covered, it is exactly the color of the legend.
      blending: THREE.NormalBlending,
      uniforms: {
        uTime: { value: 0 },
        uRise: { value: RISE_S },
        uFade: { value: FADE_MS / 1000 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aT0;
        attribute float aT1;
        uniform float uTime;
        uniform float uRise;
        uniform float uFade;
        varying vec3 vColor;
        varying float vLit;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vColor = aColor;
          // Rises in an instant, holds, and fades when its time comes. The
          // switch-off time is computed by the light model -- the minimum,
          // or the real end of the work if it comes later -- and until it
          // exists it stays in the far future.
          float rise = clamp((uTime - aT0) / uRise, 0.0, 1.0);
          float fade = 1.0 - clamp((uTime - aT1) / uFade, 0.0, 1.0);
          vLit = aT0 < -900000.0 ? 0.0 : rise * fade;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vColor;
        varying float vLit;
        varying vec2 vUv;
        void main() {
          // Solid glass, not a frame: a window exists only if someone is
          // working inside it, so drawing it dark would mean nothing.
          vec2 d = abs(vUv - 0.5) * 2.0;
          float edge = max(d.x, d.y);
          // Slightly soft edge: sharp would look glued on top of the
          // facade instead of set into it.
          float shape = 1.0 - smoothstep(0.82, 1.0, edge);
          float alpha = shape * vLit;
          if (alpha < 0.012) discard;
          // The color comes out AS IS. Multiplying it to make it glow
          // pushed every channel past 1, and the clamp ate the tint:
          // subagent and skill both ended up on the same magenta, Claude's
          // orange became yellow. The color is the information.
          gl_FragColor = vec4(vColor, alpha);
        }
      `,
    });

    // Two passes on the same instances, in a FIXED order relative to the
    // buildings.
    //
    // Buildings and windows are both transparent, and three sorts them by
    // the center of the sphere that bounds the instances -- computed once,
    // when there are no windows yet. The order ended up depending on where
    // the camera stood: from some angles the glass was drawn OVER the
    // windows and veiled them by a third, from others the ones on the back
    // disappeared behind the wall.
    //
    // The first pass runs before the buildings (and after the ground, which
    // sits at -1): the glass passes over it, and a window on the back is
    // glimpsed through the building, like a light on from the other side.
    // The second pass runs after: the wall has already written its depth,
    // so it redraws only the windows on the facade in view, at their full
    // color.
    this.#through = new THREE.InstancedMesh(geometry, this.#material, CAP);
    this.#through.renderOrder = -0.5;
    this.#mesh = new THREE.InstancedMesh(geometry, this.#material, CAP);
    this.#mesh.renderOrder = 1;
    // The positions are one: the second pass reads the same matrices.
    this.#through.instanceMatrix = this.#mesh.instanceMatrix;
    for (const mesh of [this.#through, this.#mesh]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.object3d.add(mesh);
    }
  }

  /**
   * Redraws the windows. Called when a light is born, ends or fully goes
   * dark, and when the city relocates.
   */
  setLights(lights: Iterable<Light>, metrics: (projectId: string) => BuildingMetrics): void {
    let i = 0;

    // The shader thinks in seconds of `performance.now()`, the lights in
    // epoch ms: without conversion a light born an instant ago would arrive
    // dark.
    const nowSec = performance.now() / 1000;
    const epochNow = Date.now();
    const toShaderClock = (atMs: number): number => nowSec - (epochNow - atMs) / 1000;
    const colors = this.#color.array as Float32Array;
    this.#placed = [];

    for (const light of lights) {
      if (i >= CAP) break;
      const m = metrics(light.projectId);
      const spot = windowSpot(light.slot, m);
      if (!spot) continue;

      this.#dummy.position.copy(spot.position);
      // Rotated outward: a window seen edge-on cannot be read.
      this.#dummy.rotation.set(0, spot.facing, 0);
      this.#dummy.scale.set(spot.w, spot.h, 1);
      this.#dummy.updateMatrix();
      this.#mesh.setMatrixAt(i, this.#dummy.matrix);

      this.#t0.setX(i, toShaderClock(light.litAt));
      const off = offAt(light);
      this.#t1.setX(i, Number.isFinite(off) ? toShaderClock(off) : NOT_YET);
      writeSrgb(lightColor(light), colors, i);
      this.#placed.push({
        light,
        center: spot.position,
        // The square's x axis, rotated like the facade it stands on.
        across: new THREE.Vector3(Math.cos(spot.facing), 0, -Math.sin(spot.facing)).multiplyScalar(spot.w / 2),
        up: new THREE.Vector3(0, spot.h / 2, 0),
      });
      i++;
    }

    this.#mesh.count = i;
    this.#through.count = i;
    this.#mesh.instanceMatrix.needsUpdate = true;
    this.#t0.needsUpdate = true;
    this.#t1.needsUpdate = true;
    this.#color.needsUpdate = true;
  }

  /**
   * The window under the pointer, if there is one.
   *
   * This reasons on screen and not with a ray into the scene: a ray only
   * hits the exact square, and a distant window is a four-pixel target.
   * Here what counts is the distance from the projected center, with a
   * minimum margin; between two candidates the closer one to the pointer
   * wins.
   */
  pick(x: number, y: number, camera: THREE.Camera, width: number, height: number): Light | null {
    let best: Light | null = null;
    let bestD = Infinity;
    for (const p of this.#placed) {
      // Behind the observer the projection flips the signs: discard first.
      this.#v.copy(p.center).applyMatrix4(camera.matrixWorldInverse);
      if (this.#v.z > -0.5) continue;

      const c = this.#toScreen(p.center, camera, width, height);
      const cx = c.x;
      const cy = c.y;
      const d = Math.hypot(x - cx, y - cy);
      if (d >= bestD) continue;

      // How big it is on screen: half the diagonal, from two opposite corners.
      this.#corner.copy(p.center).add(p.across).add(p.up);
      const a = this.#toScreen(this.#corner, camera, width, height);
      const r1 = Math.hypot(a.x - cx, a.y - cy);
      this.#corner.copy(p.center).add(p.across).sub(p.up);
      const b = this.#toScreen(this.#corner, camera, width, height);
      const r2 = Math.hypot(b.x - cx, b.y - cy);

      if (d > Math.max(PICK_MIN_PX, r1, r2)) continue;
      best = p.light;
      bestD = d;
    }
    return best;
  }

  #toScreen(point: THREE.Vector3, camera: THREE.Camera, width: number, height: number): { x: number; y: number } {
    this.#v.copy(point).project(camera);
    return { x: (this.#v.x * 0.5 + 0.5) * width, y: (-this.#v.y * 0.5 + 0.5) * height };
  }

  update(_dt: number, now: number): void {
    // Rise and fade live in the shader: here only the clock advances.
    this.#material.uniforms['uTime']!.value = now;
  }

  dispose(): void {
    this.#mesh.geometry.dispose();
    this.#material.dispose();
    this.#mesh.dispose();
    this.#through.dispose();
  }
}

/**
 * What color the light is: it tells WHAT WORK it is.
 *
 * The turn takes the color of the provider, the same as the building: it is
 * the session itself at its desk, and stays the only window that says
 * whether Claude Code or Codex is inside. Every call instead takes the
 * color of its category -- red for a shell, blue for a read, green for a
 * write -- the same as the pulse that leaves at the same instant.
 * Subagents and skills have their own, because they are something else
 * entering the building.
 *
 * Before, calls also took the color of the provider: a whole facade of
 * orange windows said only "Claude Code is working," which the building
 * already said. Now the facade says what it is doing.
 */
export function lightColor(light: Light): number {
  switch (light.kind) {
    case 'subagent':
      return TOOL_COLOR.agent;
    case 'skill':
      return SKILL_COLOR;
    case 'tool':
      // Nameless it stays `other`: a gray window is still a call in
      // progress, and switching it off would hide real work.
      return TOOL_COLOR[categoryOf(light.name ?? '')];
    case 'turn':
      return PROVIDER_COLOR[light.provider ?? 'claude'];
  }
}

/**
 * The channels in sRGB, straight from the hex code.
 *
 * `THREE.Color` converts them to linear space, and the shader writes them
 * to the canvas without converting them back: the orange `#ffb254` on
 * screen came out darker and more saturated than the palette's and the
 * legend's.
 */
function writeSrgb(hex: number, out: Float32Array, i: number): void {
  out[i * 3] = ((hex >> 16) & 0xff) / 255;
  out[i * 3 + 1] = ((hex >> 8) & 0xff) / 255;
  out[i * 3 + 2] = (hex & 0xff) / 255;
}

/** Where a slot's window physically stands: center, facing and size. */
function windowSpot(
  slot: number,
  m: BuildingMetrics,
): { position: THREE.Vector3; facing: number; w: number; h: number } | null {
  if (!m.position) return null;
  const floors = floorsForSize(m.size);
  const { floor, col } = windowCell(slot, floors);
  const place = windowPlacement(floor, col, floors, m.footprint, m.height);
  const { w, h } = windowSize(m.footprint, floors, m.height);
  return {
    position: new THREE.Vector3(m.position.x + place.x, place.y, m.position.z + place.z),
    facing: Math.atan2(place.nx, place.nz),
    w,
    h,
  };
}
