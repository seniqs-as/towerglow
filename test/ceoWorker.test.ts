import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createFleet } from '../src/server/ceo/fleet.ts';
import {
  costOf, createJobStore, expiredOnStage, stateOf, toolCallsOf,
  KEEP_ON_STAGE_MS, MAX_OUTCOME_CHARS,
} from '../src/server/ceo/jobs.ts';
import type { JobEnd } from '../src/server/ceo/jobs.ts';
import type { Proposal } from '../src/server/ceo/proposals.ts';
import { World } from '../src/server/state/world.ts';
import type { LiveSession } from '../src/server/providers/types.ts';
import type { DeltaEvent, ProviderId, Snapshot } from '../src/shared/protocol.ts';

/*
 * A CEO's worker signs up to the registry of live sessions like any other
 * session -- measured: ~/.claude/sessions/38339.json with kind
 * "interactive", written by a `claude -p` launched by the fleet. So the
 * session WE open is also discovered, and for a while the same effort showed
 * up twice: the badge on the project's tower and the turret on the HQ.
 *
 * Every test that starts a job closes it with `stopAll`: the hard timeout is
 * a twenty-minute timer, and a live timer keeps node alive. Without it the
 * suite does not fail -- it hangs, which is worse to diagnose.
 */

const NOW = Date.parse('2026-09-13T17:00:00.000Z');
const CWD = '/Users/tester/proj';
const WORKER_PID = 38339;
const SESSION = '157fc912-9f85-464a-8ee4-6620db840646';

/* ─────────────────────────── the fleet ─────────────────────────── */

interface Fake {
  child: ChildProcess;
  stdout: PassThrough;
}

function fakeChild(pid: number): Fake {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new PassThrough();
  Object.assign(child, {
    pid, stdout, stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true,
  });
  return { child, stdout };
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1', at: NOW, provider: 'claude', kind: 'audit', summary: 'tidy up',
    projectId: 'proj', projectName: 'proj', task: 'tidy it up', status: 'accepted',
    decidedAt: NOW, sessionId: null, ...over,
  };
}

function snapshot(): Snapshot {
  return { at: NOW, limits: [], projects: [], sessions: [], agents: [], files: [], recent: [] };
}

interface Harness {
  fleet: ReturnType<typeof createFleet>;
  fake: Fake;
  started: string[];
  progress: number[];
  attached: string[];
  ended: JobEnd[];
  quota: { provider: ProviderId; used: number[] }[];
}

function harness(t: TestContext, pid = WORKER_PID): Harness {
  const fake = fakeChild(pid);
  const started: string[] = [];
  const progress: number[] = [];
  const attached: string[] = [];
  const ended: JobEnd[] = [];
  const quota: Harness['quota'] = [];
  const fleet = createFleet({
    model: 'sonnet',
    ledger: { blockedReason: () => null, record: () => {}, spentUsd: () => 0, save: () => {} },
    execute: true,
    snapshot,
    cwdOf: () => CWD,
    onStart: (p) => started.push(p.id),
    onProgress: (_id, n) => progress.push(n),
    onAdopt: (_id, s) => attached.push(s),
    onEnd: (_id, out) => ended.push(out),
    onQuota: (provider, windows) => quota.push({ provider, used: windows.map((w) => w.usedPercent) }),
    spawn: () => fake.child,
  });
  // `t.after` and not a call at the end of the test: the hard timeout is a
  // twenty-minute timer, and a test that fails before closing it leaves the
  // suite hanging instead of red.
  t.after(() => fleet.stopAll());
  return { fleet, fake, started, progress, attached, ended, quota };
}

/** A `stream-json` line as `claude -p` writes it. */
const resultLine = (text: string, cost = 0.42): string =>
  `${JSON.stringify({ type: 'result', total_cost_usd: cost, result: text })}\n`;

const toolLine = (n: number): string =>
  `${JSON.stringify({
    type: 'assistant',
    message: { content: Array.from({ length: n }, () => ({ type: 'tool_use' })) },
  })}\n`;

test('starting a job opens it in the registry, it does not invent a session', (t) => {
  // Before this the fleet invented a SessionInfo with pid 0. It died with the
  // process, and the outcome with it: you accepted a piece of advice and could
  // no longer tell how it went.
  const h = harness(t);
  const out = h.fleet.start(proposal());
  assert.equal(out.ok, true);
  assert.equal(out.jobId, 'p1', 'the job carries the id of the proposal');
  assert.deepEqual(h.started, ['p1']);
});

test('the fleet recognises the pid of its own worker and takes its session', (t) => {
  const h = harness(t);
  h.fleet.start(proposal());
  assert.equal(h.fleet.adopt(WORKER_PID, SESSION), 'claude');
  assert.deepEqual(h.attached, [SESSION], 'the thread between the job and the session');
});

test('adopting twice does not attach twice', (t) => {
  // Reconciliation runs continuously: every round would ask the question again.
  const h = harness(t);
  h.fleet.start(proposal());
  h.fleet.adopt(WORKER_PID, SESSION);
  h.fleet.adopt(WORKER_PID, SESSION);
  assert.equal(h.attached.length, 1);
});

test('a pid that belongs to no worker is not adopted', (t) => {
  const h = harness(t);
  h.fleet.start(proposal());
  assert.equal(h.fleet.adopt(99999, SESSION), null);
  assert.equal(h.fleet.adopt(0, SESSION), null);
  assert.equal(h.fleet.adopt(1, SESSION), null);
});

test('the final answer is read from the result line, together with its price', async (t) => {
  // It is the same line we were already reading `total_cost_usd` from: we
  // threw the outcome away two characters from where it was needed.
  const h = harness(t);
  h.fleet.start(proposal());
  h.fake.stdout.write(toolLine(3));
  h.fake.stdout.write(resultLine('I found three things'));
  await new Promise((r) => setImmediate(r));
  h.fake.child.emit('close', 0, null);

  assert.deepEqual(h.progress, [3], 'the turret grows with the work done');
  assert.equal(h.ended.length, 1);
  assert.equal(h.ended[0]!.ok, true);
  assert.equal(h.ended[0]!.outcome, 'I found three things');
  assert.equal(h.ended[0]!.costUsd, 0.42);
});

test('a worker that exits without an answer is not a successful job', async (t) => {
  // Exiting with zero is not enough: the outcome is the only thing it started for.
  const h = harness(t);
  h.fleet.start(proposal());
  h.fake.child.emit('close', 0, null);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.ended[0]!.ok, false);
  assert.match(h.ended[0]!.reason, /no answer/);
});

test('a killed worker says so, and says by what', async (t) => {
  const h = harness(t);
  h.fleet.start(proposal());
  h.fake.child.emit('close', null, 'SIGTERM');
  await new Promise((r) => setImmediate(r));
  assert.equal(h.ended[0]!.ok, false);
  assert.match(h.ended[0]!.reason, /SIGTERM/);
});

/* ─────────────────────────── the registry ─────────────────────────── */

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'tg-jobs-'));

const newJob = (id = 'p1'): Parameters<ReturnType<typeof createJobStore>['add']>[0] => ({
  id, at: NOW, provider: 'claude', kind: 'audit',
  summary: 'tidy up', projectId: 'proj', projectName: 'proj',
});

const ended = (over: Partial<JobEnd> = {}): JobEnd =>
  ({ ok: true, outcome: 'done', costUsd: 0.1, reason: '', at: NOW + 1000, ...over });

test('a finished job stays on stage: that is where you read how it went', (t) => {
  const store = createJobStore(tmp());
  store.add(newJob());
  store.finish('p1', 'work', ended());
  assert.equal(stateOf(store.get('p1')!), 'done');
  assert.equal(store.onStage().length, 1, 'finished does not mean gone');
});

test('a single turret for both parts: it is a single decision, yours', (t) => {
  // Two turrets for a single yes would say you accepted two things, and the
  // outcome and the review would be read in two places far apart.
  const store = createJobStore(tmp());
  store.add(newJob());
  store.openReview('p1', false);
  assert.equal(store.onStage().length, 1);
  assert.ok(store.get('p1')?.review, 'the review did not hook onto the job');
});

test('while either of the two parts runs, the turret runs', (t) => {
  // Putting up the check mark while the review is still running would change
  // the text under the eyes of whoever is reading it.
  const store = createJobStore(tmp());
  store.add(newJob());
  store.openReview('p1', false);
  store.finish('p1', 'work', ended());
  assert.equal(stateOf(store.get('p1')!), 'running', 'the review was still running');
  store.finish('p1', 'review', ended({ outcome: 'holds' }));
  assert.equal(stateOf(store.get('p1')!), 'done');
});

test('a missing review does not paint a successful job red', (t) => {
  // What you had accepted was done: saying otherwise because of a review that
  // never arrived would be a lie at a glance.
  const store = createJobStore(tmp());
  store.add(newJob());
  store.openReview('p1', false);
  store.finish('p1', 'work', ended());
  store.finish('p1', 'review', ended({ ok: false, reason: 'stopped by SIGTERM' }));
  assert.equal(stateOf(store.get('p1')!), 'done');
});

test('calls and cost belong to both parts: one decision, one bill', (t) => {
  const store = createJobStore(tmp());
  store.add(newJob());
  store.openReview('p1', false);
  store.progress('p1', 'work', 20);
  store.progress('p1', 'review', 6);
  store.finish('p1', 'work', ended({ costUsd: 0.3 }));
  store.finish('p1', 'review', ended({ costUsd: 0.2 }));
  const j = store.get('p1')!;
  assert.equal(toolCallsOf(j), 26);
  assert.ok(Math.abs(costOf(j) - 0.5) < 1e-9);
});

test('the verdict sits on the job, not hidden inside its half', (t) => {
  const store = createJobStore(tmp());
  store.add(newJob());
  store.openReview('p1', false);
  store.finish('p1', 'review', ended({ outcome: 'does not apply' }), false);
  assert.equal(store.get('p1')?.reviewHolds, false);
});

test('only a finished job can be closed', (t) => {
  const store = createJobStore(tmp());
  store.add(newJob());
  store.dismiss('p1');
  assert.equal(store.onStage().length, 1, 'a running job does not close');
  store.finish('p1', 'work', ended());
  store.dismiss('p1');
  assert.equal(store.onStage().length, 0);
  assert.equal(store.list().length, 1, 'closed on screen, not deleted: it stays in Reports');
});

test('the second close does not overwrite the first', (t) => {
  // `error` and `close` can both arrive: what was known first wins, which is
  // also what told the truth about why.
  const store = createJobStore(tmp());
  store.add(newJob());
  store.finish('p1', 'work', ended({ ok: false, outcome: '', reason: 'spawn failed' }));
  store.finish('p1', 'work', ended({ outcome: 'late', costUsd: 9 }));
  assert.equal(store.get('p1')?.work.state, 'failed');
  assert.equal(store.get('p1')?.work.reason, 'spawn failed');
});

test('an outcome that is too long is cut, and says so', (t) => {
  const store = createJobStore(tmp());
  store.add(newJob());
  store.finish('p1', 'work', ended({ outcome: 'x'.repeat(MAX_OUTCOME_CHARS + 500) }));
  assert.equal(store.get('p1')?.work.outcome.length, MAX_OUTCOME_CHARS);
  assert.equal(store.get('p1')?.work.truncated, true, 'a text cut silently looks like an interrupted model');
});

test('a part still running at restart is a part that died with the previous server', (t) => {
  // Reopening it as running would give a turret growing for a process that
  // does not exist, and a wait for an outcome that will never arrive.
  const dir = tmp();
  const first = createJobStore(dir);
  first.add(newJob());
  first.openReview('p1');
  first.save();

  const second = createJobStore(dir);
  assert.equal(second.get('p1')?.work.state, 'failed');
  assert.equal(second.get('p1')?.review?.state, 'failed');
  assert.match(second.get('p1')?.work.reason ?? '', /server stopped/);
});

/* ─────────────────────────── the world ─────────────────────────── */

const live = (over: Partial<LiveSession> = {}): LiveSession => ({
  sessionId: SESSION, provider: 'claude', pid: WORKER_PID,
  cwd: CWD, label: 'my-dashboard-e5', title: null, status: 'busy',
  statusConfidence: 'reported', waitingFor: null, kind: 'interactive', version: '2.1.0',
  model: 'sonnet', startedAt: NOW, updatedAt: NOW, statusSince: NOW, ...over,
});

function worldWith(adopt: (pid: number, sessionId: string) => ProviderId | null): World {
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
    adoptCeoSession: adopt,
  });
}

function apply(world: World, sessions: LiveSession[]): DeltaEvent[] {
  return [...world.applyLiveSessions('claude', sessions, () => true, () => NOW, () => ({ files: 40, dirs: 0 }))];
}

test('a discovered session whose pid belongs to the CEOs does not settle in the project', (t) => {
  const world = worldWith((pid) => (pid === WORKER_PID ? 'claude' : null));
  const added = apply(world, [live()]).find((e) => e.t === 'session.add');
  assert.ok(added);
  assert.equal(added.session.spawnedByCeo, 'claude');
  assert.equal(added.session.pid, WORKER_PID, 'the real pid stays: it is what gets it reaped');
});

test('the world also passes the session id, not just the pid', (t) => {
  // Without it the fleet could not tie the job to the session doing it, and
  // the lightning bolt on the turret would have nothing to tell.
  const seen: [number, string][] = [];
  const world = worldWith((pid, id) => { seen.push([pid, id]); return 'claude'; });
  apply(world, [live()]);
  assert.deepEqual(seen, [[WORKER_PID, SESSION]]);
});

test('an ordinary session stays in its project', (t) => {
  const world = worldWith(() => null);
  const added = apply(world, [live({ pid: 47539 })]).find((e) => e.t === 'session.add');
  assert.ok(added);
  assert.equal(added.session.spawnedByCeo, null);
});

test('the question is asked only once, at birth', (t) => {
  const asked: number[] = [];
  const world = worldWith((pid) => { asked.push(pid); return 'claude'; });
  apply(world, [live()]);
  apply(world, [live()]);
  apply(world, [live()]);
  assert.deepEqual(asked, [WORKER_PID]);
});

test('a worker born before its pid is known is adopted when the pid appears', (t) => {
  /*
   * Codex's pids come from logs_2.sqlite, read every 30 s, while a new rollout
   * is seen within a second: a CEO's Codex worker was born with pid 0, asked
   * once, never adopted, and stayed "1 active session of yours" in the plan,
   * holding that project's queue (2026-10-22).
   */
  const asked: number[] = [];
  const world = worldWith((pid) => { asked.push(pid); return pid === WORKER_PID ? 'codex' : null; });
  const pass = (pid: number): DeltaEvent[] => [...world.applyLiveSessions('codex',
    [live({ provider: 'codex', pid, statusConfidence: 'inferred' })], () => true, () => NOW, () => ({ files: 40, dirs: 0 }))];
  const born = pass(0).find((e) => e.t === 'session.add');
  assert.ok(born);
  assert.equal(born.session.spawnedByCeo, null);
  const later = pass(WORKER_PID).find((e) => e.t === 'session.update');
  assert.ok(later && later.t === 'session.update');
  assert.equal(later.patch.pid, WORKER_PID);
  assert.equal(later.patch.spawnedByCeo, 'codex');
  pass(WORKER_PID);
  assert.deepEqual(asked, [0, WORKER_PID], 'at birth, then once when the pid appears, and never again');
});

test('an ordinary session whose pid appears late gets the pid and stays yours', (t) => {
  // The pid is what brings its terminal forward: it is kept even when nobody adopts it.
  const world = worldWith(() => null);
  const pass = (pid: number): DeltaEvent[] => [...world.applyLiveSessions('codex',
    [live({ provider: 'codex', pid: pid, statusConfidence: 'inferred' })], () => true, () => NOW, () => ({ files: 40, dirs: 0 }))];
  pass(0);
  const later = pass(47539).find((e) => e.t === 'session.update');
  assert.ok(later && later.t === 'session.update');
  assert.equal(later.patch.pid, 47539);
  assert.equal(later.patch.spawnedByCeo, undefined);
});

test('a worker that disappears from the registry is reaped like everyone else', (t) => {
  // The case the old code got wrong: it skipped reaping for EVERY session with
  // spawnedByCeo, and one discovered from the registry would have stayed lit
  // forever after the process died.
  const world = worldWith(() => 'claude');
  apply(world, [live()]);
  const gone = apply(world, []).find((e) => e.t === 'session.remove');
  assert.ok(gone, 'the session should have closed');
});

test('the worker line stays in the registry, and survives a restart', (t) => {
  /*
   * What the worker says it did, and whether the request stood up.
   * Measured: two jobs out of two contradicted the CEO's numbers in the first
   * line of the answer, and that fact lived only in the CEO's memory -- that
   * is, in no place the user reads.
   */
  const dir = tmp();
  const store = createJobStore(dir);
  store.add(newJob());
  store.report('p1', 'categorised 72 commits by area, no branch to consolidate', false, ['docs/commits.md']);
  store.finish('p1', 'work', ended());
  assert.equal(store.get('p1')?.workFounded, false);
  assert.match(store.get('p1')?.workDid ?? '', /72 commit/);
  assert.deepEqual(store.get('p1')?.workWrote, ['docs/commits.md']);

  store.save();
  const reopened = createJobStore(dir);
  assert.equal(reopened.get('p1')?.workFounded, false, 'the contradicted premise was lost');
  // The documents too: the plan of a task is opened from Reports days later.
  assert.deepEqual(reopened.get('p1')?.workWrote, ['docs/commits.md']);
});

test('a ledger written before documents existed loads them as none, never as undefined', (t) => {
  const dir = tmp();
  const store = createJobStore(dir);
  store.add(newJob());
  store.report('p1', 'done', true);
  store.finish('p1', 'work', ended());
  store.save();
  // An old ledger has no `workWrote`: the field must come back as an empty
  // list, or the delta channel would carry a hole the client reads as a miss.
  const file = path.join(dir, 'ceo', 'jobs.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { jobs: Record<string, unknown>[] };
  for (const j of raw.jobs) delete j['workWrote'];
  fs.writeFileSync(file, JSON.stringify(raw));
  const reopened = createJobStore(dir);
  assert.deepEqual(reopened.get('p1')?.workWrote, []);
});

test('a job with no outcome block does not pretend to know: it stays null', (t) => {
  // `null` is "I don't know" and must not be confused with "it stood up": the
  // model may have forgotten the fence, and nothing is judged on that silence.
  const store = createJobStore(tmp());
  store.add(newJob());
  store.finish('p1', 'work', ended());
  assert.equal(store.get('p1')?.workFounded, null);
  assert.equal(store.get('p1')?.workDid, null);
});

/* ─────────── a finished turret closes by itself, after five minutes ─────── */

test('a finished turret stays on stage for five minutes, then closes', (t) => {
  // The minutes are there to notice it when you look back. The result does not
  // go away: closing means off the stage, INTO Reports.
  const store = createJobStore(tmp());
  store.add(newJob());
  store.finish('p1', 'work', ended());
  const job = store.get('p1')!;
  const ended_at = job.work.endedAt!;

  assert.equal(expiredOnStage(job, ended_at + KEEP_ON_STAGE_MS - 1), false, 'closed too early');
  assert.equal(expiredOnStage(job, ended_at + KEEP_ON_STAGE_MS), true);
});

test('a turret that is working does not close, however much time passes', (t) => {
  const store = createJobStore(tmp());
  store.add(newJob());
  assert.equal(expiredOnStage(store.get('p1')!, NOW + 10 * 60 * 60_000), false);
});

test('the five minutes start from the MOST RECENT end of the two parts', (t) => {
  /*
   * Counting from the end of the work alone, a slow review would make the
   * turret vanish the instant the verdict arrives -- which is the very thing
   * you were watching it for.
   */
  const store = createJobStore(tmp());
  store.add(newJob());
  store.openReview('p1', false);
  store.finish('p1', 'work', ended({ at: NOW + 1000 }));
  store.finish('p1', 'review', ended({ at: NOW + 400_000 }), true);

  const job = store.get('p1')!;
  assert.equal(
    expiredOnStage(job, NOW + 1000 + KEEP_ON_STAGE_MS), false,
    'it counted from the end of the work instead of the end of the review',
  );
  assert.equal(expiredOnStage(job, NOW + 400_000 + KEEP_ON_STAGE_MS), true);
});

test('a job closed by hand does not close again, and one with no known end does not close', (t) => {
  const store = createJobStore(tmp());
  store.add(newJob());
  store.finish('p1', 'work', ended());
  store.dismiss('p1');
  assert.equal(expiredOnStage(store.get('p1')!, NOW + 10 * 60_000), false);

  // Better one turret too many than one that vanishes over a missing field.
  const withoutEnd = { ...store.get('p1')!, dismissed: false, work: { ...store.get('p1')!.work, endedAt: null } };
  assert.equal(expiredOnStage(withoutEnd, NOW + 10 * 60_000), false);
});

test('the registry remembers whether the review comes from a fresh session', (t) => {
  /*
   * It is not a technical detail: the one resumed with a fork knows why the
   * work was done this way, the one opened just now has only checked the
   * premises. The two answers do not carry the same weight, and the panel must
   * be able to call them by different names -- so the distinction starts here.
   */
  const dir = tmp();
  const store = createJobStore(dir);
  store.add(newJob());
  store.finish('p1', 'work', ended());
  store.openReview('p1', true);
  assert.equal(store.get('p1')?.reviewFresh, true);

  store.save();
  assert.equal(createJobStore(dir).get('p1')?.reviewFresh, true, 'lost on restart');
});

test('a job with no review says neither fresh nor resumed', (t) => {
  // `null` is "there is no review", and must not be confused with "it was resumed".
  const store = createJobStore(tmp());
  store.add(newJob());
  assert.equal(store.get('p1')?.reviewFresh, null);
});

test('a worker carries the quota in its responses, and the fleet passes it on', async (t) => {
  // The status line draws only while someone types: a worker burning the 5h
  // window at night was invisible to the reserve until this reading.
  const h = harness(t);
  h.fleet.start(proposal());
  h.fake.stdout.write(`${JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed_warning', unifiedWindows: {
      five_hour: { utilization: 0.81, resetsAt: 1789816200 },
      seven_day: { utilization: 0.33, resetsAt: 1790182800 },
    } },
  })}\n`);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.quota, [{ provider: 'claude', used: [81, 33] }]);
});

test('a context reading that arrives before its session is kept for it', (t) => {
  // Measured on 2026-10-08: after a restart the status line reader read every
  // copy once, before the registry had shown a single session. The readings
  // were dropped, and a busy tower_defense at 33% showed no context at all
  // until it next redrew its status line.
  const world = worldWith(() => null);
  assert.deepEqual(world.applySessionPatch(SESSION, { contextPct: 33 }, NOW), [], 'nothing to send yet');
  apply(world, [live()]);
  const born = world.snapshot().sessions.find((s) => s.id === SESSION);
  assert.equal(born?.contextPct, 33);
  // Taken once: a session born again later starts from what it says.
  apply(world, []);
  apply(world, [live()]);
  assert.equal(world.snapshot().sessions.find((s) => s.id === SESSION)?.contextPct, null);
});
