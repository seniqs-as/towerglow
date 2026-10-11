import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFolded, writeFolded, FOLD_KEY } from '../src/client/ui/fold.ts';
import type { SettingsStorage } from '../src/client/core/settings.ts';

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

test('a corner folded before a reload is still folded after it, and only that corner', () => {
  const storage = memory();
  writeFolded(storage, { left: false, right: true });
  assert.deepEqual(readFolded(storage), { left: false, right: true });
});

test('with nothing stored, or no storage at all, both corners open', () => {
  assert.deepEqual(readFolded(memory()), { left: false, right: false });
  assert.deepEqual(readFolded(null), { left: false, right: false });
});

test('a value the page cannot read folds nothing: a HUD must not hide itself for a hidden reason', () => {
  for (const raw of ['{not json', '"left"', 'null', '{"left":"yes","right":1}']) {
    assert.deepEqual(readFolded(memory({ [FOLD_KEY]: raw })), { left: false, right: false }, raw);
  }
});

test('a storage that throws, as in a private window, neither breaks the page nor folds anything', () => {
  const hostile: SettingsStorage = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  assert.deepEqual(readFolded(hostile), { left: false, right: false });
  assert.doesNotThrow(() => writeFolded(hostile, { left: true, right: true }));
});
