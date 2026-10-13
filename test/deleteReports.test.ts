import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createJobStore, stateOf } from '../src/server/ceo/jobs.ts';
import type { EffectRecord } from '../src/server/ceo/effect.ts';

/*
 * Erasing one job, or one outcome, or every outcome (user's request,
 * 2026-10-13). The id that arrives from the page is only ever a key into the
 * ledger: it never becomes a path, so a traversal string finds nothing and
 * touches nothing. A running job has a process working for it and stays.
 */

const T0 = Date.parse('2026-10-13T09:00:00.000Z');
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'tg-del-'));
const end = { ok: true, outcome: 'ok', costUsd: 0, reason: '', at: T0 + 1 };
const record = (): EffectRecord => ({ baseline: null, voided: 'nothing to measure here', settled: null, verdict: null });

function seeded(dir: string, ids: string[]): ReturnType<typeof createJobStore> {
  const jobs = createJobStore(dir);
  for (const id of ids) {
    jobs.add({ id, at: T0, provider: 'claude', kind: 'audit', summary: id, projectId: 'proj', projectName: 'proj' });
    jobs.finish(id, 'work', end);
    jobs.freeze(id, record());
  }
  return jobs;
}

test('deleting one job removes it from the ledger on disk and keeps the others', () => {
  const dir = tmp();
  const jobs = seeded(dir, ['a', 'b']);
  jobs.save();
  assert.equal(jobs.remove('a'), true);
  jobs.save();

  const again = createJobStore(dir);
  assert.deepEqual(again.list().map((j) => j.id), ['b']);
  assert.ok(!fs.readFileSync(path.join(dir, 'ceo', 'jobs.json'), 'utf8').includes('"id": "a"'));
});

test('a running job cannot be deleted: a process still works for it', () => {
  const dir = tmp();
  const jobs = seeded(dir, ['done']);
  jobs.add({ id: 'run', at: T0, provider: 'claude', kind: 'audit', summary: 'run', projectId: 'proj', projectName: 'proj' });
  assert.equal(stateOf(jobs.get('run')!), 'running');
  assert.equal(jobs.remove('run'), false);
  assert.ok(jobs.get('run'));
  assert.equal(jobs.clearEffect('run'), undefined);
});

test('an unknown id deletes nothing', () => {
  const jobs = seeded(tmp(), ['a']);
  assert.equal(jobs.remove('nope'), false);
  assert.equal(jobs.list().length, 1);
});

test('a path traversal id deletes nothing and touches no file outside the state directory', () => {
  const outer = tmp();
  const dir = path.join(outer, 'state');
  fs.mkdirSync(dir);
  const sentinel = path.join(outer, 'sentinel.json');
  fs.writeFileSync(sentinel, 'keep me');
  const jobs = seeded(dir, ['a']);
  jobs.save();
  const before = fs.readdirSync(outer).sort();

  for (const evil of ['../sentinel.json', '../../sentinel', '..\\sentinel.json', '/etc/passwd', '', 'a/../../sentinel.json']) {
    assert.equal(jobs.remove(evil), false, evil);
    assert.equal(jobs.clearEffect(evil), undefined, evil);
  }
  jobs.save();

  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep me');
  assert.deepEqual(fs.readdirSync(outer).sort(), before);
  assert.deepEqual(jobs.list().map((j) => j.id), ['a']);
});

test('deleting one outcome keeps the job and is not retaken from the history', () => {
  const dir = tmp();
  const jobs = seeded(dir, ['a', 'b']);
  assert.ok(jobs.get('a')!.effect);
  const next = jobs.clearEffect('a');
  assert.equal(next?.effect, null);
  // The refresh freezes every finished job that has no snapshot: it must not
  // bring this one back.
  jobs.freeze('a', record());
  assert.equal(jobs.get('a')!.effect, null);
  assert.ok(jobs.get('b')!.effect, 'the other outcome stays');
  jobs.save();

  const again = createJobStore(dir);
  assert.equal(again.get('a')!.effect, null);
  again.freeze('a', record());
  assert.equal(again.get('a')!.effect, null, 'the erasure survives a restart');
  assert.ok(again.get('b')!.effect);
});

test('deleting all outcomes clears every measure, running jobs excepted, and keeps the jobs', () => {
  const dir = tmp();
  const jobs = seeded(dir, ['a', 'b', 'c']);
  jobs.add({ id: 'run', at: T0, provider: 'claude', kind: 'audit', summary: 'run', projectId: 'proj', projectName: 'proj' });
  const gone = jobs.clearEffects();
  assert.deepEqual(gone.sort(), ['a', 'b', 'c']);
  assert.equal(jobs.list().length, 4);
  assert.ok(jobs.list().every((j) => j.effect === null));
  assert.deepEqual(jobs.clearEffects(), [], 'nothing left to erase');
});
