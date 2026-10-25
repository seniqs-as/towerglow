import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHistory } from '../src/server/state/history.ts';
import type { ClosedSession } from '../src/server/state/history.ts';
import { WORK_RULES } from '../src/server/state/workMeter.ts';

/**
 * A project's work month by month, as its tower's card shows it (the user's
 * request, 2026-10-24: tokens and hours, to show its funders).
 */

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60_000;
/** The real clock: folding looks at it, as in history.test.ts. */
const NOW = Date.now();

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-work-hist-'));
}

function monthOf(at: number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function row(id: string, over: Partial<ClosedSession> = {}): ClosedSession {
  return {
    id, projectId: 'p1', provider: 'claude', startedAt: NOW - DAY,
    confidence: 'reported', watched: true, costUsd: 1,
    tokens: { in: 1000, out: 200, cacheRead: 9000, cacheWrite: 1000, thinking: 50 },
    turns: 4, toolCalls: 10, apiMs: 5000, toolMs: 900, wallMs: 60_000,
    linesAdded: 10, linesRemoved: 2,
    ...over,
  };
}

test('a project\'s months add up its sessions\' tokens and hours', () => {
  const h = createHistory(tmp());
  const at = NOW - DAY;
  h.record(row('s1', { startedAt: at, work: { aiMs: 30 * MIN, operator: [at, at + 4 * MIN] } }));
  h.record(row('s2', { startedAt: at + 1000, work: { aiMs: 10 * MIN, operator: [] } }));
  h.record(row('other', { projectId: 'p2', startedAt: at }));
  const [m, ...rest] = h.workOf('p1', []);
  assert.equal(rest.length, 0);
  assert.equal(m?.month, monthOf(at));
  assert.equal(m?.sessions, 2);
  assert.equal(m?.timed, 2);
  assert.equal(m?.aiMs, 40 * MIN);
  assert.equal(m?.operatorMs, 4 * MIN);
  assert.equal(m?.tokens.cacheRead, 18_000);
});

test('a session whose time was never read counts its tokens, and the month says it is a floor', () => {
  const h = createHistory(tmp());
  h.record(row('read', { work: { aiMs: MIN, operator: [], models: [], rules: WORK_RULES } }));
  h.record(row('unread'));
  const m = h.workOf('p1', [])[0];
  assert.equal(m?.sessions, 2);
  assert.equal(m?.timed, 1);
  assert.equal(m?.tokens.in, 2000);
  assert.deepEqual(h.untimed().map((r) => r.id), ['unread']);
});

test('your time with two projects at once is shared, never counted in both', () => {
  // You cannot be in two places at once: a funder of one project should not
  // pay for the minutes of another.
  const h = createHistory(tmp());
  const at = NOW - DAY;
  h.record(row('a', { projectId: 'p1', startedAt: at, work: { aiMs: 0, operator: [at, at + 10 * MIN] } }));
  h.record(row('b', { projectId: 'p2', startedAt: at, work: { aiMs: 0, operator: [at, at + 10 * MIN] } }));
  assert.equal(h.workOf('p1', [])[0]?.operatorMs, 5 * MIN);
  assert.equal(h.workOf('p2', [])[0]?.operatorMs, 5 * MIN);
});

test('an open session counts so far, shares your time, and replaces its own row', () => {
  // A resumed session is open AND on record: counted twice, its month doubled.
  const h = createHistory(tmp());
  const at = NOW - DAY;
  h.record(row('resumed', { startedAt: at, work: { aiMs: 5 * MIN, operator: [] } }));
  h.record(row('mine', { projectId: 'p2', startedAt: at, work: { aiMs: 0, operator: [at, at + 10 * MIN] } }));
  const live = [{
    id: 'resumed', projectId: 'p1', startedAt: at, tokens: row('x').tokens,
    work: { aiMs: 20 * MIN, operator: [at, at + 10 * MIN] },
  }];
  const m = h.workOf('p1', live)[0];
  assert.equal(m?.sessions, 1);
  assert.equal(m?.aiMs, 20 * MIN);
  assert.equal(m?.operatorMs, 5 * MIN);
  assert.equal(h.workOf('p2', live)[0]?.operatorMs, 5 * MIN);
});

test('hours survive the fold into months, and the months come newest first', () => {
  const h = createHistory(tmp());
  const old = NOW - 45 * DAY;
  h.record(row('old', { startedAt: old, work: { aiMs: 7 * MIN, operator: [old, old + 3 * MIN] } }));
  h.record(row('new', { startedAt: NOW - DAY, work: { aiMs: MIN, operator: [] } }));
  assert.ok(!h.has('old'), 'the row past thirty days should have been folded');
  const months = h.workOf('p1', []);
  assert.deepEqual(months.map((m) => m.month), [monthOf(NOW - DAY), monthOf(old)]);
  const folded = months[1];
  assert.equal(folded?.aiMs, 7 * MIN);
  assert.equal(folded?.operatorMs, 3 * MIN);
  assert.equal(folded?.timed, 1);
});

test('hours read survive a restart, and a malformed one is read again instead of trusted', () => {
  const dir = tmp();
  const a = createHistory(dir);
  a.record(row('ok'));
  a.merge('ok', { work: { aiMs: 9 * MIN, operator: [NOW - DAY, NOW - DAY + MIN], models: [], rules: WORK_RULES } });
  a.record(row('bad', { work: { aiMs: 'lots', operator: [] } as never }));
  a.save();
  const b = createHistory(dir);
  assert.equal(b.workOf('p1', [])[0]?.aiMs, 9 * MIN);
  assert.deepEqual(b.untimed().map((r) => r.id), ['bad']);
});

test('a month folded before hours existed reads as unread, not as zero hours', () => {
  const dir = tmp();
  const month = monthOf(NOW - 60 * DAY);
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({
    version: 1,
    sessions: [],
    folds: [{
      projectId: 'p1', provider: 'claude', month,
      totals: {
        sessions: 12, turns: 0, toolCalls: 40,
        tokens: { in: 1, out: 2, cacheRead: 3, cacheWrite: 4, thinking: 0 },
        costUsd: 5, apiMs: 0, toolMs: 0, linesAdded: 0, linesRemoved: 0, reported: 12, watched: 0,
      },
    }],
  }));
  const m = createHistory(dir).workOf('p1', [])[0];
  assert.equal(m?.month, month);
  assert.equal(m?.sessions, 12);
  assert.equal(m?.timed, 0);
  assert.equal(m?.aiMs, 0);
});

const opus = (aiMs: number): { model: string; effort: string | null; aiMs: number } =>
  ({ model: 'claude-opus-5-5', effort: 'xhigh', aiMs });

test('a month adds up its sessions\' models, one line per model and effort, the largest first', () => {
  const h = createHistory(tmp());
  const at = NOW - DAY;
  const sonnet = { model: 'claude-sonnet-5-5', effort: 'high', aiMs: 30 * MIN };
  h.record(row('s1', { startedAt: at, work: { aiMs: 20 * MIN, operator: [], models: [opus(20 * MIN)] } }));
  h.record(row('s2', { startedAt: at + 1, work: { aiMs: 40 * MIN, operator: [], models: [sonnet, opus(10 * MIN)] } }));
  const live = [{
    id: 'open', projectId: 'p1', startedAt: at + 2, tokens: row('x').tokens,
    work: { aiMs: 5 * MIN, operator: [], models: [{ model: 'gpt-6.1-sol', effort: 'high', aiMs: 5 * MIN }] },
  }];
  assert.deepEqual(h.workOf('p1', live)[0]?.models, [
    opus(30 * MIN), sonnet, { model: 'gpt-6.1-sol', effort: 'high', aiMs: 5 * MIN },
  ]);
});

test('a row counted under older rules is read once more, and keeps its numbers until then', () => {
  // Rows timed on 2026-10-24 have hours and no split, and rows read in the
  // morning of 2026-10-25 turns stretched by deliveries: the startup pass
  // reads them again. One whose transcript is gone keeps what it had.
  const dir = tmp();
  const a = createHistory(dir);
  a.record(row('timed', { work: { aiMs: 9 * MIN, operator: [] } }));
  a.record(row('morning', { work: { aiMs: 0, operator: [], models: [] } }));
  a.record(row('split', { work: { aiMs: MIN, operator: [], models: [opus(MIN)], rules: WORK_RULES } }));
  a.save();
  const b = createHistory(dir);
  const again = b.untimed();
  assert.deepEqual(again.map((r) => r.id).sort(), ['morning', 'timed']);
  assert.equal(again.find((r) => r.id === 'timed')?.work?.aiMs, 9 * MIN);
  const m = b.workOf('p1', [])[0];
  assert.equal(m?.aiMs, 10 * MIN);
  assert.deepEqual(m?.models, [opus(MIN)]);
});

test('models survive the fold into months, and a month folded before them has none', () => {
  const dir = tmp();
  const h = createHistory(dir);
  const old = NOW - 45 * DAY;
  h.record(row('old', { startedAt: old, work: { aiMs: 7 * MIN, operator: [], models: [opus(7 * MIN)] } }));
  h.record(row('new', { startedAt: NOW - DAY }));
  assert.ok(!h.has('old'), 'the row past thirty days should have been folded');
  h.save();
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8')) as { folds: { totals: { models?: unknown } }[] };
  assert.deepEqual(createHistory(dir).workOf('p1', [])[1]?.models, [opus(7 * MIN)]);
  // The same file as written before the models: the month has hours and no split.
  delete raw.folds[0]!.totals.models;
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(raw));
  const before = createHistory(dir).workOf('p1', [])[1];
  assert.equal(before?.aiMs, 7 * MIN);
  assert.deepEqual(before?.models, []);
});
