import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  countsOf, createPlanStore, DEFAULT_PARALLEL, DEFAULT_RESERVE, docOf, findTask,
  normalizeGit, openQuestionsOf, STOPPED_BY_RESTART, unreadAnswersOf,
} from '../src/server/ceo/plan.ts';
import type { ParsedPlan, ParsedTask, PlanStore } from '../src/server/ceo/plan.ts';
import {
  MAX_ATTACHMENT_CHARS, MAX_ATTACHMENTS, MAX_ATTACHMENTS_TOTAL_CHARS, MAX_SAY_CHARS, MAX_TODO_CHARS,
} from '../src/shared/protocol.ts';
import { clipPlanFrame } from '../src/server/ceoPort.ts';

const T0 = Date.parse('2026-09-18T09:00:00.000Z');

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-plan-'));
}

function store(dir = tmp()): PlanStore {
  return createPlanStore(dir, { providers: ['claude', 'codex'], codexModel: null });
}

/** The projects the world knows, by display name: what the chair sees. */
const KNOWN: Record<string, { projectId: string; name: string }> = {
  alpha: { projectId: 'p-alpha', name: 'alpha' },
  beta: { projectId: 'p-beta', name: 'beta' },
};
const resolve = (name: string): { projectId: string; name: string } | null => KNOWN[name] ?? null;

function task(over: Partial<ParsedTask> = {}): ParsedTask {
  return {
    id: null, title: 'Add the export button', briefing: 'Put a CSV export in the reports panel.',
    provider: 'claude', model: 'sonnet', effort: null, size: 'medium', ...over,
  };
}

function parsed(over: Partial<ParsedPlan> = {}): ParsedPlan {
  return {
    ready: false,
    questions: [],
    projects: [{
      name: 'alpha', priority: 1, tests: [],
      tasks: [task()],
    }],
    ...over,
  };
}

/** A plan with one project and one queued task, proposed. */
function proposed(s: PlanStore = store()): PlanStore {
  assert.equal(s.applyOutcome(parsed(), resolve, T0).ok, true);
  assert.equal(s.get().status, 'proposed');
  return s;
}

function onlyTask(s: PlanStore): string {
  const t = s.get().projects[0]?.tasks[0];
  assert.ok(t, 'the plan has no task');
  return t.id;
}

/* ───────────────────────── the sheet ───────────────────────── */

test('a new plan is a draft, with the default reserve and parallelism', () => {
  const s = store();
  const p = s.get();
  assert.equal(p.status, 'drafting');
  assert.equal(p.rev, 0);
  assert.deepEqual(p.reserve.claude, DEFAULT_RESERVE);
  assert.deepEqual(p.reserve.codex, DEFAULT_RESERVE);
  assert.equal(p.parallel, DEFAULT_PARALLEL);
  assert.equal(p.review, false);
  assert.equal(p.chair, 'claude');
});

test('rev grows with every change and not on a refusal', () => {
  const s = store();
  assert.equal(s.say('alpha: ship the export', T0).ok, true);
  assert.equal(s.get().rev, 1);
  assert.equal(s.detach('nope', T0).ok, false);
  assert.equal(s.get().rev, 1, 'a refusal is not a change');
});

test('what you say ends up in the to-dos and in the minutes', () => {
  const s = store();
  s.say('alpha: ship the export', T0);
  s.say('beta comes after alpha', T0 + 1);
  const p = s.get();
  assert.equal(p.todo, 'alpha: ship the export\n\nbeta comes after alpha');
  assert.deepEqual(p.minutes.map((m) => m.role), ['user', 'user']);
});

test('the to-do list has a cap, and past it the store refuses instead of cutting', () => {
  const s = store();
  assert.equal(s.say('x'.repeat(7000), T0).ok, true);
  assert.equal(s.say('y'.repeat(7000), T0).ok, true);
  const out = s.say('z'.repeat(2000), T0);
  assert.equal(out.ok, false);
  assert.match(out.reason, new RegExp(String(MAX_TODO_CHARS)));
});

test('a message over the cap of one turn is refused with the number, and never silently cut', () => {
  const s = store();
  const long = 'x'.repeat(MAX_SAY_CHARS + 1);
  // The dispatcher keeps one char over the cap, so the store can say why.
  const frame = clipPlanFrame({ t: 'plan.say', text: 'x'.repeat(MAX_SAY_CHARS + 500) });
  assert.equal(frame.t === 'plan.say' && frame.text.length, MAX_SAY_CHARS + 1);
  const out = s.say(long, T0);
  assert.equal(out.ok, false);
  assert.match(out.reason, new RegExp(`${MAX_SAY_CHARS + 1} chars, the cap for one turn is ${MAX_SAY_CHARS}: attach it`));
  assert.equal(s.get().todo, '');
  assert.equal(s.get().minutes.length, 0);
});

test('the minutes keep a whole turn: a 2690-character list does not show up cut at 2000', () => {
  const s = store();
  const todo = `My Dashboard Todo\n${'1. something to do\n'.repeat(140)}`;
  assert.ok(todo.length > 2000);
  s.say(todo, T0);
  assert.equal(s.get().minutes[0]?.text, todo.trim());
  assert.equal(s.get().todo, todo.trim());
});

/* ───────────────────────── attachments ───────────────────────── */

test('a new attachment does not belong to the chair yet; delivered it does, and removing it becomes news', () => {
  const s = store();
  s.attach('TODO.md', '- one', T0);
  s.attach('notes.md', '- two', T0);
  assert.deepEqual(s.get().attachments.map((a) => a.sent), [false, false]);
  const [a, b] = s.get().attachments;
  s.delivered([a!.id, b!.id], [], T0);
  assert.deepEqual(s.get().attachments.map((x) => x.sent), [true, true]);

  s.detach(a!.id, T0);
  assert.deepEqual(s.get().withdrawn, ['TODO.md'], 'the chair has read it: it must be told it no longer holds');
  s.attach('draft.md', '- three', T0);
  s.detach(s.get().attachments.find((x) => x.name === 'draft.md')!.id, T0);
  assert.deepEqual(s.get().withdrawn, ['TODO.md'], 'never delivered: it is not news');

  // A file attached while the chair was answering is not in what it got.
  s.attach('late.md', '- four', T0);
  s.delivered([], ['TODO.md'], T0);
  assert.deepEqual(s.get().withdrawn, []);
  assert.equal(s.get().attachments.find((x) => x.name === 'late.md')?.sent, false);
});

test('a lost session puts every attachment back to "to send"', () => {
  const s = store();
  s.attach('TODO.md', '- one', T0);
  s.setSession('sess-1');
  s.delivered([s.get().attachments[0]!.id], [], T0);
  s.detach(s.get().attachments[0]!.id, T0);
  s.attach('notes.md', '- two', T0);
  s.delivered([s.get().attachments[0]!.id], [], T0);
  s.setSession(null);
  assert.deepEqual(s.get().attachments.map((a) => a.sent), [false]);
  assert.deepEqual(s.get().withdrawn, [], 'a new session never saw the removed file');
});

test('a plan written before "sent" existed reads its attachments back as undelivered', () => {
  const dir = tmp();
  const s = store(dir);
  s.say('use the attachment', T0);
  s.attach('global_todo.txt', '1. the ship interior', T0);
  s.save();
  const file = path.join(dir, 'ceo', 'plan.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete raw.plan.withdrawn;
  for (const a of raw.plan.attachments) delete a.sent;
  fs.writeFileSync(file, JSON.stringify(raw));
  const again = store(dir).get();
  assert.equal(again.attachments[0]?.sent, false);
  assert.deepEqual(again.withdrawn, []);
});

test('an attachment that is too big is refused with its number', () => {
  const s = store();
  const out = s.attach('TODO.md', 'x'.repeat(MAX_ATTACHMENT_CHARS + 1), T0);
  assert.equal(out.ok, false);
  assert.match(out.reason, /TODO\.md is too big/);
  assert.equal(s.get().attachments.length, 0);
});

test('the same name again is the same file updated: it takes the place of the old one', () => {
  const s = store();
  s.attach('TODO.md', 'v1', T0);
  s.attach('TODO.md', 'v2 longer', T0 + 1);
  assert.equal(s.get().attachments.length, 1);
  assert.equal(s.get().attachments[0]?.text, 'v2 longer');
  assert.equal(s.get().attachments[0]?.chars, 9);
});

test('past the maximum number of attachments it refuses, and past the total too', () => {
  const s = store();
  for (let i = 0; i < MAX_ATTACHMENTS; i++) assert.equal(s.attach(`f${i}.md`, 'todo', T0).ok, true);
  const more = s.attach('extra.md', 'todo', T0);
  assert.equal(more.ok, false);
  assert.match(more.reason, /remove one first/);

  const big = store();
  const half = 'x'.repeat(MAX_ATTACHMENT_CHARS);
  for (let i = 0; i < 4; i++) assert.equal(big.attach(`f${i}.md`, half, T0).ok, true);
  const over = big.attach('f4.md', 'x'.repeat(10), T0);
  assert.equal(over.ok, false);
  assert.match(over.reason, new RegExp(String(MAX_ATTACHMENTS_TOTAL_CHARS)));
});

test('a name with control characters becomes a single line, and an empty one becomes "attachment"', () => {
  const s = store();
  s.attach('a\nb\tc', 'todo', T0);
  s.attach('\x00', 'todo', T0);
  assert.deepEqual(s.get().attachments.map((a) => a.name), ['a b c', 'attachment']);
});

test('detach of an unknown id is a refusal, not a silence', () => {
  const s = store();
  s.attach('TODO.md', 'todo', T0);
  assert.equal(s.detach('nope', T0).ok, false);
  const id = s.get().attachments[0]!.id;
  assert.equal(s.detach(id, T0).ok, true);
  assert.equal(s.get().attachments.length, 0);
});

/* ───────────────────────── the chair's block ───────────────────────── */

test('the first block with a project takes the draft to proposed', () => {
  const s = proposed();
  const p = s.get();
  assert.equal(p.projects.length, 1);
  assert.equal(p.projects[0]?.projectId, 'p-alpha');
  assert.equal(p.projects[0]?.tasks[0]?.status, 'queued');
  assert.equal(countsOf(p).queued, 1);
});

test('a project name that does not exist is dropped and put in the minutes, never guessed', () => {
  const s = store();
  s.applyOutcome(parsed({
    projects: [
      { name: 'alpha', priority: 2, tests: [], tasks: [task()] },
      { name: 'gamma', priority: 1, tests: [], tasks: [task()] },
    ],
  }), resolve, T0);
  const p = s.get();
  assert.deepEqual(p.projects.map((x) => x.name), ['alpha']);
  assert.ok(p.minutes.some((m) => m.role === 'system' && /gamma/.test(m.text)));
});

test('the priority in the block decides the order, and is renumbered from 1', () => {
  const s = store();
  s.applyOutcome(parsed({
    projects: [
      { name: 'alpha', priority: 5, tests: [], tasks: [task()] },
      { name: 'beta', priority: 2, tests: [], tasks: [task()] },
    ],
  }), resolve, T0);
  assert.deepEqual(s.get().projects.map((x) => [x.name, x.priority]), [['beta', 1], ['alpha', 2]]);
});

test('a task on a fleet that is not there moves to the chair\'s fleet, and says so', () => {
  const s = createPlanStore(tmp(), { providers: ['claude'], codexModel: null });
  s.applyOutcome(parsed({ projects: [{ ...parsed().projects[0]!, tasks: [task({ provider: 'codex' })] }] }), resolve, T0);
  assert.equal(s.get().projects[0]?.tasks[0]?.provider, 'claude');
  assert.ok(s.get().minutes.some((m) => m.role === 'system' && /no codex CEO/.test(m.text)));
});

test('a Claude model off the list becomes null, and so does a Codex model other than yours', () => {
  const s = createPlanStore(tmp(), { providers: ['claude', 'codex'], codexModel: 'gpt-5-codex' });
  s.applyOutcome(parsed({ projects: [{ ...parsed().projects[0]!, tasks: [
    task({ model: 'claude-3-opus-20240229' }),
    task({ provider: 'codex', model: 'o3', effort: 'high' }),
    task({ provider: 'codex', model: 'gpt-5-codex', effort: 'high' }),
  ] }] }), resolve, T0);
  const tasks = s.get().projects[0]!.tasks;
  assert.equal(tasks[0]?.model, null);
  assert.equal(tasks[1]?.model, null);
  assert.equal(tasks[1]?.effort, 'high');
  assert.equal(tasks[2]?.model, 'gpt-5-codex');
});

test('push without commit does not exist: it is normalised', () => {
  assert.deepEqual(normalizeGit({ commit: false, push: true }), { commit: true, push: true });
  // A plan saved when the tests were a checkbox: the box goes with the load.
  assert.deepEqual(normalizeGit({ tests: true, commit: true, push: false } as never), { commit: true, push: false });
  const s = store();
  const id = proposed(s).get().projects[0]!.projectId;
  s.set({ kind: 'git', projectId: id, rules: { commit: false, push: true } }, T0);
  assert.equal(s.get().projects[0]?.git.commit, true);
});

test('a second block rewrites the queued tasks by id and leaves alone the ones already moved', () => {
  const s = store();
  s.applyOutcome(parsed({ projects: [{ ...parsed().projects[0]!, tasks: [task(), task({ title: 'second' })] }] }), resolve, T0);
  const [first, second] = s.get().projects[0]!.tasks.map((t) => t.id);
  s.approve(T0);
  s.launched(first!, `${first}:1`, T0);
  s.finished(first!, { status: 'done', did: 'did it', question: null, reason: '', learned: 1000 }, T0);
  s.pause(T0);
  assert.equal(s.get().status, 'paused');
  s.applyOutcome(parsed({ projects: [{ ...parsed().projects[0]!, tasks: [
    task({ id: first, title: 'rewritten' }),
    task({ id: second, title: 'second, revised' }),
    task({ title: 'a new one' }),
  ] }] }), resolve, T0 + 1);
  const tasks = s.get().projects[0]!.tasks;
  assert.deepEqual(tasks.map((t) => t.id).slice(0, 2), [first, second]);
  assert.equal(tasks.length, 3);
  assert.equal(tasks[0]?.status, 'done', 'a finished task is not rewritten');
  assert.equal(tasks[0]?.title, 'Add the export button');
  assert.equal(tasks[1]?.title, 'second, revised', 'a queued task is rewritten by id');
  assert.equal(tasks[2]?.title, 'a new one');
  assert.equal(s.get().status, 'paused', 'the block does not change the state of a paused plan');
});

test('a queued task the chair no longer lists disappears, and an empty project with it', () => {
  const s = proposed();
  s.applyOutcome(parsed({ projects: [{ name: 'beta', priority: 1, tests: [], tasks: [task()] }] }), resolve, T0 + 1);
  assert.deepEqual(s.get().projects.map((p) => p.name), ['beta']);
});

test('a choice made by hand survives the next block', () => {
  const s = proposed();
  const id = onlyTask(s);
  assert.equal(s.set({ kind: 'task', taskId: id, provider: 'codex', effort: 'high' }, T0).ok, true);
  assert.equal(s.get().projects[0]?.tasks[0]?.pinned, true);
  s.applyOutcome(parsed({ projects: [{ ...parsed().projects[0]!, tasks: [task({ id, provider: 'claude', model: 'opus' })] }] }), resolve, T0 + 1);
  const t = s.get().projects[0]!.tasks[0]!;
  assert.equal(t.provider, 'codex');
  assert.equal(t.effort, 'high');
  assert.equal(t.model, null);
});

test('an answer survives only with its own question: ids get reused', () => {
  const s = store();
  s.applyOutcome(parsed({ questions: [{ id: 'q1', text: 'CSV or JSON?' }] }), resolve, T0);
  assert.equal(openQuestionsOf(s.get()), 1);
  assert.equal(s.set({ kind: 'question', id: 'q1', text: 'CSV' }, T0).ok, true);
  assert.equal(openQuestionsOf(s.get()), 0);
  s.applyOutcome(parsed({ questions: [{ id: 'q1', text: 'CSV or JSON?' }, { id: 'q2', text: 'Where?' }] }), resolve, T0 + 1);
  assert.equal(s.get().questions[0]?.answer, 'CSV');
  assert.equal(s.get().questions[1]?.answer, null);
  s.applyOutcome(parsed({ questions: [{ id: 'q1', text: 'Which panel?' }] }), resolve, T0 + 2);
  assert.equal(s.get().questions[0]?.answer, null, 'same id, different question: the answer does not hold');
});

test('an answer the chair has not read blocks approval; once read, it goes through', () => {
  // By decision of the user: answers reach the workers only through the
  // briefings the chair rewrites, so approving over an unread one loses it.
  const s = store();
  s.applyOutcome(parsed({ questions: [{ id: 'q1', text: 'CSV or JSON?' }] }), resolve, T0);
  s.set({ kind: 'question', id: 'q1', text: 'CSV' }, T0);
  assert.equal(unreadAnswersOf(s.get()), 1);
  const out = s.approve(T0);
  assert.equal(out.ok, false);
  assert.match(out.reason, /1 answer the chair has not read yet: send it a message first/);
  assert.equal(s.get().status, 'proposed');

  s.readAnswers([{ id: 'q1', text: 'CSV or JSON?', answer: 'CSV' }], T0);
  assert.equal(unreadAnswersOf(s.get()), 0);
  assert.equal(s.approve(T0).ok, true);
});

test('an answer changed after it was read goes back to unread; the same words do not', () => {
  const s = store();
  s.applyOutcome(parsed({ questions: [{ id: 'q1', text: 'CSV or JSON?' }] }), resolve, T0);
  s.set({ kind: 'question', id: 'q1', text: 'CSV' }, T0);
  s.readAnswers([{ id: 'q1', text: 'CSV or JSON?', answer: 'CSV' }], T0);
  s.set({ kind: 'question', id: 'q1', text: '  CSV ' }, T0);
  assert.equal(s.get().questions[0]?.seen, true, 'the same words stay read');
  s.set({ kind: 'question', id: 'q1', text: 'JSON' }, T0);
  assert.equal(s.get().questions[0]?.seen, false);
  // What the chair read was CSV: reading that does not cover JSON.
  s.readAnswers([{ id: 'q1', text: 'CSV or JSON?', answer: 'CSV' }], T0);
  assert.equal(unreadAnswersOf(s.get()), 1);
});

test('a question asked again unchanged keeps its answer and its read state; unanswered it blocks nothing', () => {
  const s = store();
  s.applyOutcome(parsed({ questions: [{ id: 'q1', text: 'CSV or JSON?' }, { id: 'q2', text: 'Where?' }] }), resolve, T0);
  s.set({ kind: 'question', id: 'q1', text: 'CSV' }, T0);
  s.readAnswers([{ id: 'q1', text: 'CSV or JSON?', answer: 'CSV' }], T0);
  s.applyOutcome(parsed({ questions: [{ id: 'q1', text: 'CSV or JSON?' }, { id: 'q2', text: 'Where?' }] }), resolve, T0 + 1);
  assert.equal(s.get().questions[0]?.seen, true);
  assert.equal(unreadAnswersOf(s.get()), 0, 'an open question is flagged, it does not block');
  assert.equal(s.approve(T0).ok, true);
});

test('resuming from a pause is approving again: an unread answer blocks that too', () => {
  const s = proposed();
  s.approve(T0);
  s.pause(T0);
  s.applyOutcome(parsed({ questions: [{ id: 'q1', text: 'Push too?' }] }), resolve, T0);
  s.set({ kind: 'question', id: 'q1', text: 'yes' }, T0);
  const out = s.resume(T0);
  assert.equal(out.ok, false);
  assert.match(out.reason, /has not read yet/);
  assert.equal(s.get().status, 'paused');
});

test('a plan written before "seen" existed reads its answers back as unread', () => {
  const dir = tmp();
  const s = store(dir);
  s.applyOutcome(parsed({ questions: [{ id: 'q1', text: 'CSV?' }] }), resolve, T0);
  s.set({ kind: 'question', id: 'q1', text: 'yes' }, T0);
  s.save();
  const file = path.join(dir, 'ceo', 'plan.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const q of raw.plan.questions) delete q.seen;
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(store(dir).get().questions[0]?.seen, false);
});

test('a project enters the plan with commit and "push to main" ticked, whatever the chair proposes', () => {
  const s = store();
  s.applyOutcome(parsed({ projects: [{ name: 'alpha', priority: 1, tests: [], tasks: [task()] }] }), resolve, T0);
  assert.deepEqual(s.get().projects[0]?.git, { commit: true, push: true });
});

test('the check marks you change stay yours: the chair\'s next block does not rewrite them', () => {
  // On the field: the chair's block rewrote the rules every turn, and an
  // unticked push came back ticked without anyone touching it.
  const s = store();
  s.applyOutcome(parsed(), resolve, T0);
  const id = s.get().projects[0]!.projectId;
  s.set({ kind: 'git', projectId: id, rules: { commit: true, push: false } }, T0);
  s.applyOutcome(parsed({ projects: [{ name: 'alpha', priority: 1, tests: [], tasks: [task()] }] }), resolve, T0 + 1);
  assert.deepEqual(s.get().projects[0]?.git, { commit: true, push: false });
});

test('the document carries the branch of every project, read from the world and never saved', () => {
  const s = proposed();
  const doc = docOf(s.get(), { branches: { 'p-alpha': 'main' }, active: { 'p-alpha': 1 } });
  assert.deepEqual(doc.branches, { 'p-alpha': 'main' });
  assert.deepEqual(doc.active, { 'p-alpha': 1 });
  assert.equal('branches' in s.get(), false);
  assert.equal('active' in s.get(), false);
});

test('a 638-character question from the chair arrives whole; past the cap the cut shows', () => {
  // On the field: cut at 500 mid-word, the question lost its last two asks
  // and was answered as if it had none.
  const long = `my_dashboard: ${'the 3d room must show the real Boardroom panel, '.repeat(13)}?`;
  assert.ok(long.length > 600 && long.length < 2000);
  const s = store();
  s.applyOutcome(parsed({ questions: [{ id: 'q1', text: long }] }), resolve, T0);
  assert.equal(s.get().questions[0]?.text, long);

  const huge = 'x'.repeat(5000);
  s.applyOutcome(parsed({ questions: [{ id: 'q1', text: huge }] }), resolve, T0 + 1);
  const kept = s.get().questions[0]!.text;
  assert.equal(kept.length, 2000);
  assert.ok(kept.endsWith('…'), 'a cut that does not show looks like a finished question');
});

test('a turn with no words sends the unread answers; with no answers to send it is refused', () => {
  const s = store();
  assert.equal(s.say('   ', T0).ok, false, 'nothing to say, nothing to send');
  s.applyOutcome(parsed({ questions: [{ id: 'q1', text: 'CSV or JSON?' }] }), resolve, T0);
  s.set({ kind: 'question', id: 'q1', text: 'CSV' }, T0);
  const todo = s.get().todo;
  const out = s.say('', T0);
  assert.equal(out.ok, true);
  assert.equal(s.get().todo, todo, 'answers are not to-dos');
  assert.equal(s.get().minutes.at(-1)?.text, "Answers to the chair's questions:\n\nQ: CSV or JSON?\nA: CSV");
  assert.equal(s.get().minutes.at(-1)?.role, 'user', 'the answers are your words');
});

test('the answers stay in the minutes after the chair retires the questions; ahead of your words', () => {
  // On the field: answered, the chair's block retired the questions, and the
  // meeting tab showed the first message and an empty box.
  const s = store();
  const long = `my_dashboard: ${'the 3d room must show the real panel, '.repeat(8)}?`;
  s.applyOutcome(parsed({ questions: [{ id: 'q1', text: long }, { id: 'q2', text: 'Opus?' }] }), resolve, T0);
  s.set({ kind: 'question', id: 'q1', text: 'yes, the real one' }, T0);
  s.set({ kind: 'question', id: 'q2', text: 'no, sonnet' }, T0);
  s.say('and no codex', T0);
  const [answers, said] = s.get().minutes.slice(-2);
  assert.equal(said?.text, 'and no codex');
  assert.ok(answers?.text.startsWith("Answers to the chair's questions:"));
  assert.match(answers?.text ?? '', /\nA: yes, the real one\n/);
  assert.match(answers?.text ?? '', /Q: my_dashboard: .{150,}…\n/, 'the question gets shortened, and it shows');
  s.readAnswers([
    { id: 'q1', text: long, answer: 'yes, the real one' }, { id: 'q2', text: 'Opus?', answer: 'no, sonnet' },
  ], T0);
  s.applyOutcome(parsed({ questions: [] }), resolve, T0 + 1);
  assert.equal(s.get().questions.length, 0);
  assert.ok(s.get().minutes.some((m) => /A: no, sonnet/.test(m.text)), 'questions retired, the answers stay');
});

test('an answer over the cap is refused with the number instead of being cut, to the chair and to a worker', () => {
  const s = store();
  s.applyOutcome(parsed({ questions: [{ id: 'q1', text: 'CSV or JSON?' }] }), resolve, T0);
  const long = 'y'.repeat(2001);
  const out = s.set({ kind: 'question', id: 'q1', text: long }, T0);
  assert.equal(out.ok, false);
  assert.match(out.reason, /your answer is 2001 chars, the cap is 2000: say the rest in a message/);
  assert.equal(s.get().questions[0]?.answer, null);
  const frame = clipPlanFrame({ t: 'plan.set', patch: { kind: 'question', id: 'q1', text: 'y'.repeat(3000) } });
  assert.equal(frame.t === 'plan.set' && frame.patch.kind === 'question' && frame.patch.text.length, 2001);

  const w = proposed();
  const id = onlyTask(w);
  w.approve(T0);
  w.launched(id, `${id}:1`, T0);
  w.finished(id, { status: 'question', did: null, question: 'CSV or JSON?', reason: '', learned: null }, T0);
  assert.equal(w.answer(id, long, T0).ok, false);
  assert.equal(w.answer(id, 'CSV', T0).ok, true);
});

/* ───────────────────────── your changes ───────────────────────── */

test('the project order is rewritten and priority restarts from 1; unknown ids are ignored', () => {
  const s = store();
  s.applyOutcome(parsed({ projects: [
    { name: 'alpha', priority: 1, tests: [], tasks: [task()] },
    { name: 'beta', priority: 2, tests: [], tasks: [task()] },
  ] }), resolve, T0);
  assert.equal(s.set({ kind: 'order', order: ['p-beta', 'nope'] }, T0).ok, true);
  assert.deepEqual(s.get().projects.map((p) => [p.name, p.priority]), [['beta', 1], ['alpha', 2]]);
});

test('reserve and parallelism have limits, and outside them it refuses with the reason', () => {
  const s = store();
  assert.equal(s.set({ kind: 'reserve', provider: 'claude', window: '5h', percent: 95 }, T0).ok, false);
  assert.equal(s.set({ kind: 'reserve', provider: 'claude', window: '5h', percent: 40 }, T0).ok, true);
  assert.equal(s.get().reserve.claude['5h'], 40);
  assert.equal(s.get().reserve.claude['7d'], DEFAULT_RESERVE['7d']);
  assert.equal(s.set({ kind: 'parallel', parallel: 0 }, T0).ok, false);
  assert.equal(s.set({ kind: 'parallel', parallel: 5 }, T0).ok, false);
  assert.equal(s.set({ kind: 'parallel', parallel: 3 }, T0).ok, true);
});

test('the git rules of a project do not change under a running task', () => {
  const s = proposed();
  const id = onlyTask(s);
  s.approve(T0);
  s.launched(id, `${id}:1`, T0);
  const out = s.set({ kind: 'git', projectId: 'p-alpha', rules: { commit: true, push: true } }, T0);
  assert.equal(out.ok, false);
  assert.match(out.reason, /a task is running/);
});

test('the fleet and model of a task change only while it is queued', () => {
  const s = proposed();
  const id = onlyTask(s);
  assert.equal(s.set({ kind: 'task', taskId: id, model: 'opus' }, T0).ok, true);
  assert.equal(s.get().projects[0]?.tasks[0]?.model, 'opus');
  assert.equal(s.set({ kind: 'task', taskId: id, model: 'gpt-9' }, T0).ok, true);
  assert.equal(s.get().projects[0]?.tasks[0]?.model, null, 'a name off the list becomes null');
  s.approve(T0);
  s.launched(id, `${id}:1`, T0);
  const out = s.set({ kind: 'task', taskId: id, model: 'haiku' }, T0);
  assert.equal(out.ok, false);
  assert.match(out.reason, /only a queued task/);
});

test('the chair is chosen before the meeting starts, then the seat is taken', () => {
  const s = store();
  assert.equal(s.set({ kind: 'chair', chair: 'codex' }, T0).ok, true);
  s.say('hello', T0);
  const out = s.set({ kind: 'chair', chair: 'claude' }, T0);
  assert.equal(out.ok, false);
  assert.match(out.reason, /start over to change the chair/);
  s.reset(T0);
  assert.equal(s.get().chair, 'claude', 'a new meeting starts again with Claude in the chair');
});

/* ───────────────────────── the life of the plan ───────────────────────── */

test('only a proposal can be approved, and only if there is a queued task', () => {
  const s = store();
  const early = s.approve(T0);
  assert.equal(early.ok, false);
  assert.match(early.reason, /drafting/);
  proposed(s);
  assert.equal(s.approve(T0).ok, true);
  assert.equal(s.get().status, 'approved');
  assert.equal(s.approve(T0).ok, false, 'approving twice is not a change');
});

test('paused, the meeting reopens; approved, it does not', () => {
  const s = proposed();
  s.approve(T0);
  const closed = s.say('one more thing', T0);
  assert.equal(closed.ok, false);
  assert.match(closed.reason, /pause it/);
  assert.equal(s.pause(T0).ok, true);
  assert.equal(s.say('one more thing', T0).ok, true);
  assert.equal(s.resume(T0).ok, true);
  assert.equal(s.get().status, 'approved');
});

test('a task lives: queued, running with one attempt, done; and the plan ends with it', () => {
  const s = proposed();
  const id = onlyTask(s);
  s.approve(T0);
  const out = s.launched(id, `${id}:1`, T0);
  assert.equal(out.ok, true);
  let t = findTask(s.get(), id)!.task;
  assert.equal(t.status, 'running');
  assert.equal(t.attempts, 1);
  assert.equal(t.jobId, `${id}:1`);
  s.attachSession(id, 'sess-1', T0);
  s.finished(id, { status: 'done', did: 'Added the button', question: null, reason: '', learned: 42_000 }, T0 + 5);
  t = findTask(s.get(), id)!.task;
  assert.equal(t.status, 'done');
  assert.equal(t.did, 'Added the button');
  assert.equal(t.learned, 42_000);
  assert.equal(t.sessionId, 'sess-1');
  assert.equal(s.get().status, 'done');
});

test('no launch outside an approved plan, and no launch of a task that is not queued', () => {
  const s = proposed();
  const id = onlyTask(s);
  assert.equal(s.launched(id, `${id}:1`, T0).ok, false);
  s.approve(T0);
  assert.equal(s.launched(id, `${id}:1`, T0).ok, true);
  assert.equal(s.launched(id, `${id}:2`, T0).ok, false);
});

test('a question stops the task, the answer puts it back in the queue, the next launch counts one more attempt', () => {
  const s = proposed();
  const id = onlyTask(s);
  s.approve(T0);
  s.launched(id, `${id}:1`, T0);
  s.finished(id, { status: 'question', did: null, question: 'CSV or JSON?', reason: '', learned: null }, T0);
  let t = findTask(s.get(), id)!.task;
  assert.equal(t.status, 'question');
  assert.equal(t.question, 'CSV or JSON?');
  assert.equal(s.retry(id, T0).ok, false, 'a question is not retried: it is answered');
  assert.equal(s.answer(id, '   ', T0).ok, false);
  assert.equal(s.answer(id, 'CSV', T0).ok, true);
  t = findTask(s.get(), id)!.task;
  assert.equal(t.status, 'queued');
  assert.equal(t.answer, 'CSV');
  s.launched(id, `${id}:2`, T0);
  assert.equal(findTask(s.get(), id)!.task.attempts, 2);
});

test('a question with no text is a failure, not an endless wait', () => {
  const s = proposed();
  const id = onlyTask(s);
  s.approve(T0);
  s.launched(id, `${id}:1`, T0);
  s.finished(id, { status: 'question', did: null, question: '  ', reason: '', learned: null }, T0);
  const t = findTask(s.get(), id)!.task;
  assert.equal(t.status, 'failed');
  assert.match(t.reason ?? '', /without asking/);
});

test('a failure is retried or skipped, and skipping closes the plan if nothing is left', () => {
  const s = proposed();
  const id = onlyTask(s);
  s.approve(T0);
  s.launched(id, `${id}:1`, T0);
  s.finished(id, { status: 'failed', did: null, question: null, reason: 'exited with code 1', learned: null }, T0);
  assert.equal(findTask(s.get(), id)!.task.reason, 'exited with code 1');
  assert.equal(s.get().status, 'approved', 'a failure does not close the plan');
  assert.equal(s.retry(id, T0).ok, true);
  assert.equal(findTask(s.get(), id)!.task.status, 'queued');
  assert.equal(s.skip(id, T0).ok, true);
  assert.equal(findTask(s.get(), id)!.task.status, 'skipped');
  assert.equal(s.get().status, 'done');
});

const RESERVE_STOP = 'stopped at the reserve (5h at 70% reached the 30% reserve)';

/** One attempt of the task, ended by the reserve. */
function stoppedAtReserve(s: PlanStore, id: string): void {
  s.launched(id, `${id}:${findTask(s.get(), id)!.task.attempts + 1}`, T0);
  s.finished(id, { status: 'queued', did: null, question: null, reason: RESERVE_STOP, learned: 90_000, byReserve: true }, T0);
}

test('the reserve stops a task once and it waits in the queue; twice in a row and it waits for you', () => {
  // Stopped once it starts again on its own when the window has room, which
  // is what lets a plan run through the night. A second stop in a row says
  // the task does not fit in a window as it was planned: coming back at
  // every reset, it would burn up to the line each time with nobody looking.
  const s = proposed();
  const id = onlyTask(s);
  s.approve(T0);
  s.attachSession(id, 'sess-1', T0);

  stoppedAtReserve(s, id);
  let t = findTask(s.get(), id)!.task;
  assert.equal(t.status, 'queued', 'the first stop is not a failure');
  assert.equal(t.reason, RESERVE_STOP);

  stoppedAtReserve(s, id);
  t = findTask(s.get(), id)!.task;
  assert.equal(t.status, 'failed', 'the second in a row goes through the door a failure uses');
  assert.equal(t.reason, `${RESERVE_STOP}, 2 times in a row: retry resumes it`);
  assert.equal(t.sessionId, 'sess-1', 'the session stays: retry resumes it');
  assert.equal(s.get().status, 'approved', 'the plan is not paused: other projects go on');

  // Your retry is a go-ahead: the count starts over.
  assert.equal(s.retry(id, T0).ok, true);
  stoppedAtReserve(s, id);
  assert.equal(findTask(s.get(), id)!.task.status, 'queued');
});

test('"in a row" means nothing else happened in between: a pause is not counted, any other ending clears it', () => {
  const s = proposed();
  const id = onlyTask(s);
  s.approve(T0);

  // A pause you pressed between two stops neither counts nor forgives.
  stoppedAtReserve(s, id);
  s.launched(id, `${id}:2`, T0);
  s.finished(id, { status: 'queued', did: null, question: null, reason: 'stopped: the plan was paused', learned: null }, T0);
  assert.equal(findTask(s.get(), id)!.task.status, 'queued');
  stoppedAtReserve(s, id);
  assert.equal(findTask(s.get(), id)!.task.status, 'failed');

  // A question answered in between is the task moving: the next stop is a first one.
  s.retry(id, T0);
  stoppedAtReserve(s, id);
  s.launched(id, `${id}:5`, T0);
  s.finished(id, { status: 'question', did: null, question: 'CSV or JSON?', reason: '', learned: null }, T0);
  s.answer(id, 'CSV', T0);
  stoppedAtReserve(s, id);
  assert.equal(findTask(s.get(), id)!.task.status, 'queued');
});

test('the count of reserve stops survives a restart and never reaches the panel', () => {
  const dir = tmp();
  const s = proposed(store(dir));
  const id = onlyTask(s);
  s.approve(T0);
  stoppedAtReserve(s, id);
  assert.equal('reserveStops' in docOf(s.get()), false);
  s.save();

  // A restart must not hand the task two more tries.
  const again = store(dir);
  assert.equal(findTask(again.get(), id)!.task.status, 'queued');
  stoppedAtReserve(again, id);
  assert.equal(findTask(again.get(), id)!.task.status, 'failed');
});

test('reset refuses with a task running, archives the old plan and keeps your settings', () => {
  const dir = tmp();
  const s = proposed(store(dir));
  const id = onlyTask(s);
  s.set({ kind: 'parallel', parallel: 3 }, T0);
  s.approve(T0);
  s.launched(id, `${id}:1`, T0);
  const busy = s.reset(T0);
  assert.equal(busy.ok, false);
  assert.match(busy.reason, /running/);
  s.finished(id, { status: 'done', did: 'ok', question: null, reason: '', learned: null }, T0);
  const oldId = s.get().id;
  assert.equal(s.reset(T0 + 1).ok, true);
  const p = s.get();
  assert.notEqual(p.id, oldId);
  assert.equal(p.status, 'drafting');
  assert.equal(p.projects.length, 0);
  assert.equal(p.parallel, 3, 'the settings stay');
  assert.ok(fs.existsSync(path.join(dir, 'ceo', 'plans', `${oldId}.json`)), 'the old plan is archived');
});

/* ───────────────────────── persistence ───────────────────────── */

test('the plan is saved and read back; a task running at restart is failed, with its session', () => {
  const dir = tmp();
  const s = proposed(store(dir));
  const id = onlyTask(s);
  s.attach('TODO.md', '- ship it', T0);
  s.approve(T0);
  s.launched(id, `${id}:1`, T0);
  s.attachSession(id, 'sess-9', T0);
  s.save();
  assert.equal(fs.statSync(path.join(dir, 'ceo', 'plan.json')).mode & 0o777, 0o600);

  const again = store(dir);
  const p = again.get();
  assert.equal(p.id, s.get().id);
  assert.equal(p.attachments[0]?.text, '- ship it');
  const t = findTask(p, id)!.task;
  assert.equal(t.status, 'failed');
  assert.equal(t.reason, STOPPED_BY_RESTART);
  assert.equal(t.sessionId, 'sess-9', 'the session stays: a retry resumes it');
});

test('the document for the panel carries neither the session nor the text of the attachments', () => {
  const s = store();
  s.attach('TODO.md', '- ship it', T0);
  s.setSession('ceo-sess');
  const doc = docOf(s.get());
  assert.equal('session' in doc, false);
  assert.equal('withdrawn' in doc, false);
  assert.deepEqual(Object.keys(doc.attachments[0] ?? {}).sort(), ['addedAt', 'chars', 'id', 'name', 'sent']);
});

/* ───────────── test commands: the tests always run, with what the project needs ───────────── */

test('the chair\'s test commands enter the plan by project, and a later block only adds', () => {
  const s = store();
  s.applyOutcome(parsed({ projects: [{ ...parsed().projects[0]!, tests: ['php tests/*', 'php *', 'bash tests/api_smoke.sh'] }] }), resolve, T0);
  // `php *` is every PHP program: dropped, and the rest go in.
  assert.deepEqual(s.get().commands['p-alpha'], ['php tests/*', 'bash tests/api_smoke.sh']);
  // You take one back; the chair's next block lists the first two again and one more.
  s.set({ kind: 'commands', projectId: 'p-alpha', commands: ['php tests/*'] }, T0 + 1);
  s.applyOutcome(parsed({ projects: [{ ...parsed().projects[0]!, tests: ['php tests/*', 'node tests/ui/*'] }] }), resolve, T0 + 2);
  assert.deepEqual(s.get().commands['p-alpha'], ['php tests/*', 'node tests/ui/*']);
  // A block with no tests leaves the list as it is.
  s.applyOutcome(parsed(), resolve, T0 + 3);
  assert.deepEqual(s.get().commands['p-alpha'], ['php tests/*', 'node tests/ui/*']);
});

test('a command you type is refused whole, with the reason, and never half-saved', () => {
  const s = proposed();
  assert.equal(s.set({ kind: 'commands', projectId: 'p-alpha', commands: ['php tests/*'] }, T0).ok, true);
  const bad = s.set({ kind: 'commands', projectId: 'p-alpha', commands: ['php tests/*', 'git push origin main'] }, T0);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /git push origin main: git follows the commit and push boxes/);
  assert.deepEqual(s.get().commands['p-alpha'], ['php tests/*']);
  const many = Array.from({ length: 17 }, (_, i) => `make test-${i}`);
  assert.match(s.set({ kind: 'commands', projectId: 'p-alpha', commands: many }, T0).reason, /at most 16 commands/);
  assert.match(s.set({ kind: 'commands', projectId: 'p-nowhere', commands: [] }, T0).reason, /no such project/);
  // The last one taken back: the project has no entry left.
  assert.equal(s.set({ kind: 'commands', projectId: 'p-alpha', commands: [] }, T0).ok, true);
  assert.equal('p-alpha' in s.get().commands, false);
});

test('allowing a worker\'s needs adds them to its project and resumes it with an answer that says so', () => {
  // decsim2, 2026-09-19: the worker asked to add `php tests/*` and four more
  // to a settings file, the user answered "option A" -- and the resumed
  // worker met the same refusals, because words grant no permission.
  const s = proposed();
  const id = onlyTask(s);
  s.approve(T0);
  s.launched(id, `${id}:1`, T0);
  s.finished(id, {
    status: 'question', did: 'tests not run', question: 'It was refused `php tests/*`.',
    needs: ['php tests/*', 'bash tests/api_smoke.sh'], reason: '', learned: null,
  }, T0 + 1);
  let t = findTask(s.get(), id)!.task;
  assert.equal(t.status, 'question');
  assert.deepEqual(t.needs, ['php tests/*', 'bash tests/api_smoke.sh']);

  const out = s.allow(id, T0 + 2);
  assert.equal(out.ok, true);
  t = findTask(s.get(), id)!.task;
  assert.equal(t.status, 'queued');
  assert.deepEqual(t.needs, []);
  assert.match(t.answer ?? '', /I allowed these commands in this project: `php tests\/\*`, `bash tests\/api_smoke.sh`/);
  assert.deepEqual(s.get().commands['p-alpha'], ['php tests/*', 'bash tests/api_smoke.sh']);
  assert.match(s.allow(id, T0 + 3).reason, /not waiting for an answer/);
});

test('a question with no commands has nothing to allow, and an answer in words allows nothing', () => {
  const s = proposed();
  const id = onlyTask(s);
  s.approve(T0);
  s.launched(id, `${id}:1`, T0);
  s.finished(id, { status: 'question', did: null, question: 'CSV or JSON?', reason: '', learned: null }, T0);
  assert.match(s.allow(id, T0).reason, /asked for no command/);
  s.answer(id, 'CSV', T0);
  s.launched(id, `${id}:2`, T0 + 1);
  s.finished(id, { status: 'question', did: null, question: 'May I run php?', needs: ['php tests/*'], reason: '', learned: null }, T0 + 2);
  assert.equal(s.answer(id, 'yes, option A', T0 + 3).ok, true);
  assert.deepEqual(findTask(s.get(), id)!.task.needs, []);
  assert.equal('p-alpha' in s.get().commands, false, 'only the button grants a command');
});

test('a new plan keeps the commands: a permission given once is not asked for again', () => {
  const s = proposed();
  s.set({ kind: 'commands', projectId: 'p-alpha', commands: ['php tests/*'] }, T0);
  assert.equal(s.reset(T0 + 1).ok, true);
  assert.equal(s.get().projects.length, 0);
  assert.deepEqual(s.get().commands, { 'p-alpha': ['php tests/*'] });
  assert.deepEqual(docOf(s.get()).commands, { 'p-alpha': ['php tests/*'] });
});

test('a plan saved when the tests were a checkbox loads without it, and with no command asked', () => {
  const dir = tmp();
  const s = proposed(store(dir));
  s.save();
  const file = path.join(dir, 'ceo', 'plan.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.plan.projects[0].git = { tests: false, commit: true, push: true };
  delete raw.plan.projects[0].tasks[0].needs;
  delete raw.plan.commands;
  fs.writeFileSync(file, JSON.stringify(raw));
  const p = store(dir).get();
  assert.deepEqual(p.projects[0]?.git, { commit: true, push: true });
  assert.deepEqual(p.projects[0]?.tasks[0]?.needs, []);
  assert.deepEqual(p.commands, {});
});
