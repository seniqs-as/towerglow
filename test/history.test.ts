import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHistory } from '../src/server/state/history.ts';
import type { ClosedSession } from '../src/server/state/history.ts';

const DAY = 24 * 60 * 60 * 1000;
/**
 * The real time and not a constant.
 *
 * The monthly folding looks at the clock: with a fixed T0 in the past every row
 * would be folded as soon as it is written, and the tests would prove the
 * opposite of what they say.
 */
const NOW = Date.now();

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hist-'));
}

function row(id: string, over: Partial<ClosedSession> = {}): ClosedSession {
  return {
    id,
    projectId: 'p1',
    provider: 'claude',
    startedAt: NOW - DAY,
    confidence: 'reported',
    watched: true,
    costUsd: 1,
    tokens: { in: 1000, out: 200, cacheRead: 9000, cacheWrite: 1000, thinking: 50 },
    turns: 4,
    toolCalls: 10,
    apiMs: 5000,
    toolMs: 900,
    wallMs: 60_000,
    linesAdded: 10,
    linesRemoved: 2,
    ...over,
  };
}

test('the same session written twice doubles nothing', () => {
  // It is the case that makes the ledger usable: the tailer rereads the tail of
  // every transcript at every start, and a ledger that summed would double
  // every number each time you restart the server.
  const h = createHistory(tmp());
  h.record(row('s1'));
  h.record(row('s1'));
  h.record(row('s1'));

  const d = h.digest(NOW, 7);
  assert.equal(d.byProject.length, 1);
  assert.equal(d.byProject[0]?.now.sessions, 1);
  assert.equal(d.byProject[0]?.now.costUsd, 1);
});

test('the digest compares two periods instead of summing one', () => {
  const h = createHistory(tmp());
  h.record(row('recent', { startedAt: NOW - 2 * DAY, toolCalls: 100 }));
  h.record(row('earlier', { startedAt: NOW - 10 * DAY, toolCalls: 40 }));

  const d = h.digest(NOW, 7);
  const p = d.byProject[0];
  assert.equal(p?.now.toolCalls, 100);
  assert.equal(p?.before.toolCalls, 40, 'the session from ten days ago must sit in the previous period');
  assert.equal(p?.now.sessions, 1);
});

test('what is older than the two periods stays out of the comparison', () => {
  // The brief shows two endpoints and a direction: a third week would not
  // change the answer and would be paid for in every question.
  const h = createHistory(tmp());
  h.record(row('old', { startedAt: NOW - 20 * DAY }));
  assert.deepEqual(h.digest(NOW, 7).byProject, []);
});

test('rows past the window fold into months and disappear on their own', () => {
  // The ledger must not grow with use: that is what would turn it into the
  // very thing it is meant to watch over.
  const h = createHistory(tmp());
  h.record(row('alive', { startedAt: NOW - DAY }));
  h.record(row('buried', { startedAt: NOW - 200 * DAY }));
  assert.equal(h.rows(), 1, 'the row past thirty days should have been folded');
  // Folded, not lost: the tool that worked on it stays known.
  assert.deepEqual(h.providersOf('p1'), ['claude']);
});

test('the history survives a restart, or it is not a history', () => {
  const dir = tmp();
  const a = createHistory(dir);
  a.record(row('s1', { toolCalls: 77 }));
  a.save();

  const b = createHistory(dir);
  assert.equal(b.digest(NOW, 7).byProject[0]?.now.toolCalls, 77);
  assert.ok(b.has('s1'));
});

test('a tool that stopped working here stays in the list', () => {
  // The question is "do I use both tools on this project", not "am I using
  // them right now": that is what decides whether a meeting has a subject.
  const h = createHistory(tmp());
  h.record(row('s1', { provider: 'claude' }));
  h.record(row('s2', { provider: 'codex', startedAt: NOW - 3 * DAY }));
  assert.deepEqual(h.providersOf('p1').sort(), ['claude', 'codex']);
  assert.deepEqual(h.providersOf('p2'), []);
});

test('a row we counted ourselves is promoted when the real final cost arrives', () => {
  const h = createHistory(tmp());
  h.record(row('s1', { confidence: 'inferred', costUsd: 0, toolCalls: 31 }));
  h.merge('s1', { confidence: 'reported', costUsd: 2.5 });

  const p = h.digest(NOW, 7).byProject[0];
  assert.equal(p?.now.costUsd, 2.5);
  assert.equal(p?.now.reported, 1);
  // Turns and calls stay the observed ones: the final cost does not carry
  // them, and overwriting them with a zero would lose the only data there was.
  assert.equal(p?.now.toolCalls, 31);
});

test('a session never seen cannot be promoted: merge does not invent rows', () => {
  const h = createHistory(tmp());
  h.merge('never-seen', { costUsd: 99 });
  assert.equal(h.rows(), 0);
});

test('a corrupt history file does not prevent starting again', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'history.json'), '{ this is not json');
  const h = createHistory(dir);
  assert.equal(h.rows(), 0);
  h.record(row('s1'));
  assert.equal(h.rows(), 1);
});

test('between returns the rows one by one, not the totals of two periods', () => {
  // The question digest cannot answer: what does a TYPICAL session cost. It
  // is a question about the distribution, and two totals cannot give it.
  const h = createHistory(tmp());
  h.record(row('a', { startedAt: NOW - 3 * DAY, toolCalls: 10 }));
  h.record(row('b', { startedAt: NOW - 2 * DAY, toolCalls: 20 }));
  h.record(row('elsewhere', { projectId: 'p2', startedAt: NOW - 2 * DAY }));

  const rows = h.between('p1', NOW - 5 * DAY, NOW);
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b'], 'sorted by startedAt, and only p1\'s');
});

test('between excludes the right endpoint: the before ends when the job begins', () => {
  // It is what keeps the CEO worker out of the baseline without depending on
  // its id: the session the job opens starts AFTER you accepted it, and that
  // instant belongs to the after. Measured on disk: the audit worker started
  // 434 ms before job.at, so cutting at the moment the job FINISHES would
  // have put it among the "before" sessions.
  const h = createHistory(tmp());
  const boundary = NOW - DAY;
  h.record(row('inside', { startedAt: boundary - 1 }));
  h.record(row('on the boundary', { startedAt: boundary }));

  const rows = h.between('p1', boundary - 10_000, boundary);
  assert.deepEqual(rows.map((r) => r.id), ['inside']);
});

test('between does not see folded months: it is a floor, like weightedSince', () => {
  const h = createHistory(tmp());
  h.record(row('alive', { startedAt: NOW - DAY }));
  h.record(row('buried', { startedAt: NOW - 200 * DAY }));

  const rows = h.between('p1', NOW - 300 * DAY, NOW);
  assert.deepEqual(rows.map((r) => r.id), ['alive'], 'past thirty days the row is no longer there');
});

test('whoever reads from between cannot rewrite the history from underneath', () => {
  const h = createHistory(tmp());
  h.record(row('s1', { toolCalls: 7 }));

  const rows = h.between('p1', NOW - 5 * DAY, NOW);
  rows[0]!.toolCalls = 999;
  rows[0]!.tokens.out = 999;

  assert.equal(h.digest(NOW, 7).byProject[0]?.now.toolCalls, 7);
  assert.equal(h.digest(NOW, 7).byProject[0]?.now.tokens.out, 200, 'the tokens are a copy too');
});

test('a project with no rows in the window answers empty, not undefined', () => {
  const h = createHistory(tmp());
  assert.deepEqual(h.between('never-seen', 0, NOW), []);
});
