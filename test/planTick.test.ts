import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createPlanDesk, GENERIC_QUESTION, median, STOPPED_PAUSED, STOPPED_RESERVE, STOPPED_WAITING, WAIT_GRACE_MS,
} from '../src/server/ceo/planDesk.ts';
import type { WorkOrder } from '../src/server/ceo/fleet.ts';
import { OUTCOME_FENCE } from '../src/server/ceo/outcome.ts';
import { shareByWindow } from '../src/server/ceo/quota.ts';
import type { ClosedSession } from '../src/server/state/history.ts';
import type { ProjectInfo, ProviderId, ProviderLimits, ServerFrame, Snapshot } from '../src/shared/protocol.ts';

/*
 * The beat: what a tick launches on its own, and what it learns about the
 * price of a task. The fleet is a fake that records orders; the quota is a
 * reading built by hand from measured shapes.
 */

const T0 = Date.parse('2026-09-18T09:00:00.000Z');

function project(id: string, name: string): ProjectInfo {
  return {
    id, name, realName: name, disabled: false, slot: 0, exists: true,
    firstSeenAt: T0, lastActiveAt: T0, size: 10, lastCommit: null, branch: 'main', commits: 3,
    providers: ['claude'],
  };
}

function limits(used5h: number, used7d: number): ProviderLimits {
  return {
    provider: 'claude', at: T0, plan: 'max 5x',
    windows: [
      { label: '5h', usedPercent: used5h, windowMinutes: 300, model: null, resetsAt: T0 + 3_600_000 },
      { label: '7d', usedPercent: used7d, windowMinutes: 10_080, model: null, resetsAt: T0 + 86_400_000 },
    ],
  };
}

function block(json: object): string {
  return `Prose.\n${OUTCOME_FENCE}\n${JSON.stringify(json)}\n\`\`\`\n`;
}

const PROPOSAL = block({
  ready: true, questions: [],
  projects: [
    { name: 'alpha', priority: 1, git: { tests: true, commit: false, push: false }, tasks: [
      { id: null, title: 'alpha 1', briefing: 'b', provider: 'claude', model: null, effort: null, size: 'medium' },
      { id: null, title: 'alpha 2', briefing: 'b', provider: 'claude', model: null, effort: null, size: 'medium' },
    ] },
    { name: 'beta', priority: 2, git: { tests: true, commit: false, push: false }, tasks: [
      { id: null, title: 'beta 1', briefing: 'b', provider: 'claude', model: null, effort: null, size: 'large' },
    ] },
    { name: 'gamma', priority: 3, git: { tests: true, commit: false, push: false }, tasks: [
      { id: null, title: 'gamma 1', briefing: 'b', provider: 'claude', model: null, effort: null, size: 'small' },
    ] },
  ],
});

interface Rig {
  desk: ReturnType<typeof createPlanDesk>;
  orders: WorkOrder[];
  stopped: { jobId: string; reason: string }[];
  snapshot: Snapshot;
  closed: ClosedSession[];
  burned: number;
  reply: (f: ServerFrame) => void;
}

function rig(metered: readonly ProviderId[] = []): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-tick-'));
  const orders: WorkOrder[] = [];
  const stopped: Rig['stopped'] = [];
  const r: Partial<Rig> = { orders, stopped, closed: [], burned: 0 };
  r.snapshot = {
    at: T0, limits: [limits(10, 10)],
    projects: [project('p1', 'alpha'), project('p2', 'beta'), project('p3', 'gamma')],
    sessions: [], agents: [], files: [], recent: [],
  };
  let clock = T0;
  const desk = createPlanDesk({
    stateDir: dir,
    providers: ['claude', 'codex'],
    model: 'sonnet',
    codexModel: null,
    snapshot: () => r.snapshot!,
    cwdOf: () => '/tmp/x',
    converse: async (_p, _prompt, o) => {
      if (o.session.fresh) o.onSession(o.session.fresh);
      o.onText(PROPOSAL);
      o.reply(PROPOSAL, true);
      return { text: PROPOSAL, failed: null };
    },
    launch: (order) => {
      const denied = desk.authorized(order);
      if (denied) return { ok: false, jobId: null, reason: denied };
      orders.push(order);
      return { ok: true, jobId: order.id, reason: '' };
    },
    stop: (jobId, reason) => { stopped.push({ jobId, reason }); return true; },
    stopChair: () => {},
    blockedReason: () => null,
    metered,
    askJob: () => {},
    weightedSince: () => r.burned!,
    closedSessions: () => r.closed!,
    broadcast: () => {},
    now: () => (clock += 1),
  });
  r.desk = desk;
  r.reply = () => {};
  return r as Rig;
}

const settled = (): Promise<void> => new Promise((res) => setTimeout(res, 10));

async function approved(r: Rig, parallel = 2): Promise<void> {
  r.desk.handle({ t: 'plan.say', text: 'go' }, r.reply);
  await settled();
  r.desk.handle({ t: 'plan.set', patch: { kind: 'parallel', parallel } }, r.reply);
  r.desk.handle({ t: 'plan.approve' }, r.reply);
}

function closedRow(weightedIn: number): ClosedSession {
  return {
    id: `s-${weightedIn}`, projectId: 'p1', provider: 'claude', startedAt: T0 - 3_600_000,
    confidence: 'reported', watched: true, costUsd: 1,
    tokens: { in: weightedIn, out: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    turns: 1, toolCalls: 1, apiMs: 0, toolMs: 0, wallMs: 0, linesAdded: 0, linesRemoved: 0,
  };
}

/** A known price: the plan can run more than one task per fleet at once. */
function priced(r: Rig): void {
  r.closed = [closedRow(100_000)];
  r.burned = 1_000_000;
}

test('approving launches on its own up to the parallelism, on different projects', async () => {
  const r = rig();
  priced(r);
  await approved(r, 2);
  assert.deepEqual(r.orders.map((o) => o.summary), ['alpha 1', 'beta 1']);
  assert.equal(r.desk.plan().projects[0]!.tasks[0]!.status, 'running');
  assert.equal(r.desk.plan().projects[1]!.tasks[0]!.status, 'running');
});

test('an attempt that ends frees the slot: the next one starts without waiting for the tick', async () => {
  const r = rig();
  priced(r);
  await approved(r, 2);
  const alpha1 = r.desk.plan().projects[0]!.tasks[0]!;
  r.desk.onJobEnd(alpha1.id, alpha1.jobId!, {
    ok: true, outcome: block({ status: 'done', did: 'ok', question: null }), costUsd: 0.1, reason: '', at: T0 + 9, weighted: 100_000,
  });
  assert.deepEqual(r.orders.map((o) => o.summary), ['alpha 1', 'beta 1', 'alpha 2']);
});

test('with an unknown cost only one task per fleet starts blind; the first to finish teaches the price', async () => {
  const r = rig();
  r.snapshot.limits = [limits(50, 30)];
  await approved(r, 3);
  // unknown price: one claude task in flight, the second waits for it
  assert.deepEqual(r.orders.map((o) => o.summary), ['alpha 1']);
  assert.equal(r.desk.expected('claude', 'medium'), null);
  const alpha1 = r.desk.plan().projects[0]!.tasks[0]!;
  r.burned = 1_000_000; // the 5h window at 50% was burned by a million weighted tokens
  r.desk.onJobEnd(alpha1.id, alpha1.jobId!, {
    ok: true, outcome: block({ status: 'done', did: 'ok', question: null }), costUsd: 0.1, reason: '', at: T0 + 9, weighted: 100_000,
  });
  // a medium task now costs 100k / 1M * 50% = 5 points of the 5h, a large one 10
  assert.deepEqual(r.desk.expected('claude', 'medium'), { '5h': 5, '7d': 3 });
  assert.deepEqual(r.desk.expected('claude', 'large'), { '5h': 10, '7d': 6 });
  // known now: the end of alpha 1 ticks, and three start in priority order,
  // up to the cap of 3 -- alpha again first, because alpha is priority 1.
  assert.deepEqual(r.orders.map((o) => o.summary), ['alpha 1', 'alpha 2', 'beta 1', 'gamma 1']);
});

test('with no attempts the price comes from the fleet closed sessions, and the reserve stops the launch', async () => {
  const r = rig();
  r.closed = [closedRow(200_000), closedRow(400_000), closedRow(3_000_000)];
  r.burned = 1_000_000;
  // 5h at 75%: a medium task (median 400k -> 30 points) would breach the 30% reserve
  r.snapshot.limits = [limits(75, 10)];
  await approved(r, 2);
  assert.deepEqual(r.desk.expected('claude', 'medium'), { '5h': 30, '7d': 4 });
  assert.equal(r.orders.length, 0, 'nothing starts above the reserve');
  const ev = r.desk.event();
  assert.ok(ev.t === 'plan' && /would breach the 30% reserve/.test(ev.next ?? ''), ev.t === 'plan' ? ev.next ?? '' : '');
  // the window resets: the same tick now launches
  r.snapshot.limits = [limits(5, 10)];
  r.desk.tick();
  assert.deepEqual(r.orders.map((o) => o.summary), ['alpha 1', 'beta 1']);
});

test('a tick on an unapproved plan does nothing', async () => {
  const r = rig();
  r.desk.handle({ t: 'plan.say', text: 'go' }, r.reply);
  await settled();
  r.desk.tick();
  assert.equal(r.orders.length, 0);
  r.desk.handle({ t: 'plan.approve' }, r.reply);
  r.desk.handle({ t: 'plan.pause' }, r.reply);
  const before = r.orders.length;
  r.desk.tick();
  assert.equal(r.orders.length, before, 'while paused the tick does not launch');
});

test('a worker stuck on a prompt for half a minute is stopped, and the task becomes a question', async () => {
  const r = rig();
  priced(r);
  await approved(r, 1);
  const t1 = r.desk.plan().projects[0]!.tasks[0]!;
  r.desk.onSession(t1.id, 'sess-w');
  const waiting = (since: number): Snapshot['sessions'][number] => ({
    id: 'sess-w', projectId: 'p1', pid: 1, label: 'w', title: null, status: 'waiting', waitingFor: 'input',
    kind: 'interactive', model: null, ccVersion: '', gitBranch: null, permissionMode: null, isCeo: false,
    spawnedByCeo: 'claude', provider: 'claude', statusConfidence: 'reported', startedAt: T0,
    lastActivityAt: since, statusSince: since, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    contextLeft: null, contextPct: null, turns: 0, toolCalls: 0, lastTurnMs: null, turnsMs: 0,
    reasoningMs: null, recap: null, recapAt: null, recapInherited: false, activityTool: null,
    activityTarget: null, agentsActive: 0, deskIndex: 0,
  });
  // waiting for a moment: left alone
  r.snapshot.sessions = [waiting(T0 + 1000)];
  r.desk.tick();
  assert.equal(r.stopped.length, 0);
  // waiting past the grace: stopped, with the reason the desk reads back
  r.snapshot.sessions = [waiting(T0 - WAIT_GRACE_MS - 5000)];
  r.desk.tick();
  assert.deepEqual(r.stopped, [{ jobId: t1.jobId!, reason: STOPPED_WAITING }]);
  r.desk.onJobEnd(t1.id, t1.jobId!, { ok: false, outcome: '', costUsd: 0, reason: STOPPED_WAITING, at: T0 + 60_000 });
  const after = r.desk.plan().projects[0]!.tasks[0]!;
  assert.equal(after.status, 'question');
  assert.equal(after.question, GENERIC_QUESTION);
  assert.equal(after.sessionId, 'sess-w', 'the answer resumes that session');
});

test('the median ignores zeros and is not decided by one huge session', () => {
  assert.equal(median([]), null);
  assert.equal(median([0, 0]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 100, 3]), 3);
  assert.equal(median([1, 2, 3, 1000]), 2.5);
});

test('shareByWindow gives one figure per window, and skips those without history', () => {
  const shares = shareByWindow(50_000, 'claude', [limits(40, 20)], (_p, since, now) => (now - since > 6 * 3_600_000 ? 2_000_000 : 500_000), T0);
  assert.deepEqual(shares, { '5h': 4, '7d': 0.5 });
  const fresh = shareByWindow(50_000, 'claude', [limits(1, 20)], () => 2_000_000, T0);
  assert.deepEqual(fresh, { '7d': 0.5 }, 'a nearly untouched window cannot bear a division');
  assert.equal(shareByWindow(50_000, 'codex', [limits(40, 20)], () => 2_000_000, T0), null);
});

test('pause stops the running workers too, and the task goes back in the queue with its session', async () => {
  // "I paused it but it didn't work": the pause stopped the launches
  // and left three workers emptying the 5h window.
  const r = rig();
  priced(r);
  await approved(r, 2);
  const [a1, b1] = [r.desk.plan().projects[0]!.tasks[0]!, r.desk.plan().projects[1]!.tasks[0]!];
  r.desk.onSession(a1.id, 'sess-a');
  r.desk.handle({ t: 'plan.pause' }, r.reply);
  assert.deepEqual(r.stopped, [
    { jobId: a1.jobId!, reason: STOPPED_PAUSED },
    { jobId: b1.jobId!, reason: STOPPED_PAUSED },
  ]);
  r.desk.onJobEnd(a1.id, a1.jobId!, { ok: false, outcome: '', costUsd: 1, reason: STOPPED_PAUSED, at: T0 + 60_000 });
  const back = r.desk.plan().projects[0]!.tasks[0]!;
  assert.equal(back.status, 'queued', 'stopped by us is not failed');
  assert.equal(back.reason, STOPPED_PAUSED);
  assert.equal(back.sessionId, 'sess-a');
  assert.equal(r.orders.length, 2, 'paused, it does not start again');
  // resume: the same session, picked up where it stopped
  r.desk.onJobEnd(b1.id, b1.jobId!, { ok: false, outcome: '', costUsd: 1, reason: STOPPED_PAUSED, at: T0 + 60_000 });
  r.desk.handle({ t: 'plan.resume' }, r.reply);
  const again = r.orders.find((o) => o.origin.taskId === a1.id && o.origin.attempt === 2);
  assert.ok(again, 'resume launches the stopped task again');
  assert.equal(again.resume, 'sess-a');
  assert.match(again.task, /stopped: the plan was paused/);
});

test('at the reserve the fleet is stopped and its tasks wait; when the window has room they start again on their own', async () => {
  // The plan used to be paused here, and it stayed paused after the window
  // had reset, until a click: a plan left to run does not run on like that
  // (the user's call, 2026-10-12).
  const r = rig();
  priced(r);
  await approved(r, 2);
  const [a1, b1] = [r.desk.plan().projects[0]!.tasks[0]!, r.desk.plan().projects[1]!.tasks[0]!];
  r.desk.onSession(a1.id, 'sess-a');
  // default reserve is 30% of the 5h: 69% is still below the line
  r.snapshot.limits = [limits(69, 10)];
  r.desk.guard();
  assert.equal(r.stopped.length, 0);
  // a worker's own reading says 70%: stopped at once, and nothing is paused
  r.snapshot.limits = [limits(70, 10)];
  r.desk.guard();
  assert.deepEqual(r.stopped.map((x) => x.jobId), [a1.jobId, b1.jobId]);
  assert.ok(r.stopped.every((x) => x.reason.startsWith(STOPPED_RESERVE) && /5h at 70% reached the 30% reserve/.test(x.reason)));
  assert.equal(r.desk.plan().status, 'approved');
  // the next tick finds them still dying: not stopped again, noted once
  r.desk.tick();
  assert.equal(r.stopped.length, 2);
  assert.equal(r.desk.plan().minutes.filter((m) => /the reserve stopped the claude tasks: 5h at 70%/.test(m.text)).length, 1);
  // their ends put them back in the queue, and the window still holds them
  const reason = r.stopped[0]!.reason;
  r.desk.onJobEnd(a1.id, a1.jobId!, { ok: false, outcome: '', costUsd: 1, reason, at: T0 + 60_000, weighted: 100_000 });
  r.desk.onJobEnd(b1.id, b1.jobId!, { ok: false, outcome: '', costUsd: 1, reason, at: T0 + 60_000, weighted: 100_000 });
  assert.equal(r.desk.plan().projects[0]!.tasks[0]!.status, 'queued');
  assert.equal(r.orders.length, 2, 'over the line nothing starts');
  const ev = r.desk.event();
  assert.ok(ev.t === 'plan' && /would breach the 30% reserve/.test(ev.next ?? ''), ev.t === 'plan' ? ev.next ?? '' : '');
  // the window resets: the next tick launches them again, each in its session
  r.snapshot.limits = [limits(0, 10)];
  r.desk.tick();
  const again = r.orders.find((o) => o.origin.taskId === a1.id && o.origin.attempt === 2);
  assert.ok(again, 'the stopped task starts again with no click');
  assert.equal(again.resume, 'sess-a');
  assert.match(again.task, /stopped at the reserve/);
  assert.ok(r.orders.some((o) => o.origin.taskId === b1.id && o.origin.attempt === 2));
});

test('a task the reserve stops twice in a row stops restarting and waits for you, while the next project runs', async () => {
  // What a reset must not bring back forever: the translation that emptied
  // the 5h made 1939 tool calls through fifteen subagents, and restarted at
  // every window it would burn up to the line each time with nobody looking.
  const r = rig();
  priced(r);
  await approved(r, 1);
  const a1 = r.desk.plan().projects[0]!.tasks[0]!;
  const stopAtReserve = (attempt: number): void => {
    r.snapshot.limits = [limits(70, 10)];
    r.desk.guard();
    const s = r.stopped.at(-1)!;
    assert.equal(s.jobId, `${a1.id}:${attempt}`);
    r.desk.onJobEnd(a1.id, s.jobId, { ok: false, outcome: '', costUsd: 1, reason: s.reason, at: T0 + 60_000, weighted: 100_000 });
  };

  stopAtReserve(1);
  assert.equal(r.desk.plan().projects[0]!.tasks[0]!.status, 'queued');
  r.snapshot.limits = [limits(0, 10)];
  r.desk.tick();
  assert.equal(r.orders.at(-1)!.origin.attempt, 2, 'once, it starts again on its own');

  stopAtReserve(2);
  const held = r.desk.plan().projects[0]!.tasks[0]!;
  assert.equal(held.status, 'failed');
  assert.match(held.reason ?? '', /5h at 70% reached the 30% reserve\), 2 times in a row: retry resumes it/);
  assert.ok(r.desk.plan().minutes.some((m) => /"alpha 1" was stopped at the reserve 2 times in a row/.test(m.text)));
  const ev = r.desk.event();
  assert.ok(ev.t === 'plan' && ev.stall?.needsYou === true && /alpha: a task failed, retry or skip it/.test(ev.stall.text));

  // The window resets again: alpha stays where it is, and the plan goes on.
  r.snapshot.limits = [limits(0, 10)];
  r.desk.tick();
  assert.ok(!r.orders.some((o) => o.origin.taskId === a1.id && o.origin.attempt === 3));
  assert.equal(r.orders.at(-1)!.summary, 'beta 1');

  // Your retry resumes the same task, and it gets its two tries again.
  r.desk.handle({ t: 'plan.retry', taskId: a1.id }, r.reply);
  assert.equal(r.desk.plan().projects[0]!.tasks[0]!.status, 'queued');
});

test('a fleet on an API key is not held by the reserve of a plan, at launch or while it works', async () => {
  // The windows are a plan's, burned by your own terminals. For a fleet on
  // that plan 75% of the 5h holds a 30-point task (the test above) and 99%
  // stops it mid-flight. Billed by the token, its work spends none of it:
  // your own afternoon at the terminal used to be able to pause the plan.
  const r = rig(['claude']);
  r.closed = [closedRow(200_000), closedRow(400_000), closedRow(3_000_000)];
  r.burned = 1_000_000;
  r.snapshot.limits = [limits(75, 10)];
  await approved(r, 2);
  assert.equal(r.desk.expected('claude', 'medium'), null, 'no window of its own, so no price in points');
  // No price in points is an unknown cost: one task of the fleet at a time.
  assert.deepEqual(r.orders.map((o) => o.summary), ['alpha 1']);

  r.snapshot.limits = [limits(99, 99)];
  r.desk.guard();
  assert.equal(r.stopped.length, 0);
  assert.equal(r.desk.plan().status, 'approved');
  assert.equal(r.desk.breach('claude', T0), null, 'the fleet outside the plan reads the same answer');
});

test('a plan with no worker running does not stop itself, whatever the quota says', async () => {
  const r = rig();
  r.desk.handle({ t: 'plan.say', text: 'go' }, r.reply);
  await settled();
  r.snapshot.limits = [limits(99, 99)];
  r.desk.guard();
  assert.equal(r.desk.plan().status, 'proposed');
  assert.equal(r.stopped.length, 0);
});
