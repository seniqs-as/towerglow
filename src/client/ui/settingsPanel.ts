import { PRESETS, PRESET_IDS, systemTimeOfDay } from '../core/settings.ts';
import type { Settings, SettingsValues, SettingKey, PlanetId, PresetId } from '../core/settings.ts';
import { TIMES } from '../world/sky.ts';
import { PLANETS } from '../world/planet.ts';
import { clampPitch, MAX_PITCH, MIN_PITCH, PITCH_STEP } from '../city/layout.ts';

/**
 * The settings: every knob that costs frames, and the world's look.
 *
 * Opens beside the scene like the legend, and for the same reason: a slider
 * is dragged while watching what it does to the colony, and a modal that
 * blurs the scene would hide the one thing the slider is for.
 *
 * Rows come from Bot Crossing's panel, minus the knobs this project has no
 * use for (dormant repos, label and fps toggles: projects are hidden from
 * their menu, the fps sits in the HUD). Every control registers a `sync`
 * that re-reads the settings, so a change made anywhere -- a key, another
 * control, a preset -- shows up here without the panel knowing who made it.
 */

type KeysOf<V> = { [K in SettingKey]: SettingsValues[K] extends V ? K : never }[SettingKey];
type BoolKey = KeysOf<boolean>;
type NumKey = KeysOf<number>;

interface Control {
  sync(): void;
}

/** The planets in the order the P key and the panel step through them. */
export const PLANET_ORDER: readonly PlanetId[] = ['moon', 'mars', 'terra'];

export class SettingsPanel {
  #root: HTMLElement;
  #open = false;
  #controls: Control[] = [];
  #settings: Settings;

  constructor(host: HTMLElement, button: HTMLElement, settings: Settings) {
    this.#settings = settings;
    this.#root = document.createElement('aside');
    this.#root.className = 'settings';
    this.#root.hidden = true;
    this.#root.setAttribute('aria-label', 'Settings');
    this.#root.append(...this.#content());

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
    // Closes on a click outside or on Esc, never on a click inside: the
    // panel is used, not dodged.
    this.#root.addEventListener('click', (e) => e.stopPropagation());
    this.#root.addEventListener('pointerdown', (e) => e.stopPropagation());
    window.addEventListener('pointerdown', (e) => {
      if (!this.#open) return;
      const t = e.target;
      if (t instanceof Node && (this.#root.contains(t) || button.contains(t))) return;
      this.close();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.#open) this.close();
    });

    settings.onChange(() => this.sync());
    host.appendChild(this.#root);
    this.sync();
  }

  get isOpen(): boolean {
    return this.#open;
  }

  toggle(): void {
    if (this.#open) this.close();
    else this.open();
  }

  open(): void {
    this.#open = true;
    this.#root.hidden = false;
    this.sync();
  }

  close(): void {
    this.#open = false;
    this.#root.hidden = true;
  }

  sync(): void {
    for (const c of this.#controls) c.sync();
  }

  /* ───────────────────────── the rows ───────────────────────── */

  #content(): HTMLElement[] {
    const s = this.#settings;
    const groups: HTMLElement[] = [];

    groups.push(group('Quality preset', [
      this.#chips(
        PRESET_IDS.map((id) => ({ id, label: PRESETS[id].label, title: PRESETS[id].hint })),
        () => s.get('preset'),
        (id) => s.applyPreset(id),
      ),
    ]));

    // The one knob of the city view, above the fold: the page opens on the
    // city, and under Performance it sat a full scroll away. It moves on the
    // floor grid, so at every stop each tower meets the lines the same way.
    groups.push(group('City', [
      this.#slider('Tower spacing', 'citySpacing', MIN_PITCH, MAX_PITCH, PITCH_STEP, (v) => String(clampPitch(v)),
        'How far apart the towers of the city view stand. Every project keeps its neighbours.'),
    ]));

    groups.push(group('Performance', [
      this.#toggle('HDR + bloom', 'bloom', 'Glowing lamps, visors and windows. The first thing to drop.'),
      this.#toggle('Tilt-shift', 'tiltShift', 'A shallow depth of field, which is what makes the colony read as a model.'),
      this.#slider('Blur', 'tiltShiftStrength', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      this.#slider('Focus tilt', 'tiltShiftAngle', -45, 45, 1, (v) => `${v}°`),
      this.#select('Shadows', 'shadows', [
        ['off', 'Off'], ['low', 'Soft'], ['high', 'Sharp'], ['ultra', 'Ultra'],
      ]),
      this.#select('Particles', 'particles', [['off', 'Off'], ['low', 'Some'], ['full', 'Full']]),
      this.#select('Textures', 'textureQuality', [
        ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra'],
      ]),
      this.#select('Ground detail', 'groundDetail', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]),
      this.#toggle('Anti-aliasing', 'antialias', 'SMAA pass. Cheap, but not free.'),
      this.#slider('Render scale', 'renderScale', 0.35, 2, 0.05, (v) => `${Math.round(v * 100)}%`,
        'Of the display resolution. The governor below only ever lowers it.'),
      this.#toggle('Adaptive quality', 'autoQuality', 'Quietly drops the render scale if frames get expensive.'),
      this.#slider('Scatter', 'scatterDensity', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      this.#slider('Max crew', 'maxAgents', 10, 200, 10, (v) => String(v)),
      this.#toggle('Stars', 'stars'),
    ]));

    groups.push(group('World', [this.#planets()]));

    groups.push(group('Lighting', [
      // `Live` is a time of day like the others from where you are standing,
      // so it belongs in the same row rather than in a toggle further down.
      this.#chips(
        [...TIMES.map((t) => ({ id: t.id, label: t.label })), { id: 'live', label: 'Live' }],
        () => (s.get('clockTime') ? 'live' : nearestTime(s.get('timeOfDay'))),
        (id) => {
          s.set('autoTime', false);
          s.set('clockTime', id === 'live');
          if (id === 'live') s.set('timeOfDay', systemTimeOfDay());
          else {
            const t = TIMES.find((x) => x.id === id);
            if (t) s.set('timeOfDay', t.value);
          }
        },
      ),
      this.#slider('Time of day', 'timeOfDay', 0, 1, 0.005, clockLabel, undefined, () => {
        // Reaching for the slider is a request for a particular light, so
        // stop following the clock: otherwise the next frame would drag the
        // thumb straight back.
        s.set('clockTime', false);
      }),
      this.#toggle('Cycle day/night', 'autoTime',
        'Runs the clock forward on its own. Ignored while the sky follows this machine\'s clock.'),
      this.#slider('Cycle length', 'dayLength', 30, 900, 30, (v) => `${Math.round(v / 60)}m`),
      this.#toggle('Environment light', 'ibl',
        'Image-based lighting taken from this planet\'s own sky. Metals get something to reflect.'),
      this.#slider('Environment', 'iblIntensity', 0, 2, 0.05, (v) => v.toFixed(2)),
      this.#slider('Exposure', 'exposure', 0.4, 2, 0.05, (v) => v.toFixed(2)),
      this.#slider('Bloom', 'bloomStrength', 0, 1.6, 0.02, (v) => v.toFixed(2)),
    ]));

    groups.push(group('View', [
      this.#toggle('Return to isometric', 'autoFrame', 'Eases the angle back when you stop dragging.'),
      this.#slider('Field of view', 'fov', 20, 60, 1, (v) => `${v}°`),
      this.#toggle('Reduced motion', 'reducedMotion', 'Calms the bobbing and the camera easing.'),
    ]));

    return groups;
  }

  #row(label: string, hint?: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'settings__row';
    const l = document.createElement('div');
    l.className = 'settings__label';
    const name = document.createElement('span');
    name.className = 'settings__name';
    name.textContent = label;
    l.appendChild(name);
    if (hint) {
      const h = document.createElement('span');
      h.className = 'settings__hint';
      h.textContent = hint;
      l.appendChild(h);
    }
    row.appendChild(l);
    return row;
  }

  #toggle(label: string, key: BoolKey, hint?: string): HTMLElement {
    const s = this.#settings;
    const row = this.#row(label, hint);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'settings__toggle';
    b.setAttribute('role', 'switch');
    b.addEventListener('click', () => s.set(key, !s.get(key)));
    row.appendChild(b);
    this.#controls.push({
      sync: () => {
        b.setAttribute('aria-checked', String(s.get(key)));
        row.classList.toggle('settings__row--overridden', s.isOverridden(key));
      },
    });
    return row;
  }

  #select<K extends SettingKey>(
    label: string,
    key: K,
    options: readonly (readonly [SettingsValues[K] & string, string])[],
    hint?: string,
  ): HTMLElement {
    const s = this.#settings;
    const row = this.#row(label, hint);
    const sel = document.createElement('select');
    sel.className = 'settings__select';
    for (const [value, text] of options) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      const picked = options.find(([value]) => value === sel.value);
      if (picked) s.set(key, picked[0]);
    });
    row.appendChild(sel);
    this.#controls.push({
      sync: () => {
        sel.value = String(s.get(key));
        row.classList.toggle('settings__row--overridden', s.isOverridden(key));
      },
    });
    return row;
  }

  #slider(
    label: string,
    key: NumKey,
    min: number,
    max: number,
    step: number,
    format: (v: number) => string,
    hint?: string,
    onInput?: () => void,
  ): HTMLElement {
    const s = this.#settings;
    const row = this.#row(label, hint);
    const wrap = document.createElement('div');
    wrap.className = 'settings__range';
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'settings__slider';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const out = document.createElement('span');
    out.className = 'settings__value';
    input.addEventListener('input', () => {
      onInput?.();
      s.set(key, Number(input.value));
    });
    wrap.append(input, out);
    row.appendChild(wrap);
    this.#controls.push({
      sync: () => {
        const v = s.get(key);
        // Never fight the thumb the user is dragging.
        if (document.activeElement !== input) input.value = String(v);
        out.textContent = format(v);
        row.classList.toggle('settings__row--overridden', s.isOverridden(key));
      },
    });
    return row;
  }

  #chips<Id extends string>(
    items: readonly { id: Id; label: string; title?: string }[],
    current: () => string | null,
    onPick: (id: Id) => void,
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'settings__chips';
    const buttons: [Id, HTMLButtonElement][] = [];
    for (const item of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'settings__chip';
      b.textContent = item.label;
      if (item.title) b.title = item.title;
      b.addEventListener('click', () => onPick(item.id));
      wrap.appendChild(b);
      buttons.push([item.id, b]);
    }
    this.#controls.push({
      sync: () => {
        const now = current();
        for (const [id, b] of buttons) b.setAttribute('aria-pressed', String(id === now));
      },
    });
    return wrap;
  }

  #planets(): HTMLElement {
    const s = this.#settings;
    const wrap = document.createElement('div');
    wrap.className = 'settings__planets';
    for (const id of PLANET_ORDER) {
      const planet = PLANETS[id];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'settings__planet';
      b.title = planet.blurb;
      const orb = document.createElement('i');
      orb.className = 'settings__orb';
      orb.style.background = `radial-gradient(circle at 33% 30%, ${hex(planet.ground.high)}, ${hex(planet.ground.low)})`;
      const name = document.createElement('span');
      name.textContent = planet.name;
      b.append(orb, name);
      b.addEventListener('click', () => s.set('planet', id));
      wrap.appendChild(b);
      this.#controls.push({
        sync: () => b.setAttribute('aria-pressed', String(s.get('planet') === id)),
      });
    }
    return wrap;
  }
}

/* ─────────────────────────── bricks ─────────────────────────── */

function group(title: string, rows: HTMLElement[]): HTMLElement {
  const box = document.createElement('section');
  box.className = 'settings__group';
  const h = document.createElement('h3');
  h.textContent = title;
  box.append(h, ...rows);
  return box;
}

function hex(n: number): string {
  return `#${(n >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
}

/** 0..1 of the day as a wall clock, for the time slider. */
export function clockLabel(t: number): string {
  const total = t * 24 * 60;
  const h = Math.floor(total / 60) % 24;
  const m = Math.floor(total % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** The named time a value sits on, if it sits on one; null between them. */
export function nearestTime(value: number): string | null {
  let best: string | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const t of TIMES) {
    // Wrap-aware, so 0.99 is nearest to dawn rather than to noon.
    const d = Math.min(Math.abs(t.value - value), 1 - Math.abs(t.value - value));
    if (d < bestD) {
      bestD = d;
      best = t.id;
    }
  }
  return bestD < 0.03 ? best : null;
}

/** The next named time after `value`, wrapping at midnight: what the T key steps through. */
export function nextTime(value: number): { id: string; value: number } {
  const next = TIMES.find((t) => t.value > value + 0.005) ?? TIMES[0];
  if (!next) throw new Error('settings: no named times');
  return { id: next.id, value: next.value };
}

export type { PresetId };
