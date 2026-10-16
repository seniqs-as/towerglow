import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/server/state/world.ts';
import type { LiveSession } from '../src/server/providers/types.ts';
import { parseLine, createStats } from '../src/server/parse/records.ts';
import { project, createContext, assertSafe } from '../src/server/parse/redact.ts';
import type { RedactOptions } from '../src/server/parse/redact.ts';

/*
 * A compaction, as the page learns it.
 *
 * Field case, 2026-10-14: a Claude Code session in RPG went from 969 616
 * tokens to 12 725 on its own (`compact_boundary`, trigger auto), and the
 * context arc over its tower fell from 97% to 6% with no `/clear`. Nothing
 * on screen said why, and it read as a fault. The page now shows "context
 * compacted" for an hour; these tests hold what it is fed.
 */

const CWD = '/Users/tester/proj';
const SID = '8f44d010-1111-4222-8333-444455556666';
const NOW = Date.parse('2026-10-14T16:08:07.000Z');

const OPTS: RedactOptions = {
  projectId: 'proj123', cwd: CWD, redactPaths: false, cmdNames: true, titles: true, recap: true,
};

/** The record as Claude Code 2.1.285 writes it. */
const boundary = (extra: Record<string, unknown> = {}): string => JSON.stringify({
  parentUuid: null, logicalParentUuid: 'ecfb2a7c-6c9f-4552-82d6-e9d0efd0c413', isSidechain: false,
  type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', level: 'info',
  uuid: '15bde8fe-82d4-4cc4-b33d-41fb95e89478', timestamp: new Date(NOW).toISOString(),
  cwd: CWD, sessionId: SID, version: '2.1.285', gitBranch: 'main',
  compactMetadata: { trigger: 'auto', preTokens: 969_616, postTokens: 12_725, durationMs: 40_005 },
  ...extra,
});

function projected(line: string): any[] {
  const rec = parseLine(line, createStats());
  if (!rec) return [];
  const out = project(rec, createContext(), OPTS);
  for (const ev of out) assertSafe(ev);
  return out;
}

test('a compaction reaches the page as its time, and nothing else', () => {
  const events = projected(boundary());
  assert.equal(events.length, 1);
  assert.equal(events[0].t, 'session.update');
  assert.equal(events[0].id, SID);
  assert.deepEqual(events[0].patch, { compactedAt: NOW });
  assert.equal(JSON.stringify(events).includes('Conversation compacted'), false);
});

test("a subagent's compaction is not the session's", () => {
  assert.deepEqual(projected(boundary({ isSidechain: true })), []);
});

function world(): World {
  const slots = new Map<string, number>();
  return new World({
    homeDir: '/Users/tester',
    placement: {
      slotOf: (id) => {
        if (!slots.has(id)) slots.set(id, slots.size);
        return slots.get(id)!;
      },
      assignMany: () => {},
      save: () => {},
    },
    redactPaths: false,
    titles: true,
    seedRecap: () => null,
  });
}

const live = (provider: 'claude' | 'codex', compactedAt?: number | null): LiveSession => ({
  sessionId: SID, provider, pid: 1, cwd: CWD, label: 'proj-7b',
  title: null, status: 'busy', statusConfidence: 'reported', waitingFor: null,
  kind: 'interactive', version: '2.1.285', model: 'opus',
  startedAt: NOW - 3_600_000, updatedAt: NOW, statusSince: NOW,
  ...(compactedAt === undefined ? {} : { compactedAt }),
});

test('a registry pass does not erase the compaction the transcript told', () => {
  // The registry knows nothing of compactions: only the transcript says one
  // happened. A pass a second later must not put the field back to null, or
  // the caption would last until the next registry tick.
  const w = world();
  w.applyLiveSessions('claude', [live('claude')], () => true, () => NOW, () => ({ files: 40, dirs: 0 }));
  w.applySessionPatch(SID, { compactedAt: NOW }, NOW);
  const events = w.applyLiveSessions('claude', [live('claude')], () => true, () => NOW + 1000, () => ({ files: 40, dirs: 0 }));

  assert.equal(w.session(SID)?.compactedAt, NOW);
  assert.equal(events.some((e) => e.t === 'session.update' && 'compactedAt' in e.patch), false);
});

test('a Codex compaction travels with the live session, once', () => {
  const w = world();
  const born = w.applyLiveSessions('codex', [live('codex', null)], () => true, () => NOW, () => ({ files: 40, dirs: 0 }));
  const added = born.find((e) => e.t === 'session.add');
  assert.ok(added && added.t === 'session.add');
  assert.equal(added.session.compactedAt, null, 'no compaction read is null, not a time');

  const first = w.applyLiveSessions('codex', [live('codex', NOW)], () => true, () => NOW, () => ({ files: 40, dirs: 0 }));
  assert.ok(first.some((e) => e.t === 'session.update' && e.patch.compactedAt === NOW));
  const again = w.applyLiveSessions('codex', [live('codex', NOW)], () => true, () => NOW, () => ({ files: 40, dirs: 0 }));
  assert.equal(again.some((e) => e.t === 'session.update' && 'compactedAt' in e.patch), false,
    'the same compaction sent again on every provider tick');
});
