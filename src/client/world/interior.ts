import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Astronauts, WALK_SPEED } from '../agents/astronauts.ts';
import type { Agent, AgentStatus, CrewWorld, RosterEntry } from '../agents/astronauts.ts';
import { Visitor } from '../agents/visitor.ts';
import type { CrewRig } from '../assets/crew.ts';
import type { VillagerBody } from '../assets/villager.ts';
import type { Settings } from '../core/settings.ts';
import { WalkCamera } from '../core/walkCamera.ts';
import type { View } from './stage.ts';
import { PROVIDER_COLOR } from './palette.ts';
import type { CeoState, ProviderId } from '../../shared/protocol.ts';
import { fnv1a32 } from '../../shared/hash.ts';

/**
 * Inside the ship: one room, one desk, the CEOs sitting at it, and you.
 *
 * There was an interior once, and it was removed on purpose: it had walls
 * that decided things, and a surface that decides is a second copy of the
 * CEOs' state, bound to drift from the first. This one decides nothing. At
 * the desk the Planning panel opens -- the same object the HUD button opens,
 * handed in as a `DeskPanel` -- and walking away closes it again. Which
 * panel that is belongs to whoever hands it in, and it is Planning by the
 * user's call (2026-09-20): walking up to the two of them is the moment you
 * plan with them. The room never builds a panel, never holds a proposal or a
 * word of an answer, and does not import the store: what it knows of a CEO
 * is who sits where and one word of mood, which is how the colony knows a
 * session too.
 *
 * It is a `View`: a scene of its own, drawn by the colony's renderer through
 * the colony's post chain, with a camera of its own (`WalkCamera`) because
 * inside you walk. You come in through the hatch at the top of the ramp --
 * the way the crew goes home -- and you leave by walking back onto it.
 *
 * The room's frame is its own: the hatch at +Z, the desk at the far end
 * towards -Z, the floor at y = 0. Nothing here reads the DOM, so a test can
 * walk you up to the desk.
 */

/** The room, in its own frame. */
export const ROOM = { halfWidth: 4.5, back: -5, front: 5, height: 3.2 } as const;
/** How much room a walker takes: a shade over half a helmet. */
export const WALKER_RADIUS = 0.35;

/** The hatch in the front wall: where you come in, and walking back onto it is walking out. */
export const HATCH_HALF = 0.9;
export const EXIT_Z = ROOM.front - 0.7;
/** Where you stand on coming in: a stride inside the hatch, facing the desk. */
export const ENTRY = { x: 0, z: ROOM.front - 1.6 } as const;
/** Facing the desk: `atan2(dx, dz)` of a step towards -Z. */
const FACING_DESK = Math.PI;

/** The desk: a slab across the far end, with the CEOs behind it. */
export const DESK = { halfWidth: 1.8, front: -2.4, back: -3.4, top: 0.8 } as const;
/**
 * Where a CEO sits: just behind the desk, on a chair. Measured on the rig:
 * seated, the knees rise 0.41 units and the feet reach 0.69 forward -- at
 * `CEO_SIZE` 0.25 m and 0.42 m, so with the seat at 0.3 both stay under a
 * top at 0.8 and behind the panel that closes the desk's front. At 1.5, the
 * size a CEO used to be, they were 0.34 and 0.58 and fitted too: a smaller
 * one only has further to spare.
 */
export const SEAT_Z = DESK.back - 0.15;
export const SEAT_Y = 0.3;
/** Standing this far in front of the desk, or nearer, is standing at it. */
export const DESK_REACH = 1.6;
/**
 * How big a CEO sits next to you: 1.34 m of astronaut, a head over the crew
 * out on the plots and well clear of a desk 0.8 high.
 *
 * It was 1.5 -- the most `sizeOf` lets an astronaut be -- when being bigger
 * than you was the point. The user asked for the other way round
 * (2026-09-20): you walk in taller than the ones you came to see
 * (`VILLAGER_SCALE`), and they are the small ones behind the desk.
 */
export const CEO_SIZE = 1.1;
/** Your trim: the Board panel's violet. You are neither Claude nor Codex. */
export const YOUR_TRIM = 0xc77dff;
const YOU = 'you';

/** A box you cannot walk into, on the floor plan. */
export interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** A point on the floor plan. */
export interface Spot {
  x: number;
  z: number;
}

/** A console against each side wall. Obstacles, and something to look at on the way in. */
const CONSOLES: readonly Box[] = [
  { minX: -ROOM.halfWidth, maxX: -ROOM.halfWidth + 0.6, minZ: 0.8, maxZ: 2.2 },
  { minX: ROOM.halfWidth - 0.6, maxX: ROOM.halfWidth, minZ: 0.8, maxZ: 2.2 },
];

/** Where the chairs stand across the desk: one in the middle, or two side by side. */
export function seatsFor(count: number): number[] {
  if (count <= 1) return [0];
  const gap = 1.9;
  return Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * gap);
}

/** Everything you walk round: the desk, a chair per seat, the two consoles. */
export function obstaclesFor(seats: readonly number[]): Box[] {
  const out: Box[] = [{ minX: -DESK.halfWidth, maxX: DESK.halfWidth, minZ: DESK.back, maxZ: DESK.front }];
  for (const x of seats) out.push({ minX: x - 0.5, maxX: x + 0.5, minZ: SEAT_Z - 0.6, maxZ: SEAT_Z + 0.2 });
  out.push(...CONSOLES);
  return out;
}

function inside(box: Box, x: number, z: number, r: number): boolean {
  return x > box.minX - r && x < box.maxX + r && z > box.minZ - r && z < box.maxZ + r;
}

function blocked(obstacles: readonly Box[], x: number, z: number): boolean {
  for (const box of obstacles) if (inside(box, x, z, WALKER_RADIUS)) return true;
  return false;
}

/**
 * One step, sliding along whatever is in the way. Each axis is tried on its
 * own, so walking into the desk at an angle runs along its edge instead of
 * stopping dead against it -- the same rule the colony's grid follows.
 * Written into `out`, which may be `from`.
 */
export function walkRoom(from: Spot, dx: number, dz: number, obstacles: readonly Box[], out: Spot = { x: 0, z: 0 }): Spot {
  const r = WALKER_RADIUS;
  const x0 = from.x;
  const z0 = from.z;
  // Already inside something (a chair that moved under you): let it walk out.
  const free = !blocked(obstacles, x0, z0);
  let x = THREE.MathUtils.clamp(x0 + dx, -ROOM.halfWidth + r, ROOM.halfWidth - r);
  if (free && blocked(obstacles, x, z0)) x = x0;
  let z = THREE.MathUtils.clamp(z0 + dz, ROOM.back + r, ROOM.front - r);
  if (free && blocked(obstacles, x, z)) z = z0;
  out.x = x;
  out.z = z;
  return out;
}

/** Standing in front of the desk, close enough to talk across it. */
export function atDesk(p: Spot): boolean {
  return p.z >= DESK.front && p.z <= DESK.front + DESK_REACH && Math.abs(p.x) <= DESK.halfWidth + 0.3;
}

/** Standing on the hatch: the way out. */
export function atHatch(p: Spot): boolean {
  return p.z >= EXIT_Z && Math.abs(p.x) <= HATCH_HALF;
}

/**
 * A CEO's state, as the figure at the desk wears it. The same words the
 * Board panel shows, turned into what an astronaut's eyes and face already
 * know how to say: answering is working, a question for you is waiting, a
 * failure is blocked, stopped is asleep in the chair.
 */
export function ceoStatus(state: CeoState): AgentStatus {
  switch (state) {
    case 'starting':
    case 'thinking':
      return 'working';
    case 'asking':
    case 'waiting':
      return 'waiting';
    case 'error':
      return 'blocked';
    case 'off':
      return 'sleeping';
    case 'idle':
      return 'idle';
  }
}

const FORWARD: ReadonlySet<string> = new Set(['KeyW', 'ArrowUp']);
const BACKWARD: ReadonlySet<string> = new Set(['KeyS', 'ArrowDown']);
const LEFTWARD: ReadonlySet<string> = new Set(['KeyA', 'ArrowLeft']);
const RIGHTWARD: ReadonlySet<string> = new Set(['KeyD', 'ArrowRight']);

/**
 * The walking keys that are down, by `KeyboardEvent.code` so the layout of
 * the keyboard does not move them. Up the screen is towards the desk.
 */
export class WalkKeys {
  readonly #down = new Set<string>();

  /** True when the key is a walking key: the caller keeps it from scrolling the page. */
  press(code: string): boolean {
    if (!isWalkKey(code)) return false;
    this.#down.add(code);
    return true;
  }

  release(code: string): void {
    this.#down.delete(code);
  }

  /**
   * Let go of everything. A key held while the focus jumps into a text box
   * never sends its keyup to us, and without this you would walk on into
   * the wall for as long as you were typing.
   */
  clear(): void {
    this.#down.clear();
  }

  /** Where the held keys point, as a unit step on the floor plan; zero when none, or when they cancel. */
  move(): Spot {
    const any = (set: ReadonlySet<string>): number => {
      for (const code of set) if (this.#down.has(code)) return 1;
      return 0;
    };
    const x = any(RIGHTWARD) - any(LEFTWARD);
    const z = any(BACKWARD) - any(FORWARD);
    const len = Math.hypot(x, z);
    return len > 0 ? { x: x / len, z: z / len } : { x: 0, z: 0 };
  }
}

export function isWalkKey(code: string): boolean {
  return FORWARD.has(code) || BACKWARD.has(code) || LEFTWARD.has(code) || RIGHTWARD.has(code);
}

/**
 * The panel the desk opens, as the room needs it: the one the HUD button
 * opens, handed in. `open(false)` shows it without moving the focus: you
 * walk up holding a key, and a text box that took the focus would take the
 * key's repeats as typing.
 */
export interface DeskPanel {
  readonly enabled: boolean;
  readonly isOpen: boolean;
  open(focus?: boolean): void;
  close(): void;
}

export interface InteriorOptions {
  settings: Settings;
  faceTexture: THREE.Texture | null;
  panel: DeskPanel;
  /** You walked back onto the hatch. */
  onLeave: () => void;
}

// Colours from the ship's own hull, so the inside is the same ship.
const HULL = 0xe9e4da;
const HULL_DARK = 0xc4bfb4;
const TRIM = 0xc96442;
const DARK = 0x2b2f36;
const FLOOR = 0x3a3f47;

export class Interior implements View {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly keys = new WalkKeys();

  readonly #settings: Settings;
  readonly #panel: DeskPanel;
  readonly #onLeave: () => void;
  readonly #crew: Astronauts;
  /** You, in person. Null until the model pack has been decoded. */
  #visitor: Visitor | null = null;
  readonly #lens: WalkCamera;
  readonly #world: CrewWorld;
  /** Chairs, desk lights and desk pads: rebuilt when the number of CEOs changes. */
  readonly #seating = new THREE.Group();
  #pads: { provider: ProviderId; material: THREE.MeshBasicMaterial }[] = [];
  #hatchPad!: THREE.MeshBasicMaterial;
  #deskMark!: THREE.MeshBasicMaterial;

  #providers: ProviderId[] = [];
  #moods = new Map<ProviderId, AgentStatus>();
  #seats: number[] = seatsFor(0);
  #obstacles: Box[] = obstaclesFor(this.#seats);
  #you: Spot = { x: ENTRY.x, z: ENTRY.z };
  #inside = false;
  #atDesk = false;
  /** The panel was opened by walking up to the desk, so walking away closes it. */
  #openedIt = false;

  constructor(opts: InteriorOptions) {
    this.#settings = opts.settings;
    this.#panel = opts.panel;
    this.#onLeave = opts.onLeave;

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 80);
    this.#lens = new WalkCamera(this.camera);
    this.#lens.snap(this.#you);

    this.scene.name = 'interior';
    this.scene.background = new THREE.Color(0x05070b);
    // Low on purpose, like the lamps in `#buildLights`: see there.
    this.scene.environmentIntensity = 0.2;
    this.#buildRoom();
    this.#buildLights();
    this.scene.add(this.#seating);

    this.#crew = new Astronauts(opts.settings, opts.faceTexture);
    this.scene.add(this.#crew.object3d);
    this.#world = {
      shipDoor: (out) => out.set(ENTRY.x, 0, ROOM.front - WALKER_RADIUS),
      shipWayIn: (out) => {
        for (const v of out) v.set(ENTRY.x, 0, ROOM.front);
      },
      groundAt: (x, z) => this.#groundAt(x, z),
    };
    this.#rebuildSeating();
    this.#syncCrew();
  }

  /** The figures in the room: the CEOs and you. Read, never written. */
  get crew(): Astronauts {
    return this.#crew;
  }

  /** Where you are standing, on the floor plan. */
  get you(): Readonly<Spot> {
    return this.#you;
  }

  get inside(): boolean {
    return this.#inside;
  }

  get atDesk(): boolean {
    return this.#atDesk;
  }

  get focusDistance(): number {
    return this.#lens.distance;
  }

  setRig(rig: CrewRig): void {
    this.#crew.setRig(rig);
  }

  /**
   * The body you walk around in. Until it arrives you are an astronaut like
   * the crew -- the roster says `hidden` only once there is something else
   * to draw, so a pack that failed to decode leaves a figure, not a hole.
   */
  setVillager(body: VillagerBody): void {
    this.#visitor?.dispose();
    this.#visitor = new Visitor(body);
    this.scene.add(this.#visitor.object3d);
    this.#syncCrew();
  }

  /** The face atlas is the colony's; whoever built it disposes it. */
  setFaceTexture(tex: THREE.Texture | null): void {
    this.#crew.setFaceTexture(tex);
  }

  /** Reflections for the room, see `roomReflections`. */
  setEnvironment(tex: THREE.Texture | null): void {
    this.scene.environment = tex;
  }

  /**
   * Who sits at the desk, from the caps: the same list the Board panel
   * builds its desks from, so the room never seats a CEO the panel has no
   * desk for.
   */
  setCeos(providers: readonly ProviderId[]): void {
    const next = [...providers];
    if (next.length === this.#providers.length && next.every((p, i) => p === this.#providers[i])) return;
    this.#providers = next;
    this.#seats = seatsFor(next.length);
    this.#obstacles = obstaclesFor(this.#seats);
    this.#rebuildSeating();
    this.#syncCrew();
  }

  /** A CEO's state changed: the figure's face and eyes follow, nothing else. */
  setCeoState(provider: ProviderId, state: CeoState): void {
    const mood = ceoStatus(state);
    if (this.#moods.get(provider) === mood) return;
    this.#moods.set(provider, mood);
    this.#syncCrew();
  }

  /** In through the hatch: you stand just inside it, facing the desk, and the camera cuts to you. */
  enter(): void {
    this.#inside = true;
    this.keys.clear();
    this.#you = { x: ENTRY.x, z: ENTRY.z };
    this.#syncCrew();
    this.#crew.place(YOU, ENTRY.x, ENTRY.z, FACING_DESK, true);
    this.#lens.snap(this.#you);
    this.#atDesk = false;
    this.#openedIt = false;
  }

  /** Out again. A panel the desk opened is closed; one you opened yourself is yours. */
  leave(): void {
    this.#inside = false;
    this.keys.clear();
    this.#setDesk(false);
  }

  update(dt: number, now: number): void {
    if (this.#inside) {
      const step = this.keys.move();
      if (step.x !== 0 || step.z !== 0) {
        const pace = WALK_SPEED * dt;
        walkRoom(this.#you, step.x * pace, step.z * pace, this.#obstacles, this.#you);
        this.#crew.place(YOU, this.#you.x, this.#you.z, Math.atan2(step.x, step.z));
      }
      this.#setDesk(atDesk(this.#you));
      if (atHatch(this.#you)) {
        this.leave();
        this.#onLeave();
      }
    }
    this.#crew.update(dt, now);
    const visitor = this.#visitor;
    if (visitor) {
      const you = this.#crew.byId.get(YOU);
      if (you) visitor.follow(you);
      visitor.update(dt, this.#settings.get('reducedMotion') ? 0.35 : 1);
    }
    this.#lens.update(this.#you, dt, this.#settings.get('reducedMotion'));
    this.#glow(now);
  }

  #setDesk(near: boolean): void {
    if (near === this.#atDesk) return;
    this.#atDesk = near;
    const panel = this.#panel;
    if (near) {
      if (panel.enabled && !panel.isOpen) {
        panel.open(false);
        this.#openedIt = true;
      }
      return;
    }
    if (this.#openedIt && panel.isOpen) panel.close();
    this.#openedIt = false;
  }

  /** The roster of the room: a seated CEO per provider, and you. */
  #syncCrew(): void {
    const entries: RosterEntry[] = this.#providers.map((provider, i) => {
      const x = this.#seats[i] ?? 0;
      return {
        id: `ceo:${provider}`,
        status: this.#moods.get(provider) ?? 'idle',
        provider,
        site: { x, y: 0, z: SEAT_Z },
        // Faces the room, where you come in from.
        anchor: { x, y: 0, z: ROOM.front },
        known: true,
        seed: fnv1a32(`ceo:${provider}`),
        size: CEO_SIZE,
        seated: true,
      };
    });
    entries.push({
      id: YOU,
      status: 'idle',
      provider: 'claude',
      trim: YOUR_TRIM,
      site: { x: this.#you.x, y: 0, z: this.#you.z },
      anchor: null,
      known: true,
      seed: fnv1a32(YOU),
      driven: true,
      hidden: this.#visitor !== null,
    });
    this.#crew.setRoster(entries, this.#world);
  }

  /** The CEO of a provider, as the room draws it. */
  ceoOf(provider: ProviderId): Agent | null {
    return this.#crew.byId.get(`ceo:${provider}`) ?? null;
  }

  /** The floor, except on a chair's seat: that is what a seated CEO stands on. */
  #groundAt(x: number, z: number): number {
    for (const sx of this.#seats) {
      if (Math.abs(x - sx) < 0.45 && z > SEAT_Z - 0.45 && z < SEAT_Z + 0.25) return SEAT_Y;
    }
    return 0;
  }

  /** The hatch pulses to say it is the way out; a CEO answering lights its pad; the desk's mark wakes when you reach it. */
  #glow(now: number): void {
    const pulse = 0.5 + 0.5 * Math.sin(now * 2.4);
    this.#hatchPad.opacity = 0.35 + 0.3 * pulse;
    this.#deskMark.opacity = this.#atDesk ? 0.3 : 0.12;
    for (const pad of this.#pads) {
      const busy = this.#moods.get(pad.provider) === 'working';
      const k = busy ? 1.1 + 0.9 * (0.5 + 0.5 * Math.sin(now * 6)) : 0.55;
      pad.material.color.setHex(PROVIDER_COLOR[pad.provider]).multiplyScalar(k);
    }
  }

  // -- building -------------------------------------------------------------------------

  #buildRoom(): void {
    const { halfWidth: hw, back, front, height: h } = ROOM;
    const width = hw * 2;
    const depth = front - back;
    const mid = (front + back) / 2;

    /*
     * Walls and ceiling face IN, and are drawn from that side only. The lens
     * sits behind you and never turns, so the wall behind you is always
     * seen from outside -- and culled. That is the whole of the dollhouse
     * cut: nothing has to hide it.
     */
    const plane = (w: number, ht: number, rx: number, ry: number, x: number, y: number, z: number): THREE.BufferGeometry => {
      const g = new THREE.PlaneGeometry(w, ht);
      g.rotateX(rx);
      g.rotateY(ry);
      g.translate(x, y, z);
      return g;
    };
    const shell = mergeAll([
      plane(width, h, 0, 0, 0, h / 2, back),
      plane(width, h, 0, Math.PI, 0, h / 2, front),
      plane(depth, h, 0, Math.PI / 2, -hw, h / 2, mid),
      plane(depth, h, 0, -Math.PI / 2, hw, h / 2, mid),
    ]);
    this.scene.add(new THREE.Mesh(shell, new THREE.MeshStandardMaterial({ color: HULL, roughness: 0.62, metalness: 0.05 })));
    this.scene.add(new THREE.Mesh(
      plane(width, depth, Math.PI / 2, 0, 0, h, mid),
      new THREE.MeshStandardMaterial({ color: 0xd8d4cc, roughness: 0.8, metalness: 0.05 }),
    ));

    // The floor runs on past the hatch, under the lens: from behind you,
    // near the door, the bottom of the frame would otherwise be the void.
    const apron = 3;
    const floor = new THREE.Mesh(
      plane(width, depth + apron, -Math.PI / 2, 0, 0, 0, mid + apron / 2),
      new THREE.MeshStandardMaterial({ color: FLOOR, roughness: 0.55, metalness: 0.35 }),
    );
    this.scene.add(floor);

    // Seams between the floor plates.
    const seams: THREE.BufferGeometry[] = [];
    for (let x = -hw + 1.5; x < hw; x += 1.5) seams.push(plane(0.03, depth, -Math.PI / 2, 0, x, 0.002, mid));
    for (let z = back + 1.5; z < front; z += 1.5) seams.push(plane(width, 0.03, -Math.PI / 2, 0, 0, 0.002, z));
    this.scene.add(new THREE.Mesh(mergeAll(seams), new THREE.MeshStandardMaterial({ color: 0x4d535d, roughness: 0.5, metalness: 0.4 })));

    // Ribs and a kick band on the side and back walls -- never on the front
    // one, which stands between you and the lens: a rib there would be a
    // post in front of the camera.
    const trimParts: THREE.BufferGeometry[] = [];
    const box = (w: number, ht: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry => {
      const g = new THREE.BoxGeometry(w, ht, d);
      g.translate(x, y, z);
      return g;
    };
    for (let z = back + 1.25; z < front; z += 2.5) {
      trimParts.push(box(0.14, h, 0.3, -hw + 0.07, h / 2, z), box(0.14, h, 0.3, hw - 0.07, h / 2, z));
    }
    trimParts.push(box(0.05, 0.3, depth, -hw + 0.025, 0.15, mid), box(0.05, 0.3, depth, hw - 0.025, 0.15, mid));
    trimParts.push(box(width, 0.3, 0.05, 0, 0.15, back + 0.025));
    this.scene.add(new THREE.Mesh(mergeAll(trimParts), new THREE.MeshStandardMaterial({ color: HULL_DARK, roughness: 0.6, metalness: 0.1 })));

    // A lit stripe along each side wall, the ramp's colour.
    const stripes = mergeAll([box(0.03, 0.05, depth, -hw + 0.16, 2.35, mid), box(0.03, 0.05, depth, hw - 0.16, 2.35, mid)]);
    this.scene.add(new THREE.Mesh(stripes, new THREE.MeshBasicMaterial({ color: new THREE.Color(TRIM).multiplyScalar(1.6) })));

    // Portholes: space outside, dark and a little blue. Between the ribs,
    // which stand 0.14 off the wall and would cut a rim in half.
    const glass: THREE.BufferGeometry[] = [];
    const rims: THREE.BufferGeometry[] = [];
    for (const z of [-2.5, 0, 2.7]) {
      for (const side of [-1, 1]) {
        const ry = side < 0 ? Math.PI / 2 : -Math.PI / 2;
        const x = side * (hw - 0.01);
        const pane = new THREE.CircleGeometry(0.42, 24);
        pane.rotateY(ry);
        pane.translate(x, 1.6, z);
        glass.push(pane);
        const rim = new THREE.RingGeometry(0.42, 0.54, 24);
        rim.rotateY(ry);
        rim.translate(x - side * 0.005, 1.6, z);
        rims.push(rim);
      }
    }
    this.scene.add(new THREE.Mesh(mergeAll(glass), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x0b1c3a).multiplyScalar(1.4) })));
    this.scene.add(new THREE.Mesh(mergeAll(rims), new THREE.MeshStandardMaterial({ color: HULL_DARK, roughness: 0.4, metalness: 0.5 })));

    // Light panels in the ceiling, bright enough for the bloom to catch.
    const panels = mergeAll([-2.9, 0, 3].map((z) => plane(1.4, 0.5, Math.PI / 2, 0, 0, h - 0.01, z)));
    this.scene.add(new THREE.Mesh(panels, new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.97, 0.92).multiplyScalar(1.6) })));

    // The board behind the desk: a wide dark screen with a violet line under it.
    const screen = box(3.8, 1.3, 0.06, 0, 2.0, back + 0.04);
    this.scene.add(new THREE.Mesh(screen, new THREE.MeshStandardMaterial({ color: 0x0c1016, roughness: 0.2, metalness: 0.6 })));
    this.scene.add(new THREE.Mesh(
      box(3.6, 0.04, 0.02, 0, 1.3, back + 0.08),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(YOUR_TRIM).multiplyScalar(1.5) }),
    ));

    // The consoles along the side walls, each with a screen turned to the room.
    const consoleBodies: THREE.BufferGeometry[] = [];
    const consoleScreens: THREE.BufferGeometry[] = [];
    for (const c of CONSOLES) {
      const cx = (c.minX + c.maxX) / 2;
      const cz = (c.minZ + c.maxZ) / 2;
      consoleBodies.push(box(c.maxX - c.minX, 0.9, c.maxZ - c.minZ, cx, 0.45, cz));
      const face = new THREE.PlaneGeometry(c.maxZ - c.minZ - 0.2, 0.4);
      const inward = cx < 0 ? 1 : -1;
      face.rotateX(-0.9);
      face.rotateY(inward > 0 ? Math.PI / 2 : -Math.PI / 2);
      // Tilted back, the screen's lower edge drops 0.12 below its middle:
      // this high it rests on the console's top instead of sinking into it.
      face.translate(cx + inward * 0.05, 1.03, cz);
      consoleScreens.push(face);
    }
    this.scene.add(new THREE.Mesh(mergeAll(consoleBodies), new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.45, metalness: 0.4 })));
    this.scene.add(new THREE.Mesh(mergeAll(consoleScreens), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x39d0ff).multiplyScalar(0.6) })));

    // The desk: a dark top on a white body closed at the front, which is
    // what hides the legs of whoever sits behind it.
    const deskMid = (DESK.front + DESK.back) / 2;
    const deskDepth = DESK.front - DESK.back;
    const deskW = DESK.halfWidth * 2;
    this.scene.add(new THREE.Mesh(
      box(deskW + 0.1, 0.06, deskDepth + 0.08, 0, DESK.top - 0.03, deskMid),
      new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.3, metalness: 0.45 }),
    ));
    this.scene.add(new THREE.Mesh(
      mergeAll([
        box(deskW, DESK.top - 0.06, 0.05, 0, (DESK.top - 0.06) / 2, DESK.front - 0.025),
        box(0.05, DESK.top - 0.06, deskDepth, -DESK.halfWidth + 0.025, (DESK.top - 0.06) / 2, deskMid),
        box(0.05, DESK.top - 0.06, deskDepth, DESK.halfWidth - 0.025, (DESK.top - 0.06) / 2, deskMid),
      ]),
      new THREE.MeshStandardMaterial({ color: HULL, roughness: 0.55, metalness: 0.08 }),
    ));

    // On the floor: where to stand to talk, and the way out.
    const mark = plane(deskW + 0.6, DESK_REACH, -Math.PI / 2, 0, 0, 0.004, DESK.front + DESK_REACH / 2);
    this.#deskMark = new THREE.MeshBasicMaterial({ color: YOUR_TRIM, transparent: true, opacity: 0.12, depthWrite: false });
    this.scene.add(new THREE.Mesh(mark, this.#deskMark));
    const pad = plane(HATCH_HALF * 2, front - EXIT_Z, -Math.PI / 2, 0, 0, 0.005, (front + EXIT_Z) / 2);
    this.#hatchPad = new THREE.MeshBasicMaterial({ color: new THREE.Color(TRIM).multiplyScalar(1.4), transparent: true, opacity: 0.5, depthWrite: false });
    this.scene.add(new THREE.Mesh(pad, this.#hatchPad));
  }

  /**
   * The room is small and its walls are white, so every lamp lands close
   * and bounces: what reads as dim on paper is plenty in here. The first
   * levels (hemisphere 1.2, lamps 26 and 18, environment 0.45) lit the walls
   * past the bloom's threshold, and the whole far end -- the desk, the CEOs
   * -- drowned in a white haze: a frame twice as bright as the colony's
   * (mean 146 of 255 against 71, measured on the Iris Plus at 2x). Dimming
   * only the ceiling panels changed nothing; it was the lit walls blooming.
   * At these levels the mean is 96 and the bloom is back to an accent.
   */
  #buildLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xf2f5ff, 0x40362e, 0.45));
    // Warm over the desk, cool over the way in. No shadows: a room this
    // size lit by three lamps does not need a shadow map to read.
    const desk = new THREE.PointLight(0xffe3bf, 9, 12, 2);
    desk.position.set(0, ROOM.height - 0.4, DESK.front - 0.3);
    const hall = new THREE.PointLight(0xdce9ff, 6, 12, 2);
    hall.position.set(0, ROOM.height - 0.4, 2.2);
    this.scene.add(desk, hall);
  }

  /** A chair per CEO, and on the desk in front of each a pad and a strip in its colour. */
  #rebuildSeating(): void {
    for (const child of [...this.#seating.children]) {
      this.#seating.remove(child);
      disposeTree(child);
    }
    this.#pads = [];
    const chairMat = new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.5, metalness: 0.3 });
    const chairs: THREE.BufferGeometry[] = [];
    this.#providers.forEach((provider, i) => {
      const x = this.#seats[i] ?? 0;
      const seat = new THREE.BoxGeometry(0.8, 0.08, 0.6);
      seat.translate(x, SEAT_Y - 0.04, SEAT_Z - 0.12);
      const post = new THREE.CylinderGeometry(0.06, 0.06, SEAT_Y - 0.08, 8);
      post.translate(x, (SEAT_Y - 0.08) / 2 + 0.04, SEAT_Z - 0.12);
      const foot = new THREE.CylinderGeometry(0.34, 0.34, 0.04, 16);
      foot.translate(x, 0.02, SEAT_Z - 0.12);
      const back = new THREE.BoxGeometry(0.8, 0.9, 0.08);
      back.translate(x, SEAT_Y + 0.5, SEAT_Z - 0.5);
      chairs.push(seat, post, foot, back);

      const color = new THREE.Color(PROVIDER_COLOR[provider]);
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.03, 0.02),
        new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.5) }),
      );
      strip.position.set(x, DESK.top - 0.1, DESK.front + 0.005);
      const material = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(0.55) });
      const padMesh = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.012, 0.32), material);
      padMesh.position.set(x, DESK.top + 0.006, DESK.back + 0.3);
      this.#pads.push({ provider, material });
      this.#seating.add(strip, padMesh);
    });
    if (chairs.length) this.#seating.add(new THREE.Mesh(mergeAll(chairs), chairMat));
    else chairMat.dispose();
  }

  dispose(): void {
    this.#crew.dispose();
    this.#visitor?.dispose();
    disposeTree(this.scene);
  }
}

/**
 * The room's reflections: three's neutral studio, prefiltered once. The
 * colony's environment is its sky, and a helmet in here reflecting the
 * sunset through the ceiling read as a hole in the roof.
 */
export function roomReflections(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const texture = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  pmrem.dispose();
  return texture;
}

/** Merge parts that share a material; every part must carry the same attributes. */
function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('interior: could not merge the room');
  for (const g of parts) g.dispose();
  return merged;
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      const m: THREE.Material | THREE.Material[] = o.material;
      if (Array.isArray(m)) for (const x of m) x.dispose();
      else m.dispose();
    }
  });
}
