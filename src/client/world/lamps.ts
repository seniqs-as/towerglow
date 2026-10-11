import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FADE_MS, offAt } from '../state/lights.ts';
import type { Light } from '../state/lights.ts';
import { lampSpot } from '../../shared/layout.ts';
import { lightColor } from './palette.ts';
import type { Layer } from './stage.ts';

const CAP = 2048;
/**
 * How long the light takes to come fully on.
 *
 * Not a duration: how long it stays lit is decided by the lights model, and
 * this is only the rise time. An instant switch-on reads as a jump, not as a
 * light.
 */
const RISE_S = 0.35;

/**
 * Sentinel for an instance never used: far lower than any real instant, so
 * it cannot be mistaken for a real switch-on.
 */
const NEVER = -1e6;

/** A window that has no switch-off time yet: very far in the future. */
const NOT_YET = 1e9;

/**
 * Minimum radius, in pixels, within which the pointer catches a window.
 *
 * From far away a window is a few pixels wide: without a margin, reading its
 * name would mean centring the mouse on it like a target.
 */
const PICK_MIN_PX = 10;

/** How tall a lamp post is, deck to the centre of its head. */
export const LAMP_HEIGHT = 1.6;
/** Radius of the lit head: what the pointer aims at. */
export const LAMP_HEAD_RADIUS = 0.16;

/** What a lamp needs to know about the zone it stands on. */
export interface LampZone {
  /** The centre of the zone's top deck, in world coordinates: the lamps stand on it. */
  root: THREE.Vector3;
}

/** A drawn lamp: whose it is, and where its head is. */
interface Placed {
  light: Light;
  /** The head, in world coordinates: the pointer aims at this, not the foot. */
  head: THREE.Vector3;
}

/**
 * The lamps on the kerb of every zone: someone working in the project.
 *
 * They are the windows of the old facades, brought outside: a zone is a deck
 * with no building tall enough to carry a facade, so a piece of work is a
 * post on the kerb band instead of a pane on a wall. What the light MEANS is
 * unchanged, and so is who decides how long it stays lit: `Lights` does,
 * this only draws.
 *
 * A lit window is a piece of work: a session's turn in progress, a call to
 * a tool, a subagent, a skill. How long it stays lit -- at least the
 * minimum, then for as long as the work lasts -- is decided by `Lights`;
 * here it is only drawn.
 *
 * No unlit lamps: a lamp exists only if someone is working under it, so
 * drawing an unlit one would say nothing. Instead of fading, a lamp
 * RISES out of the deck when its light is born and SINKS back into it when
 * the light ends: a post cannot go translucent the way a pane could, and a
 * thing that comes up out of the ground is read as arriving, which is what
 * happened.
 *
 * One InstancedMesh, like the windows, for the same reason: a busy colony
 * lights hundreds at once, and rise and sink have to live in the shader.
 */
export class Lamps implements Layer {
  readonly object3d: THREE.Group;
  #mesh: THREE.InstancedMesh;
  #material: THREE.ShaderMaterial;
  #color: THREE.InstancedBufferAttribute;
  #t0: THREE.InstancedBufferAttribute;
  #t1: THREE.InstancedBufferAttribute;
  #matrix = new THREE.Matrix4();
  #placed: Placed[] = [];
  #v = new THREE.Vector3();
  #corner = new THREE.Vector3();
  #across = new THREE.Vector3();
  #up = new THREE.Vector3();
  /**
   * The shader's clock: the last `now` that `update` fed it, in seconds.
   *
   * Light instants arrive in epoch ms and the shader counts whatever the
   * frame loop counts -- seconds since the engine started, in practice. The
   * conversion pivots on THIS number rather than on `performance.now()`
   * because the two clocks do not share an origin: a lamp timed against the
   * wrong one is born already lit, and the rise that says "this just
   * started" never plays.
   */
  #clock = 0;

  constructor() {
    this.object3d = new THREE.Group();
    this.object3d.name = 'lamps';

    const geometry = lampGeometry();
    const colors = new Float32Array(CAP * 3);
    this.#color = new THREE.InstancedBufferAttribute(colors, 3);
    this.#t0 = new THREE.InstancedBufferAttribute(new Float32Array(CAP).fill(NEVER), 1);
    this.#t1 = new THREE.InstancedBufferAttribute(new Float32Array(CAP).fill(NOT_YET), 1);
    geometry.setAttribute('aColor', this.#color);
    geometry.setAttribute('aT0', this.#t0);
    geometry.setAttribute('aT1', this.#t1);

    this.#material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uRise: { value: RISE_S },
        uFade: { value: FADE_MS / 1000 },
        uNight: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aT0;
        attribute float aT1;
        attribute float aHead;
        uniform float uTime;
        uniform float uRise;
        uniform float uFade;
        varying vec3 vColor;
        varying float vLit;
        varying float vHead;
        void main() {
          vColor = aColor;
          vHead = aHead;
          // Rises in an instant, stays, and sinks when its time comes. The
          // switch-off time is worked out by the lights model -- the minimum,
          // or the real end of the work if that comes later -- and until
          // there is one it stays in the far future.
          float rise = clamp((uTime - aT0) / uRise, 0.0, 1.0);
          float fade = 1.0 - clamp((uTime - aT1) / uFade, 0.0, 1.0);
          vLit = aT0 < -900000.0 ? 0.0 : rise * fade;
          // The post grows from its foot: y is scaled by how lit it is, so an
          // unlit lamp is a flat nothing at deck level and a dying one sinks
          // into the deck rather than thinning out in mid-air.
          vec3 p = position;
          p.y *= vLit;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uNight;
        varying vec3 vColor;
        varying float vLit;
        varying float vHead;
        void main() {
          // Flat on the deck it is not a lamp, only a z-fight with the deck.
          if (vLit < 0.01) discard;
          // The post is dark metal; only the head carries the colour. The
          // colour is the information, so it is written AS IS by day and
          // pushed past white at night, when the head is all one can see.
          vec3 post = vec3(0.16, 0.17, 0.2);
          vec3 head = vColor * (0.35 + uNight * 1.6);
          gl_FragColor = vec4(mix(post, head, vHead), 1.0);
        }
      `,
    });

    this.#mesh = new THREE.InstancedMesh(geometry, this.#material, CAP);
    this.#mesh.count = 0;
    this.#mesh.frustumCulled = false;
    this.object3d.add(this.#mesh);
  }

  /**
   * Redraws the lamps. Called when a light is born, ends or goes fully
   * out, and when the colony is laid out again.
   *
   * `now` is the epoch-ms instant the lights are being read at: the same
   * clock `Light.litAt` and `offAt` speak, injected rather than read from
   * `Date.now()` so a test can hold it still.
   */
  setLights(lights: Iterable<Light>, zoneOf: (projectId: string) => LampZone | null, now: number): void {
    let i = 0;

    // The shader thinks in seconds of its own clock, the lights in epoch ms:
    // without a conversion a light born an instant ago would arrive unlit.
    const toShaderClock = (atMs: number): number => this.#clock - (now - atMs) / 1000;
    const colors = this.#color.array as Float32Array;
    this.#placed = [];

    for (const light of lights) {
      if (i >= CAP) break;
      const zone = zoneOf(light.projectId);
      if (!zone) continue;
      const spot = lampSpot(light.slot);
      // The foot stands on the top deck, which is where the root already is:
      // adding the deck height on top of it again stood every lamp on air.
      const x = zone.root.x + spot.x;
      const y = zone.root.y;
      const z = zone.root.z + spot.z;

      this.#matrix.makeTranslation(x, y, z);
      this.#mesh.setMatrixAt(i, this.#matrix);

      this.#t0.setX(i, toShaderClock(light.litAt));
      const off = offAt(light);
      this.#t1.setX(i, Number.isFinite(off) ? toShaderClock(off) : NOT_YET);
      writeSrgb(lightColor(light), colors, i);
      this.#placed.push({ light, head: new THREE.Vector3(x, y + LAMP_HEIGHT, z) });
      i++;
    }

    this.#mesh.count = i;
    this.#mesh.instanceMatrix.needsUpdate = true;
    this.#t0.needsUpdate = true;
    this.#t1.needsUpdate = true;
    this.#color.needsUpdate = true;
  }

  /** How dark it is, 0 (day) to 1 (night): the sky knows, the lamps only glow. */
  setNight(night: number): void {
    this.#material.uniforms['uNight']!.value = Number.isFinite(night) ? Math.min(1, Math.max(0, night)) : 0;
  }

  /**
   * The lamp under the pointer, if there is one.
   *
   * This works on the screen, not with a ray into the scene: the ray only
   * catches the exact sphere, and a distant head is a one-pixel target.
   * What counts here is the distance from the projected centre, with a
   * minimum margin; between two candidates the one nearest the pointer wins.
   */
  pick(x: number, y: number, camera: THREE.Camera, width: number, height: number): Light | null {
    // The head is a sphere, so its silhouette is the same from anywhere: one
    // camera-right and one camera-up half-extent serve every lamp in this
    // pass. A fixed world axis would not -- looked at end-on it projects to
    // nothing, and the head would shrink to a point in the pick test.
    this.#across.setFromMatrixColumn(camera.matrixWorld, 0).setLength(LAMP_HEAD_RADIUS);
    this.#up.setFromMatrixColumn(camera.matrixWorld, 1).setLength(LAMP_HEAD_RADIUS);

    let best: Light | null = null;
    let bestD = Infinity;
    for (const p of this.#placed) {
      // Behind the viewer the projection flips the signs: discard it first.
      this.#v.copy(p.head).applyMatrix4(camera.matrixWorldInverse);
      if (this.#v.z > -0.5) continue;

      const c = this.#toScreen(p.head, camera, width, height);
      const cx = c.x;
      const cy = c.y;
      const d = Math.hypot(x - cx, y - cy);
      if (d >= bestD) continue;

      // How big it is on screen: half a diagonal, from two opposite corners.
      this.#corner.copy(p.head).add(this.#across).add(this.#up);
      const a = this.#toScreen(this.#corner, camera, width, height);
      const r1 = Math.hypot(a.x - cx, a.y - cy);
      this.#corner.copy(p.head).add(this.#across).sub(this.#up);
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
    // Rise and sink live in the shader: here only the clock moves on.
    this.#clock = now;
    this.#material.uniforms['uTime']!.value = now;
  }

  dispose(): void {
    this.#mesh.geometry.dispose();
    this.#material.dispose();
    this.#mesh.dispose();
  }
}

/**
 * The post and its head as ONE geometry, so a lamp is one instance and not
 * two that have to agree. `aHead` tells the shader which vertices are the
 * head: 1 there, 0 on the post. The merge needs every part to carry the same
 * attributes, hence the attribute on both and the uv, which nothing samples,
 * on neither.
 */
function lampGeometry(): THREE.BufferGeometry {
  const post = new THREE.CylinderGeometry(0.05, 0.08, LAMP_HEIGHT, 6);
  post.translate(0, LAMP_HEIGHT / 2, 0);
  const head = new THREE.SphereGeometry(LAMP_HEAD_RADIUS, 8, 6);
  head.translate(0, LAMP_HEIGHT, 0);
  const parts: readonly (readonly [THREE.BufferGeometry, number])[] = [[post, 0], [head, 1]];
  for (const [geo, isHead] of parts) {
    const count = geo.getAttribute('position').count;
    geo.setAttribute('aHead', new THREE.BufferAttribute(new Float32Array(count).fill(isHead), 1));
    geo.deleteAttribute('uv');
  }
  const merged = mergeGeometries([post, head], false);
  if (!merged) throw new Error('lamps: could not merge the post');
  post.dispose();
  head.dispose();
  return merged;
}

/**
 * The channels in sRGB, straight from the hex code.
 *
 * `THREE.Color` converts them to linear space, and the shader writes them to
 * the canvas without converting them back: the orange `#ffb254` came out on
 * screen darker and more saturated than the one in the palette and the
 * legend.
 */
function writeSrgb(hex: number, out: Float32Array, i: number): void {
  out[i * 3] = ((hex >> 16) & 0xff) / 255;
  out[i * 3 + 1] = ((hex >> 8) & 0xff) / 255;
  out[i * 3 + 2] = (hex & 0xff) / 255;
}
