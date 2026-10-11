import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createJobStore, stateOf } from '../src/server/ceo/jobs.ts';
import { createProposalStore } from '../src/server/ceo/proposals.ts';
import type { NewProposal } from '../src/server/ceo/proposals.ts';
import { twoClicks } from '../src/client/ui/twoClicks.ts';
import type { Armable } from '../src/client/ui/twoClicks.ts';

/*
 * Board and Reports start over as Planning does (user's request, 2026-09-29:
 * "the same mechanics, start over and a further click to confirm"). What goes
 * is archived, never lost; a job still running stays, because a process is
 * still working for it.
 */

const T0 = Date.parse('2026-09-29T09:00:00.000Z');

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'tg-over-'));

const proposal = (id: string): NewProposal => ({
  id, at: T0, provider: 'claude', kind: 'tokens', summary: `advice ${id}`,
  projectId: 'proj', projectName: 'proj', task: 'do it',
});

const archived = (dir: string, prefix: string): unknown[] => {
  const into = path.join(dir, 'ceo', 'archive');
  return fs.readdirSync(into)
    .filter((f) => f.startsWith(prefix))
    .map((f) => JSON.parse(fs.readFileSync(path.join(into, f), 'utf8')) as unknown);
};

test('Board started over: every proposal goes, pending ones too, and the registry stays empty after a restart', () => {
  const dir = tmp();
  const store = createProposalStore(dir);
  store.add(proposal('p1'));
  store.add(proposal('p2'));
  store.decide('p2', false, T0);
  assert.equal(store.clear(T0 + 1), 2);
  store.save();
  assert.deepEqual(store.list(), []);
  // A pending card that came back after a restart would be a board you
  // cleared and found full again.
  assert.deepEqual(createProposalStore(dir).list(), []);
});

test('a cleared proposal cannot be decided or applied: clearing is no road to applied', () => {
  const store = createProposalStore(tmp());
  store.add(proposal('p1'));
  store.clear(T0);
  assert.equal(store.decide('p1', true, T0).ok, false);
  assert.equal(store.markApplied('p1', 's1', T0).ok, false);
});

test('the cleared proposals are archived on disk, not deleted', () => {
  const dir = tmp();
  const store = createProposalStore(dir);
  store.add(proposal('p1'));
  store.clear(T0);
  const [file] = archived(dir, 'proposals-') as { proposals: { id: string }[] }[];
  assert.deepEqual(file?.proposals.map((p) => p.id), ['p1']);
});

test('an empty board starts over without writing an empty archive', () => {
  const dir = tmp();
  assert.equal(createProposalStore(dir).clear(T0), 0);
  assert.equal(fs.existsSync(path.join(dir, 'ceo', 'archive')), false);
});

test('Reports started over: finished jobs go, a running one stays with its process', () => {
  const dir = tmp();
  const jobs = createJobStore(dir);
  const add = (id: string): void => {
    jobs.add({ id, at: T0, provider: 'claude', kind: 'audit', summary: id, projectId: 'proj', projectName: 'proj' });
  };
  add('done');
  add('failed');
  add('running');
  add('judged');
  const end = { ok: true, outcome: 'ok', costUsd: 0, reason: '', at: T0 + 1 };
  jobs.finish('done', 'work', end);
  jobs.finish('failed', 'work', { ...end, ok: false, reason: 'broke' });
  // Its work is over but the second opinion still runs: the job runs.
  jobs.finish('judged', 'work', end);
  jobs.openReview('judged', false);

  const kept = jobs.clear(T0 + 2);
  jobs.save();
  assert.deepEqual(kept.sort(), ['judged', 'running']);
  assert.deepEqual(jobs.list().map((j) => j.id).sort(), ['judged', 'running']);
  assert.ok(jobs.list().every((j) => stateOf(j) === 'running'));

  // Its end still lands somewhere: the outcome you were waiting for.
  assert.ok(jobs.finish('running', 'work', end));

  const [file] = archived(dir, 'jobs-') as { jobs: { id: string }[] }[];
  assert.deepEqual(file?.jobs.map((j) => j.id).sort(), ['done', 'failed']);
});

/* ── the second click ── */

function button(): Armable & { click: () => void } {
  let on: (() => void) | null = null;
  return {
    textContent: '',
    dataset: {},
    addEventListener: (_type, fn) => { on = fn; },
    click: () => on?.(),
  };
}

test('one click only arms the start over: the second one erases', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const b = button();
  let erased = 0;
  twoClicks(b, 'start over', 'erase everything? click again', () => { erased += 1; });
  assert.equal(b.textContent, 'start over');

  b.click();
  assert.equal(erased, 0, 'a single click erased everything');
  assert.equal(b.textContent, 'erase everything? click again');
  assert.equal(b.dataset['armed'], 'true');

  b.click();
  assert.equal(erased, 1);
  assert.equal(b.textContent, 'start over');
  assert.equal(b.dataset['armed'], 'false');
});

test('an armed start over left alone disarms: a click later is a first click again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const b = button();
  let erased = 0;
  twoClicks(b, 'start over', 'sure?', () => { erased += 1; }, 4000);
  b.click();
  t.mock.timers.tick(4000);
  assert.equal(b.textContent, 'start over');
  b.click();
  assert.equal(erased, 0, 'a click minutes after arming erased without asking again');
});
