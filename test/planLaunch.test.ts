import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPlanDesk, PAUSED_BY_YOU, stallKey, stallOf } from '../src/server/ceo/planDesk.ts';
import type { Plan } from '../src/server/ceo/plan.ts';
import type { WorkOrder } from '../src/server/ceo/fleet.ts';
import { OUTCOME_FENCE } from '../src/server/ceo/outcome.ts';
import { assertSafe } from '../src/server/parse/redact.ts';
import type { DeltaEvent, ProjectInfo, ServerFrame, Snapshot } from '../src/shared/protocol.ts';

/*
 * From an approved plan to a running worker and back: the desk asks the
 * scheduler, hands the fleet an order, and reads what the attempt says.
 * The fleet is a fake that records orders; nothing here starts a process.
 */

const T0 = Date.parse('2026-09-18T09:00:00.000Z');

function project(id: string, name: string): ProjectInfo {
  return {
    id, name, realName: name, disabled: false, slot: 0, exists: true,
    firstSeenAt: T0, lastActiveAt: T0, size: 10, lastCommit: null, branch: 'main', commits: 3,
    providers: ['claude'],
  };
}

const SNAPSHOT: Snapshot = {
  at: T0, limits: [], projects: [project('p1', 'alpha'), project('p2', 'beta')],
  sessions: [], agents: [], files: [], recent: [],
};

function block(json: object): string {
  return `Prose.\n${OUTCOME_FENCE}\n${JSON.stringify(json)}\n\`\`\`\n`;
}

const PROPOSAL = block({
  ready: true, questions: [],
  projects: [{ name: 'alpha', priority: 1, git: { tests: true, commit: true, push: false }, tasks: [
    { id: null, title: 'Ship the export', briefing: 'CSV, in reports.ts, with a test.', provider: 'claude', model: 'sonnet', effort: null, size: 'small' },
    { id: null, title: 'Fix the badge', briefing: 'The badge pulses twice.', provider: 'claude', model: null, effort: null, size: 'medium' },
  ] }],
});

interface Rig {
  desk: ReturnType<typeof createPlanDesk>;
  orders: WorkOrder[];
  asked: string[];
  events: DeltaEvent[];
  replies: ServerFrame[];
  reply: (f: ServerFrame) => void;
  refuse: string | null;
  /** Desktop notices, as title and text. */
  notices: string[];
}

function rig(): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-launch-'));
  const orders: WorkOrder[] = [];
  const asked: string[] = [];
  const events: DeltaEvent[] = [];
  const replies: ServerFrame[] = [];
  let clock = T0;
  const notices: string[] = [];
  const r: Partial<Rig> = { orders, asked, events, replies, refuse: null, notices };
  const desk = createPlanDesk({
    stateDir: dir,
    providers: ['claude', 'codex'],
    model: 'sonnet',
    codexModel: null,
    snapshot: () => SNAPSHOT,
    cwdOf: (id) => (id === 'p1' ? '/tmp/alpha' : '/tmp/beta'),
    converse: async (_p, _prompt, o) => {
      if (o.session.fresh) o.onSession(o.session.fresh);
      o.onText(PROPOSAL);
      o.reply(PROPOSAL, true);
      return { text: PROPOSAL, failed: null };
    },
    launch: (order) => {
      if (r.refuse) return { ok: false, jobId: null, reason: r.refuse };
      // The fleet asks the second guardian; so does the fake.
      const denied = desk.authorized(order);
      if (denied) return { ok: false, jobId: null, reason: denied };
      orders.push(order);
      return { ok: true, jobId: order.id, reason: '' };
    },
    stop: () => false,
    stopChair: () => {},
    blockedReason: () => null,
    askJob: (id) => asked.push(id),
    weightedSince: () => 0,
    closedSessions: () => [],
    broadcast: (evs) => { for (const e of evs) { assertSafe(e); events.push(e); } },
    notify: (title, text) => notices.push(`${title} | ${text}`),
    now: () => (clock += 1),
  });
  r.desk = desk;
  r.reply = (f) => replies.push(f);
  return r as Rig;
}

const settled = (): Promise<void> => new Promise((res) => setTimeout(res, 10));

/** A meeting held and approved: two tasks queued on alpha. */
async function approved(r: Rig): Promise<void> {
  r.desk.handle({ t: 'plan.say', text: 'alpha: export and badge' }, r.reply);
  await settled();
  r.desk.handle({ t: 'plan.approve' }, r.reply);
  assert.equal(r.desk.plan().status, 'approved');
}

test('approving launches the first queued task, with the briefing in the prompt and job t:1', async () => {
  const r = rig();
  await approved(r);
  assert.equal(r.orders.length, 1, 'the yes is the launch: no second button');
  assert.equal(r.desk.launchNext(), 'nothing queued', 'alpha is busy, beta has no tasks');
  const o = r.orders[0]!;
  const t1 = r.desk.plan().projects[0]!.tasks[0]!;
  assert.equal(o.id, `${t1.id}:1`);
  assert.equal(o.projectId, 'p1');
  assert.equal(o.model, 'sonnet');
  // The chair proposed no push; "push to main" is ticked by default all the same.
  assert.deepEqual(o.allowed, { commit: true, push: true });
  assert.deepEqual(o.commands, [], 'no command read or allowed yet: the common runners only');
  assert.match(o.task, /Run the project's tests and checks before you finish/);
  assert.match(o.task, /Push to `main` when the tests pass/);
  assert.ok(o.task.includes('CSV, in reports.ts, with a test.'));
  assert.equal(o.resume, null);
  assert.equal(o.ceilingMs, 15 * 60_000, 'small: a quarter of an hour');
  assert.equal(t1.status, 'running');
  assert.equal(t1.attempts, 1);
  assert.equal(t1.jobId, o.id);
});

test('before approval nothing starts, and the reason goes back to whoever pressed', async () => {
  const r = rig();
  r.desk.handle({ t: 'plan.say', text: 'alpha: export' }, r.reply);
  await settled();
  r.desk.handle({ t: 'plan.launch' }, r.reply);
  const last = r.replies.filter((f) => f.t === 'plan.doc').at(-1);
  assert.ok(last && last.t === 'plan.doc');
  assert.match(last.refused ?? '', /plan is proposed/);
  assert.equal(r.orders.length, 0);
});

test('one session per project: with the first running, the second alpha task waits, and says so', async () => {
  const r = rig();
  await approved(r);
  const why = r.desk.launchNext();
  assert.equal(why, 'nothing queued', 'beta has no tasks: alpha is busy and does not show up as a reason');
  const ev = r.events.filter((e) => e.t === 'plan').at(-1);
  assert.ok(ev && ev.t === 'plan' && ev.counts.running === 1);
});

test('the second guardian refuses an order that is stale, from another plan, unapproved or not queued', async () => {
  const r = rig();
  await approved(r);
  const plan = r.desk.plan();
  const [t1, t2] = plan.projects[0]!.tasks;
  const good: WorkOrder = {
    id: `${t2!.id}:1`, provider: 'claude', projectId: 'p1', projectName: 'alpha', kind: 'plan',
    summary: t2!.title, task: 'x', model: null, effort: null, allowed: plan.projects[0]!.git,
    resume: null, ceilingMs: null, origin: { planId: plan.id, taskId: t2!.id, attempt: 1 },
  };
  assert.equal(r.desk.authorized(good), null);
  assert.match(r.desk.authorized({ ...good, origin: { ...good.origin, attempt: 2 } }) ?? '', /stale/);
  assert.match(r.desk.authorized({ ...good, origin: { ...good.origin, planId: 'other' } }) ?? '', /another plan/);
  assert.match(r.desk.authorized({ ...good, origin: { ...good.origin, taskId: t1!.id } }) ?? '', /task is running/);
  r.desk.handle({ t: 'plan.pause' }, r.reply);
  assert.match(r.desk.authorized(good) ?? '', /plan is paused/);
  r.desk.handle({ t: 'plan.resume' }, r.reply);
  assert.equal(r.desk.authorized(good), null);
});

test('a job ended with a done block closes the task with its line and the learned cost', async () => {
  const r = rig();
  await approved(r);
  const t1 = r.desk.plan().projects[0]!.tasks[0]!;
  r.desk.onSession(t1.id, 'sess-1');
  r.desk.onJobEnd(t1.id, t1.jobId!, {
    ok: true, outcome: block({ status: 'done', did: 'Added the CSV export', question: null }),
    costUsd: 0.3, reason: '', at: T0 + 100, weighted: 42_000,
  });
  const after = r.desk.plan().projects[0]!.tasks[0]!;
  assert.equal(after.status, 'done');
  assert.equal(after.did, 'Added the CSV export');
  assert.equal(after.learned, 42_000);
  assert.equal(after.sessionId, 'sess-1');
  // and the next one went on its own, the moment the slot freed
  assert.equal(r.orders.length, 2);
  assert.equal(r.orders[1]!.summary, 'Fix the badge');
  assert.equal(r.desk.launchNext(), 'nothing queued');
});

test('an outcome without a block counts as done: the outcome is in Reports anyway', async () => {
  const r = rig();
  await approved(r);
  const t1 = r.desk.plan().projects[0]!.tasks[0]!;
  r.desk.onJobEnd(t1.id, t1.jobId!, { ok: true, outcome: 'I did it, no block.', costUsd: 0.1, reason: '', at: T0 + 5 });
  assert.equal(r.desk.plan().projects[0]!.tasks[0]!.status, 'done');
});

test('a dead process is a failed task with the fleet reason, and the project stops', async () => {
  const r = rig();
  await approved(r);
  const t1 = r.desk.plan().projects[0]!.tasks[0]!;
  r.desk.onJobEnd(t1.id, t1.jobId!, { ok: false, outcome: '', costUsd: 0, reason: 'went quiet for 5 min', at: T0 + 5 });
  assert.equal(r.desk.plan().projects[0]!.tasks[0]!.status, 'failed');
  assert.equal(r.desk.plan().projects[0]!.tasks[0]!.reason, 'went quiet for 5 min');
  assert.match(r.desk.launchNext() ?? '', /alpha: a task failed/);
});

test('a question stops the task, flags the job, and the answer resumes the same session', async () => {
  const r = rig();
  await approved(r);
  const t1 = r.desk.plan().projects[0]!.tasks[0]!;
  r.desk.onSession(t1.id, 'sess-1');
  r.desk.onJobEnd(t1.id, t1.jobId!, {
    ok: true, outcome: block({ status: 'question', did: null, question: 'CSV or JSON? I suggest CSV.' }),
    costUsd: 0.2, reason: '', at: T0 + 5,
  });
  let task = r.desk.plan().projects[0]!.tasks[0]!;
  assert.equal(task.status, 'question');
  assert.equal(task.question, 'CSV or JSON? I suggest CSV.');
  assert.deepEqual(r.asked, [t1.jobId]);
  assert.match(r.desk.launchNext() ?? '', /alpha: waiting for your answer/);
  const ev = r.events.filter((e) => e.t === 'plan').at(-1);
  assert.ok(ev && ev.t === 'plan' && ev.asks === 1);

  // the answer itself ticks: the same session resumes at once
  r.desk.handle({ t: 'plan.answer', taskId: t1.id, text: 'CSV' }, r.reply);
  assert.equal(r.orders.length, 2);
  const o = r.orders[1]!;
  assert.equal(o.id, `${t1.id}:2`);
  assert.equal(o.resume, 'sess-1');
  assert.match(o.task, /^You stopped with a question: CSV or JSON\? I suggest CSV\.\n+The user's answer: CSV/);
  task = r.desk.plan().projects[0]!.tasks[0]!;
  assert.equal(task.attempts, 2);
});

test('a retry without a session starts over with the briefing and the earlier question', async () => {
  const r = rig();
  await approved(r);
  const t1 = r.desk.plan().projects[0]!.tasks[0]!;
  r.desk.onJobEnd(t1.id, t1.jobId!, { ok: false, outcome: '', costUsd: 0, reason: 'exited with code 1', at: T0 + 5 });
  r.desk.handle({ t: 'plan.retry', taskId: t1.id }, r.reply);
  assert.equal(r.orders.length, 2, 'the retry itself relaunches');
  const o = r.orders[1]!;
  assert.equal(o.resume, null, 'no known session: it starts over');
  assert.ok(o.task.includes('CSV, in reports.ts, with a test.'));
});

test('a fleet refusal leaves the task queued and the reason on the delta', async () => {
  const r = rig();
  r.refuse = '5h quota at 90%, over the 85% cap';
  await approved(r);
  assert.equal(r.orders.length, 0);
  assert.equal(r.desk.plan().projects[0]!.tasks[0]!.status, 'queued');
  const ev = r.events.filter((e) => e.t === 'plan').at(-1);
  assert.ok(ev && ev.t === 'plan' && /quota at 90%/.test(ev.next ?? ''));
  assert.match(r.desk.launchNext() ?? '', /quota at 90%/);
});

/* ───────────── commands a worker needs, and the warning of a stalled plan ───────────── */

test('a worker refused its test commands asks for them, and "allow" resumes it with them granted', async () => {
  // decsim2, 2026-09-19: three attempts refused `php tests/*`, and the
  // answer "option A" could not grant it. Now the button does.
  const r = rig();
  await approved(r);
  const t1 = r.desk.plan().projects[0]!.tasks[0]!;
  r.desk.onSession(t1.id, 'sess-1');
  r.desk.onJobEnd(t1.id, t1.jobId!, {
    ok: true, outcome: block({ status: 'done', did: 'Committed; tests not run', question: null, needs: ['php tests/*', 'bash tests/api_smoke.sh'] }),
    costUsd: 0.2, reason: '', at: T0 + 5,
  });
  const asking = r.desk.plan().projects[0]!.tasks[0]!;
  assert.equal(asking.status, 'question', 'not done: its tests did not run');
  assert.deepEqual(asking.needs, ['php tests/*', 'bash tests/api_smoke.sh']);
  const ev = r.desk.event();
  assert.ok(ev.t === 'plan');
  assert.deepEqual(ev.stall, { needsYou: true, text: 'alpha: commands to allow' });

  r.desk.handle({ t: 'plan.allow', taskId: t1.id }, r.reply);
  assert.equal(r.orders.length, 2, 'the allow itself resumes it');
  const o = r.orders[1]!;
  assert.equal(o.resume, 'sess-1', 'the same session, which read the code already');
  assert.deepEqual(o.commands, ['php tests/*', 'bash tests/api_smoke.sh']);
  assert.match(o.task, /The user's answer: I allowed these commands in this project/);
  assert.deepEqual(r.desk.plan().commands, { p1: ['php tests/*', 'bash tests/api_smoke.sh'] });
  // The next task of the project starts with them from its first attempt.
  const next = r.desk.plan().projects[0]!.tasks[1]!;
  assert.equal(next.status, 'queued');
});

test('a stall needing you is said on the desktop at once, and once', async () => {
  const r = rig();
  await approved(r);
  const t1 = r.desk.plan().projects[0]!.tasks[0]!;
  r.desk.onJobEnd(t1.id, t1.jobId!, { ok: false, outcome: '', costUsd: 0, reason: 'exited with code 1', at: T0 + 5 });
  assert.deepEqual(r.notices, ['Plan blocked: it needs you | alpha: a task failed, retry or skip it']);
  r.desk.tick();
  r.desk.tick();
  assert.equal(r.notices.length, 1, 'the same stall is not said again at every tick');
});

test('the pause you pressed shows in the warning but is never a desktop notice', async () => {
  const r = rig();
  await approved(r);
  r.desk.handle({ t: 'plan.pause' }, r.reply);
  r.desk.tick();
  const ev = r.desk.event();
  assert.ok(ev.t === 'plan');
  assert.deepEqual(ev.stall, { needsYou: true, text: PAUSED_BY_YOU });
  assert.deepEqual(r.notices, []);
});

function planOf(status: Plan['status'], tasks: { status: Plan['projects'][number]['tasks'][number]['status']; needs?: string[] }[], name = 'alpha'): Pick<Plan, 'status' | 'projects'> {
  return {
    status,
    projects: [{
      projectId: 'p1', name, priority: 1, git: { commit: true, push: true },
      tasks: tasks.map((t, i) => ({
        id: `t${i}`, title: 'x', briefing: '', provider: 'claude', model: null, effort: null, size: 'medium',
        pinned: false, status: t.status, question: null, answer: null, needs: t.needs ?? [], attempts: 0,
        jobId: null, sessionId: null, did: null, learned: null, reason: null,
      })),
    }],
  };
}

test('a wait is a stall only when nothing runs; what needs you is one even beside a running task', () => {
  const reserve = 'alpha: 5h at 78% + ~9% would breach the 20% reserve';
  assert.deepEqual(stallOf(planOf('approved', [{ status: 'queued' }]), reserve), { needsYou: false, text: `waiting: ${reserve}` });
  assert.equal(stallOf(planOf('approved', [{ status: 'running' }, { status: 'queued' }]), reserve), null, 'behind a running task a wait is a queue');
  assert.equal(stallOf(planOf('approved', [{ status: 'queued' }]), null), null, 'no reason yet: the tick has not run');
  assert.equal(stallOf(planOf('proposed', [{ status: 'question' }]), null), null, 'nothing is approved: nothing can stall');
  assert.equal(stallOf(planOf('done', [{ status: 'done' }]), null), null);
  assert.deepEqual(stallOf(planOf('approved', [{ status: 'running' }, { status: 'question' }]), null), { needsYou: true, text: 'alpha: a worker asks you' });
  assert.deepEqual(stallOf(planOf('paused', [{ status: 'queued' }]), 'paused by you: resume to go on'), { needsYou: true, text: 'paused by you: resume to go on' });
  const long = stallOf(planOf('approved', [{ status: 'queued' }]), 'x'.repeat(400));
  assert.ok(long && long.text.length <= 128, 'it travels on the delta channel');
});

test('a stall is one kind whatever its numbers: a point more of quota is not a new notice', () => {
  const a = stallOf(planOf('approved', [{ status: 'queued' }]), 'alpha: 5h at 78% + ~9% would breach the 20% reserve')!;
  const b = stallOf(planOf('approved', [{ status: 'queued' }]), 'alpha: 5h at 79% + ~9% would breach the 20% reserve')!;
  const c = stallOf(planOf('approved', [{ status: 'queued' }]), 'alpha: you have a session open there')!;
  assert.equal(stallKey(a), stallKey(b));
  assert.notEqual(stallKey(a), stallKey(c));
});
