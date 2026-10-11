import * as THREE from 'three';
import type { ProviderId } from '../../shared/protocol.ts';
import type { Layer } from '../world/stage.ts';
import { CLOSE_ICON, EDIT_ICON, FOLDER_ICON, INFO_ICON, ZOOM_ICON, ZOOM_OUT_ICON, iconButton } from './icons.ts';
import { PENDING_MAX_MS } from '../state/pendingFocus.ts';

/** A session's state, reduced to what has to be read at a glance. */
export type BadgeState = 'busy' | 'done' | 'waiting';

export interface BadgeItem {
  id: string;
  /** Where it stands, in world coordinates. */
  position: THREE.Vector3;
  offsetY: number;
  provider: ProviderId;
  state: BadgeState;
  /** State inferred rather than declared by the tool. */
  inferred: boolean;
  /** Horizontal offset in pixels: two sessions on the same roof. */
  shift: number;
  /**
   * How many pixels above its point it floats. A session badge shares its
   * point with the project's name and sits over it: the label is sized in
   * pixels, so a gap in metres would clear it only at one zoom.
   */
  lift: number;
  /** Text that appears on mouse hover. */
  hover: string;
  /**
   * This session's terminal can be brought to the front, and so a click on
   * the badge goes there. Without one the click opens the details instead.
   */
  canFocus: boolean;
  /**
   * What a click on the badge says it does. A worker has no terminal of its
   * own, and the click opens a window that follows it instead: a hover text
   * promising to bring a terminal forward would be describing another action.
   */
  focusTitle: string;
  /** The project it belongs to: the tooltip's actions act on it. */
  projectId: string;
  /** What it is called now: the value a rename starts from. */
  projectName: string;
  /** The project's folder is still on disk. */
  canReveal: boolean;
  /** Context window used, 0-100. `null` = nothing is known about it. */
  contextPct: number | null;
}

export interface BadgeActions {
  onSelect: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
  /** Fly the camera in close to this project, to watch what happens on its deck. */
  onZoom: (projectId: string) => void;
  /** Back out of the project zoomed in on, to every project on the map. */
  onZoomOut: () => void;
  /** `name: null` brings the real name back. */
  onRename: (projectId: string, name: string | null) => void;
  onHide: (projectId: string) => void;
  onReveal: (projectId: string) => void;
}

/** What the terminal button says for a session that has a terminal of its own. */
export const FOCUS_TITLE = 'Bring this terminal to the front';
/** What it says for a worker: it has none, so the button opens a window that follows it. */
export const FOLLOW_TITLE = 'Follow this worker in a Terminal window';
/** What it says for a session with no process left: a new shell opens in its project. */
export const SHELL_TITLE = 'Open a Terminal in this project';

const MAX_DISTANCE = 900;
/**
 * How long the tooltip outlives the mouse leaving the badge.
 *
 * It is needed because the tooltip holds a button: between the edge of the
 * badge and the tooltip there are a few pixels of empty space to cross, and
 * without this wait the tooltip would vanish halfway there, making the
 * button unreachable.
 */
const TIP_GRACE_MS = 220;

/**
 * Badges on the buildings: a symbol, no text.
 *
 * The scene said too much all at once -- a line of text for every session
 * competed with the project names and with the commits. What stays here is
 * the minimum that reads from a distance (working / done / waiting for you),
 * and the rest you get by asking: the text on hover, the details on click.
 */
export class Badges implements Layer {
  readonly object3d: THREE.Group;
  #root: HTMLElement;
  #tip: HTMLElement;
  #camera: THREE.Camera;
  #nodes = new Map<string, HTMLElement>();
  #items = new Map<string, BadgeItem>();
  #act: BadgeActions;
  #tipText: HTMLElement;
  #tipInfo: HTMLButtonElement;
  #tipZoom: HTMLButtonElement;
  /** The project the camera was last flown in on: its lens turns into the way back out. */
  #zoomed: string | null = null;
  #tipFolder: HTMLButtonElement;
  #tipEdit: HTMLButtonElement;
  #tipHide: HTMLButtonElement;
  #tipInput: HTMLInputElement;
  #closeTimer: ReturnType<typeof setTimeout> | null = null;
  /** While you rename, the tooltip does not close: you would lose what you type. */
  #editing = false;
  #v = new THREE.Vector3();
  #view = new THREE.Vector3();
  #hovered: string | null = null;
  #focusTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(root: HTMLElement, camera: THREE.Camera, actions: BadgeActions) {
    this.object3d = new THREE.Group();
    this.#root = root;
    this.#camera = camera;
    this.#act = actions;

    this.#tip = document.createElement('div');
    this.#tip.className = 'badge-tip';
    this.#tip.hidden = true;

    this.#tipText = document.createElement('span');
    this.#tipText.className = 'badge-tip__text';

    this.#tipInput = document.createElement('input');
    this.#tipInput.className = 'badge-tip__input';
    this.#tipInput.type = 'text';
    this.#tipInput.maxLength = 48;
    this.#tipInput.hidden = true;
    this.#tipInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.#commitRename();
      else if (e.key === 'Escape') this.#stopEditing();
    });
    this.#tipInput.addEventListener('blur', () => this.#stopEditing());

    // The terminal is the badge's own click (the thing you want most often,
    // one gesture away); the details that click used to open live here.
    this.#tipInfo = iconButton('badge-tip__info', 'Show this session\'s details', INFO_ICON);
    this.#tipInfo.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.#hovered) this.#act.onSelect(this.#hovered);
    });

    // Right after the details: they say what the session is doing, the zoom
    // is where you watch it do it.
    this.#tipZoom = iconButton('badge-tip__zoom', 'Zoom in on this project', ZOOM_ICON);
    this.#tipZoom.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = this.#hovered ? this.#items.get(this.#hovered) : undefined;
      if (!item) return;
      if (item.projectId === this.#zoomed) this.#act.onZoomOut();
      else this.#act.onZoom(item.projectId);
    });

    this.#tipFolder = iconButton('badge-tip__folder', 'Open this folder', FOLDER_ICON);
    this.#tipFolder.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = this.#hovered ? this.#items.get(this.#hovered) : undefined;
      if (item) this.#act.onReveal(item.projectId);
    });

    this.#tipEdit = iconButton('badge-tip__edit', 'Rename this project', EDIT_ICON);
    this.#tipEdit.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#startEditing();
    });

    this.#tipHide = iconButton('badge-tip__hide', 'Disable this project', CLOSE_ICON);
    this.#tipHide.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = this.#hovered ? this.#items.get(this.#hovered) : undefined;
      if (item) this.#act.onHide(item.projectId);
      this.#hideTip();
    });

    const actionsBar = document.createElement('div');
    actionsBar.className = 'badge-tip__actions';
    // All of them here: this is the only place you need to look at for a live
    // session, and the project nameplate below must not repeat the same
    // actions a centimetre away. Which ones show is up to `#showTip`.
    actionsBar.append(this.#tipInfo, this.#tipZoom, this.#tipFolder, this.#tipEdit, this.#tipHide);

    const column = document.createElement('div');
    column.className = 'badge-tip__body';
    column.append(this.#tipText, this.#tipInput);

    this.#tip.append(column, actionsBar);
    // The tooltip hosts a button, so it has to be able to take the mouse --
    // but only the tooltip: the container stays transparent to clicks,
    // otherwise an invisible full-screen panel would stop you orbiting.
    this.#tip.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.#tip.addEventListener('pointerenter', () => this.#cancelClose());
    this.#tip.addEventListener('pointerleave', () => this.#scheduleClose());
    this.#root.appendChild(this.#tip);
  }

  /**
   * Project through another camera: the city and the colony are two views
   * with a camera each, and the nameplates follow whichever is on screen.
   */
  setCamera(camera: THREE.Camera): void {
    this.#camera = camera;
  }

  set(items: readonly BadgeItem[]): void {
    this.#items = new Map(items.map((i) => [i.id, i]));

    for (const [id, node] of this.#nodes) {
      if (this.#items.has(id)) continue;
      node.remove();
      this.#nodes.delete(id);
      clearTimeout(this.#focusTimers.get(id));
      this.#focusTimers.delete(id);
      if (this.#hovered === id) this.#hideTip();
    }

    for (const item of items) {
      let node = this.#nodes.get(item.id);
      if (!node) {
        const button = document.createElement('button');
        button.className = 'badge';
        button.type = 'button';
        // Born hidden: otherwise it sits for a frame in the top corner before
        // being placed, and that is how on-screen flashes are born.
        button.hidden = true;
        button.innerHTML = ICONS;
        button.addEventListener('pointerenter', () => {
          this.#cancelClose();
          this.#showTip(item.id);
        });
        button.addEventListener('pointerleave', () => this.#scheduleClose());
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          // Read at click time, not captured: the item is replaced on every
          // `set`, and a session can gain or lose its terminal meanwhile.
          const current = this.#items.get(item.id);
          if (current?.canFocus) this.#act.onFocus(item.id);
          else this.#act.onSelect(item.id);
        });
        this.#root.appendChild(button);
        this.#nodes.set(item.id, button);
        node = button;
      }
      node.dataset['provider'] = item.provider;
      node.dataset['state'] = item.state;
      // The context is an arc around the circle. No data, no arc: a zero
      // would say "empty context", which is a different thing.
      if (item.contextPct === null) {
        delete node.dataset['ctx'];
      } else {
        const pct = Math.round(item.contextPct);
        node.style.setProperty('--ctx', String(pct));
        node.dataset['ctx'] = pct >= 90 ? 'full' : pct >= 75 ? 'high' : 'ok';
      }
      node.dataset['inferred'] = item.inferred ? 'yes' : 'no';
      // The hover text is the bubble; the screen reader also hears what the
      // click does, which the bubble leaves to the gesture.
      node.setAttribute('aria-label', item.canFocus ? `${item.hover}. ${item.focusTitle}` : item.hover);
      // No native tooltip on top of the bubble, except the reason a jump
      // failed, which stays until the badge settles.
      if (node.dataset['focus'] === undefined) node.setAttribute('title', '');
    }

    if (this.#hovered) this.#showTip(this.#hovered);
  }

  #showTip(id: string): void {
    const item = this.#items.get(id);
    const node = this.#nodes.get(id);
    if (!item || !node || node.hidden) return;
    this.#hovered = id;
    if (this.#tipText.textContent !== item.hover) this.#tipText.textContent = item.hover;
    // A button that can do nothing is hidden rather than shown disabled: one
    // that is there and does nothing costs more attention than one that is not.
    // Without a terminal the badge's click already opens the details.
    this.#tipInfo.hidden = !item.canFocus;
    this.#setZoomIcon(item.projectId === this.#zoomed);
    this.#tipFolder.hidden = !item.canReveal;
    this.#tip.dataset['provider'] = item.provider;
    this.#tip.hidden = false;

    const r = node.getBoundingClientRect();
    const w = this.#tip.offsetWidth;
    const x = Math.min(Math.max(r.left + r.width / 2 - w / 2, 8), window.innerWidth - w - 8);
    const y = Math.max(4, r.top - this.#tip.offsetHeight - 6);
    this.#tip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }

  /**
   * Which project the camera is zoomed in on, or null once it framed
   * something else. An open tip flips its lens at once: the click that zoomed
   * in is still under the pointer, and the next one should go back out.
   */
  setZoomed(projectId: string | null): void {
    this.#zoomed = projectId;
    if (this.#hovered && !this.#tip.hidden) this.#showTip(this.#hovered);
  }

  #setZoomIcon(out: boolean): void {
    const mode = out ? 'out' : 'in';
    if (this.#tipZoom.dataset['mode'] === mode) return;
    this.#tipZoom.dataset['mode'] = mode;
    this.#tipZoom.innerHTML = out ? ZOOM_OUT_ICON : ZOOM_ICON;
    const label = out ? 'Zoom out to every project' : 'Zoom in on this project';
    this.#tipZoom.title = label;
    this.#tipZoom.setAttribute('aria-label', label);
  }

  /** Swaps the text for a field: you rename where you read the name. */
  #startEditing(): void {
    const item = this.#hovered ? this.#items.get(this.#hovered) : undefined;
    if (!item) return;
    this.#editing = true;
    this.#cancelClose();
    this.#tipInput.value = item.projectName;
    this.#tipText.hidden = true;
    this.#tipInput.hidden = false;
    this.#tipInput.focus();
    this.#tipInput.select();
  }

  #commitRename(): void {
    const item = this.#hovered ? this.#items.get(this.#hovered) : undefined;
    const text = this.#tipInput.value.trim();
    if (item) {
      // Clearing the field is not an error: it is how you say "put the real
      // name back", without having to remember what it was.
      this.#act.onRename(item.projectId, text.length > 0 ? text : null);
    }
    this.#stopEditing();
  }

  #stopEditing(): void {
    if (!this.#editing) return;
    this.#editing = false;
    this.#tipInput.hidden = true;
    this.#tipText.hidden = false;
    this.#scheduleClose();
  }

  #cancelClose(): void {
    if (this.#closeTimer === null) return;
    clearTimeout(this.#closeTimer);
    this.#closeTimer = null;
  }

  #scheduleClose(): void {
    if (this.#editing) return;
    this.#cancelClose();
    this.#closeTimer = setTimeout(() => this.#hideTip(), TIP_GRACE_MS);
  }

  #hideTip(): void {
    this.#cancelClose();
    this.#hovered = null;
    this.#tip.hidden = true;
  }

  update(): void {
    if (this.#items.size === 0) return;
    const w = window.innerWidth;
    const h = window.innerHeight;

    for (const item of this.#items.values()) {
      const node = this.#nodes.get(item.id);
      if (!node) continue;

      this.#v.copy(item.position);
      this.#v.y += item.offsetY;
      // Depth test in camera space: `project()` on a point BEHIND the viewer
      // flips the signs and would make it reappear on screen.
      this.#view.copy(this.#v).applyMatrix4(this.#camera.matrixWorldInverse);
      if (this.#view.z > -0.5 || this.#view.z < -MAX_DISTANCE) {
        this.#hide(node, item.id);
        continue;
      }

      this.#v.project(this.#camera);
      if (this.#v.x < -1.1 || this.#v.x > 1.1 || this.#v.y < -1.1 || this.#v.y > 1.1) {
        this.#hide(node, item.id);
        continue;
      }

      const x = Math.round((this.#v.x * 0.5 + 0.5) * w + item.shift);
      const y = Math.round((-this.#v.y * 0.5 + 0.5) * h - item.lift);
      if (node.hidden) node.hidden = false;
      node.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
    }

    if (this.#hovered) this.#showTip(this.#hovered);
  }

  #hide(node: HTMLElement, id: string): void {
    if (!node.hidden) node.hidden = true;
    if (this.#hovered === id) this.#hideTip();
  }

  /** Outcome of opening the folder, on the button that asked for it. */
  reportReveal(projectId: string, ok: boolean, reason: string | null): void {
    const item = this.#hovered ? this.#items.get(this.#hovered) : undefined;
    if (!item || item.projectId !== projectId) return;
    this.#tipFolder.dataset['state'] = ok ? 'ok' : 'fail';
    if (!ok && reason) this.#tipFolder.title = reason;
    setTimeout(() => {
      delete this.#tipFolder.dataset['state'];
      this.#tipFolder.title = 'Open this folder';
    }, 1800);
  }

  /**
   * The jump has left and the terminal is not there yet: the ring turns
   * until the answer, which takes a couple of seconds (see `PendingFocus`).
   */
  markFocusPending(sessionId: string): void {
    const node = this.#nodes.get(sessionId);
    if (!node) return;
    this.#setFocus(sessionId, node, 'pending', 'Opening the terminal…', PENDING_MAX_MS);
  }

  /** Outcome of the jump to the terminal, shown on the badge that asked for it. */
  reportFocus(sessionId: string, ok: boolean, reason: string | null): void {
    const node = this.#nodes.get(sessionId);
    if (!node) return;
    this.#setFocus(sessionId, node, ok ? 'ok' : 'fail', !ok && reason ? reason : '', 1800);
  }

  /**
   * One timer per badge: the outcome of a jump used to clear the ring 1.8 s
   * later whatever it showed by then, the next jump's wait included.
   */
  #setFocus(id: string, node: HTMLElement, state: string, title: string, ms: number): void {
    const prev = this.#focusTimers.get(id);
    if (prev !== undefined) clearTimeout(prev);
    node.dataset['focus'] = state;
    node.title = title;
    this.#focusTimers.set(id, setTimeout(() => {
      this.#focusTimers.delete(id);
      delete node.dataset['focus'];
      node.title = '';
    }, ms));
  }

  dispose(): void {
    this.#cancelClose();
    for (const t of this.#focusTimers.values()) clearTimeout(t);
    this.#focusTimers.clear();
    for (const node of this.#nodes.values()) node.remove();
    this.#nodes.clear();
    this.#tip.remove();
  }
}

/**
 * The context arc: a circle with `pathLength=100`, so the percentage becomes
 * the length of the stroke directly, with no per-frame maths.
 */
const CONTEXT_ARC =
  '<svg class="badge__ctx" viewBox="0 0 44 44" aria-hidden="true">' +
  '<circle class="badge__ctx-track" cx="22" cy="22" r="20" pathLength="100"/>' +
  '<circle class="badge__ctx-fill" cx="22" cy="22" r="20" pathLength="100"/></svg>';

const ICONS =
  CONTEXT_ARC +
  '<svg class="badge__icon badge__bolt" viewBox="0 0 8 12" aria-hidden="true">' +
  '<path d="M5.2 0 0 6.9h2.9L2.4 12 8 4.8H4.7z" fill="currentColor"/></svg>' +
  '<svg class="badge__icon badge__check" viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M3 8.4l3.4 3.4L13.2 5" fill="none" stroke="currentColor" stroke-width="2.1" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>' +
  '<svg class="badge__icon badge__alert" viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M8 1.8 15.2 14.2H0.8z" fill="none" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linejoin="round"/><path d="M8 6.2v3.3" stroke="currentColor" stroke-width="1.7" ' +
  'stroke-linecap="round"/><circle cx="8" cy="11.9" r="0.95" fill="currentColor"/></svg>';



