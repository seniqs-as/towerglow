import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PENDING_MAX_MS, PendingFocus } from '../src/client/state/pendingFocus.ts';

/**
 * A click on a badge takes a couple of seconds to bring a terminal forward.
 *
 * Reported on 2026-09-29: "sometimes it seems not to, maybe there is
 * latency". The badge stayed still until the answer, the click looked lost
 * and was repeated, and every repeat queued one more AppleScript behind the
 * first.
 */

test('a second click on the same session while its jump is on the way starts nothing', () => {
  const p = new PendingFocus();
  assert.equal(p.begin('s1', 1000), true);
  assert.equal(p.begin('s1', 1800), false);
  assert.equal(p.begin('s2', 1800), true, 'another session is another terminal');
});

test('the answer frees the session for the next click', () => {
  const p = new PendingFocus();
  p.begin('s1', 1000);
  p.end('s1');
  assert.equal(p.begin('s1', 1100), true);
});

test('an answer that never comes does not refuse clicks for good', () => {
  const p = new PendingFocus();
  p.begin('s1', 1000);
  assert.equal(p.begin('s1', 1000 + PENDING_MAX_MS - 1), false);
  assert.equal(p.begin('s1', 1000 + PENDING_MAX_MS), true);
});
