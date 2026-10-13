import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MEETING_CONTRACT, MEETING_ROLE, openingPrompt, parseMeetingOutcome, restartPrompt, turnPrompt,
  wrapUpPrompt,
} from '../src/server/ceo/planning.ts';
import type { MeetingContext } from '../src/server/ceo/planning.ts';
import { createPlanStore } from '../src/server/ceo/plan.ts';
import type { Plan, PlanStore } from '../src/server/ceo/plan.ts';
import { OUTCOME_FENCE } from '../src/server/ceo/outcome.ts';
import { MAX_BRIEFING_CHARS } from '../src/shared/protocol.ts';

const T0 = Date.parse('2026-09-18T09:00:00.000Z');

function store(): PlanStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-planning-'));
  return createPlanStore(dir, { providers: ['claude', 'codex'], codexModel: null });
}

const CTX: MeetingContext = {
  projects: [
    { name: 'alpha', providers: ['claude'], branch: 'main', commits: 12, root: '/Users/me/alpha', live: false },
    { name: 'beta', providers: ['claude', 'codex'], branch: null, commits: 0, root: '/Users/me/beta', live: true },
    { name: 'gone', providers: [], branch: null, commits: 0, root: null, live: false },
  ],
  limits: [{
    provider: 'claude', at: T0, plan: 'max 5x',
    windows: [
      { label: '5h', usedPercent: 61, windowMinutes: 300, model: null, resetsAt: T0 + 3_600_000 },
      { label: '7d', usedPercent: 20, windowMinutes: 10_080, model: null, resetsAt: T0 + 86_400_000 },
    ],
  }],
  providers: ['claude', 'codex'],
  metered: [],
  codexModel: null,
  now: T0,
};

function block(json: object): string {
  return `Some prose.\n${OUTCOME_FENCE}\n${JSON.stringify(json)}\n\`\`\`\n`;
}

/* ───────────────────────── the prompts ───────────────────────── */

test('the first turn carries role, projects with roots, quota, models, to-do and attachments', () => {
  const s = store();
  s.say('alpha: ship the export. beta later.', T0);
  s.attach('TODO.md', '- export\n- badge', T0);
  const p = openingPrompt(s.get(), CTX);
  assert.ok(p.startsWith(MEETING_ROLE));
  assert.match(p, /- alpha · tools: claude · branch main · 12\+ commits seen · code at \/Users\/me\/alpha/);
  assert.match(p, /- beta .* the user is working here now/);
  assert.match(p, /- gone .* not on disk/);
  assert.match(p, /claude: 5h at 61%, 7d at 20% · reserve to keep free: 30% of 5h, 20% of 7d/);
  assert.match(p, /codex: no quota reading yet/);
  assert.match(p, /haiku < sonnet < opus < fable/);
  assert.match(p, /alpha: ship the export\. beta later\./);
  assert.match(p, /--- TODO\.md \(16 chars\) ---\n- export\n- badge\n--- end ---/);
  assert.ok(p.trimEnd().endsWith(MEETING_CONTRACT.trimEnd()), 'the contract closes the prompt');
});

test('a fleet on an API key is told to the chair as billed by the token, not as waiting for a reading', () => {
  // The desk hands the chair no window for it, and "no quota reading yet"
  // would have the chair plan around a reading that never comes and a
  // reserve that holds nothing.
  const s = store();
  s.say('alpha: ship the export.', T0);
  const p = openingPrompt(s.get(), { ...CTX, limits: [], metered: ['claude'] });
  assert.match(p, /- claude: billed by the token, not on a plan · no quota window and no reserve apply/);
  assert.match(p, /- codex: no quota reading yet/);
});

test('the first turn carries the answers too, if there are any: the desk marks them read after every turn', () => {
  const s = store();
  s.applyOutcome({ ready: false, questions: [{ id: 'q1', text: 'CSV or JSON?' }], projects: [] }, () => null, T0);
  s.set({ kind: 'question', id: 'q1', text: 'CSV' }, T0);
  assert.match(openingPrompt(s.get(), CTX), /# Your questions, answered\nQ \(q1\): CSV or JSON\?\nA: CSV/);
  assert.ok(!openingPrompt(store().get(), CTX).includes('# Your questions, answered'));
});

test('a later turn carries the message, the given answers and the compact plan with ids, without briefings', () => {
  const s = store();
  s.applyOutcome({
    ready: false,
    questions: [{ id: 'q1', text: 'CSV or JSON?' }],
    projects: [{ name: 'alpha', priority: 1, tests: [], tasks: [
      { id: null, title: 'Export', briefing: 'SECRET BRIEFING TEXT', provider: 'claude', model: 'opus', effort: null, size: 'large' },
    ] }],
  }, (name) => (name === 'alpha' ? { projectId: 'p1', name } : null), T0);
  s.set({ kind: 'question', id: 'q1', text: 'CSV' }, T0);
  const id = s.get().projects[0]!.tasks[0]!.id;
  s.set({ kind: 'task', taskId: id, model: 'haiku' }, T0);
  const p = turnPrompt(s.get(), 'also fix the badge');
  assert.match(p, /# The user says\nalso fix the badge/);
  assert.match(p, /Q \(q1\): CSV or JSON\?\nA: CSV/);
  assert.ok(p.includes(`"id": "${id}"`), 'the task id is in the compact plan');
  assert.ok(p.includes('"pinned": true'), 'the choice made by hand is declared');
  assert.ok(!p.includes('SECRET BRIEFING TEXT'), 'the briefing is not resent: the chair already has it');
  assert.ok(!p.includes(MEETING_ROLE), 'the role is not repeated: the session remembers it');
});

test('an attachment added after the first turn travels with the next turn, and only that one', () => {
  // On the field: the list was attached after the first turn, and the chair
  // answered that it could see no document -- later turns carried none.
  const s = store();
  s.say('My Dashboard Todo', T0);
  s.attach('old.md', 'ALREADY READ', T0);
  s.delivered([s.get().attachments[0]!.id], [], T0);
  s.attach('global_todo.txt', '1. the ship interior\n2. the crowd', T0);
  const p = turnPrompt(s.get(), 'the text was cut: use the attached file');
  assert.match(p, /# The user says\nthe text was cut: use the attached file\n\n# Attachments\n/);
  assert.match(p, /--- global_todo\.txt \(33 chars\) ---\n1\. the ship interior\n2\. the crowd\n--- end ---/);
  assert.ok(!p.includes('ALREADY READ'), 'a file the chair already has is not paid for again every turn');
  assert.ok(!p.includes('Removed by the user'));
});

test('a turn with nothing new about attachments does not mention them', () => {
  const s = store();
  s.attach('TODO.md', '- export', T0);
  s.delivered([s.get().attachments[0]!.id], [], T0);
  assert.ok(!turnPrompt(s.get(), 'next').includes('# Attachments'));
});

test('a file removed after the chair read it is announced; re-added under the same name it is the new version', () => {
  const s = store();
  s.attach('a.md', 'A1', T0);
  s.attach('b.md', 'B1', T0);
  s.delivered(s.get().attachments.map((a) => a.id), [], T0);
  for (const a of s.get().attachments) s.detach(a.id, T0);
  s.attach('b.md', 'B2', T0);
  const p = turnPrompt(s.get(), 'changed my mind');
  assert.match(p, /Removed by the user, disregard them: a\.md\./);
  assert.match(p, /--- b\.md \(2 chars\) ---\nB2\n--- end ---/);
  assert.match(p, /its new version and replaces it/);
});

test('the role asks for short turns, and the resume after the brake forbids more reading and ends with the contract', () => {
  assert.match(MEETING_ROLE, /Keep each turn short/);
  assert.match(MEETING_ROLE, /stopped before it says anything/);
  const p = wrapUpPrompt('this call passed 2.06 USD, over the 2.00 per-call cap');
  assert.match(p, /^# You were stopped\nYour last turn was stopped before you answered: this call passed 2\.06 USD/);
  assert.match(p, /name the files you\ndid not get to/);
  assert.ok(p.trimEnd().endsWith(MEETING_CONTRACT.trimEnd()));
  assert.ok(!p.includes(MEETING_ROLE), 'the session already has the role');
});

test('an answers-only turn says there is no message, without putting words in the mouth of the user', () => {
  const p = turnPrompt(store().get(), '');
  assert.match(p, /# The user says\n\(no message this turn: the user answered your questions, below\)/);
});

test('the restart carries the minutes and the briefings, because the earlier session is gone', () => {
  const s = store();
  s.say('alpha: ship the export', T0);
  s.noteCeo('Which format?', T0 + 1);
  s.applyOutcome({
    ready: false, questions: [],
    projects: [{ name: 'alpha', priority: 1, tests: [], tasks: [
      { id: null, title: 'Export', briefing: 'Write a CSV exporter in reports.ts', provider: 'claude', model: null, effort: null, size: 'medium' },
    ] }],
  }, (name) => ({ projectId: 'p1', name }), T0 + 2);
  const p = restartPrompt(s.get(), CTX, 'CSV please');
  assert.ok(p.startsWith(MEETING_ROLE));
  assert.match(p, /# Minutes so far\n.*\n\[user\] alpha: ship the export\n\[you\] Which format\?/);
  assert.ok(p.includes('Write a CSV exporter in reports.ts'), 'the briefings go back to the new chair');
  assert.match(p, /# The user says\nCSV please/);
});

/* ───────────────────────── the block ───────────────────────── */

test('the chair block is parsed: questions, projects, tasks, ready', () => {
  const parsed = parseMeetingOutcome(block({
    ready: false,
    questions: [{ id: 'q1', text: 'CSV or JSON?' }, { text: 'no id' }],
    projects: [{
      name: 'alpha', priority: 2, git: { tests: true, commit: true, push: 'yes' },
      tests: ['npm test', 'Bash(node --check *)', 'php *', 42],
      tasks: [
        { id: null, title: 'Export', briefing: 'Do it.', provider: 'claude', model: 'opus', effort: 'high', size: 'large' },
        { id: 't-old', title: 'Badge', briefing: '', provider: 'codex', model: null, effort: 'low', size: 'huge' },
        { title: '', briefing: 'no title: dropped' },
      ],
    }],
  }));
  assert.ok(parsed);
  assert.equal(parsed.ready, false);
  assert.deepEqual(parsed.questions.map((q) => q.id), ['q1', 'q2']);
  const p = parsed.projects[0]!;
  assert.equal(p.priority, 2);
  assert.equal('git' in p, false, 'the git rules are the user\'s: the chair\'s are not even read');
  assert.deepEqual(p.tests, ['npm test', 'node --check *'], 'valid commands only, unwrapped');
  assert.equal(p.tasks.length, 2);
  assert.equal(p.tasks[0]?.id, null);
  assert.equal(p.tasks[0]?.effort, 'high', 'the parser does not decide who uses effort: the store does');
  assert.equal(p.tasks[1]?.id, 't-old');
  assert.equal(p.tasks[1]?.size, 'medium', 'an unknown size counts as medium');
});

test('with no block, or with a block that is not a plan, nothing changes', () => {
  assert.equal(parseMeetingOutcome('just prose'), null);
  assert.equal(parseMeetingOutcome(`${OUTCOME_FENCE}\nnot json\n\`\`\``), null);
  assert.equal(parseMeetingOutcome(block({ title: 'an analysis', proposals: [] })), null);
  assert.equal(parseMeetingOutcome(block({ ready: true, questions: [], projects: [] }))?.ready, true, 'ready alone is an empty plan, but a stated one');
});

test('an unclosed block is parsed all the same: it is the normal shape of a truncated answer', () => {
  const text = `prose\n${OUTCOME_FENCE}\n${JSON.stringify({ ready: false, questions: [{ id: 'q1', text: 'Where?' }], projects: [] })}`;
  assert.equal(parseMeetingOutcome(text)?.questions[0]?.text, 'Where?');
});

test('the caps apply to the block too: a long briefing is cut, questions beyond twelve are dropped', () => {
  const parsed = parseMeetingOutcome(block({
    ready: false,
    questions: Array.from({ length: 15 }, (_, i) => ({ id: `q${i}`, text: `question ${i}` })),
    projects: [{ name: 'alpha', priority: 1, git: {}, tasks: [
      { id: null, title: 'x', briefing: 'b'.repeat(MAX_BRIEFING_CHARS + 500), provider: 'claude', model: null, effort: null, size: 'small' },
    ] }],
  }));
  assert.equal(parsed?.questions.length, 12);
  assert.equal(parsed?.projects[0]?.tasks[0]?.briefing.length, MAX_BRIEFING_CHARS);
});

test('the block applied to the store becomes a proposal with the names resolved', () => {
  const s = store();
  const parsed = parseMeetingOutcome(block({
    ready: true, questions: [],
    projects: [{ name: 'alpha', priority: 1, tests: [], tasks: [
      { id: null, title: 'Export', briefing: 'Do it.', provider: 'claude', model: 'sonnet', effort: null, size: 'medium' },
    ] }],
  }));
  assert.ok(parsed);
  const out = s.applyOutcome(parsed, (name) => (name === 'alpha' ? { projectId: 'p1', name } : null), T0);
  assert.equal(out.ok, true);
  const plan: Plan = s.get();
  assert.equal(plan.status, 'proposed');
  assert.equal(plan.ready, true);
  assert.equal(plan.projects[0]?.projectId, 'p1');
});

test('the chair is asked for each project\'s test commands, and sees the ones already there', () => {
  // The tests always run (2026-09-19): the chair no longer decides whether,
  // it says with what -- read from the repository, before a worker is refused.
  assert.ok(!/whether the worker may run/.test(MEETING_ROLE));
  assert.match(MEETING_ROLE, /Workers always run a project's tests/);
  assert.match(MEETING_ROLE, /never a bare interpreter/);
  // The list is no longer what a worker may run: its sandbox is the gate,
  // and the chair must know what cannot be done inside it. Two studies of
  // the plan of 2026-10-13 needed the web, and their workers had none.
  assert.ok(!/A worker may run only these/.test(MEETING_ROLE));
  assert.match(MEETING_ROLE, /The worker is told to run these/);
  assert.match(MEETING_ROLE, /writes only inside its project and has no\nnetwork/);
  // The web is a box of the user's, off by default: the chair cannot tick it,
  // so it must ask for it instead of planning as if the worker could read.
  assert.match(MEETING_ROLE, /unless the user ticks `web` for that project/);
  assert.match(MEETING_ROLE, /ask the user to tick it: do not plan the task as if the worker could/);
  assert.match(MEETING_CONTRACT, /for claude leave it null, the user\nsets it/);
  assert.match(MEETING_CONTRACT, /"tests": \["npm test", "node --check \*"\]/);
  assert.ok(!/"git":/.test(MEETING_CONTRACT), 'the git rules are the user\'s checkboxes');
});

test('a later turn shows the chair each project\'s test commands, which its block can only add to', () => {
  const s = store();
  s.applyOutcome({ ready: false, questions: [], projects: [{ name: 'alpha', priority: 1, tests: ['php tests/*'], tasks: [
    { id: null, title: 'Export', briefing: 'Do it.', provider: 'claude', model: 'sonnet', effort: null, size: 'small' },
  ] }] }, (n) => (n === 'alpha' ? { projectId: 'p-alpha', name: 'alpha' } : null), T0);
  const p = turnPrompt(s.get(), 'go on');
  assert.match(p, /"tests": \[\n\s*"php tests\/\*"\n\s*\]/);
  assert.match(p, /the `tests` you list are added to them, never removed/);
});
