import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  headroomReason, HUMAN_GRACE_MS, humanActive, humanSessions, nextLaunch, reserveBreach,
  UNKNOWN_EXPECTED_PERCENT,
} from '../src/server/ceo/scheduler.ts';
import type { LiveSessionRef, SchedulerInput } from '../src/server/ceo/scheduler.ts';
import { emptyPlan } from '../src/server/ceo/plan.ts';
import type { Plan } from '../src/server/ceo/plan.ts';
import type { PlanProject, PlanTask, ProviderId, ProviderLimits, TaskStatus } from '../src/shared/protocol.ts';

const NOW = Date.parse('2026-09-18T09:00:00.000Z');

let seq = 0;
function task(over: Partial<PlanTask> = {}): PlanTask {
  seq += 1;
  return {
    id: `t${seq}`, title: `task ${seq}`, briefing: 'do it', provider: 'claude', model: null,
    effort: null, size: 'medium', pinned: false, status: 'queued', question: null, answer: null,
    attempts: 0, jobId: null, sessionId: null, did: null, learned: null, reason: null, ...over,
  };
}

function project(name: string, priority: number, tasks: PlanTask[]): PlanProject {
  return { projectId: `p-${name}`, name, priority, git: { tests: true, commit: true, push: false }, tasks };
}

function plan(projects: PlanProject[], over: Partial<Plan> = {}): Plan {
  return { ...emptyPlan(NOW, 'claude'), status: 'approved', projects, ...over };
}

function limits(provider: ProviderId, used5h: number, used7d: number): ProviderLimits {
  return {
    provider, at: NOW, plan: null,
    windows: [
      { label: '5h', usedPercent: used5h, windowMinutes: 300, model: null, resetsAt: NOW + 3_600_000 },
      { label: '7d', usedPercent: used7d, windowMinutes: 10_080, model: null, resetsAt: NOW + 86_400_000 },
    ],
  };
}

function input(over: Partial<SchedulerInput> = {}): SchedulerInput {
  return {
    plan: plan([project('alpha', 1, [task()])]),
    now: NOW,
    limits: [limits('claude', 10, 10), limits('codex', 10, 10)],
    live: [],
    blockedReason: () => null,
    expected: () => ({ '5h': 5, '7d': 2 }),
    ...over,
  };
}

function launched(next: ReturnType<typeof nextLaunch>): string {
  assert.ok('launch' in next, `expected a launch, got ${JSON.stringify(next)}`);
  return next.launch.title;
}

function waited(next: ReturnType<typeof nextLaunch>): string {
  assert.ok('wait' in next, `expected a wait, got ${JSON.stringify(next)}`);
  return next.wait;
}

test('only an approved plan launches', () => {
  for (const status of ['drafting', 'proposed', 'paused', 'done'] as const) {
    assert.match(waited(nextLaunch(input({ plan: plan([project('alpha', 1, [task()])], { status }) }))), new RegExp(`plan is ${status}`));
  }
  assert.ok(launched(nextLaunch(input())));
});

test('the parallelism cap counts the running tasks across the whole plan', () => {
  const p = plan([
    project('alpha', 1, [task({ status: 'running' })]),
    project('beta', 2, [task({ status: 'running' })]),
    project('gamma', 3, [task()]),
  ], { parallel: 2 });
  assert.match(waited(nextLaunch(input({ plan: p }))), /parallel cap \(2\)/);
  assert.equal(launched(nextLaunch(input({ plan: { ...p, parallel: 3 } }))), p.projects[2]!.tasks[0]!.title);
});

test('one session per project: a project with a running task is skipped, and the next one is taken', () => {
  const p = plan([
    project('alpha', 1, [task({ status: 'running' }), task()]),
    project('beta', 2, [task()]),
  ], { parallel: 3 });
  assert.equal(launched(nextLaunch(input({ plan: p }))), p.projects[1]!.tasks[0]!.title);
});

test('a question or a failure stops its own project, with the reason, not the others', () => {
  const asking = plan([project('alpha', 1, [task({ status: 'question' }), task()])]);
  assert.match(waited(nextLaunch(input({ plan: asking }))), /alpha: waiting for your answer/);
  const failed = plan([project('alpha', 1, [task({ status: 'failed' }), task()]), project('beta', 2, [task()])]);
  const next = nextLaunch(input({ plan: failed }));
  assert.equal(launched(next), failed.projects[1]!.tasks[0]!.title);
});

test('the grace window is five minutes, and the count follows the same rule', () => {
  // By decision of the user: thirty minutes held a project half an hour after
  // a session had gone quiet.
  assert.equal(HUMAN_GRACE_MS, 5 * 60_000);
  const live = (over: Partial<LiveSessionRef>): LiveSessionRef => ({
    projectId: 'p-alpha', provider: 'claude', spawnedByCeo: null, status: 'idle', lastActivityAt: NOW, ...over,
  });
  const sessions = [
    live({ lastActivityAt: NOW - 4 * 60_000 }),
    live({ lastActivityAt: NOW - 6 * 60_000 }),
    live({ status: 'busy', lastActivityAt: NOW - 60 * 60_000 }),
    live({ spawnedByCeo: 'claude' }),
  ];
  assert.equal(humanSessions(sessions, 'p-alpha', NOW), 2, 'quiet for 4 minutes and working count; quiet for 6 and the CEO one do not');
  assert.equal(humanActive(sessions.slice(1, 2), 'p-alpha', NOW), false);
});

test('an active session of yours blocks the project; one idle since yesterday does not; one opened by a CEO does not', () => {
  const live = (over: Partial<LiveSessionRef>): LiveSessionRef => ({
    projectId: 'p-alpha', provider: 'claude', spawnedByCeo: null, status: 'busy', lastActivityAt: NOW, ...over,
  });
  assert.equal(humanActive([live({})], 'p-alpha', NOW), true);
  assert.equal(humanActive([live({ status: 'idle', lastActivityAt: NOW - HUMAN_GRACE_MS - 1 })], 'p-alpha', NOW), false);
  assert.equal(humanActive([live({ status: 'idle', lastActivityAt: NOW - 60_000 })], 'p-alpha', NOW), true, 'idle for a minute is still yours');
  assert.equal(humanActive([live({ spawnedByCeo: 'claude' })], 'p-alpha', NOW), false);
  assert.match(waited(nextLaunch(input({ live: [live({})] }))), /alpha: you have a session open there/);
});

test('the quota gate on one fleet moves on to a lower-priority project on the other', () => {
  const p = plan([
    project('alpha', 1, [task({ provider: 'claude' })]),
    project('beta', 2, [task({ provider: 'codex' })]),
  ]);
  const next = nextLaunch(input({
    plan: p,
    blockedReason: (provider) => (provider === 'claude' ? '5h quota at 90%, over the 85% cap' : null),
  }));
  assert.equal(launched(next), p.projects[1]!.tasks[0]!.title);
  const both = nextLaunch(input({ plan: p, blockedReason: () => 'quota over the cap' }));
  assert.equal(waited(both), 'alpha, beta: quota over the cap', 'one line for the projects held by the same gate');
});

test('every held project says why, not only the first: the reason that holds the most goes first', () => {
  // 2026-09-19: the panel said "my_dashboard: you have a session open there"
  // and nothing else, while the dollar cap held decsim2 and visibilitycheck
  // all day. The session was yours and visible; the cap was not.
  const p = plan([
    project('my_dashboard', 1, [task({ provider: 'claude' })]),
    project('decsim2', 2, [task({ provider: 'claude' })]),
    project('visibilitycheck', 3, [task({ provider: 'claude' })]),
  ]);
  const why = waited(nextLaunch(input({
    plan: p,
    live: [{ projectId: 'p-my_dashboard', provider: 'claude', spawnedByCeo: null, status: 'busy', lastActivityAt: NOW }],
    blockedReason: () => 'spent 108.98 USD in the last 24h, cap 10.00',
  })));
  assert.equal(why, 'decsim2, visibilitycheck: spent 108.98 USD in the last 24h, cap 10.00; '
    + 'my_dashboard: you have a session open there');
  assert.ok(why.length <= 128);
});

test('the headroom: used + expected must leave the reserve free, on every window', () => {
  const p = plan([project('alpha', 1, [task()])], { reserve: { claude: { '5h': 30, '7d': 20 }, codex: { '5h': 30, '7d': 20 } } });
  // 60 + 10 = 70 <= 70: passes
  assert.equal(headroomReason(p, 'claude', [limits('claude', 60, 10)], { '5h': 10, '7d': 1 }, NOW), null);
  // 61 + 10 = 71 > 70: waits, and says so
  assert.match(headroomReason(p, 'claude', [limits('claude', 61, 10)], { '5h': 10, '7d': 1 }, NOW) ?? '', /5h at 61% \+ ~10% would breach the 30% reserve/);
  // the 7d can block while the 5h passes
  assert.match(headroomReason(p, 'claude', [limits('claude', 10, 79)], { '5h': 1, '7d': 2 }, NOW) ?? '', /7d at 79%/);
  // no reading at all: nothing to say here
  assert.equal(headroomReason(p, 'codex', [limits('claude', 99, 99)], { '5h': 1, '7d': 1 }, NOW), null);
});

test('a window that has already reset does not block: it is read as of now', () => {
  const p = plan([project('alpha', 1, [task()])]);
  const stale: ProviderLimits = {
    ...limits('claude', 95, 10),
    windows: [{ label: '5h', usedPercent: 95, windowMinutes: 300, model: null, resetsAt: NOW - 1 }],
  };
  assert.equal(headroomReason(p, 'claude', [stale], { '5h': 10 }, NOW), null);
});

test('an unknown cost counts as ten points, and runs alone per fleet', () => {
  const p = plan([
    project('alpha', 1, [task({ status: 'running', provider: 'claude' })]),
    project('beta', 2, [task({ provider: 'claude' })]),
    project('gamma', 3, [task({ provider: 'codex' })]),
  ], { parallel: 3 });
  const next = nextLaunch(input({ plan: p, expected: () => null }));
  assert.equal(launched(next), p.projects[2]!.tasks[0]!.title, 'codex has nothing in flight');
  assert.ok('launch' in next && next.expectedKnown === false);
  const claudeOnly = plan([
    project('alpha', 1, [task({ status: 'running', provider: 'claude' })]),
    project('beta', 2, [task({ provider: 'claude' })]),
  ], { parallel: 3 });
  assert.match(waited(nextLaunch(input({ plan: claudeOnly, expected: () => null }))), /beta: a claude task of unknown cost is already running/);
  const tight = plan([project('alpha', 1, [task()])], { reserve: { claude: { '5h': 30, '7d': 20 }, codex: { '5h': 30, '7d': 20 } } });
  assert.match(waited(nextLaunch(input({ plan: tight, expected: () => null, limits: [limits('claude', 100 - 30 - UNKNOWN_EXPECTED_PERCENT + 1, 0)] }))), /would breach/);
});

test('the order is the priority, and within a project the first one queued', () => {
  const p = plan([
    project('beta', 2, [task({ title: 'beta 1' })]),
    project('alpha', 1, [task({ title: 'alpha done', status: 'done' }), task({ title: 'alpha 2' }), task({ title: 'alpha 3' })]),
  ]);
  assert.equal(launched(nextLaunch(input({ plan: p }))), 'alpha 2');
});

test('nothing queued is a stated wait, and the reasons fit on a plate', () => {
  const settled: TaskStatus[] = ['done', 'skipped'];
  const p = plan([project('alpha', 1, settled.map((status) => task({ status })))]);
  assert.equal(waited(nextLaunch(input({ plan: p }))), 'nothing queued');
  const long = plan([project('a'.repeat(200), 1, [task({ status: 'question' }), task()])]);
  assert.ok(waited(nextLaunch(input({ plan: long }))).length <= 128);
});

test('tasks in flight count: three launches in one tick do not pass against the same reading', () => {
  // The night of 2026-09-18: 5h at 5%, a 20% reserve, three tasks launched in
  // one tick, each weighed against the 5% as if the others cost nothing.
  const reserve = { claude: { '5h': 20, '7d': 20 }, codex: { '5h': 20, '7d': 20 } };
  const cost = { '5h': 30, '7d': 3 };
  const tasks = [task(), task(), task()];
  let p = plan([project('a', 1, [tasks[0]!]), project('b', 2, [tasks[1]!]), project('c', 3, [tasks[2]!])], { reserve, parallel: 4 });
  const run = (next: ReturnType<typeof nextLaunch>): void => {
    const id = launched(next);
    p = { ...p, projects: p.projects.map((pr) => ({ ...pr, tasks: pr.tasks.map((t) => (t.title === id ? { ...t, status: 'running' as TaskStatus } : t)) })) };
  };
  const at5 = [limits('claude', 5, 10)];
  run(nextLaunch(input({ plan: p, limits: at5, expected: () => cost }))); // 5 + 30 = 35
  run(nextLaunch(input({ plan: p, limits: at5, expected: () => cost }))); // 5 + 30 + 30 = 65
  // 5 + 60 + 30 = 95 > 80: the third waits, and says what is running
  assert.match(waited(nextLaunch(input({ plan: p, limits: at5, expected: () => cost }))), /5h at 5% \+ ~60% running \+ ~30% would breach the 20% reserve/);
});

test('a task in flight of unknown cost counts ten points for the reserve too', () => {
  const p = plan([project('alpha', 1, [task()])], { reserve: { claude: { '5h': 20, '7d': 20 }, codex: { '5h': 20, '7d': 20 } } });
  assert.equal(headroomReason(p, 'claude', [limits('claude', 60, 10)], { '5h': 10, '7d': 1 }, NOW, []), null);
  // 60 + 10 + 10 lands on the line and is still allowed; one point more is not
  assert.equal(headroomReason(p, 'claude', [limits('claude', 60, 10)], { '5h': 10, '7d': 1 }, NOW, [null]), null);
  assert.match(headroomReason(p, 'claude', [limits('claude', 61, 10)], { '5h': 10, '7d': 1 }, NOW, [null]) ?? '', /~10% running/);
});

test('the reserve holds while work runs: reaching it is enough to stop the fleet', () => {
  const p = plan([project('alpha', 1, [task({ status: 'running' })])], { reserve: { claude: { '5h': 20, '7d': 20 }, codex: { '5h': 20, '7d': 20 } } });
  assert.equal(reserveBreach(p, 'claude', [limits('claude', 79, 10)], NOW), null);
  assert.match(reserveBreach(p, 'claude', [limits('claude', 80, 10)], NOW) ?? '', /5h at 80% reached the 20% reserve/);
  assert.match(reserveBreach(p, 'claude', [limits('claude', 10, 81)], NOW) ?? '', /7d at 81%/);
  // another fleet's reading, or none, stops nothing
  assert.equal(reserveBreach(p, 'codex', [limits('claude', 99, 99)], NOW), null);
  // a window past its reset reads zero: yesterday's 95% stops nothing today
  const stale = limits('claude', 95, 10);
  stale.windows[0] = { ...stale.windows[0]!, resetsAt: NOW - 1000 };
  assert.equal(reserveBreach(p, 'claude', [stale], NOW), null);
});
