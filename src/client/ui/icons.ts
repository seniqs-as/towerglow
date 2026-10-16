/**
 * The interface's glyphs, inline.
 *
 * Under a `default-src 'none'` CSP nothing loads from outside, and an emoji
 * character would impose the system palette instead of following the colour
 * of its context. They are strokes on `currentColor`, so they tint themselves
 * orange or white depending on what hosts them.
 */

/** Two angle brackets: the sign that means code everywhere. */
export const CODE_ICON =
  '<svg viewBox="0 0 20 14" aria-hidden="true">' +
  '<path d="M6.6 2.6 2 7l4.6 4.4M13.4 2.6 18 7l-4.6 4.4" fill="none" stroke="currentColor" ' +
  'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** A circled "i": a session's or a project's details, in the panel at the bottom right. */
export const INFO_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
  '<path d="M8 7.2v4.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>' +
  '<circle cx="8" cy="4.9" r="0.95" fill="currentColor"/></svg>';

/** A magnifier with a plus: fly the camera in close to one project. */
export const ZOOM_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<circle cx="6.8" cy="6.8" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
  '<path d="M10.2 10.2 14.3 14.3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>' +
  '<path d="M4.8 6.8h4M6.8 4.8v4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

/** The same magnifier with a minus: back out from one project to all of them. */
export const ZOOM_OUT_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<circle cx="6.8" cy="6.8" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
  '<path d="M10.2 10.2 14.3 14.3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>' +
  '<path d="M4.8 6.8h4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

/** Pencil: rename. */
export const EDIT_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M11.2 1.9 14.1 4.8 5.4 13.5 1.8 14.2 2.5 10.6z" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linejoin="round"/></svg>';

/** Cross: take out of view. Not a bin, because it deletes nothing. */
export const CLOSE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M3.6 3.6 12.4 12.4M12.4 3.6 3.6 12.4" fill="none" stroke="currentColor" ' +
  'stroke-width="1.9" stroke-linecap="round"/></svg>';

/**
 * Folder: opens the project in the file manager.
 *
 * It is there to answer "what was this?" for a project idle for months, when
 * the name alone is no longer enough to remember it.
 */
export const FOLDER_ICON =
  '<svg viewBox="0 0 16 14" aria-hidden="true">' +
  '<path d="M1.2 12V2.2h4.4l1.5 1.9h7.7V12z" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linejoin="round"/></svg>';

/**
 * A sheet with lines on it: the outcome of a job.
 *
 * Not a magnifier nor an arrow: what opens is a text written by whoever
 * worked for you, and the sheet is the sign that means a text.
 */
export const REPORT_ICON =
  '<svg viewBox="0 0 14 16" aria-hidden="true">' +
  '<path d="M2 1.2h6.6L12 4.6V14.8H2z" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linejoin="round"/>' +
  '<path d="M4.4 7.4h5.2M4.4 10h5.2M4.4 12.2h3.2" fill="none" stroke="currentColor" ' +
  'stroke-width="1.4" stroke-linecap="round"/></svg>';

/** A chevron pointing up: fold a corner away. Turned over by CSS once it is folded. */
export const CHEVRON_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M3.5 10.2 8 5.8l4.5 4.4" fill="none" stroke="currentColor" ' +
  'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* The HUD's buttons. Each one used to be a word; the word is now the hover
   text, so a glyph only has to be told apart from its neighbours, not to
   explain itself. */

/** Three bars on a baseline: statistics. */
export const STATS_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M2 14h12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
  '<path d="M4.5 11.5V8M8 11.5V3.5M11.5 11.5V6" fill="none" stroke="currentColor" ' +
  'stroke-width="2.2" stroke-linecap="round"/></svg>';

/** A gauge: will the quota last until it renews, at this pace. */
export const FORECAST_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M2 11.5a6 6 0 0 1 12 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
  '<path d="M8 11.5l3.1-3.7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
  '<circle cx="8" cy="11.5" r="1.3" fill="currentColor"/></svg>';

/** Swatches beside lines: what every colour and sign means. */
export const LEGEND_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<circle cx="3" cy="4" r="1.5" fill="currentColor"/>' +
  '<circle cx="3" cy="8" r="1.5" fill="currentColor"/>' +
  '<circle cx="3" cy="12" r="1.5" fill="currentColor"/>' +
  '<path d="M6.5 4h7.5M6.5 8h7.5M6.5 12h7.5" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round"/></svg>';

/** Sliders, because the settings panel is mostly sliders. */
export const SETTINGS_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M2 4h12M2 8h12M2 12h12" fill="none" stroke="currentColor" ' +
  'stroke-width="1.3" stroke-linecap="round"/>' +
  '<circle cx="10.5" cy="4" r="1.9" fill="currentColor"/>' +
  '<circle cx="5" cy="8" r="1.9" fill="currentColor"/>' +
  '<circle cx="11" cy="12" r="1.9" fill="currentColor"/></svg>';

/** A question mark in a ring: how to move around the colony. */
export const HELP_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
  '<path d="M6.1 6.2a1.95 1.95 0 1 1 2.7 1.8c-.5.2-.8.6-.8 1.1v.6" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<circle cx="8" cy="11.5" r="0.95" fill="currentColor"/></svg>';

/** A speech bubble: the board is where you talk to the CEOs. */
export const BOARD_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M1.8 2.6h12.4v8H7.4L4.2 13.6v-3H1.8z" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linejoin="round"/>' +
  '<circle cx="5.2" cy="6.6" r="0.95" fill="currentColor"/>' +
  '<circle cx="8" cy="6.6" r="0.95" fill="currentColor"/>' +
  '<circle cx="10.8" cy="6.6" r="0.95" fill="currentColor"/></svg>';

/** A rising line on two axes: how the project went in the weeks after. */
export const EFFECT_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M2 2v12h12" fill="none" stroke="currentColor" stroke-width="1.4" ' +
  'stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M4.8 10.6 7.6 7.6l2.1 2.1 3.8-4.5M10.9 5.2h2.6v2.6" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** A list with a tick: the plan, and what is done of it. */
export const PLAN_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M6.5 4h7.5M6.5 8h7.5M6.5 12h7.5" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round"/>' +
  '<path d="M1.6 4.3l1.2 1.2 2-2.3M1.6 8.3l1.2 1.2 2-2.3M1.6 12.3l1.2 1.2 2-2.3" fill="none" ' +
  'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** An eye struck through: projects taken out of the view. */
export const HIDDEN_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M1.5 8S3.9 3.6 8 3.6 14.5 8 14.5 8 12.1 12.4 8 12.4 1.5 8 1.5 8z" fill="none" ' +
  'stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
  '<circle cx="8" cy="8" r="1.9" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
  '<path d="M2.6 13.4 13.4 2.6" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round"/></svg>';

/** An icon button: the same shell everywhere, a different glyph. */
export function iconButton(cls: string, label: string, icon: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `act ${cls}`;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = icon;
  return b;
}

/**
 * Two stacked blocks, a tall one and a short one: switch between the light
 * city and the full colony. One glyph for both directions; the hover text
 * says which way it goes.
 */
export const VIEW_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M2.5 14.2V6.2h4v8M9.5 14.2V2h4v12.2M1.4 14.4h13.2" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
