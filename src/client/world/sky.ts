import * as THREE from 'three';
import { mulberry, type Planet } from './planet.ts';
import { systemTimeOfDay, type SettingKey, type Settings } from '../core/settings.ts';

/**
 * Sky, stars, the sun, the thing hanging in the sky, and all the lighting.
 *
 * Ported from Bot Crossing. The whole sky -- gradient, horizon warmth, sun glow and the
 * sun's disc -- is one inverted sphere with one shader, so changing the time of day costs
 * three uniform writes rather than rebuilding anything. Time runs 0..1 with 0.5 at noon;
 * everything else (sun angle, light colour, star opacity, fog) is derived from it, which
 * is what makes a slider able to drive the entire look of the scene.
 *
 * Procedural on purpose: there is no HDRI file and nothing is fetched. The module never
 * touches the DOM either; the renderer it needs for the environment map is handed in.
 */

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    // The dome is pinned to the camera, so it can never be walked out of.
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    gl_Position = projectionMatrix * mv;
  }
`;

const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform float uGlow;       // how much atmosphere there is to scatter light
  uniform float uDisc;       // sun disc brightness, faded out below the horizon
  uniform float uHaze;

  void main() {
    vec3 d = normalize( vDir );
    float h = clamp( d.y * 0.5 + 0.5, 0.0, 1.0 );

    // A hard-ish gradient near the horizon and a slow one overhead reads far more like sky
    // than a linear ramp does.
    vec3 col = mix( uHorizon, uTop, pow( h, 0.42 ) );

    float sun = max( dot( d, uSunDir ), 0.0 );
    // Wide scatter, tight halo, then the disc itself -- three terms, one draw call.
    // These stay modest on purpose: the sky is the largest surface on screen, so anything
    // above 1.0 here feeds the bloom pass across the whole frame and washes the colony out.
    col += uSunColor * pow( sun, 6.0 ) * uGlow * 0.14;
    col += uSunColor * pow( sun, 60.0 ) * uGlow * 0.3;
    col += uSunColor * smoothstep( 0.9990, 0.9996, sun ) * uDisc;

    // Haze thickens toward the horizon, so an atmosphere planet gets a soft rim.
    col = mix( col, uHorizon, uHaze * pow( 1.0 - h, 6.0 ) );

    gl_FragColor = vec4( col, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export type TimeId = 'dawn' | 'morning' | 'noon' | 'golden' | 'dusk' | 'night';

export interface NamedTime {
  id: TimeId;
  label: string;
  value: number;
}

/** Named times of day. The slider is continuous; these are just the good stops. */
export const TIMES: readonly NamedTime[] = [
  { id: 'dawn', label: 'Dawn', value: 0.255 },
  { id: 'morning', label: 'Morning', value: 0.34 },
  { id: 'noon', label: 'Noon', value: 0.5 },
  { id: 'golden', label: 'Golden', value: 0.695 },
  { id: 'dusk', label: 'Dusk', value: 0.755 },
  { id: 'night', label: 'Night', value: 0.94 },
];

const SUN_AXIS = 0.72; // which way the sun tracks across the sky
/**
 * How high the sun gets at noon, in radians -- 54 degrees, not 90.
 *
 * The arc is tilted off the zenith the way a real solar path is, rather than passing
 * straight overhead. That is load-bearing for anything with a flat vertical face: a sun at
 * the zenith puts `N.L` at zero on every wall in the colony, and they go black with only
 * ambient to catch. It is also what the old "shadows always have some length" comment was
 * after -- scaling the elevation *before* normalising cannot cap an angle, because at noon
 * the horizontal term is zero and the direction normalises to straight up regardless.
 */
const SUN_APEX = 0.95;
/** Half-width of the shadow camera, in metres, centred on whatever you are looking at. */
const SHADOW_EXTENT = 30;
/**
 * The focus is snapped to this grid before the shadow camera moves. Panning a shadow map
 * by sub-texel amounts makes every shadow edge crawl; snapping trades a little slack at
 * the frustum edge for edges that hold still.
 */
const SHADOW_SNAP = 2;

// Radii scaled up for this project's bigger map (source: dome 400, stars 330, companion 300).
const DOME_RADIUS = 900;
const STAR_RADIUS = 750;
const COMPANION_DISTANCE = 700;

// Each bag names its uniforms so writes are typed, and carries the index signature
// ShaderMaterial wants so the very same object can be handed to it.
interface DomeUniforms {
  [name: string]: THREE.IUniform;
  uTop: { value: THREE.Color };
  uHorizon: { value: THREE.Color };
  uSunColor: { value: THREE.Color };
  uSunDir: { value: THREE.Vector3 };
  uGlow: { value: number };
  uDisc: { value: number };
  uHaze: { value: number };
}

interface StarUniforms {
  [name: string]: THREE.IUniform;
  uOpacity: { value: number };
  uTwinkle: { value: number };
}

interface HaloUniforms {
  [name: string]: THREE.IUniform;
  uColor: { value: THREE.Color };
  uStrength: { value: number };
}

type DomeMesh = THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
type StarPoints = THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
type CompanionBody = THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
type CompanionHalo = THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;

export class Sky {
  readonly #scene: THREE.Scene;
  readonly #settings: Settings;
  readonly #group: THREE.Group;
  readonly #fog: THREE.Fog;
  readonly #unsubscribe: () => void;

  readonly #sunDir = new THREE.Vector3(0, 1, 0);
  #dayFactor = 1;
  #nightFactor = 0;
  #time = 0.32;
  #elapsed = 0;
  #planet: Planet | null = null;
  readonly #c1 = new THREE.Color();
  readonly #c2 = new THREE.Color();

  readonly #dome: DomeMesh;
  readonly #domeUniforms: DomeUniforms;
  readonly #sun: THREE.DirectionalLight;
  readonly #hemi: THREE.HemisphereLight;
  readonly #fill: THREE.DirectionalLight;
  readonly #focus = new THREE.Vector3();
  readonly #stars: StarPoints;
  readonly #starUniforms: StarUniforms;
  readonly #companion: THREE.Group;
  readonly #companionBody: CompanionBody;
  readonly #companionHalo: CompanionHalo;
  readonly #haloUniforms: HaloUniforms;
  // Parked high and off to one side, well away from where the sun tracks.
  readonly #compOff = new THREE.Vector3(-0.55, 0.5, -0.66).normalize().multiplyScalar(COMPANION_DISTANCE);

  // Palette derived from the planet in setPlanet.
  #dayTop = new THREE.Color();
  #dayBottom = new THREE.Color();
  #nightTop = new THREE.Color();
  #nightBottom = new THREE.Color();
  #duskColor = new THREE.Color();

  readonly #pmrem: THREE.PMREMGenerator;
  readonly #envScene: THREE.Scene;
  #envDirty = true;
  #envAt = 0;
  #envTarget: THREE.WebGLRenderTarget | null = null;

  constructor(scene: THREE.Scene, settings: Settings, renderer: THREE.WebGLRenderer) {
    this.#scene = scene;
    this.#settings = settings;
    this.#group = new THREE.Group();
    this.#group.name = 'sky';
    scene.add(this.#group);

    const dome = buildDome();
    this.#dome = dome.mesh;
    this.#domeUniforms = dome.uniforms;
    this.#group.add(this.#dome);

    const lights = buildLights(settings);
    this.#sun = lights.sun;
    this.#hemi = lights.hemi;
    this.#fill = lights.fill;
    this.#sun.target.position.set(0, 0, 0);
    this.#group.add(this.#sun, this.#sun.target, this.#hemi, this.#fill);

    const stars = buildStars();
    this.#stars = stars.points;
    this.#starUniforms = stars.uniforms;
    this.#group.add(this.#stars);

    const companion = buildCompanion();
    this.#companion = companion.group;
    this.#companionBody = companion.body;
    this.#companionHalo = companion.halo;
    this.#haloUniforms = companion.uniforms;
    this.#group.add(this.#companion);

    /**
     * Image-based lighting, taken from this planet's own sky.
     *
     * Rather than shipping an HDRI, the sky shader *is* the HDRI: a second copy of the dome --
     * sharing the same uniforms, so it is always the sky you are actually standing under -- is
     * rendered into a prefiltered radiance map. That is what gives metal something to reflect
     * and dielectrics a directional ambient, and it is why the colony changes character
     * through the day rather than just changing brightness.
     *
     * It is regenerated only when the sky has actually moved, and never more than a few times
     * a second, because prefiltering costs a couple of milliseconds.
     */
    this.#pmrem = new THREE.PMREMGenerator(renderer);
    this.#envScene = new THREE.Scene();
    // Same material, so every uniform write to the visible sky lands here too.
    const envDome = new THREE.Mesh(this.#dome.geometry, this.#dome.material);
    envDome.scale.setScalar(10);
    envDome.frustumCulled = false;
    this.#envScene.add(envDome);

    // Placeholder until setPlanet; near/far x1.8 like every planet's fog (source 90/260).
    this.#fog = new THREE.Fog(0x000000, 90 * 1.8, 260 * 1.8);
    scene.fog = this.#fog;

    this.#unsubscribe = settings.onChange((changed) => this.#onSettingsChanged(changed));
  }

  #refreshEnvironment(force = false): void {
    if (!this.#settings.get('ibl')) {
      if (this.#scene.environment) {
        this.#scene.environment = null;
        this.#envTarget?.dispose();
        this.#envTarget = null;
      }
      return;
    }
    const now = performance.now();
    if (!force && (!this.#envDirty || now - this.#envAt < 220)) return;
    this.#envDirty = false;
    this.#envAt = now;

    const next = this.#pmrem.fromScene(this.#envScene, 0, 0.5, 60);
    this.#envTarget?.dispose();
    this.#envTarget = next;
    this.#scene.environment = next.texture;
    this.#scene.environmentIntensity = this.#settings.get('iblIntensity');
  }

  // -- planet + time ---------------------------------------------------------------------

  setPlanet(planet: Planet): void {
    this.#planet = planet;
    this.#dayTop = new THREE.Color(planet.sky.top);
    this.#dayBottom = new THREE.Color(planet.sky.bottom);
    // Night is the day palette crushed toward the planet's own horizon colour, so each
    // world keeps its identity after dark instead of all three going the same black.
    this.#nightTop = new THREE.Color(planet.sky.top).multiplyScalar(0.16).lerp(new THREE.Color(0x03040c), 0.7);
    this.#nightBottom = new THREE.Color(planet.horizon).multiplyScalar(0.5);
    this.#duskColor = new THREE.Color(planet.atmosphere > 0.4 ? 0xd4692f : 0x4a3550);

    const comp = planet.companion;
    this.#companionBody.material.color.set(comp.color);
    this.#companionBody.material.emissive.set(comp.color);
    this.#companionBody.material.emissiveIntensity = 0.35;
    this.#haloUniforms.uColor.value.set(comp.glow);
    this.#companion.scale.setScalar(comp.size);
    this.#companion.position.copy(this.#compOff);
    this.#companionHalo.scale.setScalar(2.2);

    this.#envDirty = true;
    this.#domeUniforms.uHaze.value = 0.25 + planet.atmosphere * 0.5;
    this.#fog.color.set(planet.fog.color);
    this.#fog.near = planet.fog.near;
    this.#fog.far = planet.fog.far;
    this.setTime(this.#time);
  }

  /** Point the shadow frustum at the middle of the view. */
  setFocus(point: THREE.Vector3): void {
    const x = Math.round(point.x / SHADOW_SNAP) * SHADOW_SNAP;
    const z = Math.round(point.z / SHADOW_SNAP) * SHADOW_SNAP;
    if (x === this.#focus.x && z === this.#focus.z) return;
    this.#focus.set(x, 0, z);
    this.#placeSun();
  }

  /** Sun position and target both hang off the focus point, so the frustum travels with it. */
  #placeSun(): void {
    this.#sun.position.copy(this.#sunDir).multiplyScalar(150).add(this.#focus);
    this.#sun.target.position.copy(this.#focus);
    this.#sun.target.updateMatrixWorld();
  }

  setTime(t: number): void {
    this.#time = ((t % 1) + 1) % 1;
    const planet = this.#planet;
    if (!planet) return;

    // Sun on a tilted arc: 0.25 is sunrise, 0.5 noon, 0.75 sunset. The arc runs along the
    // horizon in `travel` and leans out of it toward `apex`, so noon puts the sun at
    // SUN_APEX above the horizon and off to one side rather than overhead. Both basis
    // vectors are unit and perpendicular, so the result needs no normalising.
    const a = (this.#time - 0.25) * Math.PI * 2;
    const across = Math.sin(SUN_AXIS);
    const along = Math.cos(SUN_AXIS);
    const lean = Math.cos(SUN_APEX);
    this.#sunDir.set(
      Math.cos(a) * along + Math.sin(a) * lean * -across,
      Math.sin(a) * Math.sin(SUN_APEX),
      Math.cos(a) * across + Math.sin(a) * lean * along,
    );

    // Day factor drives everything else. The smoothstep across the horizon is what gives
    // dawn and dusk their length -- a hard cut would make the lights snap on.
    const day = THREE.MathUtils.smoothstep(this.#sunDir.y, -0.14, 0.22);
    this.#dayFactor = day;
    const golden = 1 - Math.abs(THREE.MathUtils.clamp(this.#sunDir.y, -0.2, 0.55) / 0.55); // 1 at the horizon
    this.#nightFactor = 1 - day;

    // Sun light: warm and weak at the horizon, full and neutral overhead.
    const sunColor = this.#c1.set(planet.sun.color).lerp(this.#duskColor, golden * 0.7 * planet.atmosphere);
    this.#sun.color.copy(sunColor);
    this.#sun.intensity = THREE.MathUtils.lerp(planet.sun.night, planet.sun.intensity, day);
    this.#placeSun();

    this.#hemi.color.set(planet.ambient.sky);
    this.#hemi.groundColor.set(planet.ambient.ground);
    // The hemisphere light drops right back when IBL is carrying the ambient -- running both
    // at full strength double-counts the sky and flattens everything out.
    const hemiScale = this.#settings.get('ibl') ? 0.55 : 1;
    this.#hemi.intensity =
      THREE.MathUtils.lerp(planet.ambient.intensity * 0.22, planet.ambient.intensity, day) * hemiScale;
    // Enough of a bounce that surfaces turned away from the sun read as dark rather than as
    // holes in the image. On an airless world this stands in for regolith bounce.
    this.#fill.intensity = THREE.MathUtils.lerp(0.34, 0.26, day);

    // Sky gradient.
    const top = this.#c1.copy(this.#nightTop).lerp(this.#dayTop, day);
    const bottom = this.#c2.copy(this.#nightBottom).lerp(this.#dayBottom, day);
    if (planet.atmosphere > 0) bottom.lerp(this.#duskColor, golden * 0.55 * planet.atmosphere * day);
    this.#domeUniforms.uTop.value.copy(top);
    this.#domeUniforms.uHorizon.value.copy(bottom);
    this.#domeUniforms.uSunColor.value.copy(sunColor);
    this.#domeUniforms.uSunDir.value.copy(this.#sunDir);
    this.#domeUniforms.uGlow.value = (0.3 + planet.atmosphere * 1.1) * Math.max(0.08, day);
    // The disc fades out as it sets rather than snapping off at the horizon.
    this.#domeUniforms.uDisc.value = 2.4 * THREE.MathUtils.smoothstep(this.#sunDir.y, -0.06, 0.04);

    // Stars fade with the sky, and never appear at all on a thick-atmosphere daytime.
    this.#starUniforms.uOpacity.value = Math.pow(1 - day, 1.6) * (1 - planet.atmosphere * 0.35);
    this.#stars.visible = this.#settings.get('stars') && this.#starUniforms.uOpacity.value > 0.01;

    this.#haloUniforms.uStrength.value = 0.35 + (1 - day) * 0.65;
    this.#companionBody.material.emissiveIntensity = 0.25 + (1 - day) * 0.55;

    // Fog follows the horizon, or the whole world looks like it is behind glass at night.
    this.#fog.color.copy(bottom).lerp(this.#c1.set(planet.fog.color), 0.55);
    this.#envDirty = true;
  }

  #onSettingsChanged(changed: ReadonlySet<SettingKey>): void {
    if (changed.has('shadows')) {
      const size = this.#settings.shadowSize;
      this.#sun.castShadow = size > 0;
      if (size > 0) {
        this.#sun.shadow.mapSize.setScalar(size);
        this.#sun.shadow.map?.dispose();
        this.#sun.shadow.map = null;
      }
    }
    if (changed.has('stars')) this.setTime(this.#time);
    if (changed.has('ibl') || changed.has('iblIntensity')) {
      this.#scene.environmentIntensity = this.#settings.get('iblIntensity');
      this.#refreshEnvironment(true);
    }
  }

  /**
   * Advance the sky by one frame. Returns true when it moved the clock on its own (clock or
   * auto time), so the caller can write `timeOfDay` back and re-sync anything keyed off it.
   * With a camera, the dome, stars and companion ride along so they read as infinitely far.
   */
  update(dt: number, camera?: THREE.Object3D): boolean {
    this.#elapsed += dt;
    if (camera) {
      // Dome and stars ride with the camera so they read as infinitely far away.
      this.#dome.position.copy(camera.position);
      this.#stars.position.copy(camera.position);
      this.#companion.position.copy(camera.position).add(this.#compOff);
      this.#companion.lookAt(camera.position);
    }
    this.#starUniforms.uTwinkle.value = this.#elapsed;
    this.#refreshEnvironment();

    // Following the clock beats cycling: both drive the same value, and a cycle running on
    // top of it would just fight. Re-read every frame rather than on a timer -- it is two
    // divisions, and it means crossing midnight or the machine waking from sleep needs no
    // special case.
    if (this.#settings.get('clockTime')) {
      const t = systemTimeOfDay();
      if (Math.abs(t - this.#time) < 1e-5) return false;
      this.setTime(t);
      return true; // the caller re-syncs anything that keys off time
    }
    if (this.#settings.get('autoTime')) {
      this.setTime(this.#time + dt / Math.max(20, this.#settings.get('dayLength')));
      return true;
    }
    return false;
  }

  /** 0 in full day, 1 in full night. */
  get night(): number {
    return this.#nightFactor;
  }

  /** 1 in full day, 0 in full night: the complement of `night`. */
  get day(): number {
    return this.#dayFactor;
  }

  /** Unit vector toward the sun. The live vector: read it, do not write to it. */
  get sunDir(): THREE.Vector3 {
    return this.#sunDir;
  }

  /** 0..1, 0.5 at noon. */
  get time(): number {
    return this.#time;
  }

  dispose(): void {
    this.#unsubscribe();
    this.#pmrem.dispose();
    this.#envTarget?.dispose();
    this.#scene.environment = null;
    this.#dome.geometry.dispose();
    this.#dome.material.dispose();
    this.#stars.geometry.dispose();
    this.#stars.material.dispose();
    this.#companionBody.geometry.dispose();
    this.#companionBody.material.dispose();
    this.#companionHalo.geometry.dispose();
    this.#companionHalo.material.dispose();
    this.#scene.remove(this.#group);
  }
}

// -- builders ---------------------------------------------------------------------------
// Plain functions rather than methods so every field is assigned in the constructor, which
// is what lets them be readonly `#fields`.

function buildDome(): { mesh: DomeMesh; uniforms: DomeUniforms } {
  const geo = new THREE.SphereGeometry(1, 32, 20);
  const uniforms: DomeUniforms = {
    uTop: { value: new THREE.Color(0x0a1230) },
    uHorizon: { value: new THREE.Color(0x101018) },
    uSunColor: { value: new THREE.Color(0xfff0d0) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uGlow: { value: 1 },
    uDisc: { value: 1 },
    uHaze: { value: 0.3 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const mesh: DomeMesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  mesh.scale.setScalar(DOME_RADIUS);
  return { mesh, uniforms };
}

function buildLights(settings: Settings): {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  fill: THREE.DirectionalLight;
} {
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  const size = settings.shadowSize;
  sun.castShadow = size > 0;
  // The shadow camera tracks what you are looking at rather than covering the whole
  // colony. Sizing it to the view instead of the world is worth roughly a doubling of
  // effective shadow resolution -- the difference between an astronaut casting a readable
  // little shadow and casting four grey pixels.
  const s = SHADOW_EXTENT;
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s;
  sun.shadow.camera.bottom = -s;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 320;
  // Sized against the shadow texel, which is 2 * SHADOW_EXTENT / mapSize across -- roughly
  // 6cm at the balanced preset. A normal bias under one texel leaves acne on the big flat
  // decks; depth bias is left at zero because normal bias alone does the job without the
  // peter-panning that a negative depth bias causes on these small characters.
  sun.shadow.bias = 0;
  sun.shadow.normalBias = 0.09;
  sun.shadow.mapSize.setScalar(size || 1024);

  const hemi = new THREE.HemisphereLight(0x8899cc, 0x4a4038, 0.6);

  // A cool rim from the opposite side keeps night silhouettes from going fully black.
  const fill = new THREE.DirectionalLight(0x8fa8d8, 0.2);
  fill.position.set(-40, 30, -30);

  return { sun, hemi, fill };
}

function buildStars(): { points: StarPoints; uniforms: StarUniforms } {
  const count = 1400;
  const rand = mulberry(90210);
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color();

  for (let i = 0; i < count; i++) {
    // Uniform on the sphere, biased upward -- stars below the horizon are wasted vertices.
    const u = rand() * 2 - 1;
    const theta = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    const y = Math.abs(u) * 0.92 + 0.05;
    positions[i * 3] = Math.cos(theta) * r * STAR_RADIUS;
    positions[i * 3 + 1] = y * STAR_RADIUS;
    positions[i * 3 + 2] = Math.sin(theta) * r * STAR_RADIUS;
    sizes[i] = 0.6 + rand() * rand() * 3.4;
    // A few blue and orange ones stop the field looking like static.
    c.setHSL(rand() < 0.82 ? 0.58 : rand() < 0.5 ? 0.08 : 0.62, 0.35 * rand(), 0.75 + rand() * 0.25);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const uniforms: StarUniforms = { uOpacity: { value: 1 }, uTwinkle: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    vertexShader: /* glsl */ `
      attribute float aSize;
      varying vec3 vColor;
      varying float vTw;
      uniform float uTwinkle;
      void main() {
        vColor = color;
        // Each star twinkles on its own phase, seeded from its position.
        float seed = dot( position, vec3( 0.013, 0.027, 0.019 ) );
        vTw = 0.75 + 0.25 * sin( uTwinkle * 1.7 + seed * 40.0 );
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        gl_PointSize = aSize * vTw;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vTw;
      uniform float uOpacity;
      void main() {
        // Round the point off, with a soft core, so stars are not little squares.
        vec2 d = gl_PointCoord - 0.5;
        float a = smoothstep( 0.5, 0.06, length( d ) );
        gl_FragColor = vec4( vColor * vTw, a * uOpacity );
      }
    `,
  });
  mat.vertexColors = true;

  const points: StarPoints = new THREE.Points(geo, mat);
  points.renderOrder = -999;
  points.frustumCulled = false;
  return { points, uniforms };
}

/** The big body hanging in the sky -- Earth from the Moon, a moon from Terra, and so on. */
function buildCompanion(): {
  group: THREE.Group;
  body: CompanionBody;
  halo: CompanionHalo;
  uniforms: HaloUniforms;
} {
  const group = new THREE.Group();
  const geo = new THREE.SphereGeometry(1, 24, 18);
  const body: CompanionBody = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 }),
  );
  // A soft halo billboard behind it, so it glows rather than sitting flat on the sky.
  const haloGeo = new THREE.PlaneGeometry(4, 4);
  const uniforms: HaloUniforms = { uColor: { value: new THREE.Color(0x6ea8ff) }, uStrength: { value: 1 } };
  const halo: CompanionHalo = new THREE.Mesh(
    haloGeo,
    new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
      fragmentShader: `
        varying vec2 vUv; uniform vec3 uColor; uniform float uStrength;
        void main(){
          float d = length( vUv - 0.5 ) * 2.0;
          float a = pow( max( 0.0, 1.0 - d ), 3.0 );
          gl_FragColor = vec4( uColor, a * uStrength );
        }`,
    }),
  );
  halo.renderOrder = -998;
  body.renderOrder = -997;
  group.add(halo, body);
  group.frustumCulled = false;
  return { group, body, halo, uniforms };
}
