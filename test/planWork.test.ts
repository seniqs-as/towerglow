import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveGit, minutesFor, needsQuestion, parsePlanReport, planAnswer, planRetry, planTask, PLAN_WORK_CONTRACT,
} from '../src/server/ceo/planWork.ts';
import { OUTCOME_FENCE } from '../src/server/ceo/outcome.ts';
import type { Minute, PlanProject, PlanTask } from '../src/shared/protocol.ts';

const T0 = Date.parse('2026-09-18T09:00:00.000Z');

function task(over: Partial<PlanTask> = {}): PlanTask {
  return {
    id: 't1', title: 'Ship the export', briefing: 'CSV in reports.ts, with a test in test/reports.test.ts.',
    provider: 'claude', model: 'sonnet', effort: null, size: 'medium', pinned: false,
    status: 'queued', question: null, answer: null, needs: [], attempts: 0, jobId: null, sessionId: null,
    did: null, learned: null, reason: null, ...over,
  };
}

function project(over: Partial<PlanProject> = {}): PlanProject {
  return {
    projectId: 'p1', name: 'alpha', priority: 1, git: { commit: true, push: false },
    tasks: [task()], ...over,
  };
}

const MINUTES: Minute[] = [
  { at: T0, role: 'user', text: 'alpha: ship the export first. beta later.' },
  { at: T0 + 1, role: 'ceo', text: 'For alpha I will keep the CSV separator a comma.' },
  { at: T0 + 2, role: 'system', text: 'the chair named a project that is not here: alpha2' },
  { at: T0 + 3, role: 'user', text: 'beta: nothing yet' },
];

test('the prompt carries the whole briefing, the project minutes lines, and the block', () => {
  const p = planTask({ task: task(), project: project(), minutes: MINUTES, branch: 'main', commands: [] });
  assert.match(p, /^# Ship the export/);
  assert.ok(p.includes('CSV in reports.ts, with a test in test/reports.test.ts.'));
  assert.ok(p.includes('- [user] alpha: ship the export first. beta later.'));
  assert.ok(p.includes('- [chair] For alpha I will keep the CSV separator a comma.'));
  assert.ok(!p.includes('alpha2'), 'system notes do not travel');
  assert.ok(!p.includes('beta: nothing yet'), 'lines from another project do not travel');
  assert.ok(p.trimEnd().endsWith(PLAN_WORK_CONTRACT.trimEnd()));
});

test('the git rules follow the plan: pull only with commit, push only if allowed', () => {
  const all = planTask({ task: task(), project: project({ git: { commit: true, push: true } }), minutes: [], branch: 'main', commands: [] });
  assert.match(all, /git pull --rebase/);
  assert.match(all, /Push to `main` when the tests pass, and only that branch/);
  assert.match(all, /no remote, there is nothing to push: say so in `did`/);

  const none = planTask({ task: task(), project: project({ git: { commit: false, push: false } }), minutes: [], branch: 'main', commands: [] });
  assert.ok(!/git pull --rebase/.test(none));
  assert.match(none, /Never push/);
  assert.match(none, /Do not commit/);
});

test('the tests always run, and the worker is told what it may run and how to ask for more', () => {
  // visibilitycheck had its tests switched off and decsim2 could not run
  // its own: "the tests must always run, the checkbox is not even needed".
  const bare = planTask({ task: task(), project: project({ git: { commit: false, push: false } }), minutes: [], branch: 'main', commands: [] });
  assert.match(bare, /Run the project's tests and checks before you finish/);
  assert.match(bare, /common test runners are allowed: npm test/);
  assert.ok(!/tests are not allowed/.test(bare));
  assert.match(bare, /list the exact commands in `needs`/);
  assert.match(bare, /do not ask the user to edit a settings file/, 'the decsim2 worker asked exactly that');

  const php = planTask({ task: task(), project: project(), minutes: [], branch: 'main', commands: ['php tests/*', 'bash tests/api_smoke.sh'] });
  assert.match(php, /Besides the common test runners you may run: `php tests\/\*`, `bash tests\/api_smoke.sh`\./);
});

test('a project without git neither commits nor pushes, whatever its check marks say', () => {
  const rules = { commit: true, push: true };
  assert.deepEqual(effectiveGit(rules, null), { commit: false, push: false });
  assert.deepEqual(effectiveGit(rules, 'main'), rules);
  const p = planTask({ task: task(), project: project({ git: rules }), minutes: [], branch: null, commands: [] });
  assert.match(p, /This directory is not under git: do not run git/);
  assert.ok(!/git pull --rebase/.test(p));
  assert.ok(!/Push to/.test(p));
  assert.ok(!/Commit as you go/.test(p));
  assert.match(p, /Run the project's tests/, 'the tests stay: they do not depend on git');
});

test('the prompt says nobody will answer, and how to stop with a question', () => {
  const p = planTask({ task: task(), project: project(), minutes: [], branch: 'main', commands: [] });
  assert.match(p, /Nobody will answer during this task/);
  assert.match(p, /status: "question"/);
  assert.match(p, /Do not ask what the briefing already answers/);
});

test('a fresh launch after an answer carries question and answer; the resume carries only those', () => {
  const answered = task({ question: 'CSV or JSON?', answer: 'CSV', attempts: 1 });
  const fresh = planTask({ task: answered, project: project(), minutes: [], branch: 'main', commands: [] });
  assert.match(fresh, /An earlier attempt asked, and the user answered\n+Question: CSV or JSON\?\n+Answer: CSV/);
  const resumed = planAnswer(answered);
  assert.match(resumed, /^You stopped with a question: CSV or JSON\?\n+The user's answer: CSV/);
  assert.ok(!resumed.includes('# Briefing'), 'the resumed session already has the briefing');
  const retry = planRetry(task({ reason: 'went quiet for 5 min' }));
  assert.match(retry, /ended without finishing \(went quiet for 5 min\)/);
});

test('the minutes lines have a cap on count and on length', () => {
  const many: Minute[] = Array.from({ length: 30 }, (_, i) => ({ at: T0 + i, role: 'user', text: `alpha line ${i} ${'x'.repeat(600)}` }));
  const lines = minutesFor(project(), many);
  assert.equal(lines.length, 20);
  assert.ok(lines[0]!.includes('alpha line 10'), 'the most recent remain');
  assert.ok(lines.every((l) => l.length <= 520));
});

test('the worker block reads as three words, and anything else is null', () => {
  const block = (o: object): string => `prose\n${OUTCOME_FENCE}\n${JSON.stringify(o)}\n\`\`\``;
  assert.deepEqual(parsePlanReport(block({ status: 'done', did: 'Added the export', question: null })), { status: 'done', did: 'Added the export', question: null, needs: [], wrote: [] });
  assert.deepEqual(parsePlanReport(block({ status: 'question', did: null, question: 'CSV or JSON? I suggest CSV.' })), { status: 'question', did: null, question: 'CSV or JSON? I suggest CSV.', needs: [], wrote: [] });
  assert.equal(parsePlanReport(block({ status: 'maybe' })), null);
  assert.equal(parsePlanReport('no block at all'), null);
  assert.equal(parsePlanReport(block({ status: 'failed', did: 'tests failed' }))?.status, 'failed');
});

test('a worker refused a command it needs is asking, whatever status it wrote', () => {
  const block = (o: object): string => `prose\n${OUTCOME_FENCE}\n${JSON.stringify(o)}\n\`\`\``;
  // A "done" that could not run its tests is not done: the tests always run.
  const done = parsePlanReport(block({ status: 'done', did: 'Committed, tests not run', question: null, needs: ['php tests/*', 'Bash(bash tests/api_smoke.sh)'] }));
  assert.equal(done?.status, 'question');
  assert.deepEqual(done?.needs, ['php tests/*', 'bash tests/api_smoke.sh']);
  assert.equal(done?.question, needsQuestion(['php tests/*', 'bash tests/api_smoke.sh']));
  assert.match(done!.question!, /`php tests\/\*`, `bash tests\/api_smoke.sh`/);
  // Its own question is kept when it wrote one.
  const asked = parsePlanReport(block({ status: 'question', did: null, question: 'Allow php? (A) yes', needs: ['php tests/*'] }));
  assert.equal(asked?.question, 'Allow php? (A) yes');
  // A need that would allow anything is dropped: the question stays, the button does not come.
  const wild = parsePlanReport(block({ status: 'question', did: null, question: 'May I run php?', needs: ['php *'] }));
  assert.deepEqual(wild?.needs, []);
  assert.equal(wild?.status, 'question');
});

/*
 * The plan nobody could open.
 *
 * The first "planning only" task (visibilitycheck, 2026-09-19) wrote a 47 KB
 * plan into docs/ and Reports showed the worker's 3.8 KB message about it:
 * the ledger keeps twenty thousand characters, and the file lived only in
 * the editor. Now the worker names the documents it wrote, and each one is
 * a button in Reports.
 */
test('the worker names the documents it wrote, and the contract asks for them', () => {
  const block = (o: object): string => `prose\n${OUTCOME_FENCE}\n${JSON.stringify(o)}\n\`\`\``;
  assert.match(PLAN_WORK_CONTRACT, /"wrote": \[\]/);
  assert.match(PLAN_WORK_CONTRACT, /under\n`docs\/`, as markdown/, 'a plan with no file named gets one');
  const done = parsePlanReport(block({ status: 'done', did: 'Wrote the plan', wrote: ['docs/player_involvement_plan.md', './docs/notes.md'] }));
  assert.deepEqual(done?.wrote, ['docs/player_involvement_plan.md', 'docs/notes.md']);
  // A block without the field is a worker that wrote code: nothing to open.
  assert.deepEqual(parsePlanReport(block({ status: 'done', did: 'Fixed the light' }))?.wrote, []);
  // A question keeps them too: what was written before stopping is still there to read.
  const asked = parsePlanReport(block({ status: 'question', did: null, question: 'CSV or JSON?', wrote: ['docs/draft.md'] }));
  assert.deepEqual(asked?.wrote, ['docs/draft.md']);
});
