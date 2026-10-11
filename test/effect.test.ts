import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cohort, createEffects, DIRECTION, median, METRICS, MIN_COHORT, readable, shortfall,
  sideOf, valueOf,
} from '../src/server/ceo/effect.ts';
import type { ClosedSession } from '../src/server/state/history.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createJobStore } from '../src/server/ceo/jobs.ts';
import type { EffectRecord } from '../src/server/ceo/effect.ts';

/** A fake snapshot, with the only number the tests look at. */
function record(sessions: number): EffectRecord {
  return {
    baseline: {
      at: 1000, projectId: 'p1', provider: 'claude', from: 0, to: 1000,
      sessions, side: sideOf([]),
    },
    voided: '', settled: null, verdict: null,
  };
}

/**
 * Rows are built by hand, as in `history.test.ts`.
 *
 * No global clock and no fs: there is nothing to inject in here because
 * there is nothing that looks outside.
 */
function row(id: string, over: Partial<ClosedSession> = {}): ClosedSession {
  return {
    id,
    projectId: 'p1',
    provider: 'claude',
    startedAt: 1_000,
    confidence: 'reported',
    watched: true,
    costUsd: 1,
    tokens: { in: 1000, out: 2000, cacheRead: 100_000, cacheWrite: 10_000, thinking: 500 },
    turns: 4,
    toolCalls: 20,
    apiMs: 5000,
    toolMs: 900,
    wallMs: 60_000,
    linesAdded: 10,
    linesRemoved: 2,
    ...over,
  };
}

test('a 433-dollar session does not move the median, and that is why it is a median', () => {
  // The case is not made up: history.json really has a row of 616 million
  // tokens of cache reads alone against a project median of two. In a ratio
  // of sums, or in a mean, it rules on its own and that is that.
  const normal = [row('a'), row('b'), row('c')];
  const monster = row('monster', {
    tokens: { in: 688_284, out: 1_462_843, cacheRead: 616_329_360, cacheWrite: 9_019_442, thinking: 0 },
  });

  const without = sideOf(normal).cost.value!;
  const withIt = sideOf([...normal, monster]).cost.value!;

  assert.ok(withIt < without * 1.5, `the median went from ${without} to ${withIt}: the monster took it over`);
});

test('the median is of per-session ratios, not a ratio of sums', () => {
  // Two cheap sessions and a very expensive one: the ratio of sums would say
  // that a line of code costs as much as the big session, the median says what
  // it costs in a TYPICAL session.
  const rows = [
    row('a', { tokens: { in: 0, out: 100, cacheRead: 0, cacheWrite: 0, thinking: 0 }, linesAdded: 10, linesRemoved: 0 }),
    row('b', { tokens: { in: 0, out: 100, cacheRead: 0, cacheWrite: 0, thinking: 0 }, linesAdded: 10, linesRemoved: 0 }),
    row('c', { tokens: { in: 0, out: 100_000, cacheRead: 0, cacheWrite: 0, thinking: 0 }, linesAdded: 10, linesRemoved: 0 }),
  ];
  // per line: 50, 50, 50000 -> median 50. Sums: 500500/30 = 16683.
  assert.equal(sideOf(rows).yield.value, 50);
});

test('the CEO worker does not enter the cohort of the project it worked on', () => {
  // Measured: after the audit on my_dashboard there are four sessions, and TWO
  // are the worker and the reviewer. Counting them would mean measuring the
  // CEO's cost and calling it the project's work.
  const rows = [row('mine'), row('worker'), row('reviewer')];
  const kept = cohort(rows, 'claude', new Set(['worker', 'reviewer']));
  assert.deepEqual(kept.map((r) => r.id), ['mine']);
});

test('a row with every token at zero stays out: it did not cost zero, it is unknown', () => {
  // It really exists, dated 2026-09-08. Inside a median it would drag it to zero.
  const empty = row('empty', { tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 } });
  const kept = cohort([row('a'), empty], 'claude', new Set());
  assert.deepEqual(kept.map((r) => r.id), ['a']);
});

test('the other tool does not enter: two token economies do not make one median', () => {
  const kept = cohort([row('claude1'), row('codex1', { provider: 'codex' })], 'claude', new Set());
  assert.deepEqual(kept.map((r) => r.id), ['claude1']);
});

test('under three sessions no number comes out, only how many are missing and for which figure', () => {
  const side = sideOf([row('a'), row('b')]);
  assert.equal(side.cost.value, null, 'two rows are not enough');
  assert.equal(side.cost.n, 2, 'but how many there are is known, and that is what gets said');

  const gap = shortfall(side);
  assert.equal(gap.need, 1);
  assert.ok(gap.needFor !== null, 'and the figure about to open is named');
});

test('the gate is per metric: the cost reads while the calls per turn do not', () => {
  // The five figures have different predicates, so on the same handful of
  // rows they form cohorts of different sizes. A single gate on the whole
  // reading would say `null` to everything.
  const rows = [
    row('a', { watched: false, turns: 0, toolCalls: 0 }),
    row('b', { watched: false, turns: 0, toolCalls: 0 }),
    row('c', { watched: false, turns: 0, toolCalls: 0 }),
  ];
  const side = sideOf(rows);
  assert.ok(side.cost.value !== null, 'the cost is there: three rows with tokens');
  assert.equal(side.calls.value, null, 'the calls are not: none of these was watched');
  assert.equal(side.calls.n, 0);
});

test('a row recovered from disk has no turns, and does not pretend to have any', () => {
  const seed = row('seed', { watched: false, turns: 0, toolCalls: 0 });
  assert.equal(valueOf(seed, 'calls'), null);
});

test('a session that touched no code stays out of the yield, and is not worth zero', () => {
  const noLines = row('doc', { linesAdded: 0, linesRemoved: 0 });
  assert.equal(valueOf(noLines, 'yield'), null, 'null, never zero and never infinity');
});

test('Codex does not declare landed lines: the yield stays empty instead of dividing by zero', () => {
  const rows = [
    row('x', { provider: 'codex', confidence: 'inferred', linesAdded: 0, linesRemoved: 0 }),
    row('y', { provider: 'codex', confidence: 'inferred', linesAdded: 0, linesRemoved: 0 }),
    row('z', { provider: 'codex', confidence: 'inferred', linesAdded: 0, linesRemoved: 0 }),
  ];
  const side = sideOf(rows);
  assert.equal(side.yield.value, null);
  assert.equal(side.yield.n, 0);
  assert.ok(side.cost.value !== null, 'but the cost is measured for Codex too');
});

test('no figure can produce NaN, not even from a row that is all zeros', () => {
  const zero = row('zero', {
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    turns: 0, toolCalls: 0, linesAdded: 0, linesRemoved: 0, watched: false,
  });
  for (const id of METRICS) {
    const v = valueOf(zero, id);
    assert.ok(v === null || Number.isFinite(v), `${id} produced ${v}`);
  }
});

test('the output share is measured on WEIGHT, not on in plus out', () => {
  // On a real session of 21.8 million weighted tokens the output is worth 10%.
  // With out/(in+out) it would come out at 92%, which is just as true and does
  // not say where the quota is going.
  const r = row('r', { tokens: { in: 100, out: 1000, cacheRead: 1_000_000, cacheWrite: 0, thinking: 0 } });
  const share = valueOf(r, 'output')!;
  assert.ok(share > 3 && share < 5, `expected around 4%, got ${share}`);
});

test('two figures out of five have no direction, and are not coloured', () => {
  assert.equal(DIRECTION.output, 'none');
  assert.equal(DIRECTION.calls, 'none');
  assert.equal(DIRECTION.cost, 'lower');
  assert.equal(DIRECTION.cache, 'higher');
});

test('one figure readable on both sides is enough: waiting for all of them means never reading', () => {
  const watched = [row('a'), row('b'), row('c')];
  const fromDisk = [
    row('d', { watched: false, turns: 0, toolCalls: 0 }),
    row('e', { watched: false, turns: 0, toolCalls: 0 }),
    row('f', { watched: false, turns: 0, toolCalls: 0 }),
  ];
  const ok = readable(sideOf(watched), sideOf(fromDisk));
  assert.ok(ok.includes('cost'));
  assert.ok(!ok.includes('calls'), 'the calls are missing on one side, so they are not compared');
});

test('the median of nothing is null, not zero', () => {
  assert.equal(median([]), null);
  assert.equal(median([2, 1, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('MIN_COHORT is three, and the test exists because the number is a measurement', () => {
  // At five, on the two real jobs on disk ("after" cohorts of 2 and 0 sessions)
  // no figure would ever have become readable. A gate that never opens does
  // not protect: it does not exist.
  assert.equal(MIN_COHORT, 3);
});

/* ─────────────── the ledger: where the measurement is kept ─────────────── */

test('the snapshot is taken only once: the second does not overwrite', () => {
  // At thirty days the rows that produced it disappear from the history
  // ledger. A baseline retaken from a poorer set would say that the "before"
  // has changed, and a before that changes is not a before.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-eff-'));
  const s = createJobStore(dir);
  s.add({
    id: 'j1', at: 1000, provider: 'claude', kind: 'audit',
    summary: 'something', projectId: 'p1', projectName: 'p1',
  });

  s.freeze('j1', record(10));
  s.freeze('j1', record(99));

  assert.equal(s.get('j1')?.effect?.baseline?.sessions, 10);
});

test('a ledger written before the measurement existed still reads, with effect at null', () => {
  // The reason VERSION stays 2: createJobStore discards the whole file if the
  // number does not match, and the jobs already on disk would vanish from Reports.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-eff-'));
  fs.mkdirSync(path.join(dir, 'ceo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ceo', 'jobs.json'), JSON.stringify({
    version: 2,
    jobs: [{
      id: 'old', at: 1, provider: 'claude', kind: 'audit', summary: 's',
      projectId: 'p1', projectName: 'p1',
      work: {
        state: 'done', sessionId: null, toolCalls: 0, costUsd: 0,
        outcome: 'x', truncated: false, reason: '', endedAt: 2,
      },
      review: null, reviewHolds: null, dismissed: false,
    }],
  }));

  const s = createJobStore(dir);
  const j = s.get('old');
  assert.ok(j, 'the old job must still be there');
  assert.equal(j.effect, null, 'and the new field is null, not undefined');
});

test('a reading cannot be put on record for a job that has no before', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-eff-'));
  const s = createJobStore(dir);
  s.add({
    id: 'j2', at: 1000, provider: 'claude', kind: 'audit',
    summary: 's', projectId: 'p1', projectName: 'p1',
  });
  assert.equal(s.settle('j2', {} as never), undefined);
});

/* ─────────────────────── the life cycle ─────────────────────── */

const DAY = 24 * 60 * 60 * 1000;

/** A bench with a fake in-memory history and a real ledger on disk. */
function bench(rows: ClosedSession[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-eff-'));
  const jobs = createJobStore(dir);
  const notes: string[] = [];
  const effects = createEffects({
    jobs,
    projectSessions: (projectId, from, to) => rows
      .filter((r) => r.projectId === projectId && r.startedAt >= from && r.startedAt < to)
      .sort((a, b) => a.startedAt - b.startedAt),
    remember: (_job, text) => notes.push(text),
  });
  return { jobs, effects, notes };
}

function job(jobs: ReturnType<typeof bench>['jobs'], id: string, at: number) {
  jobs.add({
    id, at, provider: 'claude', kind: 'audit',
    summary: 'cut the calls', projectId: 'p1', projectName: 'p1',
  });
  return jobs.get(id)!;
}

test('the worker does not enter the before, even if it appears to start an instant before the job', () => {
  // The real case: the audit worker has startedAt 434 ms BEFORE job.at.
  // Cutting the window at the end of the job would have counted it among the
  // sessions "before" itself.
  const at = 10 * DAY;
  const rows = [
    row('mine1', { startedAt: at - 3 * DAY }),
    row('mine2', { startedAt: at - 2 * DAY }),
    row('mine3', { startedAt: at - 1 * DAY }),
    row('worker', { startedAt: at - 434 }),
  ];
  const b = bench(rows);
  const j = job(b.jobs, 'j1', at);
  b.jobs.attach('j1', 'work', 'worker');
  b.effects.freeze(b.jobs.get('j1')!, at + 1000);

  const base = b.jobs.get('j1')!.effect!.baseline!;
  assert.equal(base.sessions, 3, 'three sessions of mine, the worker out');
  assert.equal(base.to, at, 'the window ends when you accepted');
  void j;
});

test('a failed job has no before: there was no treatment', () => {
  const b = bench([]);
  job(b.jobs, 'j1', 1000);
  b.jobs.finish('j1', 'work', { ok: false, outcome: '', costUsd: 0, reason: 'died', at: 2000 });
  b.effects.freeze(b.jobs.get('j1')!, 3000);

  const rec = b.jobs.get('j1')!.effect!;
  assert.equal(rec.baseline, null);
  assert.equal(rec.voided, 'the work failed');
});

test('a second job on the same project truncates the window, it does not void it', () => {
  const at = 10 * DAY;
  const rows = [
    row('a', { startedAt: at - 3 * DAY }),
    row('b', { startedAt: at - 2 * DAY }),
    row('c', { startedAt: at - 1 * DAY }),
    row('after1', { startedAt: at + 1 * DAY }),
    row('after2', { startedAt: at + 2 * DAY }),
    row('after3', { startedAt: at + 3 * DAY }),
    // This one falls past the second job: it belongs to that one, not to this.
    row('others', { startedAt: at + 6 * DAY }),
  ];
  const b = bench(rows);
  job(b.jobs, 'j1', at);
  b.jobs.finish('j1', 'work', { ok: true, outcome: 'done', costUsd: 1, reason: '', at });
  b.effects.freeze(b.jobs.get('j1')!, at);
  job(b.jobs, 'j2', at + 5 * DAY);

  const r = b.effects.board(at + 8 * DAY).find((x) => x.job.id === 'j1')!.reading!;
  assert.equal(r.afterSessions, 3, 'only the three sessions before the second job');
  assert.equal(r.closedBy, 'job');
  assert.equal(r.state, 'read', 'the cohort was already full: the measurement stands, it is not thrown away');
});

test('a worker without a receipt does not lead to declaring that nothing landed', () => {
  // Measured: all three CEO workers on disk have linesAdded at zero because
  // their row is `inferred`, and one of them had really written code.
  // That zero is an absence, not a fact.
  const at = 10 * DAY;
  const rows = [
    row('a', { startedAt: at - 3 * DAY }),
    row('b', { startedAt: at - 2 * DAY }),
    row('c', { startedAt: at - 1 * DAY }),
    row('worker', {
      startedAt: at + 1000, confidence: 'inferred', linesAdded: 0, linesRemoved: 0,
    }),
    row('d', { startedAt: at + 1 * DAY }),
    row('e', { startedAt: at + 2 * DAY }),
    row('f', { startedAt: at + 3 * DAY }),
  ];
  const b = bench(rows);
  job(b.jobs, 'j1', at);
  b.jobs.attach('j1', 'work', 'worker');
  b.jobs.finish('j1', 'work', { ok: true, outcome: 'done', costUsd: 1, reason: '', at });
  b.effects.freeze(b.jobs.get('j1')!, at);

  const r = b.effects.board(at + 4 * DAY).find((x) => x.job.id === 'j1')!.reading!;
  assert.notEqual(r.state, 'void', 'whether it wrote is unknown: the measurement is taken anyway');
  assert.match(r.reason, /no receipt/, 'but it says that it is unknown');
});

test('a worker with a receipt and zero lines declares that nothing landed', () => {
  const at = 10 * DAY;
  const rows = [
    row('a', { startedAt: at - 3 * DAY }),
    row('b', { startedAt: at - 2 * DAY }),
    row('c', { startedAt: at - 1 * DAY }),
    row('worker', {
      startedAt: at + 1000, confidence: 'reported', linesAdded: 0, linesRemoved: 0,
    }),
  ];
  const b = bench(rows);
  job(b.jobs, 'j1', at);
  b.jobs.attach('j1', 'work', 'worker');
  b.jobs.finish('j1', 'work', { ok: true, outcome: 'done', costUsd: 1, reason: '', at });
  b.effects.freeze(b.jobs.get('j1')!, at);

  const r = b.effects.board(at + 4 * DAY).find((x) => x.job.id === 'j1')!.reading!;
  assert.equal(r.state, 'void');
  assert.match(r.reason, /nothing landed/);
});

test('until there are enough sessions it says how many are missing, and for what', () => {
  const at = 10 * DAY;
  const rows = [
    row('a', { startedAt: at - 3 * DAY }),
    row('b', { startedAt: at - 2 * DAY }),
    row('c', { startedAt: at - 1 * DAY }),
    row('after1', { startedAt: at + 1 * DAY }),
  ];
  const b = bench(rows);
  job(b.jobs, 'j1', at);
  b.jobs.finish('j1', 'work', { ok: true, outcome: 'done', costUsd: 1, reason: '', at });
  b.effects.freeze(b.jobs.get('j1')!, at);

  const r = b.effects.board(at + 2 * DAY).find((x) => x.job.id === 'j1')!.reading!;
  assert.equal(r.state, 'waiting');
  assert.equal(r.need, 2);
  assert.match(r.reason, /2 more sessions for/);
});

test('the line that goes into memory always carries the cohort next to the percentage', () => {
  // Without it, the CEO rereads "-38%" in the brief and reasons on it as on a
  // success of its own measured over who knows how many sessions.
  const at = 10 * DAY;
  const expensive = { in: 0, out: 100_000, cacheRead: 0, cacheWrite: 0, thinking: 0 };
  const cheap = { in: 0, out: 10_000, cacheRead: 0, cacheWrite: 0, thinking: 0 };
  const rows = [
    row('a', { startedAt: at - 3 * DAY, tokens: expensive }),
    row('b', { startedAt: at - 2 * DAY, tokens: expensive }),
    row('c', { startedAt: at - 1 * DAY, tokens: expensive }),
    row('d', { startedAt: at + 1 * DAY, tokens: cheap }),
    row('e', { startedAt: at + 2 * DAY, tokens: cheap }),
    row('f', { startedAt: at + 3 * DAY, tokens: cheap }),
  ];
  const b = bench(rows);
  job(b.jobs, 'j1', at);
  b.jobs.finish('j1', 'work', { ok: true, outcome: 'done', costUsd: 1, reason: '', at });
  b.effects.freeze(b.jobs.get('j1')!, at);

  b.effects.refresh(at + 4 * DAY);
  assert.equal(b.notes.length, 1);
  assert.match(b.notes[0]!, /over 3 sessions/);
  assert.match(b.notes[0]!, /-90%/);
});

test('the line in memory is written only once, not at every question', () => {
  const at = 10 * DAY;
  const rows = [
    row('a', { startedAt: at - 3 * DAY }),
    row('b', { startedAt: at - 2 * DAY }),
    row('c', { startedAt: at - 1 * DAY }),
    row('d', { startedAt: at + 1 * DAY }),
    row('e', { startedAt: at + 2 * DAY }),
    row('f', { startedAt: at + 3 * DAY }),
  ];
  const b = bench(rows);
  job(b.jobs, 'j1', at);
  b.jobs.finish('j1', 'work', { ok: true, outcome: 'done', costUsd: 1, reason: '', at });
  b.effects.freeze(b.jobs.get('j1')!, at);

  b.effects.refresh(at + 4 * DAY);
  b.effects.refresh(at + 5 * DAY);
  b.effects.refresh(at + 6 * DAY);
  assert.equal(b.notes.length, 1);
});

test('when nothing moved the memory says so, instead of staying silent', () => {
  const at = 10 * DAY;
  const rows = [
    row('a', { startedAt: at - 3 * DAY }), row('b', { startedAt: at - 2 * DAY }),
    row('c', { startedAt: at - 1 * DAY }), row('d', { startedAt: at + 1 * DAY }),
    row('e', { startedAt: at + 2 * DAY }), row('f', { startedAt: at + 3 * DAY }),
  ];
  const b = bench(rows);
  job(b.jobs, 'j1', at);
  b.jobs.finish('j1', 'work', { ok: true, outcome: 'done', costUsd: 1, reason: '', at });
  b.effects.freeze(b.jobs.get('j1')!, at);

  b.effects.refresh(at + 4 * DAY);
  assert.match(b.notes[0]!, /nothing moved/);
});

test('a closed window is put on record and never recomputed', () => {
  // At thirty days the rows that produced it disappear: a reading that kept
  // redoing itself would become progressively false without saying so.
  const at = 10 * DAY;
  const rows = [
    row('a', { startedAt: at - 3 * DAY }), row('b', { startedAt: at - 2 * DAY }),
    row('c', { startedAt: at - 1 * DAY }), row('d', { startedAt: at + 1 * DAY }),
    row('e', { startedAt: at + 2 * DAY }), row('f', { startedAt: at + 3 * DAY }),
  ];
  const b = bench(rows);
  job(b.jobs, 'j1', at);
  b.jobs.finish('j1', 'work', { ok: true, outcome: 'done', costUsd: 1, reason: '', at });
  b.effects.freeze(b.jobs.get('j1')!, at);

  b.effects.refresh(at + 20 * DAY);
  const settled = b.jobs.get('j1')!.effect!.settled;
  assert.ok(settled, 'past fourteen days the window closes');
  assert.equal(settled.closedBy, 'time');
  assert.equal(settled.afterSessions, 3);

  rows.length = 0;
  const after = b.effects.board(at + 40 * DAY).find((x) => x.job.id === 'j1')!.reading!;
  assert.equal(after.afterSessions, 3, 'the record stays even without the rows that produced it');
});

test('a finished job without a snapshot takes one at the first opportunity', () => {
  // It is the path by which jobs accepted BEFORE this measurement existed
  // come onto the scene: without it, they would stay empty forever.
  const at = 10 * DAY;
  const rows = [
    row('a', { startedAt: at - 3 * DAY }),
    row('b', { startedAt: at - 2 * DAY }),
    row('c', { startedAt: at - 1 * DAY }),
  ];
  const b = bench(rows);
  job(b.jobs, 'j1', at);
  b.jobs.finish('j1', 'work', { ok: true, outcome: 'done', costUsd: 1, reason: '', at });
  assert.equal(b.jobs.get('j1')!.effect, null, 'nobody froze it at the end');

  b.effects.refresh(at + DAY);
  assert.equal(b.jobs.get('j1')!.effect?.baseline?.sessions, 3);
});

test('too late for an honest before, it says so instead of taking a false one', () => {
  // The snapshot looks back fourteen days and the history keeps thirty:
  // beyond the difference, what disappears are the OLDEST rows, and a
  // baseline on the few left would say the project cost less than it
  // actually did.
  const at = 10 * DAY;
  const b = bench([row('a', { startedAt: at - DAY })]);
  job(b.jobs, 'j1', at);
  b.jobs.finish('j1', 'work', { ok: true, outcome: 'done', costUsd: 1, reason: '', at });

  b.effects.refresh(at + 20 * DAY);
  const rec = b.jobs.get('j1')!.effect!;
  assert.equal(rec.baseline, null);
  assert.match(rec.voided, /no longer on disk/);
});

test('a job still running takes no snapshot', () => {
  const b = bench([]);
  job(b.jobs, 'j1', 1000);
  b.effects.refresh(2000);
  assert.equal(b.jobs.get('j1')!.effect, null);
});
