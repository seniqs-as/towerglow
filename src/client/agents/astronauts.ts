import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FACE, FACE_LOOPS, FRAME_COLS, FRAME_ROWS } from './faces.ts';
import type { Navigation, Waypoint } from './navigation.ts';
import { attachMatrixAt, decorateSkinned, frameFor } from '../assets/crew.ts';
import type { ClipKey, CrewRig } from '../assets/crew.ts';
import { MAX_AGENT_CAP } from '../core/settings.ts';
import type { Settings, SettingKey } from '../core/settings.ts';
import type { Layer } from '../world/stage.ts';
import type { CrewStatus } from '../state/status.ts';
import { PROVIDER_COLOR } from '../world/palette.ts';
import type { ProviderId } from '../../shared/protocol.ts';
import { mulberry32 } from '../../shared/hash.ts';
import { WAY_IN_POINTS } from '../world/ship.ts';
import { GESTURE_CLIP, requestGesture, restingGesture, settleGesture } from './gestures.ts';
import type { Gesture, GestureState } from './gestures.ts';

/**
 * Every astronaut in the colony, drawn in seven draw calls. Ported from Bot
 * Crossing; what changed is what the colony feeds it (see `RosterEntry`).
 * Two more crews run on the same class with rosters of their own: the CEOs
 * seated at their desk inside the ship with you walking in (`interior.ts`),
 * and you on your way up the ramp (`boarding.ts`) -- never in the colony's
 * roster, which counts sessions and nothing else.
 *
 * The body is one instanced, GPU-skinned mesh playing KayKit's hand-animated
 * clips (see `crew.ts`) -- every torso, arm and leg in the colony in a single
 * draw, whether there are six sessions or three hundred. Everything the crew
 * WEARS stays procedural and stays in its own `InstancedMesh`: helmet, visor,
 * screen-face, backpack, antenna and lamp, because those carry the colony's
 * own identity and its own shaders.
 *
 * Worn parts are pinned to bones the cheap way. The baked animation lives in
 * an ordinary array as well as in the texture the shader samples, so placing
 * a helmet is one matrix read out of that array -- no skeleton is evaluated
 * on the CPU, and the helmet can never be a frame out of step with the head
 * it sits on.
 *
 * Per-agent variation that would normally need a separate material rides
 * along as instanced attributes instead: suit colour and eye colour through
 * `instanceColor`, the face's atlas frame and the body's animation frame
 * through custom `aFrame` attributes.
 *
 * Picking is done analytically rather than by raycasting the instanced meshes
 * -- projecting N head positions to screen space is both cheaper and far more
 * forgiving to click at the size these characters render.
 *
 * Nothing here touches the DOM: the face atlas is a canvas, so it is built by
 * the caller and handed in, and the whole state machine runs under
 * `node --test` with no rig and no renderer.
 */

/** What a session is doing, as the roster says it. The locomotion states are internal. */
export type AgentStatus = CrewStatus | 'celebrating';

/** Where an astronaut is in its life: out of the ship, on the way, there, going home, up the ramp, gone. */
export type AgentState = 'spawning' | 'walking' | 'at-site' | 'leaving' | 'boarding' | 'gone';

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** One session, as the colony hands it over on every reconcile. */
export interface RosterEntry {
  id: string;
  status: AgentStatus;
  /** Which tool works here: it picks the trim colour, the way it does everywhere else. */
  provider: ProviderId;
  /** Where the astronaut stands: just outside its structure, facing in. */
  site: Point3;
  /**
   * The thing being worked on. A working astronaut circles it rather than
   * standing at one spot, so it needs the structure, not just a place near it.
   */
  anchor: Point3 | null;
  /** Already on the map before this page opened: appears in place, no entrance. */
  known: boolean;
  /** Deterministic per session (the caller hashes the id): suit tone, face and phase. */
  seed: number;
  /** How big this one stands next to a session's astronaut: 1 unless said otherwise. */
  size?: number;
  /**
   * Where it comes out and goes back in, when that is not the ship. A
   * subagent is born inside its session's habitat, not off the ramp, and it
   * does not queue at the ship's door either.
   */
  home?: Point3 | null;
  /**
   * Sits at its site whatever its status, facing `anchor`: the CEO at its
   * desk. The status still picks the face and the eyes, so a CEO answering
   * looks busy without getting up.
   */
  seated?: boolean;
  /**
   * Moved by hand through `place`, never by a route: you, walking in the
   * ship. It is not separated, it does not wander and it does not go home on
   * its own; the clip still follows how far it actually moved.
   */
  driven?: boolean;
  /** The trim, when it is nobody's tool: you are neither Claude nor Codex. */
  trim?: number;
  /**
   * Walked and posed like any other, drawn by somebody else: you, wearing
   * the villager (`agents/visitor.ts`). The crew stays the one place that
   * says where you are, which way you face and whether you are walking --
   * the figure reads that off and wears it, and decides nothing of its own.
   */
  hidden?: boolean;
}

/**
 * A short gesture that interrupts whatever an astronaut is doing, standing
 * still for it: a hop when a turn ends, a look back at the ship when you send
 * a prompt. Events, not states -- they say something just happened.
 */
export type Cue = 'hop' | 'heed';

const CUES: Readonly<Record<Cue, { clip: ClipKey; seconds: number }>> = {
  // The jump is a one-shot; the rig says how long it really is.
  hop: { clip: 'jump', seconds: 1.1 },
  heed: { clip: 'interact', seconds: 1.8 },
};

/** The bits of the world the crew needs to know about, as plain callbacks. */
export interface CrewWorld {
  shipDoor(out: THREE.Vector3): THREE.Vector3;
  /** Past the door: the foot of the ramp, its lip, a step inside the hull. See `Ship.wayIn`. */
  shipWayIn(out: readonly THREE.Vector3[]): void;
  groundAt(x: number, z: number): number;
}

/**
 * What the colony reads off an astronaut every frame: where it is, what it is
 * doing, and the two beats it throws particles on. Read, never written.
 */
interface AgentFields {
  id: string;
  /** The effective status: the roster's, or `celebrating` while `celebrate()` holds. */
  status: AgentStatus;
  state: AgentState;
  pos: THREE.Vector3;
  yaw: number;
  /**
   * Where the helmet is, in world units, kept live by `update`. The HTML badges
   * read this vector object every frame, so it is never replaced, only written.
   */
  head: THREE.Vector3;
  /** The eased ground height actually stood on: the deck on a zone, the terrain between. */
  groundY: number;
  hop: number;
  phase: number;
  walkAmp: number;
  scale: number;
  /** True for exactly the frame the hammer lands: when the colony throws sparks. */
  workSwing: boolean;
  /** What its hands do while working, from the tool the session last called. */
  gesture: Gesture;
  /** 1 for a session's astronaut, less for a subagent's. */
  size: number;
  /** Seconds left of the cue it is playing; 0 when there is none. */
  cueLeft: number;
  clipKey: ClipKey;
  /** The row of the bake it is posed on, and the atlas frame on its visor. */
  frame: number;
  faceFrame: number;
  /** Walked and posed here, drawn elsewhere. See `RosterEntry.hidden`. */
  hidden: boolean;
  /** Slot in the instance buffers, -1 until the first write. */
  index: number;
}

export type Agent = Readonly<AgentFields>;

/** The whole record: the public fields plus the simulation's own. */
interface Crewman extends AgentFields {
  provider: ProviderId;
  /** What the roster last said; `status` returns to it when a celebration ends. */
  rosterStatus: AgentStatus;
  /** Seconds of celebration left; 0 when the roster status is in force. */
  cheerLeft: number;
  gestures: GestureState;
  /** Where it appears and leaves, when that is not the ship door. */
  home: THREE.Vector3 | null;
  /** See `RosterEntry.seated` and `RosterEntry.driven`; `hidden` is public. */
  seated: boolean;
  driven: boolean;
  /** A trim of its own, or null for its tool's colour. */
  ownTrim: number | null;
  cueClip: ClipKey | null;
  /** What a cue turns it towards, if anything. */
  cueFace: THREE.Vector3 | null;
  /** This astronaut's own dice, seeded from the session: a crowd never blinks in unison. */
  rnd: () => number;
  site: THREE.Vector3;
  anchor: THREE.Vector3 | null;
  workSpot: THREE.Vector3;
  workAt: number;
  vel: THREE.Vector3;
  targetYaw: number;
  speed: number;
  stateAge: number;
  blinkAt: number;
  faceTimer: number;
  /** How fast this one's face loop runs, as a multiple of the status's own rate. */
  facePace: number;
  faceIndex: number;
  loop: readonly number[] | null;
  suit: number;
  eye: THREE.Color;
  trim: THREE.Color;
  /** False until the first ground sample, so the first frame snaps instead of easing up. */
  groundSampled: boolean;
  /** The height last sampled; `groundY` eases towards it. */
  groundAt: number;
  groundX: number;
  groundZ: number;
  /** The `groundMoved` count this agent last sampled at: behind it, the ground under it may have moved. */
  groundEpoch: number;
  /** Distance actually covered per second, damped: what picks the animation clip. */
  groundSpeed: number;
  /** Set by `walk` on a refused step; latched per wander leg as `driftBlocked`. */
  blocked: boolean;
  driftBlocked: boolean;
  clipTime: number;
  /** Phase of the hammer cycle on the previous frame; -1 outside the work clip. */
  workPhase: number;
  wander: THREE.Vector3;
  wanderAt: number;
  path: readonly Waypoint[] | null;
  pathAt: number;
  pathVersion: number;
  pathGoal: THREE.Vector3;
  /** Seconds the walk has lately been refused most of its step; see `STALL_S`. */
  stall: number;
  /** Where the current stretch of standing still began, and at what `stateAge`; see `STUCK_S`. */
  stillAt: THREE.Vector3;
  stillSince: number;
  /** On the ramp: the next point of the way in, where this leg began (height included), and how far is left. */
  wayAt: number;
  wayFrom: THREE.Vector3;
  wayLeft: number;
  colorDirty: boolean;
}

export const SUIT_TONES: readonly number[] = [0xf3f1ec, 0xe8e4dc, 0xf7f4ee, 0xdfe4e8, 0xf1e9df];

/**
 * Eye colour per behaviour. Eyes are pushed past 1.0 so the bloom pass catches
 * them. The trim used to come from this table too; here it says which tool is
 * working (`PROVIDER_COLOR`), the same as everywhere else in the colony.
 */
const AGENT_LOOK: Readonly<Record<AgentStatus, { eye: readonly [number, number, number] }>> = {
  working: { eye: [0.35, 2.5, 1.15] },
  waiting: { eye: [0.45, 1.5, 3.0] },
  blocked: { eye: [3.0, 0.5, 0.45] },
  celebrating: { eye: [2.9, 2.1, 0.6] },
  idle: { eye: [1.1, 1.5, 1.7] },
  sleeping: { eye: [0.7, 0.8, 1.4] },
};

/**
 * The face loop each status plays. The source looked the loop up by status
 * name, and its `broken` loop matched no status, so a blocked astronaut wore
 * the idle face: `broken` (crossed eyes, a wobbly mouth) is what it is for.
 */
const STATUS_LOOP: Readonly<Record<AgentStatus, readonly number[] | null>> = {
  working: FACE_LOOPS.working,
  waiting: FACE_LOOPS.waiting,
  celebrating: FACE_LOOPS.celebrating,
  sleeping: FACE_LOOPS.sleeping,
  blocked: FACE_LOOPS.broken,
  idle: null,
};

/**
 * What a CEO's face does at its desk with nothing to answer.
 *
 * An idle astronaut out in the colony wears one frame and blinks, which is
 * right for a figure the size of a thumb seen from the air. A metre away
 * across a desk it is a mask: two of them, wearing the same frame, are one
 * figure drawn twice. So a seated idler gets a loop, and `#face` runs it at
 * a pace of that agent's own -- the two behind the desk are never on the
 * same frame at the same moment, which is the whole point of it.
 */
const DESK_IDLE: readonly number[] = [
  FACE.idle, FACE.idle, FACE.think1, FACE.idle, FACE.idle, FACE.happy,
  FACE.idle, FACE.think2, FACE.think3, FACE.idle, FACE.wink, FACE.idle,
];

export const WALK_SPEED = 2.1;
const TURN_RATE = 7.5;
/**
 * How many astronauts may walk out of the ship in one reconcile. The rest of a
 * big arrival -- a reload, a first run, a hidden project being shown again --
 * are placed on their plots instead.
 */
export const MAX_ENTRANCE = 6;
/** Around the ramp, where an astronaut standing still blocks everyone still coming out. */
const DOORWAY_CLEAR = 5.5;
/** How close to the door an astronaut going home starts up the ramp. */
const BOARD_REACH = 1.2;
/**
 * How far behind the one ahead of it an astronaut on the ramp keeps, along
 * the way in. The ramp is on rails, where separation does not push: without a
 * gap two sessions ending together climb it inside one another.
 */
const RAMP_GAP = 1.1;
/** A climb, not a stroll: a shade slower than the walk. */
const CLIMB_PACE = 0.8;
/**
 * Over this much of the way in, measured back from the end, the astronaut
 * shrinks to nothing. It is taller than the half of the hatch above the
 * ramp's lip, and at full size its helmet came out through the top of the
 * collar; this much puts it under the collar by the lip.
 */
const HATCH_FADE = 1.4;

/** How close counts as "reached this waypoint". A shade over one nav cell. */
const WAYPOINT_REACHED = 0.55;
/**
 * How close a waypoint is retired even with the leg after it out of sight:
 * well inside its own cell, which is free and sees that leg by construction.
 * Without it an astronaut a grid rounding off the sightline would circle the
 * waypoint for good.
 */
const WAYPOINT_AT = 0.15;
/**
 * How long a walk may slide along a wall, getting less than `STALL_GAIN` of
 * each step, before its route is asked for again. `slide` counts a step as
 * taken if either axis moved at all, so an astronaut the crowd has shoved off
 * its leg and against a rail moves a millimetre sideways a frame, is never
 * blocked, and without this keeps a route that no longer starts where it
 * stands. A quarter second rather than at once: a crowd pressed against a
 * wall would otherwise spend the whole frame's path budget every frame.
 */
const STALL_S = 0.25;
const STALL_GAIN = 0.25;
/**
 * A walker that has not got `STILL_REACH` from where it stood in this many
 * seconds is stuck: on its way out it gives up on its site, on its way home
 * it is retired where it stands. Stuck used to be a clock: a blocked frame
 * any time after eight seconds of walking, or forty-five seconds of walking
 * at all. From the ship to a project in the colony's outer ring is 80 m, 45 s
 * at the slowest pace, and a walker that had done nothing wrong gave up at
 * the foot of the ramp; one grazing a rail on its way round a stack gave up
 * on the spot.
 */
const STUCK_S = 8;
const STILL_REACH = 1;
/**
 * The backstop for a walker that keeps moving and never arrives: longer than
 * any honest route, which on a 300 m map at the slowest pace is under three
 * minutes.
 */
const WALK_LIMIT_S = 180;
/**
 * How far apart astronauts hold each other, measured against the widest thing
 * they wear: the helmet is 0.95 across, so anything under that is a spacing at
 * which they are visibly inside one another. The old 0.72 was exactly that --
 * separation WAS running and holding them at 0.71, which is a quarter of a
 * helmet of overlap. This leaves real air: a crowd pressed in from every side
 * settles a little tighter than the radius asks for.
 */
const SEPARATION = 1.15;
/** Touching distance: a shade over the helmet, which is the widest thing they wear. */
const CONTACT = 1;
/**
 * How close an idler has to get to the spot it wandered at before it calls
 * that arriving, and how briskly it ambles there.
 *
 * Both exist to keep a drifting agent's speed ABOVE the threshold that puts it
 * in a walk clip for the whole leg. `walk` eases off as it closes, so stopping
 * at a generous radius is what stops the last stretch being a crawl -- and a
 * crawl is movement the standing clip cannot express, so it reads as an
 * astronaut gliding across the deck.
 */
const DRIFT_ARRIVE = 0.9;
const DRIFT_PACE = 0.55;
/**
 * How close to its site counts as arrived. Deliberately derived from
 * SEPARATION and larger than it: if an astronaut had to get closer than its
 * neighbours will let it, one standing on a busy spot could never finish
 * arriving, and would spend the rest of its life shoving at the crowd it was
 * trying to join.
 */
export const ARRIVE_RADIUS = SEPARATION + 0.45;
/** Paths computed per frame. Re-routing the whole crew takes a few frames, unnoticeably. */
const PATH_BUDGET = 6;

/**
 * The mannequin is authored 2.2 units tall. The colony wants a "little guy"
 * silhouette at the isometric rest distance, and the structures are sized
 * against one -- so the whole rig is scaled once, here, and every worn part
 * below is measured in the SCALED character's own units so the helmet does
 * not have to be re-tuned when this moves.
 */
export const CREW_SCALE = 0.56;

/** Where a badge hangs before the rig has said how tall an astronaut is. */
const HEAD_HEIGHT_NO_RIG = 1.0;

/** Fewer instance slots than this are never allocated: a tiny preset must not starve a roster. */
const MIN_CAPACITY = 64;

/** Screen-space hit radius for `pick`, in NDC units scaled by the aspect. */
const PICK_RADIUS = 0.075;

/**
 * Where the worn parts sit relative to the bone they hang off, in the
 * mannequin's own units -- the root transform carries CREW_SCALE, so
 * everything downstream of a bone is measured in the rig's space and stays
 * put if that scale is ever retuned.
 */
const P = {
  helmetR: 0.48,
  headUp: 0.46, // the head bone sits at the neck; the helmet centres above it
  packZ: -0.3,
  packUp: 0.06,
  // The antenna stands on the crown of the helmet rather than out of its side,
  // so it reads at the distance the colony is normally looked at instead of
  // turning into a loose speck.
  antX: 0.16,
  antY: 0.88,
  antZ: -0.05,
  tipX: 0.2,
  tipY: 1.14,
  lightZ: 0.26,
  lightY: 0.05,
  // The hammer, in the right hand's own frame. The hand bone's own +Y runs
  // back down the forearm, so the shaft is turned through half a circle to
  // stand the head up out of the fist rather than hang it through the floor.
  gripX: 0,
  gripY: -0.04,
  gripZ: 0.02,
  gripRx: 0,
  gripRz: Math.PI,
} as const;

const PART_NAMES = ['helmet', 'visor', 'pack', 'antenna', 'tip', 'lamp', 'hammer', 'face'] as const;
type PartName = (typeof PART_NAMES)[number];
type Part = THREE.InstancedMesh<THREE.BufferGeometry, THREE.Material>;
type Parts = Record<PartName, Part>;
/** The parts with a silhouette worth a shadow; the glowing bits and the face have none. */
const CASTS_SHADOW: ReadonlySet<PartName> = new Set<PartName>(['helmet', 'pack', 'antenna', 'hammer']);
/** The glowing parts pulse every frame; the rest only re-upload when something moved slot. */
const ANIMATED: ReadonlySet<PartName> = new Set<PartName>(['tip', 'lamp']);

/** How many instance slots a settings value buys: floored, and capped by what any preset asks. */
function capacityFor(settings: Settings): number {
  return Math.max(MIN_CAPACITY, Math.min(MAX_AGENT_CAP, settings.get('maxAgents')));
}

export class Astronauts implements Layer {
  readonly object3d: THREE.Group;

  #settings: Settings;
  #unsubscribe: () => void;
  #faceTexture: THREE.Texture | null;
  #faceMaterial: THREE.MeshBasicMaterial;
  #agents: Crewman[] = [];
  #byId = new Map<string, Crewman>();
  #capacity = 0;
  #parts: Parts;
  #frameAttr: THREE.InstancedBufferAttribute;
  #frameData: Float32Array;
  #hoverRing: THREE.Mesh;
  #selectRing: THREE.Mesh;
  #selected: Crewman | null = null;

  #rig: CrewRig | null = null;
  #crew: THREE.InstancedMesh | null = null;
  #crewFrameAttr: THREE.InstancedBufferAttribute | null = null;
  #crewFrameData: Float32Array | null = null;
  #headSlot = 0;
  #chestSlot = 0;
  #handSlot = 0;
  #headHeight = HEAD_HEIGHT_NO_RIG;

  #nav: Navigation | null = null;
  #world: CrewWorld | null = null;
  /** Bumped by `groundMoved`: every agent samples its ground again on the next frame. */
  #groundEpoch = 0;
  #roster: readonly RosterEntry[] | null = null;
  #routeBudget = 0;
  #visibleCount = 0;

  // Reusable scratch: allocating inside the frame loop is what makes GC hitch.
  #m = new THREE.Matrix4();
  #m2 = new THREE.Matrix4();
  #m3 = new THREE.Matrix4();
  #m4 = new THREE.Matrix4();
  #q = new THREE.Quaternion();
  #e = new THREE.Euler();
  #v = new THREE.Vector3();
  #one = new THREE.Vector3(1, 1, 1);
  #color = new THREE.Color();
  #wp = new THREE.Vector3();
  #way: readonly THREE.Vector3[] = Array.from({ length: WAY_IN_POINTS }, () => new THREE.Vector3());
  #sep = new THREE.Vector3();
  #door = new THREE.Vector3();
  /** The `now` of the last update: the clock gestures are held against. */
  #clock = 0;
  /** Uniform bucket grid for the separation query, so it stays O(n) as the crew grows. */
  #buckets = new Map<number, Crewman[]>();

  constructor(settings: Settings, faceTexture: THREE.Texture | null) {
    this.#settings = settings;
    this.#faceTexture = faceTexture;
    this.object3d = new THREE.Group();
    this.object3d.name = 'astronauts';

    this.#faceMaterial = this.#makeFaceMaterial();
    const built = this.#buildMeshes(capacityFor(settings));
    this.#parts = built.parts;
    this.#frameAttr = built.frameAttr;
    this.#frameData = built.frameData;
    this.#applyShadowFlags();

    // Ground rings for hover + selection. Two ordinary meshes, moved around as needed.
    this.#hoverRing = ring(0.42, 0.5, 0x9fd8ff, 0.5);
    this.#selectRing = ring(0.5, 0.62, 0xffd28a, 0.9);
    this.#hoverRing.visible = false;
    this.#selectRing.visible = false;
    this.object3d.add(this.#hoverRing, this.#selectRing);

    this.#unsubscribe = settings.onChange((changed) => this.#onSettingsChanged(changed));
  }

  // -- construction -------------------------------------------------------------------

  #buildMeshes(capacity: number): { parts: Parts; frameAttr: THREE.InstancedBufferAttribute; frameData: Float32Array } {
    this.#capacity = capacity;

    // The suit is painted fabric-over-hardshell: fairly rough, not metallic,
    // but glossy enough on the helmet to catch a highlight off the environment map.
    const suit = (roughness: number, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial =>
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness, metalness: 0.04, ...extra });

    // Everything worn is measured off the helmet, so the suit stays in
    // proportion if the rig is ever scaled again.
    const R = P.helmetR;

    // Helmet shell.
    const helmetGeo = new THREE.SphereGeometry(R, 16, 11);
    const helmet = this.#mesh(helmetGeo, suit(0.26, { metalness: 0.03, envMapIntensity: 1.35 }), capacity);

    // Visor: a dark screen wrapped onto the helmet. The patch itself is a
    // rectangle in UV space, so its rounded silhouette is cut in the fragment
    // shader instead -- a squircle SDF, which gives soft corners a rectangular
    // patch can never have, and lets the white helmet show through where the
    // screen ends.
    const visorGeo = sphereCap(R * 1.032, 2.45, Math.PI * 0.62, 20, 14);
    const visor = this.#mesh(visorGeo, visorMaterial(), capacity);

    // Backpack + a life-support cylinder on each side.
    const packGeo = roundedBox(R * 0.89, R * 0.98, R * 0.55, R * 0.19);
    const pack = this.#mesh(packGeo, suit(0.66), capacity);

    const antGeo = new THREE.CylinderGeometry(R * 0.042, R * 0.053, R * 0.57, 4);
    antGeo.translate(0, R * 0.285, 0);
    const antenna = this.#mesh(antGeo, suit(0.24, { metalness: 0.95 }), capacity);

    // The blinking bits: antenna tip and chest lamp. Unlit and pushed past 1.0
    // so they are the things the bloom pass picks out at night.
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true });
    const tip = this.#mesh(new THREE.SphereGeometry(R * 0.125, 6, 4), glowMat, capacity);
    const lamp = this.#mesh(new THREE.SphereGeometry(R * 0.16, 6, 5), glowMat.clone(), capacity);

    // The hammer, held in the right hand while a session is running. Wood and
    // steel rather than suit white, so it reads as a tool at the distance the
    // colony is watched from.
    const hammer = this.#mesh(hammerGeometry(R), suit(0.62, { vertexColors: true }), capacity);

    // Face: the features only, drawn straight onto the visor beneath. Built as
    // a sphere cap a hair larger than the visor, so it lies exactly on the
    // curved surface instead of clipping through it -- a flat plane at this
    // radius sinks inside the sphere and the features disappear.
    const faceGeo = sphereCap(P.helmetR * 1.047, 1.72, 0.98, 16, 10);
    const face = this.#mesh(faceGeo, this.#faceMaterial, capacity);
    const frameData = new Float32Array(capacity * 2);
    const frameAttr = new THREE.InstancedBufferAttribute(frameData, 2);
    frameAttr.setUsage(THREE.DynamicDrawUsage);
    face.geometry.setAttribute('aFrame', frameAttr);

    const parts: Parts = { helmet, visor, pack, antenna, tip, lamp, hammer, face };
    for (const name of PART_NAMES) {
      const mesh = parts[name];
      mesh.name = name;
      mesh.frustumCulled = false; // one bounding volume for every agent everywhere is useless
      this.object3d.add(mesh);
    }
    return { parts, frameAttr, frameData };
  }

  /**
   * Hand over the baked crew rig and build the body mesh.
   *
   * Split out from the constructor because the rig is loaded: the colony is
   * built before boot has finished loading, and until this lands the crew is
   * helmets and backpacks with nothing between them -- which is fine, because
   * no agent exists until the first roster arrives, and that comes after.
   */
  setRig(rig: CrewRig): void {
    if (this.#rig === rig) return;
    this.#rig = rig;
    this.#disposeCrew();

    const geo = rig.geometry.clone();
    const frames = new Float32Array(this.#capacity);
    const frameAttr = new THREE.InstancedBufferAttribute(frames, 1);
    frameAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aFrame', frameAttr);
    this.#crewFrameAttr = frameAttr;
    this.#crewFrameData = frames;

    // One uniform block for the surface and the shadow pass, the same as the structures do.
    const uniforms: Record<string, THREE.IUniform> = {
      uBones: { value: rig.boneTexture },
      uFrameMax: { value: rig.frameCount - 1 },
    };

    const material = decorateSkinned(
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.68, metalness: 0.04 }),
      uniforms,
    );

    const mesh = new THREE.InstancedMesh(geo, material, this.#capacity);
    mesh.name = 'crew';
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < this.#capacity; i++) mesh.setColorAt(i, white);
    mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);

    const depth = decorateSkinned(
      new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }),
      uniforms,
      { normals: false },
    );
    mesh.customDepthMaterial = depth;

    this.#crew = mesh;
    this.object3d.add(mesh);
    this.#applyShadowFlags();

    // Bones anything worn hangs off. Read back per frame from the same baked
    // table the shader samples, so a helmet is never a frame out of step with
    // the head under it.
    this.#headSlot = rig.attachSlot.get('head') ?? 0;
    this.#chestSlot = rig.attachSlot.get('chest') ?? 0;
    this.#handSlot = rig.attachSlot.get('hand.r') ?? 0;

    // Where the helmet sits above the ground at rest, in world units. The
    // picker and the badges aim here rather than at the feet, so a click lands
    // on the part of an astronaut you are looking at -- and reading it off the
    // rig means it follows CREW_SCALE without a second constant.
    const restHeadY = rig.attach[this.#headSlot * 16 + 13] ?? 0;
    this.#headHeight = (restHeadY + P.headUp) * CREW_SCALE;
  }

  #disposeCrew(): void {
    const crew = this.#crew;
    if (!crew) return;
    this.object3d.remove(crew);
    crew.geometry.dispose();
    disposeMaterial(crew.material);
    crew.customDepthMaterial?.dispose();
    crew.dispose();
    this.#crew = null;
    this.#crewFrameAttr = null;
    this.#crewFrameData = null;
  }

  #mesh(geo: THREE.BufferGeometry, mat: THREE.Material, count: number): Part {
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Force USE_INSTANCING_COLOR on every part so tinting is available without a recompile.
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < count; i++) mesh.setColorAt(i, white);
    mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
    return mesh;
  }

  /**
   * The face material. The atlas is a mask, so the shader ignores the sampled
   * colour entirely: the red channel becomes ALPHA and the instance's own
   * colour becomes the glow, which is how every astronaut gets a different eye
   * colour from one shared texture.
   *
   * The dark panel behind the features is the VISOR, which is a rounded shape
   * cut by an SDF. This cap used to paint its own dark background as well, and
   * because the cap is a rectangle that second background showed as a
   * rectangle sitting on the rounded one -- two panels, the corners of the
   * upper one clipping out of the lower. Carrying alpha in the mask instead
   * means the only thing this draws is the features themselves, so the visor's
   * own silhouette is the only edge there is.
   *
   * `depthWrite` is off because this is transparent now: with it on, the cap
   * would write depth across its whole rectangle and punch a hole in anything
   * drawn behind it later.
   */
  #makeFaceMaterial(): THREE.MeshBasicMaterial {
    const mat = new THREE.MeshBasicMaterial({
      map: this.#faceTexture,
      toneMapped: true,
      transparent: true,
      depthWrite: false,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms['uFrameScale'] = { value: new THREE.Vector2(1 / FRAME_COLS, 1 / FRAME_ROWS) };
      shader.uniforms['uGlow'] = { value: 1.85 };

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec2 aFrame;
           uniform vec2 uFrameScale;`,
        )
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
           vMapUv = uv * uFrameScale + aFrame;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uGlow;`,
        )
        .replace(
          '#include <map_fragment>',
          `float mask = texture2D( map, vMapUv ).r;
           // The mask is drawn from paths, so its edges are already antialiased:
           // taking alpha straight from it is what gives the features soft edges
           // against the helmet without a single extra sample.
           diffuseColor.rgb = vColor.rgb * uGlow;
           diffuseColor.a = mask;`,
        )
        // vColor is the glow source above, so the usual instance-colour multiply must go.
        .replace('#include <color_fragment>', '');
    };
    return mat;
  }

  #applyShadowFlags(): void {
    const on = this.#settings.shadowSize > 0;
    for (const name of PART_NAMES) this.#parts[name].castShadow = on && CASTS_SHADOW.has(name);
    // The body is the shadow that matters: it is the whole silhouette.
    if (this.#crew) this.#crew.castShadow = on;
  }

  /**
   * Swap the face atlas. The atlas is a canvas, so the colony builds it (and
   * rebuilds it when the texture quality changes) and hands it over; whoever
   * built it disposes it.
   */
  setFaceTexture(tex: THREE.Texture | null): void {
    this.#faceTexture = tex;
    this.#faceMaterial.map = tex;
    this.#faceMaterial.needsUpdate = true;
  }

  get faceTexture(): THREE.Texture | null {
    return this.#faceTexture;
  }

  /** The colony hands over the navigation grid once it has been built. */
  setNavigation(nav: Navigation): void {
    this.#nav = nav;
  }

  /**
   * The ground moved where nobody walked: a stack gained or lost a deck.
   *
   * The crew samples the ground only after moving, because most of it is
   * parked at a site. Seen on the colony: a stack pushed up four decks, and
   * everybody working on it stood where the old top had been, buried to the
   * chest in the new plates until they happened to take a step.
   */
  groundMoved(): void {
    this.#groundEpoch++;
  }

  #onSettingsChanged(changed: ReadonlySet<SettingKey>): void {
    if (changed.has('shadows')) this.#applyShadowFlags();
    if (changed.has('maxAgents')) {
      // The instanced buffers are sized at build time, so a bigger roster needs new ones.
      const wanted = capacityFor(this.#settings);
      if (wanted !== this.#capacity) this.#rebuild(wanted);
      if (this.#roster && this.#world) this.setRoster(this.#roster, this.#world);
    }
  }

  #rebuild(capacity: number): void {
    const rig = this.#rig;
    this.#disposeCrew();
    for (const name of PART_NAMES) {
      const mesh = this.#parts[name];
      this.object3d.remove(mesh);
      mesh.geometry.dispose();
      // The face material carries the shared atlas and is reused as is.
      if (name !== 'face') disposeMaterial(mesh.material);
      mesh.dispose();
    }
    const built = this.#buildMeshes(capacity);
    this.#parts = built.parts;
    this.#frameAttr = built.frameAttr;
    this.#frameData = built.frameData;
    this.#applyShadowFlags();
    this.#rig = null;
    if (rig) this.setRig(rig);
    for (const agent of this.#agents) {
      agent.index = -1;
      agent.colorDirty = true;
    }
  }

  // -- roster -------------------------------------------------------------------------

  get agents(): readonly Agent[] {
    return this.#agents;
  }

  get byId(): ReadonlyMap<string, Agent> {
    return this.#byId;
  }

  /** How many instances were written on the last frame. */
  get visibleCount(): number {
    return this.#visibleCount;
  }

  /** How many instance slots the buffers hold right now. */
  get capacity(): number {
    return this.#capacity;
  }

  /** The head of a session, kept live: the same vector object every time, never a copy. */
  headOf(id: string): THREE.Vector3 | null {
    return this.#byId.get(id)?.head ?? null;
  }

  /**
   * Reconcile the live agents against the current session list: spawn
   * newcomers at the ship, update the ones that are still here, and send
   * anything that vanished home rather than deleting it out from under the
   * viewer. Returns how many agents are on the map, the ones walking home included.
   */
  setRoster(entries: readonly RosterEntry[], world: CrewWorld): number {
    this.#roster = entries;
    this.#world = world;
    const cap = Math.min(this.#capacity, this.#settings.get('maxAgents'));
    // Agents on their way back to the ship still hold a slot, so the roster has
    // to leave room for them. Without this the clamp above would quietly drop
    // whoever sorted last, which is better than an empty planet but still not
    // what the scan said.
    let leaving = 0;
    for (const a of this.#agents) if (a.state === 'leaving' || a.state === 'boarding') leaving++;
    const wanted = entries.slice(0, Math.max(1, cap - leaving));
    const seen = new Set<string>();

    // The ramp is one door and the ship is a solid obstacle around it, so an
    // entrance is a queue. A handful arriving together is the shot the colony
    // is for; a hundred is a scrum that shoves its own members into the ship's
    // footprint, where they give up, sit down and become the obstacle for
    // everybody behind them. Past this many, the rest are simply already
    // outside -- which is what a session the colony has seen before is anyway.
    let entrances = MAX_ENTRANCE;
    for (const entry of wanted) {
      seen.add(entry.id);
      const existing = this.#byId.get(entry.id);
      if (existing) {
        this.#updateAgent(existing, entry);
        continue;
      }
      // Someone with a door of their own does not queue at the ship's.
      const walksOut = !entry.known && (entry.home ? true : entrances > 0);
      if (walksOut && !entry.home) entrances--;
      this.#spawnAgent(entry, walksOut, world);
    }

    for (const agent of this.#agents) {
      if (!seen.has(agent.id) && agent.state !== 'leaving') this.#sendHome(agent);
    }
    return this.#agents.length;
  }

  #spawnAgent(entry: RosterEntry, walksOut: boolean, world: CrewWorld): Crewman {
    const rnd = mulberry32(entry.seed);
    const home = entry.home ?? null;
    const door = home ? this.#door.set(home.x, home.y, home.z) : world.shipDoor(this.#door);
    // A home is a spot picked clear of the wall it comes out of: scattering
    // round it the way the ramp's crowd scatters would put it inside that wall.
    // A seat is a spot too, and a hand-moved one starts where it was put.
    const exact = entry.seated === true || entry.driven === true;
    const spread = exact ? 0 : home ? 0.2 : 1.4;
    const jitter = (): number => (rnd() - 0.5) * spread;
    // Straight onto its plot, a pace off the exact spot so a zone's crew does
    // not appear in a stack. The nav grid sorts out anything that lands on a structure.
    const site = entry.site;
    const start = walksOut
      ? new THREE.Vector3(door.x + jitter(), 0, door.z + jitter())
      : new THREE.Vector3(site.x + jitter(), 0, site.z + jitter());

    const agent: Crewman = {
      id: entry.id,
      provider: entry.provider,
      status: entry.status,
      rosterStatus: entry.status,
      cheerLeft: 0,
      gestures: restingGesture(),
      gesture: 'hammer',
      size: sizeOf(entry),
      home: home ? new THREE.Vector3(home.x, home.y, home.z) : null,
      seated: entry.seated === true,
      driven: entry.driven === true,
      hidden: entry.hidden === true,
      ownTrim: entry.trim ?? null,
      cueLeft: 0,
      cueClip: null,
      cueFace: null,
      rnd,
      site: new THREE.Vector3(site.x, site.y, site.z),
      anchor: entry.anchor ? new THREE.Vector3(entry.anchor.x, entry.anchor.y, entry.anchor.z) : null,
      workSpot: new THREE.Vector3(),
      workAt: 0,
      pos: start,
      head: new THREE.Vector3(start.x, start.y + this.#headHeight, start.z),
      vel: new THREE.Vector3(),
      yaw: rnd() * Math.PI * 2,
      targetYaw: 0,
      speed: WALK_SPEED * (0.86 + rnd() * 0.28),
      phase: rnd() * Math.PI * 2,
      // An astronaut already outside does not play the entrance; it is just there.
      state: walksOut ? 'spawning' : 'walking',
      stateAge: 0,
      // Every astronaut runs its own clocks so a crowd never blinks in unison.
      blinkAt: 1 + rnd() * 4,
      faceFrame: FACE.boot,
      // Its own clock for the face too, started part way through and running
      // at its own pace: two agents that share a status share a loop, and
      // stepping it together is what makes them read as one thing.
      //
      // Off the seed rather than off `rnd`, which is also the path's dice: a
      // draw taken here moves every wander target after it, and two sessions
      // ending together then came up the ramp 0.87 apart where the test that
      // defends single file wants 0.9.
      faceTimer: fromSeed(entry.seed, 5) * 0.55,
      facePace: 0.75 + fromSeed(entry.seed, 15) * 0.6,
      faceIndex: Math.floor(rnd() * 16),
      loop: null,
      suit: SUIT_TONES[(entry.seed >>> 3) % SUIT_TONES.length] ?? 0xffffff,
      eye: new THREE.Color(1, 1, 1),
      trim: new THREE.Color(0xffffff),
      hop: 0,
      groundSampled: false,
      groundAt: 0,
      groundY: 0,
      groundX: 0,
      groundZ: 0,
      groundEpoch: this.#groundEpoch,
      groundSpeed: 0,
      blocked: false,
      driftBlocked: false,
      // Animation state: which baked clip, how far into it, and the row of the
      // bone table that lands on. Started at a random offset so a crowd never
      // marches in step.
      clipKey: walksOut ? 'spawn' : 'idle',
      clipTime: rnd() * 0.6,
      frame: 0,
      workPhase: -1,
      workSwing: false,
      wander: new THREE.Vector3(),
      wanderAt: 0,
      scale: walksOut ? 0 : 1, // pops up out of the ship, or was already standing there
      path: null,
      pathAt: 0,
      pathVersion: -1,
      pathGoal: new THREE.Vector3(NaN, 0, NaN),
      stall: 0,
      stillAt: start.clone(),
      stillSince: 0,
      wayAt: 0,
      wayFrom: new THREE.Vector3(),
      wayLeft: 0,
      colorDirty: true,
      index: -1,
      walkAmp: 0,
    };
    // Seated already turned to its desk: the first thing you would see on
    // coming in was the CEO swivelling round from wherever its dice pointed.
    if (agent.seated && agent.anchor) {
      agent.yaw = Math.atan2(agent.anchor.x - site.x, agent.anchor.z - site.z);
      agent.targetYaw = agent.yaw;
    }
    this.#applyTrim(agent);
    this.#applyStatus(agent, entry.status);
    this.#agents.push(agent);
    this.#byId.set(agent.id, agent);
    return agent;
  }

  #updateAgent(agent: Crewman, entry: RosterEntry): void {
    const wasSeated = agent.seated;
    agent.seated = entry.seated === true;
    agent.driven = entry.driven === true;
    agent.hidden = entry.hidden === true;
    // Sitting down picks a face loop of its own, and a status that has not
    // changed would otherwise never ask for one.
    if (agent.seated !== wasSeated) this.#applyStatus(agent, agent.rosterStatus);
    if ((entry.trim ?? null) !== agent.ownTrim) {
      agent.ownTrim = entry.trim ?? null;
      this.#applyTrim(agent);
    }
    // Where a hand-moved one stands is `place`'s to say: a roster written a
    // moment earlier would pull it back to where it was then.
    const moved = !agent.driven && Math.hypot(entry.site.x - agent.site.x, entry.site.z - agent.site.z) > 0.05;
    if (!agent.driven) agent.site.set(entry.site.x, entry.site.y, entry.site.z);
    // A site that has moved is a site to walk to. This matters most for an
    // astronaut that gave up on an unreachable one and adopted the ground it
    // was standing on: the next scan hands the real site back, and without
    // this it would stand there for good, parked in the middle of somebody
    // else's zone.
    const away = Math.hypot(agent.site.x - agent.pos.x, agent.site.z - agent.pos.z);
    if (moved && agent.state === 'at-site' && away > ARRIVE_RADIUS) {
      agent.state = 'walking';
      agent.stateAge = 0;
      agent.pathVersion = -1;
    }
    if (entry.anchor) {
      (agent.anchor ??= new THREE.Vector3()).set(entry.anchor.x, entry.anchor.y, entry.anchor.z);
    }
    if (entry.home) (agent.home ??= new THREE.Vector3()).set(entry.home.x, entry.home.y, entry.home.z);
    agent.size = sizeOf(entry);
    if (entry.provider !== agent.provider) {
      agent.provider = entry.provider;
      this.#applyTrim(agent);
    }
    if (entry.status !== agent.rosterStatus) {
      agent.rosterStatus = entry.status;
      // A celebration in progress is not interrupted: the new status takes over when it ends.
      if (agent.cheerLeft <= 0) this.#applyStatus(agent, entry.status);
    }
  }

  /** The trim says which tool works here, the same colour as its structure and its lamp. */
  #applyTrim(agent: Crewman): void {
    agent.trim.setHex(agent.ownTrim ?? PROVIDER_COLOR[agent.provider]);
    agent.colorDirty = true;
  }

  /** Status change -> new behaviour, new eye colour, new face loop. */
  #applyStatus(agent: Crewman, status: AgentStatus): void {
    const look = AGENT_LOOK[status];
    agent.status = status;
    agent.eye.setRGB(look.eye[0], look.eye[1], look.eye[2]);
    agent.loop = STATUS_LOOP[status] ?? (agent.seated ? DESK_IDLE : null);
    agent.colorDirty = true;

    // One on the ramp keeps going in: taken off the rails it would be
    // standing inside the hull, where the grid has solid ship.
    if (agent.state === 'boarding') return;
    // A spawning agent keeps walking out of the ship; everyone else re-targets at once.
    if (agent.state !== 'spawning') agent.state = 'walking';
    agent.stateAge = 0;
    agent.pathVersion = -1;
  }

  /**
   * A commit landed: cheer for this long, then go back to whatever the roster
   * says. Ignored for an astronaut already on its way home.
   */
  celebrate(id: string, seconds: number): void {
    const agent = this.#byId.get(id);
    if (!agent || agent.state === 'leaving' || agent.state === 'boarding' || agent.state === 'gone') return;
    agent.cheerLeft = Math.max(agent.cheerLeft, seconds);
    if (agent.status !== 'celebrating') this.#applyStatus(agent, 'celebrating');
  }

  /**
   * What the hands should be doing while this astronaut works. Held for a
   * few seconds before the next one may replace it (see `gestures.ts`).
   */
  setGesture(id: string, gesture: Gesture): void {
    const agent = this.#byId.get(id);
    if (!agent) return;
    requestGesture(agent.gestures, gesture, this.#clock);
    agent.gesture = agent.gestures.current;
  }

  /**
   * Play a cue: stop where it stands and do it, then carry on. Ignored for an
   * astronaut still coming out, already going home, or not standing yet.
   */
  cue(id: string, cue: Cue): void {
    const agent = this.#byId.get(id);
    if (!agent || agent.scale < 0.5) return;
    if (agent.state !== 'at-site' && agent.state !== 'walking') return;
    const spec = CUES[cue];
    const clip = this.#rig?.clips[spec.clip];
    agent.cueClip = spec.clip;
    // A one-shot lasts as long as it was authored; a loop as long as the cue says.
    agent.cueLeft = clip && !clip.loop ? clip.duration : spec.seconds;
    agent.cueFace = null;
    if (cue === 'heed' && this.#world && !agent.home) {
      agent.cueFace = this.#world.shipDoor(new THREE.Vector3());
    }
  }

  /** Close enough to the ramp that standing still there is in somebody's way. */
  #nearDoor(pos: THREE.Vector3): boolean {
    const world = this.#world;
    if (!world) return false;
    const door = world.shipDoor(this.#door);
    const dx = pos.x - door.x;
    const dz = pos.z - door.z;
    return dx * dx + dz * dz < DOORWAY_CLEAR * DOORWAY_CLEAR;
  }

  #sendHome(agent: Crewman): void {
    if (agent.state === 'leaving' || agent.state === 'boarding' || agent.state === 'gone') return;
    agent.state = 'leaving';
    agent.stateAge = 0;
    agent.loop = null;
    agent.faceFrame = FACE.wink;
    agent.pathVersion = -1;
    agent.cueLeft = 0;
    agent.cueClip = null;
    agent.cueFace = null;
    if (agent.home) {
      agent.site.copy(agent.home);
      return;
    }
    const world = this.#world;
    if (world) agent.site.copy(world.shipDoor(this.#door));
  }

  remove(id: string): void {
    const agent = this.#byId.get(id);
    if (agent) this.#sendHome(agent);
  }

  /**
   * Put a hand-moved astronaut here, turned to `yaw` (null keeps its heading).
   * It covers the distance on the next update, which is what the clip reads:
   * a step from the keyboard walks, standing still stands. `jump` puts it
   * there now instead, so arriving at the door is not read as a sprint across
   * the room. Ignored for anyone the roster did not mark `driven`.
   */
  place(id: string, x: number, z: number, yaw: number | null, jump = false): void {
    const agent = this.#byId.get(id);
    if (!agent || !agent.driven) return;
    agent.site.set(x, 0, z);
    if (yaw !== null) agent.targetYaw = yaw;
    if (!jump) return;
    agent.pos.x = x;
    agent.pos.z = z;
    agent.groundSpeed = 0;
    agent.walkAmp = 0;
    if (yaw !== null) agent.yaw = yaw;
  }

  // -- per-frame simulation -----------------------------------------------------------

  update(dt: number, now: number): void {
    const anim = this.#settings.get('reducedMotion') ? 0.35 : 1;
    this.#clock = now;

    this.#rebuildBuckets();
    this.#routeBudget = PATH_BUDGET;

    for (let i = this.#agents.length - 1; i >= 0; i--) {
      const agent = this.#agents[i];
      if (!agent) continue;
      agent.stateAge += dt;
      if (agent.cheerLeft > 0) {
        agent.cheerLeft -= dt;
        if (agent.cheerLeft <= 0) {
          agent.cheerLeft = 0;
          if (agent.state !== 'leaving' && agent.state !== 'boarding') this.#applyStatus(agent, agent.rosterStatus);
        }
      }
      if (agent.cueLeft > 0) {
        agent.cueLeft -= dt;
        if (agent.cueLeft <= 0) {
          agent.cueLeft = 0;
          agent.cueClip = null;
          agent.cueFace = null;
        }
      }
      if (settleGesture(agent.gestures, now)) agent.gesture = agent.gestures.current;
      this.#step(agent, dt, now, anim);
      this.#animate(agent, dt, anim);
      this.#face(agent, dt);
      agent.head.set(agent.pos.x, agent.pos.y + this.#headHeight * agent.size, agent.pos.z);

      if (agent.state === 'gone') {
        this.#agents.splice(i, 1);
        this.#byId.delete(agent.id);
        if (this.#selected === agent) this.setSelected(null);
      }
    }

    this.#writeMatrices(now);
    this.#updateRings(now);
  }

  /**
   * Make sure the agent has a usable route, and hand back the point it should
   * steer at. Falls back to the goal itself when there is no path -- an
   * astronaut heading vaguely the right way and sliding along walls beats one
   * standing still because A* gave up.
   */
  #steerTarget(agent: Crewman, out: THREE.Vector3): THREE.Vector3 {
    const nav = this.#nav;
    if (!nav) return out.copy(agent.site);

    const stale = agent.pathVersion !== nav.version || agent.pathGoal.distanceToSquared(agent.site) > 0.25;
    if (stale && this.#routeBudget > 0) {
      this.#routeBudget--;
      agent.path = nav.findPath(agent.pos.x, agent.pos.z, agent.site.x, agent.site.z);
      agent.pathAt = 0;
      agent.pathVersion = nav.version;
      agent.pathGoal.copy(agent.site);
    }

    const path = agent.path;
    if (!path || !path.length) return out.copy(agent.site);

    // Retire a waypoint once it is reached AND the leg after it is in sight.
    // Reached alone was the rule, and a route round the end of a wall -- the
    // foot of a ramp's rail -- has its corner reached from the wrong side of
    // that wall: steering at the next leg from there pinned the astronaut
    // against the wall's end, `slide` giving it a millimetre a frame so it
    // never counted as blocked, until it gave up and took the dirt as its
    // site. Measured before the fix: 88 of 324 arrivals left at the foot.
    while (agent.pathAt < path.length - 1) {
      const wp = path[agent.pathAt];
      const next = path[agent.pathAt + 1];
      if (!wp || !next) break;
      const dx = wp.x - agent.pos.x;
      const dz = wp.z - agent.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > WAYPOINT_REACHED * WAYPOINT_REACHED) break;
      if (d2 > WAYPOINT_AT * WAYPOINT_AT && !nav.lineOfSight(agent.pos.x, agent.pos.z, next.x, next.z)) break;
      agent.pathAt++;
    }
    const wp = path[agent.pathAt];
    if (!wp) return out.copy(agent.site);
    return out.set(wp.x, 0, wp.z);
  }

  #step(agent: Crewman, dt: number, now: number, anim: number): void {
    const fromX = agent.pos.x;
    const fromZ = agent.pos.z;
    agent.blocked = false;
    // Distance is always measured to the real goal; steering follows the route to it.
    const steer = this.#steerTarget(agent, this.#wp);
    const toSite = this.#v.set(steer.x - agent.pos.x, 0, steer.z - agent.pos.z);
    const dist = Math.hypot(agent.site.x - agent.pos.x, agent.site.z - agent.pos.z);

    // A cue stops it where it stands. Only the walk is paused: the arrival
    // and the status behind it pick up again the moment the cue ends.
    const cued = agent.cueLeft > 0 && (agent.state === 'at-site' || agent.state === 'walking');
    // Hand-moved: it is where `place` put it, and nothing here argues. Going
    // home is still the crew's, so a roster that drops it is not ignored.
    const held = agent.driven && (agent.state === 'at-site' || agent.state === 'walking' || agent.state === 'spawning');
    if (held) {
      agent.pos.x = agent.site.x;
      agent.pos.z = agent.site.z;
      agent.vel.set(0, 0, 0);
      agent.scale = Math.min(1, agent.scale + dt * 3);
    } else if (cued) {
      agent.vel.set(0, 0, 0);
      if (agent.cueFace) this.#faceToward(agent, agent.cueFace);
      this.#settle(agent, dt);
    } else switch (agent.state) {
      case 'spawning': {
        agent.scale = Math.min(1, agent.scale + dt * 2.6);
        if (agent.stateAge > 0.9) agent.state = 'walking';
        this.#walk(agent, toSite, dist, dt, 0.55);
        break;
      }

      case 'walking': {
        agent.scale = Math.min(1, agent.scale + dt * 3);
        this.#walk(agent, toSite, dist, dt, 1);
        // Close enough -- settle into whatever this session is actually doing.
        // Or close enough to GIVE UP: a site that something was built on top
        // of between polls can never be reached, and an astronaut shouldering
        // a wall forever is worse than one standing a little short of where
        // it meant to be. It adopts the spot it got to, and the next poll
        // hands it a site that has been checked against the grid.
        const stuck = this.#stuck(agent);
        if (dist < ARRIVE_RADIUS || stuck) {
          // Adopting the ground it reached is right for a site something got
          // built on top of. It is exactly wrong next to the ship: an
          // astronaut still shouldering its way out of the doorway would
          // claim the doorway, and the queue behind it inherits a permanent
          // wall. Out there it keeps its real site and tries again, which the
          // crowd thinning out is usually enough to fix.
          const inDoorway = this.#nearDoor(agent.pos);
          if (stuck && dist >= ARRIVE_RADIUS && !inDoorway) agent.site.copy(agent.pos);
          if (stuck && inDoorway) {
            agent.stateAge = 0;
            agent.pathVersion = -1;
            break;
          }
          agent.state = 'at-site';
          agent.stateAge = 0;
        }
        break;
      }

      case 'at-site': {
        if (agent.seated) {
          // On its seat and nowhere else: not shoved by anyone walking up to
          // the desk, and never off pottering round the room because the
          // status says idle.
          agent.pos.x = agent.site.x;
          agent.pos.z = agent.site.z;
          agent.vel.set(0, 0, 0);
          this.#faceToward(agent, agent.anchor ?? agent.site);
        } else if (agent.status === 'idle') {
          // Idlers potter around their plot, and `drift` owns their velocity outright.
          this.#drift(agent, dt, now);
        } else if (agent.status === 'working' && agent.anchor) {
          this.#workRound(agent, dt, now, agent.anchor);
        } else {
          // Everybody else has arrived and stays: a session that has gone
          // quiet has sat down on the floor, one that is working is at its
          // structure. Velocity is zeroed rather than eased down, because
          // nothing here moves the agent any more -- a decaying velocity is a
          // number only the animation reads, and what it says is "still
          // walking" for a third of a second after the astronaut has visibly
          // stopped.
          agent.vel.set(0, 0, 0);
          if (agent.status !== 'sleeping') this.#faceToward(agent, agent.site);
          this.#settle(agent, dt);
        }
        this.#sitePose(agent, dt, anim);
        break;
      }

      case 'leaving': {
        // A habitat door is a hole in a wall at ground level: shrinking into
        // it reads as going in. The ship's door is the foot of a ramp.
        if (agent.home) agent.scale = Math.max(0, agent.scale - (dist < 1.4 ? dt * 2.2 : 0));
        this.#walk(agent, toSite, dist, dt, 1.15);
        // Giving up on ever reaching the door retires the agent, so a blocked
        // path can never leave a ghost walking forever. Given up on by the
        // same rule as the way out, not by a clock: 22 seconds of walking
        // home was the clock, and from a project in the outer ring the
        // astronaut vanished half way to the ship. Given up on in the
        // doorway, it goes in anyway: the way in is on rails from there.
        const stuck = this.#stuck(agent);
        if (!agent.home && (dist < BOARD_REACH || (stuck && this.#nearDoor(agent.pos)))) {
          this.#startBoarding(agent);
        } else if (agent.scale <= 0.001 || (agent.home && dist < 0.9 && agent.stateAge > 1.5) || stuck) {
          agent.state = 'gone';
        }
        break;
      }

      case 'boarding': {
        this.#board(agent, dt);
        break;
      }

      case 'gone':
        break;
    }

    // How fast the astronaut ACTUALLY travelled, not how fast it meant to. The
    // two come apart whenever something is in the way: velocity stays high
    // while the collision code refuses the step, and an agent driven off
    // intent alone walks on the spot against a wall.
    const moved = Math.hypot(agent.pos.x - fromX, agent.pos.z - fromZ) / Math.max(dt, 1e-4);
    // Asymmetric on purpose. Setting off is picked up on the very frame it
    // happens, so an astronaut is never sliding in a standing pose; stopping
    // decays over a tenth of a second, which both stops a half-blocked step
    // flickering the clip and lets the walk cycle finish its stride instead
    // of freezing mid-step.
    agent.groundSpeed = moved > agent.groundSpeed ? moved : THREE.MathUtils.damp(agent.groundSpeed, moved, 20, dt);
    agent.phase += dt * (2.2 + agent.groundSpeed * 3.4) * anim;
    agent.walkAmp = THREE.MathUtils.damp(agent.walkAmp, Math.min(1, agent.groundSpeed / WALK_SPEED), 8, dt);

    agent.yaw = angleDamp(agent.yaw, agent.targetYaw, TURN_RATE, dt);

    // Stand on the ground rather than on y=0. A zone's deck is a raised slab
    // and the terrain between zones rolls by half a metre either way, so a
    // crew pinned to zero is buried for half the colony. Sampled only when
    // the agent has actually moved -- most of the crew is parked at its site,
    // and the sample is a lookup plus a noise evaluation.
    // On the ramp the height comes from the way in, not from the ground.
    const world = this.#world;
    if (world && agent.state !== 'boarding') {
      const moved = Math.abs(agent.pos.x - agent.groundX) + Math.abs(agent.pos.z - agent.groundZ) > 0.2;
      const carried = agent.groundEpoch !== this.#groundEpoch;
      if (!agent.groundSampled || moved || carried) {
        agent.groundX = agent.pos.x;
        agent.groundZ = agent.pos.z;
        agent.groundAt = world.groundAt(agent.pos.x, agent.pos.z);
        agent.groundEpoch = this.#groundEpoch;
      }
      // Eased, so walking up onto a deck is a step rather than a teleport.
      // Snapped outright on the first frame, or a spawning astronaut rises
      // out of the floor; and snapped when the deck moved under a standing
      // astronaut, which is carried, not stepping -- eased, its boots sank
      // into the plate for the first frames of every push.
      const snap = !agent.groundSampled || (carried && !moved);
      agent.groundY = snap ? agent.groundAt : THREE.MathUtils.damp(agent.groundY, agent.groundAt, 14, dt);
      agent.groundSampled = true;
    }
    agent.pos.y = agent.groundY + agent.hop;
  }

  #startBoarding(agent: Crewman): void {
    agent.state = 'boarding';
    agent.stateAge = 0;
    agent.path = null;
    agent.vel.set(0, 0, 0);
    agent.wayAt = 0;
    agent.wayFrom.set(agent.pos.x, agent.groundY, agent.pos.z);
    this.#world?.shipWayIn(this.#way);
    agent.wayLeft = this.#wayLeft(agent);
  }

  /** How far is left of the way in: to the next point, then leg by leg to the end. */
  #wayLeft(agent: Crewman): number {
    const way = this.#way;
    const next = way[agent.wayAt];
    if (!next) return 0;
    let left = Math.hypot(next.x - agent.pos.x, next.z - agent.pos.z);
    for (let i = agent.wayAt + 1; i < way.length; i++) {
      const a = way[i - 1];
      const b = way[i];
      if (a && b) left += Math.hypot(b.x - a.x, b.z - a.z);
    }
    return left;
  }

  /**
   * Up the ramp and in through the hatch, on rails. The grid has the ship as
   * a solid disc, which is right for everyone walking past it and wrong for
   * the one going in, and the ramp is not ground `groundAt` knows: so the last
   * few metres are walked leg by leg along `shipWayIn`, height and all. The
   * height of a leg runs from where it began to where it ends, so the step
   * from the terrain onto the ramp's foot is a slope and never a jump.
   */
  #board(agent: Crewman, dt: number): void {
    const way = this.#way;
    this.#world?.shipWayIn(way);

    // Single file. Everyone boarding is compared on last frame's numbers,
    // which is all a gap of a metre needs.
    let hold = false;
    for (const other of this.#agents) {
      if (other === agent || other.state !== 'boarding') continue;
      if (other.wayLeft < agent.wayLeft && agent.wayLeft - other.wayLeft < RAMP_GAP) {
        hold = true;
        break;
      }
    }

    const next = way[agent.wayAt];
    if (!next) {
      agent.state = 'gone';
      return;
    }
    const dx = next.x - agent.pos.x;
    const dz = next.z - agent.pos.z;
    const leg = Math.hypot(dx, dz);
    const pace = agent.speed * CLIMB_PACE;
    const stride = hold ? 0 : Math.min(leg, pace * dt);
    if (leg > 1e-4) {
      agent.pos.x += (dx / leg) * stride;
      agent.pos.z += (dz / leg) * stride;
      agent.targetYaw = Math.atan2(dx, dz);
      agent.vel.set(hold ? 0 : (dx / leg) * pace, 0, hold ? 0 : (dz / leg) * pace);
    }
    const span = Math.hypot(next.x - agent.wayFrom.x, next.z - agent.wayFrom.z);
    const along = span > 1e-4 ? THREE.MathUtils.clamp(1 - (leg - stride) / span, 0, 1) : 1;
    agent.groundY = THREE.MathUtils.lerp(agent.wayFrom.y, next.y, along);

    if (leg - stride < 0.02) {
      agent.wayFrom.copy(next);
      agent.wayAt++;
    }
    agent.wayLeft = this.#wayLeft(agent);
    // Grown back rather than set: one sent home while still coming out is small.
    agent.scale = Math.min(1, agent.scale + dt * 3, agent.wayLeft / HATCH_FADE);
    if (agent.wayAt >= way.length || agent.wayLeft < 0.02) agent.state = 'gone';
  }

  /**
   * Whether a walk has got nowhere: not `STILL_REACH` from where it stood in
   * `STUCK_S`, or on its way for longer than any honest route. Called once a
   * frame by whatever is walking. The stretch of standing still restarts with
   * the state as well: `stateAge` going back to zero is every way into a walk.
   */
  #stuck(agent: Crewman): boolean {
    if (agent.stillSince > agent.stateAge || Math.hypot(agent.pos.x - agent.stillAt.x, agent.pos.z - agent.stillAt.z) > STILL_REACH) {
      agent.stillAt.copy(agent.pos);
      agent.stillSince = agent.stateAge;
    }
    return agent.stateAge - agent.stillSince > STUCK_S || agent.stateAge > WALK_LIMIT_S;
  }

  /**
   * `toTarget` points at the next waypoint; `goalDist` is how far the FINAL
   * goal still is. Slowing down uses the goal so an astronaut cruises through
   * intermediate corners and only eases as it actually arrives.
   */
  #walk(agent: Crewman, toTarget: THREE.Vector3, goalDist: number, dt: number, factor: number): void {
    const legDist = toTarget.length();
    if (legDist > 0.05) {
      const dir = toTarget.divideScalar(legDist);
      const want = agent.speed * factor * Math.min(1, goalDist / 1.8);
      agent.vel.x = THREE.MathUtils.damp(agent.vel.x, dir.x * want, 6, dt);
      agent.vel.z = THREE.MathUtils.damp(agent.vel.z, dir.z * want, 6, dt);
    }

    const push = this.#separation(agent, this.#sep);
    const dx = (agent.vel.x + push.x) * dt;
    const dz = (agent.vel.z + push.z) * dt;

    const nav = this.#nav;
    if (nav) {
      // Blocked head-on, the agent slides; a route that has gone stale can
      // never become a walk through a wall.
      const x0 = agent.pos.x;
      const z0 = agent.pos.z;
      if (!nav.slide(agent.pos, dx, dz)) {
        agent.vel.multiplyScalar(0.4);
        // Wedged against something the path did not know about: ask for a new one.
        agent.pathVersion = -1;
        agent.blocked = true;
      } else {
        // Moved, but how much of that along the step it asked for? Not
        // `blocked`: that is what gives up on a site, and this is a route to
        // fix, not a site to abandon.
        const asked = dx * dx + dz * dz;
        const gained = (agent.pos.x - x0) * dx + (agent.pos.z - z0) * dz;
        agent.stall = asked > 1e-8 && gained < asked * STALL_GAIN ? agent.stall + dt : 0;
        if (agent.stall > STALL_S) {
          agent.stall = 0;
          agent.pathVersion = -1;
        }
      }
    } else {
      agent.pos.x += dx;
      agent.pos.z += dz;
    }

    if (Math.hypot(agent.vel.x, agent.vel.z) > 0.05) {
      agent.targetYaw = Math.atan2(agent.vel.x, agent.vel.z);
    }
  }

  /** Bucket every agent by a coarse cell, so separation only ever looks at real neighbours. */
  #rebuildBuckets(): void {
    const buckets = this.#buckets;
    buckets.clear();
    for (const agent of this.#agents) {
      if (agent.state === 'gone' || agent.scale < 0.2) continue;
      const key = ((agent.pos.x / 2) | 0) * 10007 + ((agent.pos.z / 2) | 0);
      let list = buckets.get(key);
      if (!list) buckets.set(key, (list = []));
      list.push(agent);
    }
  }

  /** Is anybody already standing here? Same bucket grid the separation query walks. */
  #crowded(x: number, z: number, ignore: Crewman): boolean {
    const bx = (x / 2) | 0;
    const bz = (z / 2) | 0;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const list = this.#buckets.get((bx + ox) * 10007 + (bz + oz));
        if (!list) continue;
        for (const other of list) {
          if (other === ignore) continue;
          const dx = x - other.pos.x;
          const dz = z - other.pos.z;
          if (dx * dx + dz * dz < SEPARATION * SEPARATION) return true;
        }
      }
    }
    return false;
  }

  /** A soft shove away from anyone standing too close. */
  #separation(agent: Crewman, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    const buckets = this.#buckets;
    const bx = (agent.pos.x / 2) | 0;
    const bz = (agent.pos.z / 2) | 0;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const list = buckets.get((bx + ox) * 10007 + (bz + oz));
        if (!list) continue;
        for (const other of list) {
          if (other === agent) continue;
          const dx = agent.pos.x - other.pos.x;
          const dz = agent.pos.z - other.pos.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > SEPARATION * SEPARATION || d2 < 1e-6) continue;
          const d = Math.sqrt(d2);
          // Two regimes, because one is not enough. The gentle term ramps up
          // as they close so a crowd settles instead of oscillating -- but in
          // a press, half a dozen gentle pushes from every side cancel, and
          // the equilibrium lands INSIDE helmet width. So there is a second,
          // much firmer term that only exists at touching distance, where
          // being apart stops being cosmetic. Widening the gentle radius does
          // not fix that; it makes it worse, by adding more pushes to cancel.
          const strength = (1 - d / SEPARATION) * 1.2 + (d < CONTACT ? (1 - d / CONTACT) * 5 : 0);
          out.x += (dx / d) * strength;
          out.z += (dz / d) * strength;
        }
      }
    }
    return out;
  }

  /** A slow wander inside the plot, re-targeted every few seconds. */
  #drift(agent: Crewman, dt: number, now: number): void {
    if (now > agent.wanderAt) {
      agent.wanderAt = now + 3 + agent.rnd() * 5;
      // Stay put rather than walk at a wall -- or at somebody. A few
      // candidates and the first that is neither inside a structure nor on
      // top of a neighbour wins: separation can push a crowd apart, but it
      // cannot stop one forming if everybody keeps choosing to walk into the
      // same patch of ground.
      agent.wander.copy(agent.site);
      for (let i = 0; i < 4; i++) {
        const a = agent.rnd() * Math.PI * 2;
        const r = 0.8 + agent.rnd() * 2;
        const wx = agent.site.x + Math.cos(a) * r;
        const wz = agent.site.z + Math.sin(a) * r;
        if (this.#nav?.isBlocked(wx, wz)) continue;
        if (this.#crowded(wx, wz, agent)) continue;
        agent.wander.set(wx, 0, wz);
        break;
      }
      agent.driftBlocked = false;
    }
    const to = this.#v.set(agent.wander.x - agent.pos.x, 0, agent.wander.z - agent.pos.z);
    const d = to.length();
    if (d > DRIFT_ARRIVE && !agent.driftBlocked) {
      this.#walk(agent, to, d, dt, DRIFT_PACE);
      // A drift leg is a straight line at a spot only ever checked for being
      // INSIDE a wall, never for being reachable -- so it can run into the
      // side of a structure. Give the leg up at the first refused step rather
      // than shuffling against the wall until the next wander comes due,
      // which is several seconds of walking on the spot.
      if (agent.blocked) agent.driftBlocked = true;
      return;
    }
    // Arrived -- or the spot was never far enough away to be worth crossing.
    // Stop dead rather than easing down through the speeds no standing clip
    // can carry, and hold still until the next wander is due, only yielding
    // to anyone standing inside us.
    agent.vel.set(0, 0, 0);
    this.#settle(agent, dt);
  }

  /**
   * Push a seated agent out of anyone it has ended up inside, and do nothing else.
   *
   * Separation on its own converges: once no neighbour is within the radius
   * the push is zero and the agent is still. That is the whole difference
   * between resolving a pile-up and wandering. The push is applied to
   * position only, never to velocity, so a nudged sleeper does not read as
   * walking and stays in its sitting clip.
   */
  #settle(agent: Crewman, dt: number): void {
    const push = this.#separation(agent, this.#sep);
    if (push.x === 0 && push.z === 0) return;
    const dx = push.x * dt;
    const dz = push.z * dt;
    const nav = this.#nav;
    if (nav) nav.slide(agent.pos, dx, dz);
    else {
      agent.pos.x += dx;
      agent.pos.z += dz;
    }
  }

  /**
   * Working: walk round the structure and hammer at it from a different side
   * every so often.
   *
   * A session that is running is DOING something, and an astronaut welded to
   * one spot for an hour does not say that. Spots are picked on the ring the
   * roster put it on, so it never wanders off its own site, and it always
   * turns to face the thing it is hitting.
   */
  #workRound(agent: Crewman, dt: number, now: number, anchor: THREE.Vector3): void {
    if (now > agent.workAt) {
      agent.workAt = now + 5 + agent.rnd() * 7;
      const radius = Math.max(1.6, Math.hypot(agent.site.x - anchor.x, agent.site.z - anchor.z));
      // Somewhere else on the ring -- at least a third of the way round, so a
      // move is worth making rather than a shuffle on the spot.
      const from = Math.atan2(agent.pos.z - anchor.z, agent.pos.x - anchor.x);
      agent.workSpot.copy(agent.site);
      // Same rule as a drift: a spot on the ring that is walled off, or that
      // somebody else is already working from, is not a spot.
      for (let i = 0; i < 4; i++) {
        const a = from + (agent.rnd() > 0.5 ? 1 : -1) * (1.1 + agent.rnd() * 1.6);
        const wx = anchor.x + Math.cos(a) * radius;
        const wz = anchor.z + Math.sin(a) * radius;
        if (this.#nav?.isBlocked(wx, wz)) continue;
        if (this.#crowded(wx, wz, agent)) continue;
        agent.workSpot.set(wx, 0, wz);
        break;
      }
      agent.driftBlocked = false;
    }

    const to = this.#v.set(agent.workSpot.x - agent.pos.x, 0, agent.workSpot.z - agent.pos.z);
    const d = to.length();
    if (d > DRIFT_ARRIVE && !agent.driftBlocked) {
      this.#walk(agent, to, d, dt, DRIFT_PACE);
      if (agent.blocked) agent.driftBlocked = true;
      return;
    }
    // Arrived: stop dead, turn to the work, and swing.
    agent.vel.set(0, 0, 0);
    this.#faceToward(agent, anchor);
    this.#settle(agent, dt);
  }

  #faceToward(agent: Crewman, point: THREE.Vector3): void {
    // Stand a little back from the build site and look at it.
    const dx = point.x - agent.pos.x;
    const dz = point.z - agent.pos.z;
    if (Math.abs(dx) + Math.abs(dz) > 0.01) agent.targetYaw = Math.atan2(dx, dz);
  }

  /**
   * What each status adds on top of its clip, once the agent has arrived.
   *
   * Vertical motion used to live here -- a hop for celebrating, a slump for
   * blocked. The clips own all of that now, and a hand-written offset on top
   * of an authored one only ever fights it, so the only thing left is the
   * slow turn a celebrating agent does on the spot, which no single clip can
   * express.
   */
  #sitePose(agent: Crewman, dt: number, anim: number): void {
    agent.hop = 0;
    if (agent.status === 'celebrating') agent.targetYaw += dt * 1.4 * anim;
  }

  /** Pick this frame's face: a status loop, interrupted by the agent's own blink clock. */
  #face(agent: Crewman, dt: number): void {
    agent.faceTimer += dt;
    agent.blinkAt -= dt;

    if (agent.state === 'spawning' && agent.stateAge < 0.8) {
      agent.faceFrame = FACE.boot;
      return;
    }
    if (agent.state === 'leaving' || agent.state === 'boarding') {
      agent.faceFrame = agent.stateAge % 2 < 1.4 ? FACE.happy : FACE.wink;
      return;
    }
    // Blink beats everything except sleeping -- a sleeping agent's eyes are
    // already shut -- and blocked, whose eyes are crosses.
    if (agent.blinkAt <= 0 && agent.status !== 'sleeping' && agent.status !== 'blocked') {
      agent.faceFrame = FACE.blink;
      if (agent.blinkAt < -0.12) agent.blinkAt = 2.4 + agent.rnd() * 5;
      return;
    }

    const loop = agent.loop;
    if (!loop || !loop.length) {
      agent.faceFrame = FACE.idle;
      return;
    }
    const rate = (agent.status === 'working' ? 0.22 : 0.55) * agent.facePace;
    if (agent.faceTimer > rate) {
      agent.faceTimer = 0;
      agent.faceIndex = (agent.faceIndex + 1) % loop.length;
    }
    agent.faceFrame = loop[agent.faceIndex % loop.length] ?? FACE.idle;
  }

  // -- animation ----------------------------------------------------------------------

  /**
   * Choose the clip an agent should be playing and advance its clock.
   *
   * Locomotion wins over status: an idler pottering across its plot walks, it
   * does not hammer while sliding. Walk playback is driven by actual ground
   * speed so short steps cannot moonwalk -- the same rule the old hand-written
   * cycle followed, applied to a real one instead.
   */
  #animate(agent: Crewman, dt: number, anim: number): void {
    agent.workSwing = false;
    const rig = this.#rig;
    if (!rig) return;

    // Any real translation belongs in a walk clip. The threshold is low on
    // purpose: what it guards against is the reverse mistake, an agent
    // standing in an idle pose while the world slides past its feet, and the
    // movement code is what keeps it from dawdling just under the line.
    const speed = agent.groundSpeed;
    let key: ClipKey;
    if (agent.state === 'spawning') key = 'spawn';
    else if (agent.cueLeft > 0 && agent.cueClip) key = agent.cueClip;
    else if (speed > 0.12) key = speed > WALK_SPEED * 1.25 ? 'run' : 'walk';
    // Already in the chair when you come in: the loop, not the sitting down,
    // and the bake whose head does not swing away (see `HOLD_HEAD`).
    else if (agent.seated) key = 'sitDesk';
    else {
      switch (agent.status) {
        case 'working':
          key = GESTURE_CLIP[agent.gesture];
          break;
        case 'waiting':
          key = 'wave';
          break;
        case 'blocked':
          key = 'hit';
          break;
        case 'celebrating':
          key = 'cheer';
          break;
        // Sitting down is a one-shot that hands over to the loop when it
        // finishes, so an agent that has just nodded off lowers itself rather
        // than snapping into a sit.
        case 'sleeping':
          key = agent.clipKey === 'sit' ? 'sit' : 'sitDown';
          break;
        default:
          key = 'idle';
      }
    }

    const clip = rig.clips[key];

    if (key !== agent.clipKey) {
      agent.clipKey = key;
      // Everyone else starts a clip at its first frame: it is the pose the
      // thing that just happened ends on. A desk is the exception, because
      // two CEOs sit down on the same frame and then breathe as one body.
      agent.clipTime = key === 'sitDesk' ? agent.rnd() * clip.duration : 0;
      agent.workPhase = -1;
    }

    // Stride rate follows the ground, everything else runs at its authored speed.
    const rate = key === 'walk' || key === 'run' ? THREE.MathUtils.clamp(speed / WALK_SPEED, 0.4, 2.1) : 1;
    agent.clipTime += dt * anim * rate;

    if (key === 'sitDown' && agent.clipTime >= clip.duration) {
      agent.clipKey = 'sit';
      agent.clipTime = 0;
      agent.frame = frameFor(rig.clips.sit, 0);
      return;
    }
    agent.frame = frameFor(clip, agent.clipTime);

    // The hammer lands halfway round the cycle. The swing is the one frame the
    // phase crosses that point, so the colony throws sparks once per blow
    // however fast or slow the frames come.
    // The console clip has a downbeat of its own, and a shell command is
    // work that throws sparks too.
    if (key === 'work' || key === 'workAlt') {
      const phase = (agent.frame - clip.start) / Math.max(1, clip.frames - 1);
      const prev = agent.workPhase < 0 ? 0 : agent.workPhase;
      agent.workSwing = crossesDownbeat(prev, phase);
      agent.workPhase = phase;
    }
  }

  // -- writing the instance buffers ---------------------------------------------------

  #writeMatrices(now: number): void {
    const { helmet, visor, pack, antenna, tip, lamp, face, hammer } = this.#parts;
    const rig = this.#rig;
    const crew = this.#crew;
    const root = this.#m;
    const child = this.#m2;
    const bone = this.#m3;
    const worn = this.#m4;
    const q = this.#q;
    const e = this.#e;
    const v = this.#v;
    const one = this.#one;
    const frames = this.#frameData;
    const crewFrames = this.#crewFrameData;

    let i = 0;
    let hands = 0;
    let staticDirty = false;
    for (const agent of this.#agents) {
      // Never write past the end of the instance buffers. Going over is not a
      // rendering artefact you can squint past: WebGL refuses the whole
      // `drawElementsInstanced` call, so one agent too many takes EVERY
      // astronaut off screen at once.
      //
      // It can go over. `setRoster` caps how many agents it will spawn, but an
      // agent that has left the roster stays in this list while it walks back
      // to the ship -- and the slot it vacated in the roster is immediately
      // filled by a session that was previously past the cap. Drop one session
      // on a colony sitting at the cap and there is briefly one more agent than
      // there are slots, which is exactly when the colony would empty.
      if (i >= this.#capacity) break;
      if (agent.state === 'gone' || agent.hidden) continue;
      const s = agent.scale;
      if (s <= 0.001) continue;

      // Root transform for the whole character. The rig is authored at 2.2
      // units tall, so CREW_SCALE rides along here and everything downstream
      // inherits it.
      e.set(0, agent.yaw, 0);
      q.setFromEuler(e);
      v.set(agent.pos.x, agent.pos.y, agent.pos.z);
      root.compose(v, q, one.setScalar(s * CREW_SCALE * agent.size));
      one.setScalar(1);

      if (crew && crewFrames) {
        crew.setMatrixAt(i, root);
        crewFrames[i] = agent.frame;
      }

      // Everything worn hangs off a bone at the frame the body is actually on,
      // so a helmet cannot drift off a head that is looking down or lying on
      // the ground.
      if (rig) {
        attachMatrixAt(rig, agent.frame, this.#headSlot, bone);
        worn.multiplyMatrices(root, bone);
        setPart(child, worn, helmet, i, 0, P.headUp, 0, 0, 0, 0);
        setPart(child, worn, visor, i, 0, P.headUp, 0, 0, 0, 0);
        setPart(child, worn, face, i, 0, P.headUp, 0, 0, 0, 0);
        setPart(child, worn, antenna, i, P.antX, P.antY, P.antZ, 0.06, 0, -0.12);
        setPart(child, worn, tip, i, P.tipX, P.tipY, P.antZ, 0, 0, 0);

        attachMatrixAt(rig, agent.frame, this.#chestSlot, bone);
        worn.multiplyMatrices(root, bone);
        setPart(child, worn, pack, i, 0, P.packUp, P.packZ, 0, 0, 0);
        setPart(child, worn, lamp, i, 0, P.lightY, P.lightZ, 0, 0, 0);

        // The hammer only exists while a session is running, so it gets its
        // own instance counter -- an unused slot in the middle of an instanced
        // mesh still draws.
        if (agent.clipKey === 'work') {
          attachMatrixAt(rig, agent.frame, this.#handSlot, bone);
          worn.multiplyMatrices(root, bone);
          setPart(child, worn, hammer, hands++, P.gripX, P.gripY, P.gripZ, P.gripRx, 0, P.gripRz);
        }
      }

      // Suit and trim only change when the status does, or when an agent
      // leaving the roster shuffles everyone's slot along -- so they are
      // written on those frames, not all of them.
      const c = this.#color;
      if (agent.index !== i || agent.colorDirty) {
        agent.colorDirty = false;
        crew?.setColorAt(i, c.setHex(agent.suit));
        helmet.setColorAt(i, c.setHex(agent.suit));
        pack.setColorAt(i, agent.trim);
        face.setColorAt(i, agent.eye);
        staticDirty = true;
      }

      // Antenna tip and chest lamp pulse; a blocked agent's lamp stutters like a fault light.
      const pulse =
        agent.status === 'blocked'
          ? (Math.sin(now * 9) > 0.2 ? 1 : 0.05)
          : 0.55 + 0.45 * Math.sin(now * 2.6 + agent.phase);
      tip.setColorAt(i, c.copy(agent.eye).multiplyScalar(0.6 + pulse * 1.1));
      lamp.setColorAt(i, c.copy(agent.trim).multiplyScalar(0.7 + pulse * 1.6));

      // Atlas frame for the face.
      const f = agent.faceFrame;
      frames[i * 2] = (f % FRAME_COLS) / FRAME_COLS;
      frames[i * 2 + 1] = 1 - (Math.floor(f / FRAME_COLS) + 1) / FRAME_ROWS;

      agent.index = i;
      i++;
    }

    const n = i;
    for (const name of PART_NAMES) {
      const mesh = this.#parts[name];
      mesh.count = name === 'hammer' ? hands : n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor && (staticDirty || ANIMATED.has(name))) mesh.instanceColor.needsUpdate = true;
    }
    if (crew) {
      crew.count = n;
      crew.instanceMatrix.needsUpdate = true;
      if (this.#crewFrameAttr) this.#crewFrameAttr.needsUpdate = true;
      if (staticDirty && crew.instanceColor) crew.instanceColor.needsUpdate = true;
    }
    this.#frameAttr.needsUpdate = true;
    this.#visibleCount = n;
  }

  // -- picking ------------------------------------------------------------------------

  /**
   * Nearest agent to a screen point, in screen space. Cheaper than raycasting
   * ten instanced meshes and far kinder to click, since the hit radius grows
   * with how big the astronaut actually is on screen rather than with its
   * silhouette. Aims at the head, which is the part of an astronaut you look at.
   */
  pick(ndcX: number, ndcY: number, aspect: number, camera: THREE.Camera, maxDist = PICK_RADIUS): Agent | null {
    let best: Crewman | null = null;
    let bestScore = Infinity;
    const v = this.#v;

    for (const agent of this.#agents) {
      if (agent.scale < 0.3 || agent.state === 'gone' || agent.hidden) continue;
      v.copy(agent.head).project(camera);
      if (v.z > 1) continue; // behind the camera
      const dx = (v.x - ndcX) * aspect;
      const dy = v.y - ndcY;
      const d = Math.hypot(dx, dy);
      if (d > maxDist) continue;
      // Break ties by depth so the nearer of two overlapping agents wins.
      const score = d + v.z * 0.05;
      if (score < bestScore) {
        bestScore = score;
        best = agent;
      }
    }
    return best;
  }

  setHover(agent: Agent | null): void {
    this.#hoverRing.visible = agent !== null;
    if (agent) this.#hoverRing.position.set(agent.pos.x, agent.pos.y + 0.03, agent.pos.z);
  }

  setSelected(agent: Agent | null): void {
    this.#selected = agent ? (this.#byId.get(agent.id) ?? null) : null;
    this.#selectRing.visible = this.#selected !== null;
  }

  #updateRings(now: number): void {
    const a = this.#selected;
    if (a) {
      this.#selectRing.position.set(a.pos.x, a.pos.y + 0.035, a.pos.z);
      this.#selectRing.rotation.y = now * 0.6;
      this.#selectRing.scale.setScalar(1 + Math.sin(now * 3) * 0.05);
    }
    if (this.#hoverRing.visible) this.#hoverRing.rotation.y = -now * 0.4;
  }

  dispose(): void {
    this.#unsubscribe();
    for (const name of PART_NAMES) {
      const mesh = this.#parts[name];
      mesh.geometry.dispose();
      mesh.dispose();
    }
    // The face material is shared by name with the atlas it maps; the atlas is
    // the caller's, the material is ours.
    for (const name of PART_NAMES) if (name !== 'face') disposeMaterial(this.#parts[name].material);
    this.#faceMaterial.dispose();
    this.#disposeCrew();
    for (const r of [this.#hoverRing, this.#selectRing]) {
      r.geometry.dispose();
      disposeMaterial(r.material);
    }
    this.object3d.removeFromParent();
  }
}

// -- helpers ----------------------------------------------------------------------------

/** A number in [0,1) from a seed and a salt, taking nothing from the agent's own dice. */
function fromSeed(seed: number, shift: number): number {
  return ((seed >>> shift) % 1024) / 1024;
}

/** A size the roster asked for, kept to something an astronaut can be. */
function sizeOf(entry: RosterEntry): number {
  const s = entry.size;
  return s !== undefined && Number.isFinite(s) && s > 0 ? Math.min(1.5, s) : 1;
}

const _cq = new THREE.Quaternion();
const _ce = new THREE.Euler();
const _cv = new THREE.Vector3();
const _cs = new THREE.Vector3(1, 1, 1);

/** Compose a child's local transform, concatenate onto the root, and store the instance. */
function setPart(
  scratch: THREE.Matrix4, root: THREE.Matrix4, mesh: Part, index: number,
  x: number, y: number, z: number, rx: number, ry: number, rz: number,
): void {
  _ce.set(rx, ry, rz);
  _cq.setFromEuler(_ce);
  _cv.set(x, y, z);
  scratch.compose(_cv, _cq, _cs);
  scratch.premultiply(root);
  mesh.setMatrixAt(index, scratch);
}

function angleDamp(current: number, target: number, lambda: number, dt: number): number {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return current + delta * (1 - Math.exp(-lambda * dt));
}

/**
 * Did a cycle phase in [0, 1) pass the halfway mark between two frames? The
 * phase only ever climbs, so a drop means it wrapped: the mark was crossed on
 * the way round unless it was already behind, or has been passed again since.
 */
export function crossesDownbeat(prev: number, cur: number): boolean {
  if (cur < prev) return prev < 0.5 || cur >= 0.5;
  return prev < 0.5 && cur >= 0.5;
}

/**
 * The visor. A rounded-rectangle SDF in the patch's own UV space decides what
 * is screen and what is helmet, and a thin band just inside the edge is
 * lifted to read as a bezel.
 */
function visorMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0x08090e, roughness: 0.3, metalness: 0.16 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n varying vec2 vVisorUv;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n vVisorUv = uv;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n varying vec2 vVisorUv;`)
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         // Rounded-box SDF: |max(q,0)| + min(max(q.x,q.y),0) - r, the standard 2D form.
         vec2 p = ( vVisorUv - 0.5 ) * 2.0;
         // "half" is a reserved word in GLSL ES; a variable named that will not compile.
         vec2 halfSize = vec2( 0.86, 0.80 );
         float radius = 0.52;
         vec2 q = abs( p ) - halfSize + radius;
         float sd = length( max( q, 0.0 ) ) + min( max( q.x, q.y ), 0.0 ) - radius;
         if ( sd > 0.0 ) discard;
         float bezel = smoothstep( -0.14, -0.01, sd );`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         // A cool rim right at the cut, so the screen reads as set into a bezel.
         totalEmissiveRadiance += vec3( 0.16, 0.22, 0.34 ) * bezel;`,
      );
  };
  return mat;
}

/**
 * A claw hammer, in the rig's own units: a shaft with a steel head across the top.
 *
 * Coloured per vertex rather than per instance, because the two halves are
 * different materials and the instance colour is already spoken for by the
 * suit palette.
 */
function hammerGeometry(R: number): THREE.BufferGeometry {
  const shaft = new THREE.CylinderGeometry(R * 0.055, R * 0.07, R * 1.15, 6);
  shaft.translate(0, R * 0.24, 0);
  paint(shaft, 0x8a6440);

  // The head crosses the shaft. It is authored long along X, which is already
  // square to the shaft's Y -- turning it a quarter turn about Z, as this used
  // to, stood the head UP IN LINE WITH the handle, so the astronaut appeared
  // to be swinging a mallet end-on.
  const head = roundedBox(R * 0.5, R * 0.19, R * 0.19, R * 0.05);
  head.translate(0, R * 0.82, 0);
  paint(head, 0x9aa0a8);

  const merged = mergeGeometries([shaft, head], false);
  shaft.dispose();
  head.dispose();
  if (!merged) throw new Error('astronauts: could not merge the hammer');
  return merged;
}

/** Bake a flat colour into a geometry's vertex colours. */
function paint(geo: THREE.BufferGeometry, hex: number): void {
  const c = new THREE.Color(hex);
  const n = geo.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** A cheap rounded box: a low-segment box with its vertices pulled onto a rounded shell. */
function roundedBox(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d, 2, 2, 2);
  const pos = geo.getAttribute('position');
  const v = new THREE.Vector3();
  const inner = new THREE.Vector3();
  const out = new THREE.Vector3();
  const half = new THREE.Vector3(w / 2 - r, h / 2 - r, d / 2 - r);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    inner.set(
      THREE.MathUtils.clamp(v.x, -half.x, half.x),
      THREE.MathUtils.clamp(v.y, -half.y, half.y),
      THREE.MathUtils.clamp(v.z, -half.z, half.z),
    );
    out.copy(v).sub(inner);
    if (out.lengthSq() > 0) out.setLength(r);
    pos.setXYZ(i, inner.x + out.x, inner.y + out.y, inner.z + out.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * A patch of sphere centred on +Z -- the direction the astronaut faces.
 * Three's own parametrisation puts phi=0 at -X, so the patch is offset by a
 * quarter turn to land the cap on the front of the helmet rather than its cheek.
 */
function sphereCap(radius: number, phiSpread: number, thetaSpread: number, wSeg = 18, hSeg = 12): THREE.SphereGeometry {
  return new THREE.SphereGeometry(
    radius,
    wSeg,
    hSeg,
    Math.PI / 2 - phiSpread / 2,
    phiSpread,
    Math.PI / 2 - thetaSpread / 2,
    thetaSpread,
  );
}

function ring(inner: number, outer: number, color: number, opacity: number): THREE.Mesh {
  const geo = new THREE.RingGeometry(inner, outer, 32);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 3;
  return mesh;
}

function disposeMaterial(m: THREE.Material | THREE.Material[]): void {
  if (Array.isArray(m)) for (const x of m) x.dispose();
  else m.dispose();
}
