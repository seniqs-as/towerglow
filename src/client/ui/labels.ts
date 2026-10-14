import * as THREE from 'three';
import type { Layer } from '../world/stage.ts';

export type LabelKind = 'project' | 'hq' | 'commit';

export interface LabelItem {
  id: string;
  text: string;
  kind: LabelKind;
  position: THREE.Vector3;
  /** Rises above the building: without this the nameplate ends up inside the volume. */
  offsetY: number;
  /**
   * Pixels up and across from that point, as a badge has: what hangs over a
   * session's badge must clear it at every distance, which no world offset
   * does.
   */
  lift?: number;
  shift?: number;
  /**
   * The nameplate takes the mouse and opens a menu.
   *
   * Applies to projects: it is the only way to reach the ones that are OFF,
   * which have no session badge to go through -- and they are most of the
   * city.
   */
  interactive?: boolean;
  /** Distance beyond which this nameplate disappears. Used for file names,
   *  which only make sense up close. */
  maxDistance?: number;
  /**
   * Who wins when two nameplates compete for the same space.
   * Lower = more important. An agent that is running counts for more than
   * the name of an idle project, even if its building is farther away.
   */
  priority?: number;
}

export interface LabelHover {
  onEnter: (item: LabelItem, node: HTMLElement) => void;
  onLeave: (item: LabelItem) => void;
  onClick?: (item: LabelItem) => void;
}

/** Beyond this number the nameplates stop being information and become noise. */
const MAX_VISIBLE = 26;
/**
 * Beyond this distance the nameplates do not hide: they all collapse onto
 * the horizon line and pile up. With the camera high the horizon is at the
 * top of the screen, so the distance limit is the only effective defence.
 */
const MAX_DISTANCE = 420;
/** Corner taken by the HUD: nameplates that end up under it are unreadable. */
const HUD_W = 320;
const HUD_H = 165;
/**
 * How much a nameplate dims at its distance limit. It was 0.55: a far tower's
 * name sat at 45% opacity, pale cyan on a see-through plate, and the city's
 * names were the hardest thing on screen to read. The plate is the map, so
 * distance only hints at depth.
 */
const FAR_FADE = 0.15;

/**
 * What a project's nameplate says: its name, in capitals whatever case it was
 * typed in. The capitals used to be only a `text-transform` in the stylesheet,
 * so the text itself kept the case of a rename, and anything that did not go
 * through that one rule -- the rename field over the plate, a measurement --
 * read it in lower case.
 */
export function projectPlateText(name: string, exists: boolean): string {
  return (exists ? name : `${name} (gone)`).toUpperCase();
}

/**
 * Nameplates as projected DOM elements, not 3D text.
 *
 * No FontLoader and no glyph atlas: they would be resources to load and one
 * more risk under a `default-src 'none'` CSP. The DOM gives crisp text at
 * every resolution and costs nothing, as long as the count stays low.
 */
export class Labels implements Layer {
  readonly object3d: THREE.Group;
  #root: HTMLElement;
  #camera: THREE.Camera;
  #nodes = new Map<string, HTMLElement>();
  #items: LabelItem[] = [];
  #v = new THREE.Vector3();
  #view = new THREE.Vector3();
  #camPos = new THREE.Vector3();
  #ranked: { item: LabelItem; d2: number }[] = [];
  #candidates: (Candidate & { node: HTMLElement; spot: { x: number; y: number; opacity: number } | null })[] = [];
  /** Measured sizes, by id: see `#sizeOf`. */
  #sizes = new Map<string, { w: number; h: number }>();
  /** Who is on screen: gives priority when competing for space. */
  #visible: ReadonlySet<string> = new Set<string>();
  #decideAccum = 0;
  #hover: LabelHover | null;

  constructor(root: HTMLElement, camera: THREE.Camera, hover?: LabelHover) {
    this.object3d = new THREE.Group();
    this.#root = root;
    this.#camera = camera;
    this.#hover = hover ?? null;
  }

  /**
   * Project through another camera: the city and the colony are two views
   * with a camera each, and the nameplates follow whichever is on screen.
   */
  setCamera(camera: THREE.Camera): void {
    this.#camera = camera;
  }

  set(items: readonly LabelItem[]): void {
    this.#items = [...items];
    const wanted = new Set(items.map((i) => i.id));
    for (const [id, node] of this.#nodes) {
      if (wanted.has(id)) continue;
      node.remove();
      this.#nodes.delete(id);
      this.#sizes.delete(id);
    }
    for (const item of items) {
      let node = this.#nodes.get(item.id);
      if (!node) {
        node = document.createElement('div');
        node.className = 'label';
        // It is born HIDDEN. Otherwise it sits for a frame at (0,0) before
        // update() places it, and while moving the view you see flashes in a
        // corner every time a nameplate enters the scene.
        node.hidden = true;
        if (item.interactive && this.#hover) {
          // Listeners are attached AT CREATION, not on every `set`:
          // reattaching them each pass would pile up one per update.
          const hover = this.#hover;
          const self = node;
          node.classList.add('label--interactive');
          node.addEventListener('pointerenter', () => {
            const current = this.#items.find((i) => i.id === item.id);
            if (current) hover.onEnter(current, self);
          });
          node.addEventListener('pointerleave', () => hover.onLeave(item));
          node.addEventListener('click', (e) => {
            e.stopPropagation();
            const current = this.#items.find((i) => i.id === item.id);
            if (current) hover.onClick?.(current);
          });
        }
        this.#root.appendChild(node);
        this.#nodes.set(item.id, node);
      }
      // A new text or kind is a new size: measured again on the next frame.
      if (node.dataset['kind'] !== item.kind || node.textContent !== item.text) this.#sizes.delete(item.id);
      node.dataset['kind'] = item.kind;
      if (node.textContent !== item.text) node.textContent = item.text;
    }
  }

  /**
   * The outcome of an action that happens OUTSIDE the page, on the nameplate
   * that asked for it: without a sign you would not know if anything happened.
   */
  flash(id: string, ok: boolean, reason: string | null): void {
    const node = this.#nodes.get(id);
    if (!node) return;
    node.dataset['outcome'] = ok ? 'ok' : 'fail';
    node.title = ok ? '' : (reason ?? '');
    setTimeout(() => {
      delete node.dataset['outcome'];
      node.title = '';
    }, 1800);
  }

  update(dt: number): void {
    if (this.#items.length === 0) return;

    // The DECISION on who is shown is costly to change: redoing it every frame
    // makes two nameplates competing for the same space alternate while the
    // camera moves, and that is exactly how the flicker is born.
    // The position, on the other hand, is always updated, otherwise the
    // nameplates drag along behind the scene.
    this.#decideAccum += dt;
    const decide = this.#decideAccum >= DECIDE_EVERY;
    if (decide) this.#decideAccum = 0;

    this.#camera.getWorldPosition(this.#camPos);
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.#ranked.length = 0;
    for (const item of this.#items) {
      this.#ranked.push({ item, d2: this.#camPos.distanceToSquared(item.position) });
    }
    // First by importance, then -- at equal importance -- whoever was already
    // visible, and only after that by proximity. That is the hysteresis that
    // keeps the nameplates still: one already on screen is not ousted by one
    // that just arrived.
    this.#ranked.sort(
      (a, b) =>
        (a.item.priority ?? 5) - (b.item.priority ?? 5) ||
        (this.#visible.has(b.item.id) ? 1 : 0) - (this.#visible.has(a.item.id) ? 1 : 0) ||
        a.d2 - b.d2,
    );

    // Where each nameplate would go, before anybody is shown: the choice is
    // made on the whole frame at once (`arrange`), then written to the DOM.
    this.#candidates.length = 0;
    for (let i = 0; i < this.#ranked.length; i++) {
      const { item } = this.#ranked[i]!;
      const node = this.#nodes.get(item.id);
      if (!node) continue;
      const spot = i < MAX_VISIBLE ? this.#project(item, w, h) : null;
      const size = spot ? this.#sizeOf(item.id, node) : null;
      this.#candidates.push({
        id: item.id,
        node,
        spot,
        rect: spot && size ? plateRect(spot.x, spot.y, size.w, size.h) : null,
      });
    }

    const shown = arrange(this.#candidates, this.#visible, decide);
    for (const c of this.#candidates) {
      if (!c.spot || !shown.has(c.id)) {
        hide(c.node);
        continue;
      }
      c.node.hidden = false;
      c.node.style.transform = `translate3d(${Math.round(c.spot.x)}px, ${Math.round(c.spot.y)}px, 0) translate(-50%, -100%)`;
      c.node.style.opacity = String(c.spot.opacity);
    }
    this.#visible = shown;
  }

  /** Where a nameplate lands on screen, or null when it has no place there. */
  #project(item: LabelItem, w: number, h: number): { x: number; y: number; opacity: number } | null {
    this.#v.copy(item.position);
    this.#v.y += item.offsetY;

    // The camera-space test first: project() on a point BEHIND the viewer
    // flips the signs and spits out plausible-looking coordinates.
    this.#view.copy(this.#v).applyMatrix4(this.#camera.matrixWorldInverse);
    const limit = item.maxDistance ?? MAX_DISTANCE;
    if (this.#view.z > -0.5 || this.#view.z < -limit) return null;

    this.#v.project(this.#camera);
    if (this.#v.x < -1 || this.#v.x > 1 || this.#v.y < -1 || this.#v.y > 1) return null;

    const x = (this.#v.x * 0.5 + 0.5) * w + (item.shift ?? 0);
    const y = (-this.#v.y * 0.5 + 0.5) * h - (item.lift ?? 0);
    if (x < 60 || x > w - 60 || y < 24 || y > h - 12) return null;
    if (x < HUD_W && y < HUD_H) return null;

    const fade = 1 - (-this.#view.z / limit) * FAR_FADE;
    return { x, y, opacity: Math.max(1 - FAR_FADE, Math.min(1, fade)) };
  }

  /**
   * A nameplate's size, measured once per text. Read off the node every
   * frame it was 0 whenever the nameplate was hidden (display:none has no
   * box), so a hidden name was tested at a guessed 90 px: it fitted, was
   * shown, measured its real width on the next frame, overlapped its
   * neighbour and hid again -- on and off for as long as two towers stood
   * close on screen. That was the flicker while turning the view.
   */
  #sizeOf(id: string, node: HTMLElement): { w: number; h: number } {
    const known = this.#sizes.get(id);
    if (known) return known;
    const hidden = node.hidden;
    if (hidden) {
      // Laid out but not drawn, for the one read.
      node.style.visibility = 'hidden';
      node.hidden = false;
    }
    const size = { w: node.offsetWidth, h: node.offsetHeight };
    if (hidden) {
      node.hidden = true;
      node.style.visibility = '';
    }
    // Not in the document yet, or the page is not laid out: guess, and
    // measure again next time instead of keeping the guess.
    if (size.w === 0) return { w: 90, h: 16 };
    this.#sizes.set(id, size);
    return size;
  }

  dispose(): void {
    for (const node of this.#nodes.values()) node.remove();
    this.#nodes.clear();
  }
}

/** How often the set of nameplates on screen may change, in seconds. */
export const DECIDE_EVERY = 0.2;

/**
 * How much clear space a hidden nameplate needs around it before it comes
 * back, in pixels. One already shown leaves only when it actually overlaps:
 * with a single threshold, two names sliding past each other while the view
 * turns crossed it back and forth at every decision.
 */
export const ENTRY_MARGIN = 10;

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Candidate {
  id: string;
  /** Its box on screen, or null when it has no place there this frame. */
  rect: Rect | null;
}

/** The box of a nameplate hanging from `x, y` by the middle of its lower edge. */
export function plateRect(x: number, y: number, w: number, h: number): Rect {
  return { x0: x - w / 2 - 3, y0: y - h - 3, x1: x + w / 2 + 3, y1: y + 3 };
}

/**
 * Which nameplates are on screen this frame, from candidates already ranked
 * by who deserves the space.
 *
 * Between two decisions nobody new appears: whoever is shown stays shown
 * while it has a place on screen, and whoever is hidden waits. Before, a
 * hidden name was tested every frame and shown on any frame it happened to
 * fit, then hidden on the next -- that is a flicker by construction. At a
 * decision, whoever fits keeps or takes its space in rank order, a newcomer
 * only with `ENTRY_MARGIN` to spare.
 */
export function arrange(
  candidates: readonly Candidate[],
  visible: ReadonlySet<string>,
  decide: boolean,
): Set<string> {
  const shown = new Set<string>();
  if (!decide) {
    for (const c of candidates) if (c.rect && visible.has(c.id)) shown.add(c.id);
    return shown;
  }
  const placed: Rect[] = [];
  for (const c of candidates) {
    if (!c.rect) continue;
    const pad = visible.has(c.id) ? 0 : ENTRY_MARGIN;
    const r = c.rect;
    const clear = placed.every(
      (p) => r.x0 - pad >= p.x1 || r.x1 + pad <= p.x0 || r.y0 - pad >= p.y1 || r.y1 + pad <= p.y0,
    );
    if (!clear) continue;
    placed.push(r);
    shown.add(c.id);
  }
  return shown;
}

/**
 * display:none, not opacity:0. A nameplate hidden by opacity alone still sits
 * at (0,0), and fifteen overlapping nameplates become readable again as
 * their transparencies add up: that is exactly how the pile in a corner
 * formed.
 */
function hide(node: HTMLElement): void {
  if (!node.hidden) node.hidden = true;
}
