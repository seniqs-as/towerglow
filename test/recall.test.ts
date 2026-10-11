import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_FIELD_CHARS } from '../src/shared/protocol.ts';
import type { ProjectInfo, Snapshot } from '../src/shared/protocol.ts';
import type { ClosedSession } from '../src/server/state/history.ts';
import { buildBrief } from '../src/server/ceo/brief.ts';
import type { BriefNote } from '../src/server/ceo/brief.ts';
import { createEffects } from '../src/server/ceo/effect.ts';
import { createJobStore } from '../src/server/ceo/jobs.ts';
import type { JobStore } from '../src/server/ceo/jobs.ts';
import { createCeoMemory } from '../src/server/ceo/memory.ts';
import type { CeoMemory } from '../src/server/ceo/memory.ts';
import { precedentOf, rebuildJobNotes, recallJob, workNote } from '../src/server/ceo/recall.ts';

/*
 * What the CEO remembers about a job, and why it is now rebuilt.
 *
 * Two failures read in `~/.towerglow/ceo/memory.json` on 18 September 2026:
 *
 *  - the effect of the audit on my_dashboard sat in memory as four lines
 *    (+382% over 3 sessions, +200% over 4, +17% over 8, and "measured, but
 *    not mine"), one per server restart, and the CEO took the first one --
 *    already disproved -- for a trend, and proposed diagnosing it;
 *  - the job line for decsim2 was the echo of the proposal ("review 20
 *    commits"), even after the job registry said 72 commits: the CEO proposed
 *    the same review twice more, and one of those was accepted.
 */

const DAY = 24 * 60 * 60 * 1000;
const AT = Date.parse('2026-09-13T17:09:00.000Z');

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'tg-recall-'));

function row(id: string, startedAt: number, out: number): ClosedSession {
  return {
    id, projectId: 'p1', provider: 'claude', startedAt, confidence: 'reported', watched: true,
    costUsd: 1, tokens: { in: 1000, out, cacheRead: 100_000, cacheWrite: 10_000, thinking: 500 },
    turns: 4, toolCalls: 20, apiMs: 5000, toolMs: 900, wallMs: 60_000,
    linesAdded: 10, linesRemoved: 2,
  };
}

function addJob(jobs: JobStore, id: string, at: number, over: { kind?: string; project?: string } = {}) {
  jobs.add({
    id, at, provider: 'claude', kind: over.kind ?? 'audit',
    summary: 'my_dashboard burns 29.5% of 7d quota with 212 tool calls; find cache misses',
    projectId: over.project ?? 'p1', projectName: over.project === undefined ? 'my_dashboard' : over.project,
  });
}

/** The desk's own wiring, reproduced: the effect line is keyed by job. */
function effectsOn(jobs: JobStore, memory: CeoMemory, rows: () => ClosedSession[]) {
  return createEffects({
    jobs,
    projectSessions: (projectId, from, to) => rows()
      .filter((r) => r.projectId === projectId && r.startedAt >= from && r.startedAt < to),
    remember: (job, text) => memory.note({
      at: Date.now(), provider: job.provider, kind: 'effect',
      project: job.projectName, text, key: `effect:${job.id}`,
    }),
  });
}

/* ─────────────────────── the memory with keys ─────────────────────── */

test('a note with the same key replaces the old one, it is not added beside it', () => {
  const m = createCeoMemory(tmp());
  const note = (text: string, at: number) =>
    ({ at, provider: 'claude' as const, kind: 'effect' as const, project: 'my_dashboard', text, key: 'effect:j1' });
  m.note(note('after your audit: cost per session +382%, over 3 sessions', AT));
  m.note(note('after your audit: cost per session +200%, over 4 sessions', AT + DAY));
  m.note(note('after your audit: cost per session +17%, over 8 sessions', AT + 2 * DAY));
  const list = m.list('claude');
  assert.equal(list.length, 1, 'the readings of the same job piled up');
  assert.match(list[0]!.text, /\+17%/);
});

test('the same keyed note rewritten at every start does not change its date', () => {
  // Otherwise rebuilding the notes at start would make a job from a week ago
  // look like the most recent thing the CEO knows.
  const m = createCeoMemory(tmp());
  const n = { provider: 'claude' as const, kind: 'done' as const, project: 'p', text: 'already done', key: 'work:j1' };
  m.note({ ...n, at: AT });
  m.note({ ...n, at: AT + 5 * DAY });
  assert.equal(m.list('claude')[0]!.at, AT);
});

test('a note rebuilt with its old date does not jump ahead of the recent ones', () => {
  const m = createCeoMemory(tmp());
  const base = { provider: 'claude' as const, kind: 'rejected' as const, project: 'p' };
  m.note({ ...base, at: AT + 3 * DAY, text: 'you turned this down: pause' });
  m.note({ ...base, kind: 'done', at: AT, text: 'already done (your audit of 2026-09-13): x', key: 'work:j1' });
  assert.equal(m.list('claude')[0]!.text, 'you turned this down: pause');
});

test('the key survives a restart', () => {
  const dir = tmp();
  const first = createCeoMemory(dir);
  first.note({ at: AT, provider: 'claude', kind: 'effect', project: 'p', text: '+382%', key: 'effect:j1' });
  first.save();
  const again = createCeoMemory(dir);
  again.note({ at: AT + DAY, provider: 'claude', kind: 'effect', project: 'p', text: '+17%', key: 'effect:j1' });
  assert.deepEqual(again.list('claude').map((n) => n.text), ['+17%']);
});

/* ─────────────────────── the effect: one line per job ─────────────────────── */

test('the readings of the same job across restarts stay a single line', () => {
  // The real case: `noted` lived only in RAM, so every server restart
  // rewrote the measure with the cohort of that moment -- and the memory kept
  // them all, because the text was different.
  const dir = tmp();
  const jobs = createJobStore(dir);
  const memory = createCeoMemory(dir);
  addJob(jobs, 'j1', AT);
  jobs.finish('j1', 'work', { ok: true, outcome: 'done', costUsd: 1, reason: '', at: AT });

  const rows: ClosedSession[] = [
    row('a', AT - 3 * DAY, 2000), row('b', AT - 2 * DAY, 2000), row('c', AT - DAY, 2000),
    row('d', AT + DAY, 9000), row('e', AT + 2 * DAY, 9000), row('f', AT + 3 * DAY, 9000),
  ];
  const first = effectsOn(jobs, memory, () => rows);
  first.freeze(jobs.get('j1')!, AT);
  first.refresh(AT + 4 * DAY);
  assert.match(memory.list('claude')[0]!.text, /over 3 sessions/);

  // The server restarts, more sessions arrive, the reading changes.
  rows.push(row('g', AT + 5 * DAY, 2000), row('h', AT + 6 * DAY, 2000));
  effectsOn(jobs, memory, () => rows).refresh(AT + 7 * DAY);

  const effect = memory.list('claude').filter((n) => n.kind === 'effect');
  assert.equal(effect.length, 1, `effect lines: ${effect.map((n) => n.text).join(' | ')}`);
  assert.match(effect[0]!.text, /over 5 sessions/);
  assert.match(effect[0]!.text, /your audit of 2026-09-13/, 'the line does not say which job it is about');
  assert.match(effect[0]!.text, /still measuring/, 'an open window must say so');
});

test('the verdict takes the place of the number: "not mine" next to "+382%" left the number standing', () => {
  const dir = tmp();
  const jobs = createJobStore(dir);
  const memory = createCeoMemory(dir);
  addJob(jobs, 'j1', AT);
  jobs.finish('j1', 'work', { ok: true, outcome: 'done', costUsd: 1, reason: '', at: AT });
  const rows = [
    row('a', AT - 3 * DAY, 2000), row('b', AT - 2 * DAY, 2000), row('c', AT - DAY, 2000),
    row('d', AT + DAY, 9000), row('e', AT + 2 * DAY, 9000), row('f', AT + 3 * DAY, 9000),
  ];
  const effects = effectsOn(jobs, memory, () => rows);
  effects.freeze(jobs.get('j1')!, AT);
  effects.refresh(AT + 4 * DAY);
  assert.match(memory.list('claude')[0]!.text, /cost per session \+/);

  jobs.setVerdict('j1', { at: AT + 5 * DAY, attributed: false, why: 'cost tracks a fleet-wide thinking surge' });
  effects.refresh(AT + 5 * DAY);

  const effect = memory.list('claude').filter((n) => n.kind === 'effect');
  assert.equal(effect.length, 1);
  assert.match(effect[0]!.text, /measured, but not mine: cost tracks a fleet-wide thinking surge/);
  assert.ok(!effect[0]!.text.includes('%'), 'the number stayed in memory next to the verdict');
});

/* ─────────────────────── the job line ─────────────────────── */

test('the job line is the worker line, with the name of the job', () => {
  const jobs = createJobStore(tmp());
  addJob(jobs, 'j2', AT, { kind: 'consolidate', project: 'decsim2' });
  jobs.report('j2', '72 commits from git log, not 20: categorized by area', false);
  const j = jobs.finish('j2', 'work', { ok: true, outcome: 'x', costUsd: 1, reason: '', at: AT + 1000 })!;
  const n = workNote(j)!;
  assert.equal(n.kind, 'objection');
  assert.equal(n.text, 'done (your consolidate of 2026-09-13), but the request did not hold up: 72 commits from git log, not 20: categorized by area');
});

test('without the worker line the summary remains, called what it is: unchecked words', () => {
  const jobs = createJobStore(tmp());
  addJob(jobs, 'j1', AT);
  const j = jobs.finish('j1', 'work', { ok: true, outcome: 'prose', costUsd: 1, reason: '', at: AT })!;
  assert.match(workNote(j)!.text, /in your own unchecked words: my_dashboard burns 29\.5%/);
});

test('at start the old echo of the proposal gives way to the worker line', () => {
  // decsim2: memory.json said "review 20 commits" even after the job
  // registry said 72. Rejections do not come from a job, and they stay.
  const dir = tmp();
  const jobs = createJobStore(dir);
  addJob(jobs, 'j2', AT, { kind: 'consolidate', project: 'decsim2' });
  jobs.report('j2', '72 commits from git log, not 20', false);
  jobs.finish('j2', 'work', { ok: true, outcome: 'x', costUsd: 1, reason: '', at: AT + 1000 });

  const memory = createCeoMemory(dir);
  const legacy = { provider: 'claude' as const, project: 'decsim2' };
  memory.note({ ...legacy, at: AT, kind: 'done', text: 'already done: decsim2 ... review 20 commits and stabilize for release' });
  memory.note({ ...legacy, at: AT + DAY, kind: 'effect', text: 'after that work: weighted tokens per line +159%, over 4 sessions' });
  memory.note({ ...legacy, at: AT + 2 * DAY, kind: 'rejected', text: 'you turned this down: pause decsim2' });

  rebuildJobNotes(memory, jobs.list());

  const texts = memory.list('claude').map((n) => n.text);
  assert.ok(!texts.some((t) => t.includes('20 commits and stabilize')), 'the echo of the proposal remained');
  assert.ok(!texts.some((t) => t.startsWith('after that work')), 'the unnamed measure remained');
  assert.ok(texts.some((t) => t.includes('did not hold up: 72 commit')), 'the worker line is missing');
  assert.ok(texts.includes('you turned this down: pause decsim2'), 'a rejection does not come from a job');
});

test('rebuilding twice changes nothing', () => {
  const dir = tmp();
  const jobs = createJobStore(dir);
  addJob(jobs, 'j1', AT);
  jobs.finish('j1', 'work', { ok: true, outcome: 'x', costUsd: 1, reason: '', at: AT });
  const memory = createCeoMemory(dir);
  rebuildJobNotes(memory, jobs.list());
  const before = JSON.stringify(memory.list('claude'));
  rebuildJobNotes(memory, jobs.list());
  recallJob(memory, jobs.get('j1')!);
  assert.equal(JSON.stringify(memory.list('claude')), before);
});

/* ─────────────────────── the proposal card ─────────────────────── */

test('a proposal on the same project says on the card that work was already done there, and how it went', () => {
  // On 16 September the CEO proposed again the decsim2 review done two days
  // earlier, and it was accepted: nothing on the card said so.
  const jobs = createJobStore(tmp());
  addJob(jobs, 'j2', AT, { kind: 'consolidate', project: 'decsim2' });
  jobs.report('j2', '72 commits from git log, not 20: categorized by area, no branch to consolidate', false);
  jobs.finish('j2', 'work', { ok: true, outcome: 'x', costUsd: 1, reason: '', at: AT + 1000 });

  const line = precedentOf({ id: 'p9', projectId: 'decsim2', at: AT + 2 * DAY }, jobs.list())!;
  assert.match(line, /^Already worked on here: consolidate of 2026-09-13, the request did not hold up\. 72 commit/);
  assert.ok(line.length <= MAX_FIELD_CHARS, `over the channel cap: ${line.length}`);
});

test('a job outside the window, or on another project, is not a precedent', () => {
  const jobs = createJobStore(tmp());
  addJob(jobs, 'j1', AT, { project: 'decsim2' });
  jobs.finish('j1', 'work', { ok: true, outcome: 'x', costUsd: 1, reason: '', at: AT });
  assert.equal(precedentOf({ id: 'p9', projectId: 'decsim2', at: AT + 15 * DAY }, jobs.list()), null);
  assert.equal(precedentOf({ id: 'p9', projectId: 'other', at: AT + DAY }, jobs.list()), null);
  assert.equal(precedentOf({ id: 'p9', projectId: null, at: AT + DAY }, jobs.list()), null);
});

/* ─────────────────────── in the brief ─────────────────────── */

function project(id: string, name: string): ProjectInfo {
  return {
    id, name, realName: name, disabled: false, slot: 0, exists: true,
    firstSeenAt: AT, lastActiveAt: AT, size: 120,
    lastCommit: null, branch: 'main', commits: 3, providers: ['claude'],
  };
}

test('the effect lines sit apart, and the brief says they are not premises', () => {
  const snap: Snapshot = {
    at: AT, limits: [], projects: [project('p1', 'my_dashboard')], sessions: [],
    agents: [], files: [], recent: [],
  };
  const memory: BriefNote[] = [
    { kind: 'done', project: 'my_dashboard', text: 'already done (your audit of 2026-09-13): x' },
    { kind: 'effect', project: 'my_dashboard', text: 'after your audit of 2026-09-13 (still measuring): cost per session +382%, over 3 sessions' },
  ];
  const text = buildBrief(snap, { provider: 'claude', now: AT, memory });
  const rule = text.indexOf('never make its numbers the');
  assert.ok(rule > 0, 'the rule on the effect lines is missing');
  assert.ok(text.indexOf('already done (your audit') < rule, 'a decision ended up among the measures');
  assert.ok(text.indexOf('+382%') > rule, 'the measure sits before its rule');
});
