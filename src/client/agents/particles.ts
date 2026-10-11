import * as THREE from 'three';
import type { Settings, SettingKey } from '../core/settings.ts';
import type { Layer } from '../world/stage.ts';
import type { Planet } from '../world/planet.ts';

/**
 * All the little bits: welding sparks, boot dust, confetti, and the haze that drifts across
 * a planet with an atmosphere.
 *
 * Ported from Bot Crossing. One pool, two draw calls. Particles live in flat typed arrays
 * and are swap-removed on death, so the buffer stays contiguous and the GPU only ever sees
 * the live prefix -- no per-particle objects, no allocation during play, and turning
 * particles off in the settings genuinely stops all of it rather than just hiding the
 * result.
 *
 * A `Layer`: the caller adds `object3d` to the scene and calls `update` every frame. The
 * pools are sized from `settings.particleBudget` and rebuilt when the `particles` level
 * changes, because 'low' and 'full' are different budgets, not just a switch.
 *
 * Nothing here touches the DOM: three.js geometry and materials only, so it can be built
 * and stepped from a Node test. Randomness is injected for the same reason.
 */

const GRAVITY = -3.6;

/** How far above whatever it landed on a particle settles, so it skitters on top of it. */
const SETTLE = 0.04;

/** A colour as three channels. A `THREE.Color` qualifies. */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** What `ambient` needs of the camera: where it is on the ground plane. */
export interface CameraLike {
  position: { x: number; z: number };
}

class Pool {
  readonly capacity: number;
  count = 0;

  readonly position: Float32Array;
  readonly velocity: Float32Array;
  readonly color: Float32Array;
  readonly size: Float32Array;
  /** Remaining, in seconds. */
  readonly life: Float32Array;
  readonly maxLife: Float32Array;
  readonly drag: Float32Array;
  readonly gravity: Float32Array;
  // Recorded per particle rather than assumed: a plot's deck is a raised slab, so the
  // height a spark bounces off depends entirely on where it was thrown from.
  readonly floor: Float32Array;
  readonly alpha: Float32Array;

  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.ShaderMaterial;
  readonly points: THREE.Points;

  // Held by reference: `geometry.attributes[name]` is an indexed lookup that may be absent
  // as far as the types know, and these four are flagged for upload every frame.
  readonly #attrPosition: THREE.BufferAttribute;
  readonly #attrColor: THREE.BufferAttribute;
  readonly #attrSize: THREE.BufferAttribute;
  readonly #attrAlpha: THREE.BufferAttribute;

  constructor(capacity: number, blending: THREE.Blending) {
    this.capacity = capacity;

    this.position = new Float32Array(capacity * 3);
    this.velocity = new Float32Array(capacity * 3);
    this.color = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.floor = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);

    const geo = new THREE.BufferGeometry();
    this.#attrPosition = new THREE.BufferAttribute(this.position, 3);
    this.#attrColor = new THREE.BufferAttribute(this.color, 3);
    this.#attrSize = new THREE.BufferAttribute(this.size, 1);
    this.#attrAlpha = new THREE.BufferAttribute(this.alpha, 1);
    geo.setAttribute('position', this.#attrPosition);
    geo.setAttribute('color', this.#attrColor);
    geo.setAttribute('aSize', this.#attrSize);
    geo.setAttribute('aAlpha', this.#attrAlpha);
    geo.setDrawRange(0, 0);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending,
      vertexColors: true,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 1 } }]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        attribute float aSize;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        uniform float uScale;
        void main() {
          vColor = color;
          vAlpha = aAlpha;
          vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
          // Perspective-correct point size, clamped so a particle right under the camera
          // cannot blow up into a full-screen quad.
          gl_PointSize = clamp( aSize * uScale * ( 260.0 / -mvPosition.z ), 1.0, 90.0 );
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = length( d );
          if ( r > 0.5 ) discard;
          // Soft core with a fast falloff -- reads as a spark rather than a disc.
          float a = pow( 1.0 - r * 2.0, 1.6 ) * vAlpha;
          gl_FragColor = vec4( vColor, a );
          #include <fog_fragment>
        }
      `,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  /** `ground` is the surface this particle was thrown off -- a deck, or the terrain. */
  spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    r: number,
    g: number,
    b: number,
    size: number,
    life: number,
    drag = 1.2,
    gravity = 1,
    ground = 0,
  ): boolean {
    // A full pool drops the newest particle rather than stalling or growing.
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    const i3 = i * 3;
    this.position[i3] = x;
    this.position[i3 + 1] = y;
    this.position[i3 + 2] = z;
    this.velocity[i3] = vx;
    this.velocity[i3 + 1] = vy;
    this.velocity[i3 + 2] = vz;
    this.color[i3] = r;
    this.color[i3 + 1] = g;
    this.color[i3 + 2] = b;
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.drag[i] = drag;
    this.gravity[i] = gravity;
    this.floor[i] = ground + SETTLE;
    this.alpha[i] = 1;
    return true;
  }

  update(dt: number): void {
    const { position, velocity, color, size, life, maxLife, drag, gravity, floor, alpha } = this;
    let i = 0;
    while (i < this.count) {
      // Every read below is of a slot that `spawn` filled; the `?? 0` fallbacks only
      // satisfy the checked index reads and never fire.
      const remaining = (life[i] ?? 0) - dt;
      life[i] = remaining;
      if (remaining <= 0) {
        // Swap-remove: move the last live particle into this slot and shrink.
        const last = --this.count;
        if (last !== i) {
          const a = i * 3;
          const b = last * 3;
          for (let k = 0; k < 3; k++) {
            position[a + k] = position[b + k] ?? 0;
            velocity[a + k] = velocity[b + k] ?? 0;
            color[a + k] = color[b + k] ?? 0;
          }
          size[i] = size[last] ?? 0;
          life[i] = life[last] ?? 0;
          maxLife[i] = maxLife[last] ?? 0;
          drag[i] = drag[last] ?? 0;
          gravity[i] = gravity[last] ?? 0;
          floor[i] = floor[last] ?? 0;
          alpha[i] = alpha[last] ?? 0;
        }
        continue; // re-test the particle just swapped in
      }

      const i3 = i * 3;
      const d = Math.max(0, 1 - (drag[i] ?? 0) * dt);
      let vx = (velocity[i3] ?? 0) * d;
      let vy = (velocity[i3 + 1] ?? 0) * d + GRAVITY * (gravity[i] ?? 0) * dt;
      let vz = (velocity[i3 + 2] ?? 0) * d;
      const px = (position[i3] ?? 0) + vx * dt;
      let py = (position[i3 + 1] ?? 0) + vy * dt;
      const pz = (position[i3 + 2] ?? 0) + vz * dt;

      // Bounce once off the ground so sparks skitter instead of sinking through it. Against
      // the surface the particle came off, not against y=0 -- sparks struck on a plot fall to
      // that plot's deck, and a fixed world floor would drop them through it.
      const ground = floor[i] ?? 0;
      if (py < ground && vy < 0) {
        py = ground;
        vy *= -0.32;
        vx *= 0.6;
        vz *= 0.6;
      }
      velocity[i3] = vx;
      velocity[i3 + 1] = vy;
      velocity[i3 + 2] = vz;
      position[i3] = px;
      position[i3 + 1] = py;
      position[i3 + 2] = pz;

      const t = remaining / (maxLife[i] ?? 1);
      // Fade in fast, out slow -- a linear fade reads as a pop.
      alpha[i] = t > 0.85 ? (1 - t) / 0.15 : t / 0.85;
      i++;
    }

    this.geometry.setDrawRange(0, this.count);
    this.#attrPosition.needsUpdate = true;
    this.#attrColor.needsUpdate = true;
    this.#attrSize.needsUpdate = true;
    this.#attrAlpha.needsUpdate = true;
  }

  clear(): void {
    this.count = 0;
    this.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

interface Pools {
  glow: Pool;
  dust: Pool;
  /** The budget these were sized from, so a redundant notification costs nothing. */
  budget: number;
}

function createPools(budget: number): Pools {
  const size = Math.max(64, budget);
  // Sparks and confetti are additive so they read as light; dust is alpha-blended so it
  // reads as matter. That distinction is the whole reason there are two pools.
  return {
    glow: new Pool(Math.ceil(size * 0.6), THREE.AdditiveBlending),
    dust: new Pool(Math.ceil(size * 0.4), THREE.NormalBlending),
    budget,
  };
}

export class Particles implements Layer {
  readonly object3d: THREE.Group;
  enabled: boolean;

  readonly #settings: Settings;
  readonly #random: () => number;
  #pools: Pools;
  #ambientTimer = 0;
  readonly #unsubscribe: () => void;

  constructor(settings: Settings, random: () => number = Math.random) {
    this.#settings = settings;
    this.#random = random;
    this.object3d = new THREE.Group();
    this.object3d.name = 'particles';

    this.#pools = createPools(settings.particleBudget);
    this.object3d.add(this.#pools.glow.points, this.#pools.dust.points);

    this.enabled = settings.particleBudget > 0;
    this.setEnabled(this.enabled);
    this.#unsubscribe = settings.onChange((changed) => this.onSettingsChanged(changed));
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    const { glow, dust } = this.#pools;
    glow.points.visible = on;
    dust.points.visible = on;
    if (!on) {
      glow.clear();
      dust.clear();
    }
  }

  /**
   * Wired to `settings.onChange` by the constructor; public so a caller that fans out
   * notifications itself, the way the source's colony did, can still call it -- a second
   * call with nothing changed is free.
   */
  onSettingsChanged(changed: ReadonlySet<SettingKey>): void {
    if (!changed.has('particles')) return;
    const budget = this.#settings.particleBudget;
    if (budget !== this.#pools.budget) {
      // The level moves the budget, not just the switch: a pool built under 'low' would
      // silently cap 'full' at a third of what was asked for.
      const old = this.#pools;
      this.object3d.remove(old.glow.points, old.dust.points);
      old.glow.dispose();
      old.dust.dispose();
      this.#pools = createPools(budget);
      this.object3d.add(this.#pools.glow.points, this.#pools.dust.points);
    }
    this.setEnabled(budget > 0);
  }

  /** Welding sparks from an astronaut's hands. `ground` is what the welder is standing on. */
  weld(x: number, y: number, z: number, color: RGB, ground = 0): void {
    if (!this.enabled) return;
    const rand = this.#random;
    const n = this.#settings.get('particles') === 'full' ? 3 : 1;
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const s = 0.9 + rand() * 2.4;
      this.#pools.glow.spawn(
        x + (rand() - 0.5) * 0.16,
        y + (rand() - 0.5) * 0.12,
        z + (rand() - 0.5) * 0.16,
        Math.cos(a) * s * 0.5,
        1.1 + rand() * 2.2,
        Math.sin(a) * s * 0.5,
        color.r * 2.4,
        color.g * 2.2,
        color.b * 1.6,
        0.055 + rand() * 0.05,
        0.35 + rand() * 0.5,
        1.6,
        1,
        ground,
      );
    }
  }

  /** A puff kicked up by a boot. `ground` is the surface the boot landed on. */
  step(x: number, y: number, z: number, tint: RGB, ground = 0): void {
    if (!this.enabled) return;
    const rand = this.#random;
    const a = rand() * Math.PI * 2;
    this.#pools.dust.spawn(
      x,
      y + 0.03,
      z,
      Math.cos(a) * 0.28,
      0.24 + rand() * 0.2,
      Math.sin(a) * 0.28,
      tint.r,
      tint.g,
      tint.b,
      0.12 + rand() * 0.14,
      0.5 + rand() * 0.4,
      2.4,
      0.12,
      ground,
    );
  }

  /** Confetti for a finished thread. `ground` is what the celebrating agent is standing on. */
  cheer(x: number, y: number, z: number, color: RGB, ground = 0): void {
    if (!this.enabled) return;
    const rand = this.#random;
    const n = this.#settings.get('particles') === 'full' ? 14 : 6;
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const s = 0.6 + rand() * 1.6;
      this.#pools.glow.spawn(
        x,
        y + 0.8,
        z,
        Math.cos(a) * s,
        2.4 + rand() * 2.4,
        Math.sin(a) * s,
        color.r * (1.4 + rand()),
        color.g * (1.4 + rand()),
        color.b * (1.4 + rand()),
        0.07 + rand() * 0.07,
        1.1 + rand() * 0.9,
        0.7,
        0.8,
        ground,
      );
    }
  }

  /** Thruster wash when the ship is used. */
  thruster(x: number, y: number, z: number): void {
    if (!this.enabled) return;
    const rand = this.#random;
    for (let i = 0; i < 6; i++) {
      const a = rand() * Math.PI * 2;
      const r = rand() * 1.4;
      this.#pools.dust.spawn(
        x + Math.cos(a) * r,
        y + 0.1,
        z + Math.sin(a) * r,
        Math.cos(a) * (1.6 + rand() * 2),
        0.5 + rand() * 0.7,
        Math.sin(a) * (1.6 + rand() * 2),
        0.55,
        0.5,
        0.46,
        0.3 + rand() * 0.3,
        0.9 + rand() * 0.6,
        1.6,
        0.08,
      );
    }
  }

  /**
   * A ring of dust kicked out along the surface: a crate hitting the pile.
   * Low and wide rather than a column, so it reads as weight landing, not as
   * smoke. `ground` is the surface it landed on.
   */
  puff(x: number, y: number, z: number, tint: RGB, ground = 0): void {
    if (!this.enabled) return;
    const rand = this.#random;
    const n = this.#settings.get('particles') === 'full' ? 8 : 4;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand() * 0.5;
      const s = 1.1 + rand() * 0.9;
      this.#pools.dust.spawn(
        x + Math.cos(a) * 0.3,
        y + 0.05,
        z + Math.sin(a) * 0.3,
        Math.cos(a) * s,
        0.25 + rand() * 0.35,
        Math.sin(a) * s,
        tint.r,
        tint.g,
        tint.b,
        0.16 + rand() * 0.12,
        0.6 + rand() * 0.4,
        2.6,
        0.15,
        ground,
      );
    }
  }

  /**
   * Data leaving for the network: a mote of light rising straight up from a
   * structure and fading. Gravity is negative and drag low so it climbs
   * steadily -- the one particle here that goes up and keeps going, which is
   * what keeps it from reading as a spark.
   */
  uplink(x: number, y: number, z: number, color: RGB): void {
    if (!this.enabled) return;
    const rand = this.#random;
    const n = this.#settings.get('particles') === 'full' ? 2 : 1;
    for (let i = 0; i < n; i++) {
      this.#pools.glow.spawn(
        x + (rand() - 0.5) * 0.25,
        y + rand() * 0.3,
        z + (rand() - 0.5) * 0.25,
        (rand() - 0.5) * 0.08,
        0.9 + rand() * 0.5,
        (rand() - 0.5) * 0.08,
        color.r * 2,
        color.g * 2,
        color.b * 2,
        0.06 + rand() * 0.04,
        1.6 + rand() * 0.8,
        0.1,
        -0.12,
        // No floor to bounce off: it is going up.
        -1e6,
      );
    }
  }

  /** A shell command running: a soft grey puff off the structure that rises a little and spreads. */
  steam(x: number, y: number, z: number, ground = 0): void {
    if (!this.enabled) return;
    const rand = this.#random;
    const n = this.#settings.get('particles') === 'full' ? 3 : 1;
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const grey = 0.62 + rand() * 0.12;
      this.#pools.dust.spawn(
        x + (rand() - 0.5) * 0.3,
        y + rand() * 0.2,
        z + (rand() - 0.5) * 0.3,
        Math.cos(a) * 0.25,
        0.45 + rand() * 0.3,
        Math.sin(a) * 0.25,
        grey,
        grey,
        grey + 0.03,
        0.22 + rand() * 0.16,
        1.1 + rand() * 0.6,
        1.4,
        -0.05,
        ground,
      );
    }
  }

  /**
   * An engine firing downward: short hot glow shooting down from the nozzle,
   * and a little dust with it. For the landers, which hover over a habitat,
   * so nothing here bounces -- it fades out before it could reach anything.
   */
  exhaust(x: number, y: number, z: number): void {
    if (!this.enabled) return;
    const rand = this.#random;
    const n = this.#settings.get('particles') === 'full' ? 3 : 1;
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const r = rand() * 0.18;
      this.#pools.glow.spawn(
        x + Math.cos(a) * r,
        y,
        z + Math.sin(a) * r,
        Math.cos(a) * 0.3,
        -(2.2 + rand() * 1.6),
        Math.sin(a) * 0.3,
        2.6,
        1.3 + rand() * 0.5,
        0.45,
        0.07 + rand() * 0.05,
        0.18 + rand() * 0.14,
        1.2,
        0.4,
        -1e6,
      );
    }
    if (rand() < 0.5) {
      this.#pools.dust.spawn(
        x + (rand() - 0.5) * 0.4,
        y - 0.2,
        z + (rand() - 0.5) * 0.4,
        (rand() - 0.5) * 0.8,
        -(0.6 + rand() * 0.5),
        (rand() - 0.5) * 0.8,
        0.6,
        0.57,
        0.53,
        0.2 + rand() * 0.12,
        0.5 + rand() * 0.3,
        2,
        0.05,
        -1e6,
      );
    }
  }

  /** Sleepy `z` bubbles. */
  snooze(x: number, y: number, z: number): void {
    if (!this.enabled) return;
    this.#pools.glow.spawn(x, y, z, 0.12, 0.42, 0.05, 0.55, 0.6, 1.1, 0.075, 1.9, 0.35, -0.02);
  }

  /**
   * Planet haze -- dust on Mars, pollen on Terra. Spawned in a ring around the camera so it
   * is always where you are looking without simulating the whole world.
   */
  ambient(dt: number, camera: CameraLike, planet: Planet): void {
    if (!this.enabled || !planet.dust) return;
    this.#ambientTimer -= dt;
    if (this.#ambientTimer > 0) return;
    const rate = this.#settings.get('particles') === 'full' ? 0.045 : 0.12;
    this.#ambientTimer = rate / planet.dust;

    const rand = this.#random;
    const a = rand() * Math.PI * 2;
    const r = 12 + rand() * 34;
    const x = camera.position.x + Math.cos(a) * r;
    const z = camera.position.z + Math.sin(a) * r;
    const terra = planet.id === 'terra';
    this.#pools.dust.spawn(
      x,
      0.4 + rand() * 5,
      z,
      terra ? (rand() - 0.5) * 0.5 : 1.6 + rand() * 1.4,
      terra ? 0.15 + rand() * 0.25 : 0.1,
      terra ? (rand() - 0.5) * 0.5 : 0.7 + rand(),
      terra ? 0.85 : 0.78,
      terra ? 0.9 : 0.55,
      terra ? 0.55 : 0.4,
      terra ? 0.09 : 0.2,
      3 + rand() * 3,
      0.12,
      terra ? -0.02 : 0.02,
    );
  }

  update(dt: number): void {
    if (!this.enabled) return;
    this.#pools.glow.update(dt);
    this.#pools.dust.update(dt);
  }

  get liveCount(): number {
    return this.#pools.glow.count + this.#pools.dust.count;
  }

  /** How many more particles the pools can hold right now: what the HUD and tests read. */
  get capacity(): number {
    return this.#pools.glow.capacity + this.#pools.dust.capacity;
  }

  dispose(): void {
    this.#unsubscribe();
    const { glow, dust } = this.#pools;
    this.object3d.remove(glow.points, dust.points);
    glow.dispose();
    dust.dispose();
  }
}
