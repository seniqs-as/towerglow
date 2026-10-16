import { CLOSE_ICON, EDIT_ICON, FOLDER_ICON, INFO_ICON, iconButton } from './icons.ts';

export interface ProjectMenuActions {
  /** The project's details: how tall it stands, and the files and folders that make it so. */
  onInfo: (projectId: string) => void;
  /** `name: null` brings back the real name. */
  onRename: (projectId: string, name: string | null) => void;
  onHide: (projectId: string) => void;
  onReveal: (projectId: string) => void;
}

/** Pixels between the label and the icons: small enough to cross before the menu closes. */
const MENU_GAP = 4;

/**
 * Details, rename and disable for ANY project, on or off.
 *
 * The same two actions used to live only in the session badge's tooltip, and
 * that badge exists only where someone is working: idle projects -- which
 * are most of the city, and the ones you most often want to rename or get
 * out of the way -- could not be reached at all.
 *
 * The menu opens on hovering the project's nameplate, that is, where the name
 * is read: it is the same principle as inline renaming, applied to an
 * element that previously did not even take the mouse.
 *
 * Only the icons, beside the label. The menu used to repeat the name in a
 * box of its own just above it: two copies of the same word, one on top of
 * the other, for a hover. The label is already the name; the rename field
 * opens over it, where the name is read.
 */
export class ProjectMenu {
  #root: HTMLElement;
  /** Holds the rename field; out of the row while nobody is renaming. */
  #body: HTMLElement;
  #input: HTMLInputElement;
  #act: ProjectMenuActions;
  #openFor: { id: string; name: string } | null = null;
  #reveal: HTMLButtonElement;
  #anchor: HTMLElement | null = null;
  #closeTimer: ReturnType<typeof setTimeout> | null = null;
  #editing = false;

  constructor(host: HTMLElement, actions: ProjectMenuActions) {
    this.#act = actions;

    this.#root = document.createElement('div');
    this.#root.className = 'pmenu';
    this.#root.hidden = true;

    this.#input = document.createElement('input');
    this.#input.className = 'pmenu__input';
    this.#input.type = 'text';
    this.#input.maxLength = 48;
    this.#input.hidden = true;
    this.#input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.#commit();
      else if (e.key === 'Escape') this.#stopEditing();
    });
    this.#input.addEventListener('blur', () => this.#stopEditing());

    // First, as in the badge's bubble: a tower with nobody on it has no
    // badge, and its numbers would otherwise be nowhere (the user's request,
    // 2026-10-16).
    const info = iconButton('pmenu__info', 'Show this project\'s details', INFO_ICON);
    info.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = this.#openFor;
      if (open) this.#act.onInfo(open.id);
    });

    this.#reveal = iconButton('pmenu__reveal', 'Open this folder', FOLDER_ICON);
    this.#reveal.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = this.#openFor;
      if (open) this.#act.onReveal(open.id);
    });

    const edit = iconButton('pmenu__edit', 'Rename this project', EDIT_ICON);
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#startEditing();
    });

    const hide = iconButton('pmenu__hide', 'Disable this project', CLOSE_ICON);
    hide.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = this.#openFor;
      if (open) this.#act.onHide(open.id);
      this.close();
    });

    this.#body = document.createElement('span');
    this.#body.className = 'pmenu__body';
    this.#body.hidden = true;
    this.#body.append(this.#input);

    const bar = document.createElement('span');
    bar.className = 'pmenu__actions';
    bar.append(info, this.#reveal, edit, hide);

    this.#root.append(this.#body, bar);
    // The menu takes the mouse, the container does not: twenty pixels of
    // invisible panel are enough to make rotating the camera impossible.
    this.#root.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.#root.addEventListener('pointerenter', () => this.#cancelClose());
    this.#root.addEventListener('pointerleave', () => this.#scheduleClose());
    host.appendChild(this.#root);
  }

  /** The project the menu is open on, if it is open. */
  get openFor(): string | null {
    return this.#openFor?.id ?? null;
  }

  /**
   * Opens the menu beside the nameplate.
   *
   * The anchor is the element, not its coordinates: the nameplate moves every
   * frame along with the city, and a menu pinned to a position would slide
   * away on its own as soon as you touch the camera.
   */
  open(projectId: string, name: string, anchor: HTMLElement, onDisk = true): void {
    this.#cancelClose();
    if (this.#openFor?.id !== projectId) this.#stopEditing(false);
    this.#openFor = { id: projectId, name };
    // A project gone from disk has no folder to open: the button is not
    // there, rather than being there and doing nothing.
    this.#reveal.hidden = !onDisk;
    this.#anchor = anchor;
    this.#root.hidden = false;
    this.place();
  }

  /** Re-reads the position: the nameplate underneath has moved. */
  place(): void {
    if (this.#root.hidden || !this.#anchor) return;
    if (this.#anchor.hidden) {
      // The nameplate has left the scene: the menu must not hang in mid-air.
      if (!this.#editing) this.close();
      return;
    }
    const r = this.#anchor.getBoundingClientRect();
    const w = this.#root.offsetWidth;
    let x: number;
    if (this.#editing) {
      // The field lies over the label, starting where the name starts.
      x = r.left - (this.#input.getBoundingClientRect().left - this.#root.getBoundingClientRect().left);
    } else {
      // To the right of the name; to its left when the right edge has no room.
      x = r.right + MENU_GAP;
      if (x + w > window.innerWidth - 8) x = r.left - MENU_GAP - w;
    }
    x = Math.min(Math.max(x, 8), window.innerWidth - w - 8);
    const y = Math.max(4, r.top + r.height / 2 - this.#root.offsetHeight / 2);
    this.#root.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }

  /** Called when the mouse leaves the nameplate: it closes, but not right away. */
  scheduleClose(): void {
    this.#scheduleClose();
  }

  close(): void {
    this.#cancelClose();
    this.#stopEditing(false);
    this.#openFor = null;
    this.#anchor = null;
    this.#root.hidden = true;
  }

  /**
   * Outcome of the open, shown on the button that asked for it.
   *
   * The folder opens OUTSIDE the page: without a sign here you would not know
   * whether anything happened or the click got lost.
   */
  reportReveal(projectId: string, ok: boolean, reason: string | null): void {
    if (this.#openFor?.id !== projectId) return;
    this.#reveal.dataset['state'] = ok ? 'ok' : 'fail';
    if (!ok && reason) this.#reveal.title = reason;
    setTimeout(() => {
      delete this.#reveal.dataset['state'];
      this.#reveal.title = 'Open this folder';
    }, 1800);
  }

  #startEditing(): void {
    if (!this.#openFor) return;
    this.#editing = true;
    this.#cancelClose();
    this.#input.value = this.#openFor.name;
    // At least as wide as the label it covers, or the name shows past its end.
    const label = this.#anchor?.offsetWidth ?? 0;
    this.#input.style.width = `${Math.max(label, 140)}px`;
    this.#body.hidden = false;
    this.#input.hidden = false;
    this.#input.focus();
    this.#input.select();
    this.place();
  }

  #commit(): void {
    const open = this.#openFor;
    const text = this.#input.value.trim();
    // Emptying the field is not an error: it is the way to say "put the real
    // name back", without having to remember it.
    if (open) this.#act.onRename(open.id, text.length > 0 ? text : null);
    this.#stopEditing();
  }

  #stopEditing(reschedule = true): void {
    if (!this.#editing) return;
    this.#editing = false;
    this.#input.hidden = true;
    this.#body.hidden = true;
    if (reschedule) this.#scheduleClose();
  }

  #cancelClose(): void {
    if (this.#closeTimer === null) return;
    clearTimeout(this.#closeTimer);
    this.#closeTimer = null;
  }

  #scheduleClose(): void {
    // While you rename, the menu does not close: you would lose what you type.
    if (this.#editing) return;
    this.#cancelClose();
    this.#closeTimer = setTimeout(() => this.close(), 260);
  }
}
