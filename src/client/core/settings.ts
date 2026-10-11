/**
 * Every knob that costs frames, in one place.
 *
 * Ported from Bot Crossing. Settings are a flat object so they serialise
 * straight to storage, and everything that reads them subscribes rather than
 * polling: a change fires `onChange` with the set of keys that moved, so the
 * renderer rebuilds only what actually needs rebuilding.
 *
 * Storage is injected, not reached for: the tests hand in a fake, and the
 * browser hands in `localStorage`. Nothing here touches the DOM.
 */
import { CELL_PITCH } from '../city/layout.ts';

export type ShadowQuality = 'off' | 'low' | 'high' | 'ultra';
export type ParticleLevel = 'off' | 'low' | 'full';
export type TextureQuality = 'low' | 'medium' | 'high' | 'ultra';
export type GroundDetail = 'low' | 'medium' | 'high';
export type PlanetId = 'moon' | 'mars' | 'terra';
export type PresetId = 'potato' | 'low' | 'balanced' | 'high' | 'ultra';

/** The knobs a quality preset sets. */
export interface QualityValues {
  renderScale: number;
  shadows: ShadowQuality;
  bloom: boolean;
  antialias: boolean;
  particles: ParticleLevel;
  textureQuality: TextureQuality;
  scatterDensity: number;
  groundDetail: GroundDetail;
  maxAgents: number;
  stars: boolean;
  ibl: boolean;
  tiltShift: boolean;
}

export interface SettingsValues extends QualityValues {
  preset: PresetId | 'custom';
  // World
  planet: PlanetId;
  /** 0..1: 0 is midnight, 0.5 is noon. */
  timeOfDay: number;
  /** The sky cycles on its own, `dayLength` seconds per day. */
  autoTime: boolean;
  /** The sky follows this machine's own clock. Wins over `autoTime`; both off is manual. */
  clockTime: boolean;
  dayLength: number;
  // Look
  exposure: number;
  bloomStrength: number;
  /** 0..1: share of the effect's full blur radius. */
  tiltShiftStrength: number;
  /** Degrees; 0 keeps the sharp band horizontal. */
  tiltShiftAngle: number;
  iblIntensity: number;
  fov: number;
  // City
  /**
   * Distance between two towers of the city view, centre to centre. A taste
   * and not a quality knob: no preset touches it. The city draws it on its
   * grid and inside its range (`clampPitch`), whatever is stored here.
   */
  citySpacing: number;
  // Behaviour
  /** Drop the render scale when frames get expensive. */
  autoQuality: boolean;
  /** Ease the camera back to isometric when you stop dragging. Opt-in. */
  autoFrame: boolean;
  reducedMotion: boolean;
}

export type SettingKey = keyof SettingsValues;
export type QualityKey = keyof QualityValues;

export interface Preset {
  label: string;
  hint: string;
  values: QualityValues;
}

/**
 * What a fresh install opens on. Fixed rather than guessed from the device:
 * `autoQuality` scales the render buffer UNDER whichever preset is chosen, so
 * a slow machine is caught by the governor within a second or two, measured
 * on actual frame times rather than inferred from core counts.
 */
export const DEFAULT_PRESET: PresetId = 'balanced';

export const PRESETS: Readonly<Record<PresetId, Preset>> = {
  potato: {
    label: 'Potato',
    hint: 'battery first: flat light, no extras',
    values: {
      renderScale: 0.5, shadows: 'off', bloom: false, antialias: false, particles: 'off',
      textureQuality: 'low', scatterDensity: 0.15, groundDetail: 'low', maxAgents: 40,
      stars: false, ibl: false, tiltShift: false,
    },
  },
  low: {
    label: 'Low',
    hint: 'for when you are on the go',
    values: {
      renderScale: 0.7, shadows: 'off', bloom: true, antialias: false, particles: 'low',
      textureQuality: 'low', scatterDensity: 0.35, groundDetail: 'low', maxAgents: 60,
      stars: true, ibl: false, tiltShift: false,
    },
  },
  balanced: {
    label: 'Balanced',
    hint: 'the default: looks good, runs cool',
    values: {
      renderScale: 1, shadows: 'low', bloom: true, antialias: false, particles: 'low',
      textureQuality: 'medium', scatterDensity: 0.6, groundDetail: 'medium', maxAgents: 90,
      stars: true, ibl: true, tiltShift: true,
    },
  },
  high: {
    label: 'High',
    hint: 'sharp shadows and a full sky',
    values: {
      renderScale: 1, shadows: 'high', bloom: true, antialias: true, particles: 'full',
      textureQuality: 'high', scatterDensity: 0.85, groundDetail: 'high', maxAgents: 140,
      stars: true, ibl: true, tiltShift: true,
    },
  },
  ultra: {
    label: 'Ultra',
    hint: 'everything on, plugged in',
    values: {
      renderScale: 1.5, shadows: 'ultra', bloom: true, antialias: true, particles: 'full',
      textureQuality: 'ultra', scatterDensity: 1, groundDetail: 'high', maxAgents: 200,
      stars: true, ibl: true, tiltShift: true,
    },
  },
};

export const PRESET_IDS: readonly PresetId[] = ['potato', 'low', 'balanced', 'high', 'ultra'];

export const SHADOW_SIZES: Readonly<Record<ShadowQuality, number>> = { off: 0, low: 1024, high: 2048, ultra: 4096 };
const TEXTURE_SIZES: Readonly<Record<TextureQuality, number>> = { low: 256, medium: 512, high: 1024, ultra: 1024 };
const PARTICLE_BUDGET: Readonly<Record<ParticleLevel, number>> = { off: 0, low: 900, full: 3000 };

/**
 * The largest `maxAgents` any preset asks for. Anything sized once at boot
 * allocates against this rather than against whatever preset happens to be
 * active, so raising quality later cannot outrun a buffer.
 */
export const MAX_AGENT_CAP = Math.max(...PRESET_IDS.map((id) => PRESETS[id].values.maxAgents));

/** Local wall clock as a fraction of the day: what `clockTime` follows. */
export function systemTimeOfDay(date = new Date()): number {
  return (date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds()) / 86400;
}

function defaults(): SettingsValues {
  return {
    preset: DEFAULT_PRESET,
    ...PRESETS[DEFAULT_PRESET].values,
    planet: 'moon',
    timeOfDay: systemTimeOfDay(),
    autoTime: false,
    // On by default, unlike Bot Crossing: an always-open window that goes dark
    // in the evening is the point of having a sky at all.
    clockTime: true,
    dayLength: 240,
    exposure: 1.0,
    bloomStrength: 0.25,
    tiltShiftStrength: 0.2,
    tiltShiftAngle: 0,
    iblIntensity: 1.0,
    fov: 38,
    citySpacing: CELL_PITCH,
    autoQuality: true,
    autoFrame: false,
    reducedMotion: false,
  };
}

/** Which string values each enum key accepts: a stored typo must not reach the renderer. */
const ENUMS: Readonly<Partial<Record<SettingKey, readonly string[]>>> = {
  preset: [...PRESET_IDS, 'custom'],
  shadows: ['off', 'low', 'high', 'ultra'],
  particles: ['off', 'low', 'full'],
  textureQuality: ['low', 'medium', 'high', 'ultra'],
  groundDetail: ['low', 'medium', 'high'],
  planet: ['moon', 'mars', 'terra'],
};

/** Keys whose change forces a full rebuild of the world (terrain, scatter, sky). */
export const WORLD_KEYS: ReadonlySet<SettingKey> = new Set<SettingKey>([
  'planet', 'groundDetail', 'scatterDensity', 'stars',
]);
/** Keys that only need the renderer reconfigured. */
export const RENDER_KEYS: ReadonlySet<SettingKey> = new Set<SettingKey>([
  'renderScale', 'shadows', 'bloom', 'antialias', 'exposure', 'bloomStrength',
  'tiltShift', 'tiltShiftStrength', 'tiltShiftAngle',
]);

export interface ChangeScope {
  world: boolean;
  render: boolean;
}

export type SettingsListener = (
  changed: ReadonlySet<SettingKey>,
  scope: ChangeScope,
  values: Readonly<SettingsValues>,
) => void;

/** The two calls this module makes on `localStorage`, so a test can hand in a Map. */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const STORE_KEY = 'towerglow.settings.v1';

export interface SettingsOptions {
  storage?: SettingsStorage | null;
  /** How long to wait before writing a change; 0 writes at once. */
  saveDelayMs?: number;
}

export class Settings {
  readonly values: SettingsValues;
  readonly #storage: SettingsStorage | null;
  readonly #saveDelayMs: number;
  #listeners = new Set<SettingsListener>();
  #saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SettingsOptions = {}) {
    this.#storage = options.storage ?? null;
    this.#saveDelayMs = options.saveDelayMs ?? 400;
    this.values = { ...defaults(), ...load(this.#storage) };
  }

  get<K extends SettingKey>(key: K): SettingsValues[K] {
    return this.values[key];
  }

  /** True when `key` currently differs from what the active preset specifies. */
  isOverridden(key: SettingKey): boolean {
    const preset = presetOf(this.values.preset);
    if (!preset || !isQualityKey(key)) return false;
    return preset.values[key] !== this.values[key];
  }

  set<K extends SettingKey>(key: K, value: SettingsValues[K]): void {
    if (this.values[key] === value) return;
    this.values[key] = value;
    // Touching any quality knob directly means you are no longer on a named preset.
    if (isQualityKey(key) && presetOf(this.values.preset)) this.values.preset = 'custom';
    this.#emit([key]);
  }

  applyPreset(name: PresetId): void {
    const preset = PRESETS[name];
    const changed: SettingKey[] = [];
    for (const key of QUALITY_KEYS) {
      const value = preset.values[key];
      if (this.values[key] !== value) {
        (this.values as Record<QualityKey, unknown>)[key] = value;
        changed.push(key);
      }
    }
    this.values.preset = name;
    this.#emit(changed.length ? changed : ['preset']);
  }

  /**
   * Adopt a whole saved set at once. One emit rather than one per key, so the
   * renderer is reconfigured once instead of thirty times on the way in.
   */
  applyAll(values: Partial<SettingsValues>): number {
    const changed: SettingKey[] = [];
    for (const [key, value] of Object.entries(sanitize(values))) {
      const k = key as SettingKey;
      if (this.values[k] === value) continue;
      (this.values as unknown as Record<string, unknown>)[k] = value;
      changed.push(k);
    }
    if (changed.length) this.#emit(changed);
    return changed.length;
  }

  onChange(fn: SettingsListener): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  // Convenience readers used all over the render code.
  get shadowSize(): number {
    return SHADOW_SIZES[this.values.shadows];
  }
  get textureSize(): number {
    return TEXTURE_SIZES[this.values.textureQuality];
  }
  get particleBudget(): number {
    return PARTICLE_BUDGET[this.values.particles];
  }

  #emit(keys: readonly SettingKey[]): void {
    const changed = new Set(keys);
    const scope: ChangeScope = {
      world: keys.some((k) => WORLD_KEYS.has(k)),
      render: keys.some((k) => RENDER_KEYS.has(k)),
    };
    for (const fn of this.#listeners) fn(changed, scope, this.values);
    this.#scheduleSave();
  }

  #scheduleSave(): void {
    if (!this.#storage) return;
    if (this.#saveDelayMs <= 0) {
      this.#save();
      return;
    }
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.#save();
    }, this.#saveDelayMs);
  }

  #save(): void {
    try {
      this.#storage?.setItem(STORE_KEY, JSON.stringify(this.values));
    } catch {
      /* private mode, quota: the colony just forgets between sessions */
    }
  }
}

const QUALITY_KEYS = Object.keys(PRESETS.balanced.values) as QualityKey[];

function isQualityKey(key: SettingKey): key is QualityKey {
  return (QUALITY_KEYS as readonly string[]).includes(key);
}

function presetOf(name: PresetId | 'custom'): Preset | null {
  return name === 'custom' ? null : PRESETS[name];
}

/**
 * Keep only the keys we know, with the type we expect. A stored file from an
 * older version, or one edited by hand, must not be able to hand the renderer
 * a string where it wants a number.
 */
function sanitize(raw: unknown): Partial<SettingsValues> {
  if (!raw || typeof raw !== 'object') return {};
  const base = defaults();
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in base)) continue;
    const k = key as SettingKey;
    const expected = typeof base[k];
    if (typeof value !== expected) continue;
    if (expected === 'number' && !Number.isFinite(value)) continue;
    const allowed = ENUMS[k];
    if (allowed && !allowed.includes(value as string)) continue;
    out[k] = value;
  }
  return out as Partial<SettingsValues>;
}

function load(storage: SettingsStorage | null): Partial<SettingsValues> {
  if (!storage) return {};
  try {
    return sanitize(JSON.parse(storage.getItem(STORE_KEY) || '{}'));
  } catch {
    return {};
  }
}

export function hasStoredSettings(storage: SettingsStorage | null): boolean {
  try {
    return Boolean(storage?.getItem(STORE_KEY));
  } catch {
    return false;
  }
}
