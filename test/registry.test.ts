import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRegistryEntry } from '../src/server/sources/registrySource.ts';

/*
 * The registry of live sessions is written by Claude Code, and two of its
 * fields are free text that reaches the page: the session's name and the
 * version. They went out as they were, past the redaction net and into every
 * snapshot, so they are capped where they come in.
 */

const NOW = Date.now();
// A pid that is certainly alive: the registry drops entries of dead ones.
const entry = (over: Record<string, unknown>): Record<string, unknown> => ({
  pid: process.pid,
  sessionId: '8f44d010-1111-4222-8333-444455556666',
  cwd: '/Users/me/code/my_dashboard',
  updatedAt: NOW,
  startedAt: NOW,
  status: 'busy',
  ...over,
});

test('a session name of any length reaches the page cut to a nameplate', () => {
  const s = parseRegistryEntry(entry({ name: 'n'.repeat(5000), version: 'v'.repeat(5000) }), NOW);
  assert.equal(s?.label.length, 64);
  assert.equal(s?.version.length, 32);
});

test('a short name and version pass as they are', () => {
  const s = parseRegistryEntry(entry({ name: 'fix the ramp', version: '2.1.143' }), NOW);
  assert.equal(s?.label, 'fix the ramp');
  assert.equal(s?.version, '2.1.143');
});

test('a turn over with a shell still running is flagged, not called work', () => {
  // Claude Code 2.1.293 writes "status": "shell" and says "1 shell still
  // running", without saying whose. Read as busy, the `npm run dev` the user
  // typed with `!` kept tower_defense working for twenty minutes after the
  // work was done; whether it is work is the world model's call.
  const shell = parseRegistryEntry(entry({ status: 'shell' }), NOW);
  assert.equal(shell?.status, 'idle');
  assert.equal(shell?.backgroundShell, true);
  assert.equal(parseRegistryEntry(entry({ status: 'busy' }), NOW)?.backgroundShell, false);
  assert.equal(parseRegistryEntry(entry({ status: 'idle' }), NOW)?.status, 'idle');
  assert.equal(parseRegistryEntry(entry({ status: 'something new' }), NOW)?.status, 'idle', 'an unknown state is not work');
});
