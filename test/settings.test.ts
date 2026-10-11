import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Settings, PRESETS, STORE_KEY, MAX_AGENT_CAP, hasStoredSettings,
} from '../src/client/core/settings.ts';
import type { SettingsStorage, SettingKey } from '../src/client/core/settings.ts';
import { CELL_PITCH } from '../src/client/city/layout.ts';

function memory(initial: Record<string, string> = {}): SettingsStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

test('a preset sets every knob it names and nothing else', () => {
  const s = new Settings({ storage: null });
  const planet = s.get('planet');
  const fov = s.get('fov');
  s.applyPreset('potato');
  for (const [key, value] of Object.entries(PRESETS.potato.values)) {
    assert.equal(s.get(key as SettingKey), value, `${key} not applied`);
  }
  assert.equal(s.get('preset'), 'potato');
  assert.equal(s.get('planet'), planet, 'a quality preset must not touch the world');
  assert.equal(s.get('fov'), fov);
});

test('touching a knob leaves the named preset', () => {
  const s = new Settings({ storage: null });
  assert.equal(s.get('preset'), 'balanced');
  s.set('shadows', 'ultra');
  assert.equal(s.get('preset'), 'custom');
  // A knob outside the preset does not: the preset still describes the quality.
  const t = new Settings({ storage: null });
  t.set('planet', 'mars');
  assert.equal(t.get('preset'), 'balanced');
});

test('isOverridden reads against the active preset', () => {
  const s = new Settings({ storage: null });
  assert.equal(s.isOverridden('shadows'), false);
  // A stored file that names a preset but carries one knob edited by hand:
  // that knob is the one to mark.
  s.applyAll({ shadows: 'ultra' });
  assert.equal(s.get('preset'), 'balanced');
  assert.equal(s.isOverridden('shadows'), true);
  assert.equal(s.isOverridden('bloom'), false);
  s.applyPreset('ultra');
  assert.equal(s.isOverridden('shadows'), false, 'ultra IS ultra');
  // Off any named preset there is nothing to be overridden against.
  s.set('shadows', 'low');
  assert.equal(s.get('preset'), 'custom');
  assert.equal(s.isOverridden('shadows'), false);
  assert.equal(s.isOverridden('planet'), false, 'not a quality knob: never overridden');
});

test('onChange reports the keys that moved and the scope', () => {
  const s = new Settings({ storage: null });
  const seen: { keys: string[]; world: boolean; render: boolean }[] = [];
  const off = s.onChange((changed, scope) => {
    seen.push({ keys: [...changed].sort(), world: scope.world, render: scope.render });
  });
  s.set('planet', 'terra');
  s.set('bloom', false);
  s.set('bloom', false); // unchanged: no emit
  s.set('fov', 45);
  assert.deepEqual(seen, [
    { keys: ['planet'], world: true, render: false },
    { keys: ['bloom'], world: false, render: true },
    { keys: ['fov'], world: false, render: false },
  ]);
  off();
  s.set('fov', 50);
  assert.equal(seen.length, 3, 'unsubscribed listeners stay quiet');
});

test('stored values win over defaults and unknown keys are dropped', () => {
  const storage = memory({
    [STORE_KEY]: JSON.stringify({
      planet: 'mars', fov: 41, shadows: 'nonsense', maxAgents: 'lots', bogus: 1, exposure: Number.NaN,
    }),
  });
  const s = new Settings({ storage });
  assert.equal(s.get('planet'), 'mars');
  assert.equal(s.get('fov'), 41);
  assert.equal(s.get('shadows'), PRESETS.balanced.values.shadows, 'a typo must not reach the renderer');
  assert.equal(s.get('maxAgents'), PRESETS.balanced.values.maxAgents, 'a string is not a number');
  assert.equal(s.get('exposure'), 1, 'NaN is not a number either');
  assert.equal('bogus' in s.values, false);
  // A corrupt file is the same as no file.
  const t = new Settings({ storage: memory({ [STORE_KEY]: '{not json' }) });
  assert.equal(t.get('planet'), 'moon');
  assert.equal(hasStoredSettings(storage), true);
  assert.equal(hasStoredSettings(memory()), false);
});

test('a change is written back, and a listener sees it before the write', () => {
  const storage = memory();
  const s = new Settings({ storage, saveDelayMs: 0 });
  s.set('planet', 'terra');
  const saved = JSON.parse(storage.data.get(STORE_KEY) ?? '{}') as { planet?: string };
  assert.equal(saved.planet, 'terra');
});

test('the sky follows the clock by default', () => {
  const s = new Settings({ storage: null });
  assert.equal(s.get('clockTime'), true);
  assert.ok(s.get('timeOfDay') >= 0 && s.get('timeOfDay') < 1);
});

test('applyAll adopts a whole set with one emit', () => {
  const s = new Settings({ storage: null });
  let emits = 0;
  s.onChange(() => {
    emits++;
  });
  const n = s.applyAll({ planet: 'mars', fov: 44, bogus: 3 } as never);
  assert.equal(n, 2);
  assert.equal(emits, 1);
  assert.equal(s.applyAll({ planet: 'mars' }), 0, 'nothing moved, nothing emitted');
  assert.equal(emits, 1);
});

test('the agent cap is the largest any preset asks for', () => {
  assert.equal(MAX_AGENT_CAP, Math.max(...Object.values(PRESETS).map((p) => p.values.maxAgents)));
  const s = new Settings({ storage: null });
  assert.equal(s.shadowSize, 1024);
  assert.equal(s.particleBudget, 900);
});

test('the spacing of the city is a taste: it opens on the layout\'s own and no preset moves it', () => {
  // The distance between the towers was asked for four times, a little more
  // each time. It is a setting so the fifth time is a slider, and it is not a
  // quality knob: picking Potato must not pull the city in.
  const s = new Settings({ storage: null });
  assert.equal(s.get('citySpacing'), CELL_PITCH);
  s.set('citySpacing', 60);
  assert.equal(s.get('preset'), 'balanced', 'moving the towers is not leaving the preset');
  s.applyPreset('potato');
  assert.equal(s.get('citySpacing'), 60);
});

test('the spacing is remembered, and a stored one that is not a number is dropped', () => {
  const kept = new Settings({ storage: memory({ [STORE_KEY]: JSON.stringify({ citySpacing: 66 }) }) });
  assert.equal(kept.get('citySpacing'), 66);
  const broken = new Settings({ storage: memory({ [STORE_KEY]: JSON.stringify({ citySpacing: 'far' }) }) });
  assert.equal(broken.get('citySpacing'), CELL_PITCH);
});
