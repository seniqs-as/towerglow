import type { SettingsStorage } from '../core/settings.ts';
import { CHEVRON_ICON } from './icons.ts';

/**
 * The two top corners of the HUD fold away behind a chevron.
 *
 * Watching the colony work is what the page is for, and the counters on the
 * left and the quota on the right sit over the sky whether anyone reads them
 * or not. A folded corner keeps only what it cannot lose: the chevron that
 * brings it back and, on the left, the link dot, which is how a dropped
 * connection shows.
 *
 * Remembered per browser under a key of its own, not in `Settings`: it is
 * where this viewer likes the chrome, not how the world looks, and the
 * settings panel has no business offering it. Nothing here touches the DOM
 * until `foldCorners` is called, so the storage half runs in Node.
 */

export type Corner = 'left' | 'right';
export type Folded = Readonly<Record<Corner, boolean>>;

export const FOLD_KEY = 'towerglow.fold.v1';

const OPEN: Folded = { left: false, right: false };

/**
 * What the viewer left folded. Anything unreadable -- no storage, a private
 * window that throws, a value from some other version -- opens both corners:
 * a HUD that hides itself for a reason nobody can see is the worse mistake.
 */
export function readFolded(storage: SettingsStorage | null): Folded {
  if (!storage) return OPEN;
  try {
    const raw = storage.getItem(FOLD_KEY);
    if (!raw) return OPEN;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return OPEN;
    const p = parsed as Record<string, unknown>;
    return { left: p['left'] === true, right: p['right'] === true };
  } catch {
    return OPEN;
  }
}

export function writeFolded(storage: SettingsStorage | null, folded: Folded): void {
  if (!storage) return;
  try {
    storage.setItem(FOLD_KEY, JSON.stringify(folded));
  } catch {
    // Quota or a private window: the fold still works, it is just forgotten.
  }
}

export interface FoldTarget {
  /** What folds away. */
  body: HTMLElement;
  /** The chevron that folds it; it stays where it is either way. */
  button: HTMLButtonElement;
}

export function foldCorners(targets: Readonly<Record<Corner, FoldTarget>>, storage: SettingsStorage | null): void {
  let folded = readFolded(storage);
  for (const corner of ['left', 'right'] as const) {
    const { body, button } = targets[corner];
    button.innerHTML = CHEVRON_ICON;
    button.setAttribute('aria-controls', body.id);
    const paint = (): void => {
      const shut = folded[corner];
      body.hidden = shut;
      button.setAttribute('aria-expanded', String(!shut));
      const label = shut ? 'Show panel' : 'Hide panel';
      button.title = label;
      button.setAttribute('aria-label', label);
    };
    paint();
    button.addEventListener('click', () => {
      folded = { ...folded, [corner]: !folded[corner] };
      writeFolded(storage, folded);
      paint();
    });
  }
}
