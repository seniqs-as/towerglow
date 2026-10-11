import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RINGS, RING_WINDOW_MS, RingLedger, ringWorthy } from '../src/shared/rings.ts';
import type { GitEvent } from '../src/shared/rings.ts';
import { World } from '../src/server/state/world.ts';

/*
 * The rings on the towers. Measured on 2026-10-08: after three server
 * restarts with the page open, every tower in the city wore three copies of
 * its last twenty reflog lines -- weeks old on projects nobody had touched --
 * while a page opened afresh showed none at all.
 */

const NOW = Date.parse('2026-10-08T14:00:00.000Z');
const HOUR = 3_600_000;

const git = (over: Partial<GitEvent> = {}): GitEvent => ({
  t: 'git', projectId: 'p1', at: NOW - 10 * 60_000, kind: 'commit', sha: 'abc1234',
  branch: 'main', subject: 'fix the ramp', ...over,
});

test('a reflog line replayed after a restart is the same ring, not a second one', () => {
  const ledger = new RingLedger();
  assert.equal(ledger.accept(git(), NOW), true);
  assert.equal(ledger.accept(git(), NOW), false, 'the same line again');
  assert.equal(ledger.accept(git(), NOW), false, 'and again');
  assert.equal(ledger.all().length, 1);
  // The same sha moved by another kind of event is another line of the reflog.
  assert.equal(ledger.accept(git({ kind: 'reset', at: NOW - 30 * 60_000 }), NOW), true);
});

test('only the last hour stands on a tower, and switching branch never does', () => {
  // An hour and not a day (the user's call): with a day, nearly every project
  // touched since yesterday wore rings, and a tower stopped saying what is
  // happening now.
  assert.equal(RING_WINDOW_MS, HOUR);
  assert.equal(ringWorthy(git({ at: NOW - RING_WINDOW_MS - 1 }), NOW), false, 'a commit of an hour ago');
  assert.equal(ringWorthy(git({ at: NOW - 5 * HOUR }), NOW), false, 'a commit of this morning');
  assert.equal(ringWorthy(git({ kind: 'checkout' }), NOW), false);
  assert.equal(ringWorthy(git({ at: NOW - 50 * 60_000 }), NOW), true);
});

test('at most a dozen per project, the newest, oldest first', () => {
  const ledger = new RingLedger();
  for (let i = 0; i < 20; i++) ledger.accept(git({ sha: `s${i}`, at: NOW - (20 - i) * 60_000 }), NOW);
  const shown = ledger.all();
  assert.equal(shown.length, MAX_RINGS);
  assert.deepEqual(shown.map((e) => e.sha), Array.from({ length: MAX_RINGS }, (_, i) => `s${i + 20 - MAX_RINGS}`));
  // An older line arriving late does not push out a newer one.
  assert.equal(ledger.accept(git({ sha: 'late', at: NOW - 21 * 60_000 }), NOW), false);
  assert.equal(ledger.all().length, MAX_RINGS);
});

test('rings age out, and a reset starts from the list it is given', () => {
  const ledger = new RingLedger();
  ledger.accept(git({ sha: 'old', at: NOW - 50 * 60_000 }), NOW);
  ledger.accept(git({ sha: 'new', at: NOW - 10 * 60_000 }), NOW);
  assert.equal(ledger.prune(NOW + 20 * 60_000), true);
  assert.deepEqual(ledger.all().map((e) => e.sha), ['new']);
  assert.equal(ledger.prune(NOW + 20 * 60_000), false, 'nothing more to let go');
  ledger.reset([git({ sha: 'x' }), git({ sha: 'x' }), git({ sha: 'y', projectId: 'p2' })], NOW);
  assert.deepEqual(ledger.all().map((e) => e.sha).sort(), ['x', 'y']);
});

test('the snapshot carries the rings, so a page opened at any moment shows the same towers', () => {
  // Before, the rings reached a page only live: one opened after the start
  // saw none, one left open across a restart saw the history once more.
  const world = new World({ homeDir: '/Users/me' } as never);
  const at = Date.now() - 10 * 60_000;
  world.applyGit(git({ at }));
  world.applyGit(git({ at })); // replayed by a restart
  world.applyGit(git({ sha: 'old', at: Date.now() - 3 * RING_WINDOW_MS }));
  assert.deepEqual(world.snapshot().rings?.map((e) => e.sha), ['abc1234']);
});
