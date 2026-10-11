import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hqPlacement, HQ_HEIGHT } from '../../shared/layout.ts';
import type { Layer } from './stage.ts';

/**
 * The lander. Ported from Bot Crossing (MIT). Every crew member walks out of
 * its ramp when a session appears and back up it when one ends, so it is the
 * colony's one fixed piece of narrative furniture. From out here it is only
 * looked at: what is past the hatch is `interior.ts`, a scene of its own,
 * and you get there up this same ramp (`boarding.ts`).
 *
 * The hull is merged into a single geometry; only the parts that actually
 * move or glow -- the ramp, the beacon, the engine wash -- stay separate.
 *
 * It stands where `hqPlacement()` says and nowhere else: the ship is the one
 * landmark the mental map is anchored to, so it must never move with the
 * number of projects. The only thing that moves it is the planet's own
 * surface, through `setGroundHeight`.
 */

const HULL = 0xf0ece4;
const HULL_DARK = 0xc4bfb4;
const TRIM = 0xc96442;
const METAL = 0x8f9299;
const GLASS = 0x7fc4e0;
const BELL = 0x4a4d55;

/** Roughness / metalness per material, so the hull reads as painted panel over bare strut. */
const SURFACE: ReadonlyMap<number, readonly [number, number]> = new Map<number, readonly [number, number]>([
  [HULL, [0.48, 0.05]],
  [HULL_DARK, [0.62, 0.08]],
  [TRIM, [0.45, 0.1]],
  [METAL, [0.26, 0.95]],
  [GLASS, [0.06, 0]],
  [BELL, [0.35, 0.85]],
]);
const DEFAULT_SURFACE: readonly [number, number] = [0.55, 0.15];

/*
 * Legs. Every dimension is derived from where the foot has to land, so the
 * strut, the footpad and the ground all agree -- eyeballing the offsets
 * separately is exactly how legs end up floating above a pad or buried under
 * one. Module-level because the apron radius, which the colony needs to keep
 * its scatter and crew clear, is derived from the same foot.
 */
const LEG_TILT = 0.46;
const LEG_LEN = 2.9;
const HIP_R = 1.55;
const HIP_Y = 2.75;
const FOOT_R = HIP_R + Math.sin(LEG_TILT) * LEG_LEN;
const FOOT_Y = HIP_Y - Math.cos(LEG_TILT) * LEG_LEN;

/** Radius of the scorched apron under the ship: what the scatter must leave clear. */
export const SHIP_APRON_RADIUS = FOOT_R + 2.3;

/**
 * Radius the crew's nav grid treats as solid around the ship's centre. From
 * Bot Crossing's `_rebuildNavigation`: it covers the legs and the skirt, and
 * leaves the ramp foot walkable, which is where the crew has to reach.
 */
export const SHIP_OBSTACLE_RADIUS = 3.4;

/* Ramp: from the lip of the airlock down to the ground. */
const RAMP_TOP_Y = 3.05;
const RAMP_TOP_Z = 2.68;
const RAMP_FOOT_Z = 6.1;
const RAMP_FOOT_Y = 0.06;
/** The dark disc of the hatch: whatever is behind it, seen from the ramp, is inside. */
const HATCH_Z = 2.3;

/*
 * The way in, in the ship's own frame and at standing height: the foot of
 * the ramp, its lip at the airlock, and a step inside the hull. Standing
 * height is the top of the treads, which sit 0.09 + 0.025 over the middle of
 * the slab; along a slope that thickness is taller than it is thick.
 */
const RAMP_SLOPE = Math.atan2(RAMP_TOP_Y - RAMP_FOOT_Y, RAMP_FOOT_Z - RAMP_TOP_Z);
const TREAD_LIFT = 0.1 / Math.cos(RAMP_SLOPE);
const WAY_IN: readonly THREE.Vector3[] = [
  new THREE.Vector3(0, RAMP_FOOT_Y + TREAD_LIFT, RAMP_FOOT_Z),
  new THREE.Vector3(0, RAMP_TOP_Y + TREAD_LIFT, RAMP_TOP_Z),
  // Half a helmet behind the hatch: far enough that the disc and the hull
  // hide all of it, near enough that it is still inside the collar.
  new THREE.Vector3(0, RAMP_TOP_Y + TREAD_LIFT, HATCH_Z - 0.5),
];
/** How many points `wayIn` writes. */
export const WAY_IN_POINTS = WAY_IN.length;

export class Ship implements Layer {
  readonly object3d: THREE.Group;

  #hull!: THREE.Mesh;
  #glassMaterial!: THREE.MeshBasicMaterial;
  #ramp!: THREE.Mesh;
  #stripMaterial!: THREE.MeshBasicMaterial;
  #beaconMaterial!: THREE.MeshBasicMaterial;
  #padMaterial!: THREE.MeshBasicMaterial;
  /** The foot of the ramp, in the group's own frame: where the crew appears and vanishes. */
  #doorLocal!: THREE.Vector3;

  /** Ramps glow brighter while the crew is using them. Decays on its own. */
  #traffic = 0;
  /** How dark it is, 0 to 1: pushed in by whoever owns the sky. */
  #night = 0;

  constructor() {
    this.object3d = new THREE.Group();
    this.object3d.name = 'ship';
    const at = hqPlacement();
    this.object3d.position.set(at.x, 0, at.z);
    // Turned so the ramp points back toward the middle of the colony. Both
    // numbers come from `hqPlacement()` and nowhere else: the placement is
    // the one source of where the ship is, and a second one would drift.
    this.object3d.rotation.y = Math.atan2(-at.x, -at.z);

    this.#buildHull();
    this.#buildRamp(); // sets doorLocal from where the ramp actually lands
    this.#buildLights();
  }

  /** What the H key frames: the ship, a little below the beacon. */
  static focus(): { x: number; y: number; z: number } {
    const at = hqPlacement();
    return { x: at.x, y: HQ_HEIGHT * 0.45, z: at.z };
  }

  /**
   * The terrain height at the pad. The ship's x and z are frozen by the
   * layout; only the planet under it can change, and it is the caller who
   * knows the planet.
   */
  setGroundHeight(y: number): void {
    this.object3d.position.y = y;
  }

  #buildHull(): void {
    const parts: THREE.BufferGeometry[] = [];
    const colors: THREE.Color[] = [];
    const push = (geo: THREE.BufferGeometry, color: number): void => {
      parts.push(geo);
      colors.push(new THREE.Color(color));
    };

    // Main body -- a squat capsule sitting up on its legs.
    const body = new THREE.SphereGeometry(2.4, 22, 16);
    body.scale(1, 0.86, 1);
    body.translate(0, 3.5, 0);
    push(body, HULL);

    // Skirt under the belly, so the hull does not just stop in mid-air above the legs.
    const skirt = new THREE.CylinderGeometry(1.75, 1.15, 1.1, 20);
    skirt.translate(0, 1.5, 0);
    push(skirt, HULL_DARK);

    // Nose cap + sensor mast.
    const nose = new THREE.SphereGeometry(1.0, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    nose.scale(1, 0.9, 1);
    nose.translate(0, 5.42, 0);
    push(nose, TRIM);
    const mast = new THREE.CylinderGeometry(0.08, 0.11, 1.4, 6);
    mast.translate(0, 6.0, 0);
    push(mast, METAL);

    // Porthole surrounds, on the widest band where a flat ring genuinely sits flush.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.62;
      const ring = new THREE.TorusGeometry(0.4, 0.07, 6, 14);
      ring.rotateY(-a + Math.PI / 2);
      ring.translate(Math.cos(a) * 2.33, 3.7, Math.sin(a) * 2.33);
      push(ring, HULL_DARK);
    }

    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const leg = new THREE.CylinderGeometry(0.16, 0.21, LEG_LEN, 8);
      leg.rotateZ(LEG_TILT);
      leg.rotateY(-a);
      leg.translate(Math.cos(a) * ((HIP_R + FOOT_R) / 2), (HIP_Y + FOOT_Y) / 2, Math.sin(a) * ((HIP_R + FOOT_R) / 2));
      push(leg, METAL);

      const pad = new THREE.CylinderGeometry(0.6, 0.46, 0.26, 12);
      pad.translate(Math.cos(a) * FOOT_R, Math.max(0.13, FOOT_Y), Math.sin(a) * FOOT_R);
      push(pad, HULL_DARK);

      // A brace from mid-leg back up into the skirt.
      const braceR = (HIP_R + FOOT_R) * 0.36;
      const brace = new THREE.CylinderGeometry(0.06, 0.06, 1.7, 5);
      brace.rotateZ(-0.95);
      brace.rotateY(-a);
      brace.translate(Math.cos(a) * (braceR + 0.5), 1.55, Math.sin(a) * (braceR + 0.5));
      push(brace, METAL);
    }

    // Engine bell.
    const bell = new THREE.CylinderGeometry(0.55, 1.05, 1.0, 14, 1, true);
    bell.translate(0, 0.85, 0);
    push(bell, BELL);

    /*
     * The airlock. A short tube poking out of the hull rather than a flat
     * ring laid on it -- a torus can never sit flush against a sphere, and
     * one that tries ends up as an arch with its bottom hanging in the air.
     */
    const collar = new THREE.CylinderGeometry(0.92, 0.92, 0.9, 16, 1, true);
    collar.rotateX(Math.PI / 2);
    collar.translate(0, 3.15, 2.25);
    push(collar, HULL_DARK);
    // Only the top two-thirds of the ring: a full torus leaves a bar hanging
    // in the gap the ramp comes out of, which reads as a handle rather than
    // as a hatch frame.
    const lip = new THREE.TorusGeometry(0.92, 0.1, 6, 20, Math.PI * 1.34);
    lip.rotateZ(-Math.PI * 0.17);
    lip.translate(0, 3.15, 2.68);
    push(lip, TRIM);

    this.#hull = new THREE.Mesh(mergeWithColors(parts, colors), hullMaterial());
    this.#hull.castShadow = true;
    this.#hull.receiveShadow = true;
    this.object3d.add(this.#hull);

    // The dark hatch opening, set at the back of the collar so it reads as depth.
    const opening = new THREE.Mesh(
      new THREE.CircleGeometry(0.9, 20),
      new THREE.MeshBasicMaterial({ color: 0x05060a, toneMapped: false }),
    );
    opening.position.set(0, 3.15, HATCH_Z);
    this.object3d.add(opening);

    const glassParts: THREE.BufferGeometry[] = [];
    const glassColors: THREE.Color[] = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.62;
      const pane = new THREE.CircleGeometry(0.36, 14);
      pane.rotateY(-a + Math.PI / 2);
      pane.translate(Math.cos(a) * 2.37, 3.7, Math.sin(a) * 2.37);
      glassParts.push(pane);
      glassColors.push(new THREE.Color(GLASS));
    }
    this.#glassMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: true });
    this.object3d.add(new THREE.Mesh(mergeWithColors(glassParts, glassColors), this.#glassMaterial));
  }

  /**
   * The ramp runs from the lip of the airlock down to the ground. Its length
   * and angle are solved from those two points rather than set by hand, so
   * it always meets both.
   */
  #buildRamp(): void {
    const drop = RAMP_TOP_Y - RAMP_FOOT_Y;
    const run = RAMP_FOOT_Z - RAMP_TOP_Z;
    const length = Math.hypot(run, drop);
    const angle = Math.atan2(drop, run);

    const geo = new THREE.BoxGeometry(1.8, 0.14, length);
    geo.translate(0, 0, length / 2); // pivot at the hatch end
    const mat = new THREE.MeshStandardMaterial({ color: HULL_DARK, roughness: 0.7, metalness: 0.15 });
    this.#ramp = new THREE.Mesh(geo, mat);
    this.#ramp.position.set(0, RAMP_TOP_Y, RAMP_TOP_Z);
    this.#ramp.rotation.x = angle;
    this.#ramp.castShadow = true;
    this.#ramp.receiveShadow = true;
    this.object3d.add(this.#ramp);

    // Treads across it, and a lit strip down each edge.
    const treads: THREE.BufferGeometry[] = [];
    const treadColors: THREE.Color[] = [];
    const steps = Math.max(3, Math.round(length / 0.55));
    for (let i = 1; i < steps; i++) {
      const t = new THREE.BoxGeometry(1.6, 0.05, 0.09);
      t.translate(0, 0.09, (length * i) / steps);
      treads.push(t);
      treadColors.push(new THREE.Color(0x8e8a80));
    }
    this.#ramp.add(new THREE.Mesh(mergeWithColors(treads, treadColors), hullMaterial()));

    const strips: THREE.BufferGeometry[] = [];
    const stripColors: THREE.Color[] = [];
    for (const dx of [-0.82, 0.82]) {
      const s = new THREE.BoxGeometry(0.1, 0.07, length - 0.15);
      s.translate(dx, 0.09, length / 2);
      strips.push(s);
      stripColors.push(new THREE.Color(TRIM));
    }
    this.#stripMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: true });
    this.#ramp.add(new THREE.Mesh(mergeWithColors(strips, stripColors), this.#stripMaterial));

    // The crew appears and vanishes a step short of the ground, at the foot of the ramp.
    this.#doorLocal = new THREE.Vector3(0, 0, RAMP_FOOT_Z + 0.6);
  }

  #buildLights(): void {
    // Beacon on the mast.
    this.#beaconMaterial = new THREE.MeshBasicMaterial({ color: 0xff5a4a, toneMapped: true });
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 8), this.#beaconMaterial);
    beacon.position.set(0, 6.5, 0);
    this.object3d.add(beacon);

    // Landing lights ringing the pad.
    const pads: THREE.BufferGeometry[] = [];
    const padColors: THREE.Color[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r = FOOT_R + 1.5;
      const l = new THREE.SphereGeometry(0.12, 8, 6);
      l.translate(Math.cos(a) * r, 0.12, Math.sin(a) * r);
      pads.push(l);
      padColors.push(new THREE.Color(0x9fd8ff));
    }
    this.#padMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: true });
    this.object3d.add(new THREE.Mesh(mergeWithColors(pads, padColors), this.#padMaterial));

    // Scorched apron under the ship.
    const apron = new THREE.Mesh(
      new THREE.CircleGeometry(SHIP_APRON_RADIUS, 32),
      new THREE.MeshStandardMaterial({ color: 0x2f2c2c, roughness: 1, transparent: true, opacity: 0.65 }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = 0.05;
    apron.receiveShadow = true;
    this.object3d.add(apron);
  }

  /**
   * World position of the foot of the ramp -- where the crew appears and
   * vanishes.
   *
   * The group's world matrix is refreshed first: the ground height can change
   * between two frames, and a door read off a stale matrix would put the crew
   * a planet's worth of terrain above or below the ramp. The ship has a dozen
   * children, so the refresh costs nothing worth saving.
   */
  shipDoor(out: THREE.Vector3): THREE.Vector3 {
    this.object3d.updateMatrixWorld(true);
    return out.copy(this.#doorLocal).applyMatrix4(this.object3d.matrixWorld);
  }

  /**
   * The way in past the door, in world units: the foot of the ramp, its lip,
   * a step inside the hull. Written into the first `WAY_IN_POINTS` vectors of
   * `out`. Without it the crew went home by shrinking at the door, pivoting
   * on its boots, which from above is an astronaut sinking into the dirt in
   * front of the ramp.
   */
  wayIn(out: readonly THREE.Vector3[]): void {
    this.object3d.updateMatrixWorld(true);
    const m = this.object3d.matrixWorld;
    WAY_IN.forEach((p, i) => out[i]?.copy(p).applyMatrix4(m));
  }

  /** Called when someone uses the ramp, so the lights react. */
  ping(): void {
    this.#traffic = Math.min(2.5, this.#traffic + 1);
  }

  /** How dark it is, 0 (day) to 1 (night): the sky knows, the ship only glows. */
  setNight(night: number): void {
    this.#night = Number.isFinite(night) ? Math.min(1, Math.max(0, night)) : 0;
  }

  update(dt: number, now: number): void {
    // Beacon: a double-blink, like a real aircraft strobe.
    const t = now % 2;
    const strobe = t < 0.08 || (t > 0.2 && t < 0.28) ? 1 : 0.08;
    this.#beaconMaterial.color.setRGB(3.2 * strobe, 0.35 * strobe, 0.28 * strobe);

    const night = this.#night;
    const gain = 0.35 + night * 2.2;
    this.#padMaterial.color.setRGB(0.55 * gain, 0.82 * gain, 1.1 * gain);
    this.#glassMaterial.color.setRGB(0.5 * gain, 0.78 * gain, 0.92 * gain);

    // Ramp strips brighten while anyone is walking on them.
    this.#traffic = Math.max(0, this.#traffic - dt * 1.5);
    const busy = Math.min(1, this.#traffic);
    const pulse = 0.6 + 0.4 * Math.sin(now * 4);
    const s = (0.5 + night * 1.2) * (1 + busy * pulse * 1.6);
    this.#stripMaterial.color.setRGB(1.0 * s, 0.45 * s, 0.3 * s);
  }

  dispose(): void {
    this.object3d.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m: THREE.Material | THREE.Material[] = o.material;
        if (Array.isArray(m)) for (const x of m) x.dispose();
        else m.dispose();
      }
    });
    this.object3d.removeFromParent();
  }
}

/**
 * Merge a set of geometries, baking one flat colour per part into vertex
 * colours -- plus the roughness and metalness that colour implies, so a
 * single merged hull can hold painted panel, bare strut and glass and have
 * each behave correctly under the environment map.
 */
function mergeWithColors(parts: readonly THREE.BufferGeometry[], colors: readonly THREE.Color[]): THREE.BufferGeometry {
  parts.forEach((geo, i) => {
    const c = colors[i] ?? new THREE.Color(HULL);
    const count = geo.getAttribute('position').count;
    const arr = new Float32Array(count * 3);
    const surf = new Float32Array(count * 2);
    const s = SURFACE.get(c.getHex()) ?? DEFAULT_SURFACE;
    for (let k = 0; k < count; k++) {
      arr[k * 3] = c.r;
      arr[k * 3 + 1] = c.g;
      arr[k * 3 + 2] = c.b;
      surf[k * 2] = s[0];
      surf[k * 2 + 1] = s[1];
    }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    geo.setAttribute('aSurface', new THREE.BufferAttribute(surf, 2));
    // Every part must carry the same attributes or the merge refuses the set;
    // the uv is the one nothing here samples.
    geo.deleteAttribute('uv');
    if (!geo.hasAttribute('normal')) geo.computeVertexNormals();
  });
  const merged = mergeGeometries([...parts], false);
  if (!merged) throw new Error('ship: could not merge the hull');
  for (const g of parts) g.dispose();
  return merged;
}

/**
 * The hull material: per-vertex PBR, and double-sided so the engine bell and
 * the airlock collar -- both open tubes -- show their insides instead of
 * vanishing. Shadows are cast from the back faces so the double-sided hull
 * does not shadow itself with acne.
 */
function hullMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.55,
    metalness: 0.22,
    side: THREE.DoubleSide,
    shadowSide: THREE.BackSide,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n attribute vec2 aSurface;\n varying vec2 vSurface;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vSurface = aSurface;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n varying vec2 vSurface;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vSurface.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vSurface.y;');
  };
  return mat;
}
