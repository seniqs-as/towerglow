import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findRecap } from '../src/server/sources/recapSeed.ts';
import { slugFor } from '../src/server/paths.ts';
import { World } from '../src/server/state/world.ts';
import type { SeededRecap } from '../src/server/state/world.ts';
import type { LiveSession } from '../src/server/providers/types.ts';
import type { DeltaEvent, SessionInfo } from '../src/shared/protocol.ts';
import { MAX_RECAP_CHARS } from '../src/shared/protocol.ts';
import type { PathPolicy } from '../src/server/paths.ts';

const CWD = '/Users/tester/proj';
const MINE = '8f44d010-1111-4222-8333-444455556666';
const OTHER = '3e6afb62-2222-4333-8444-555566667777';
const OLDER = 'c6884675-3333-4444-8555-666677778888';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-12T16:00:00.000Z');

interface Fixture {
  dir: string;
  policy: PathPolicy;
  /** Writes a transcript and pins its mtime: the scan order depends on it. */
  write(sessionId: string, lines: string[], mtime: number): void;
}

function fixture(): Fixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-recap-'));
  const claudeDir = path.join(home, '.claude');
  const dir = path.join(claudeDir, 'projects', slugFor(CWD));
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir: claudeDir,
    policy: { claudeDir, codexDir: path.join(home, '.codex'), homeDir: home },
    write(sessionId, lines, mtime) {
      const file = path.join(dir, `${sessionId}.jsonl`);
      fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
      fs.utimesSync(file, new Date(mtime), new Date(mtime));
    },
  };
}

const recapLine = (sessionId: string, at: number, content: string): string =>
  JSON.stringify({
    type: 'system',
    subtype: 'away_summary',
    sessionId,
    timestamp: new Date(at).toISOString(),
    content,
  });

const noise = (sessionId: string, at: number): string =>
  JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    sessionId,
    timestamp: new Date(at).toISOString(),
    durationMs: 1000,
    messageCount: 2,
  });

const find = (f: Fixture, sessionId: string) =>
  findRecap({ claudeDir: f.dir, cwd: CWD, sessionId, policy: f.policy, now: NOW });

test('the recap of the session itself wins over the one of the session next to it, even if older', () => {
  const f = fixture();
  f.write(MINE, [recapLine(MINE, NOW - 5 * HOUR, 'mine, from five hours ago')], NOW - HOUR);
  f.write(OTHER, [recapLine(OTHER, NOW - HOUR, "the one from the other session")], NOW - 30 * 60_000);

  const hit = find(f, MINE);
  assert.equal(hit?.text, 'mine, from five hours ago');
  assert.equal(hit?.inherited, false, 'an own recap is not inherited');
  assert.equal(hit?.at, NOW - 5 * HOUR);
});

test('without an own recap one is inherited, and declared as such', () => {
  const f = fixture();
  // The session just born with /clear: its own transcript, but no away_summary.
  f.write(MINE, [noise(MINE, NOW - 60_000)], NOW - 60_000);
  f.write(OTHER, [recapLine(OTHER, NOW - HOUR, 'we were fixing the recap')], NOW - 30 * 60_000);

  const hit = find(f, MINE);
  assert.equal(hit?.text, 'we were fixing the recap');
  assert.equal(hit?.inherited, true, 'a recap from another session must be marked');
});

test('a recap read at startup is capped like one read live', () => {
  // It goes straight into the session the page receives: without the cap a
  // summary of any length crossed the WebSocket, in every snapshot.
  const f = fixture();
  f.write(MINE, [recapLine(MINE, NOW - HOUR, 'x'.repeat(5000))], NOW - HOUR);
  assert.equal(find(f, MINE)?.text.length, MAX_RECAP_CHARS);
});

test('the LAST away_summary in the file is taken, not the first', () => {
  const f = fixture();
  f.write(MINE, [
    recapLine(MINE, NOW - 3 * HOUR, 'old'),
    noise(MINE, NOW - 2 * HOUR),
    recapLine(MINE, NOW - HOUR, 'fresh'),
  ], NOW - HOUR);

  assert.equal(find(f, MINE)?.text, 'fresh');
});

test('between two transcripts the most recent recap wins, not the file written last', () => {
  const f = fixture();
  f.write(MINE, [noise(MINE, NOW - 60_000)], NOW - 60_000);
  // The most recently touched file carries an older recap: it happens when a
  // session stays open for a long time without writing a new one.
  f.write(OTHER, [recapLine(OTHER, NOW - 4 * HOUR, 'old but touched just now')], NOW - 60_000);
  f.write(OLDER, [recapLine(OLDER, NOW - 2 * HOUR, 'recent but idle for a while')], NOW - 2 * HOUR);

  assert.equal(find(f, MINE)?.text, 'recent but idle for a while');
});

test('past a day nothing is inherited: it would no longer say what is going on', () => {
  const f = fixture();
  f.write(MINE, [noise(MINE, NOW - 60_000)], NOW - 60_000);
  f.write(OTHER, [recapLine(OTHER, NOW - 30 * HOUR, 'the day before yesterday')], NOW - 30 * HOUR);

  assert.equal(find(f, MINE), null);
});

test('an own recap never expires: it is the watched session anyway', () => {
  const f = fixture();
  f.write(MINE, [recapLine(MINE, NOW - 30 * HOUR, 'the same session since yesterday')], NOW - 60_000);

  const hit = find(f, MINE);
  assert.equal(hit?.text, 'the same session since yesterday');
  assert.equal(hit?.inherited, false);
});

test('without away_summary, and without a directory, it stays null', () => {
  const f = fixture();
  f.write(MINE, [noise(MINE, NOW - 60_000)], NOW - 60_000);
  assert.equal(find(f, MINE), null);

  const empty = fixture();
  assert.equal(find(empty, MINE), null, 'an empty directory must not throw');
  assert.equal(
    findRecap({ claudeDir: f.dir, cwd: '/Users/tester/never-seen', sessionId: MINE, policy: f.policy }),
    null,
    'a project without a directory must not throw',
  );
});

test('a file outside the allow-list is not opened, even if it sits right in the middle', () => {
  const f = fixture();
  f.write(MINE, [noise(MINE, NOW - 60_000)], NOW - 60_000);
  // Non-conforming name: the transcript allow-list wants a uuid, and this
  // file must not be read, not even to look for a recap inside it.
  const stray = path.join(f.dir, 'projects', slugFor(CWD), 'notes.jsonl');
  fs.writeFileSync(stray, `${recapLine(OTHER, NOW - HOUR, 'not to be read')}\n`);
  fs.utimesSync(stray, new Date(NOW), new Date(NOW));

  assert.equal(find(f, MINE), null);
});

test('a truncated line at the tail does not prevent finding the previous recap', () => {
  const f = fixture();
  const file = path.join(f.dir, 'projects', slugFor(CWD), `${MINE}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${recapLine(MINE, NOW - HOUR, 'whole')}\n${recapLine(MINE, NOW, 'trunc').slice(0, 40)}`,
  );
  fs.utimesSync(file, new Date(NOW), new Date(NOW));

  assert.equal(find(f, MINE)?.text, 'whole');
});

/**
 * The seed as seen by the world model: that is where it becomes a card.
 *
 * The case is the real one -- `/clear` -- where the session comes in with
 * nothing of its own and must still say in words what is going on, until it
 * writes one itself.
 */

const live = (sessionId: string): LiveSession => ({
  sessionId, provider: 'claude', pid: 1, cwd: CWD, label: 'proj-7b',
  title: null, status: 'busy', statusConfidence: 'reported', waitingFor: null,
  kind: 'interactive', version: '2.1.0', model: 'opus',
  startedAt: NOW, updatedAt: NOW, statusSince: NOW,
});

/** The building is born together with the session: only the latter matters here. */
function sessionAdd(events: readonly DeltaEvent[]): SessionInfo {
  const ev = events.find((e) => e.t === 'session.add');
  assert.ok(ev, 'no session added');
  return ev.session;
}

function worldWith(seed: SeededRecap | null): World {
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
    seedRecap: () => seed,
  });
}

test('the session is born with the inherited recap, marked as such', () => {
  const world = worldWith({ text: 'we were fixing the recap', at: NOW - HOUR, inherited: true });
  const added = sessionAdd(world.applyLiveSessions('claude', [live(MINE)], () => true, () => NOW, () => ({ files: 40, dirs: 0 })));

  assert.equal(added.recap, 'we were fixing the recap');
  assert.equal(added.recapAt, NOW - HOUR);
  assert.equal(added.recapInherited, true);
});

test('its own first recap switches the seed off', () => {
  const world = worldWith({ text: 'from the session before', at: NOW - HOUR, inherited: true });
  world.applyLiveSessions('claude', [live(MINE)], () => true, () => NOW, () => ({ files: 40, dirs: 0 }));

  world.applySessionPatch(MINE, { recap: 'its own', recapAt: NOW, recapInherited: false }, NOW);
  const session = world.session(MINE);
  assert.equal(session?.recap, 'its own');
  assert.equal(session?.recapInherited, false, 'an own recap does not stay marked as inherited');
});

test('without a seed the session is born silent, as before', () => {
  const world = worldWith(null);
  const added = sessionAdd(world.applyLiveSessions('claude', [live(MINE)], () => true, () => NOW, () => ({ files: 40, dirs: 0 })));

  assert.equal(added.recap, null);
  assert.equal(added.recapInherited, false);
});
