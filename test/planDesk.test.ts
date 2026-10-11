import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPlanDesk } from '../src/server/ceo/planDesk.ts';
import type { PlanDeskOptions } from '../src/server/ceo/planDesk.ts';
import { OUTCOME_FENCE } from '../src/server/ceo/outcome.ts';
import type { CallEnd, ConverseOptions } from '../src/server/ceo/runner.ts';
import { assertSafe } from '../src/server/parse/redact.ts';
import type { DeltaEvent, ProjectInfo, ServerFrame, Snapshot } from '../src/shared/protocol.ts';
import type { WorkOrder } from '../src/server/ceo/fleet.ts';

/*
 * The desk, with the chair played by a fake: no test here launches a model.
 * What is pinned is the round trip -- what the chair is asked, in which
 * session, and what its block does to the plan on disk.
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

interface Call {
  provider: string;
  prompt: string;
  session: ConverseOptions['session'];
}

interface Rig {
  desk: ReturnType<typeof createPlanDesk>;
  calls: Call[];
  events: DeltaEvent[];
  replies: ServerFrame[];
  /** What the fake chair answers to the next turn. */
  script: ((call: Call) => CallEnd)[];
  reply: (f: ServerFrame) => void;
}

function block(json: object): string {
  return `Here is what I think.\n${OUTCOME_FENCE}\n${JSON.stringify(json)}\n\`\`\`\n`;
}

const PROPOSAL = block({
  ready: true, questions: [],
  projects: [{ name: 'alpha', priority: 1, git: { tests: true, commit: true, push: false }, tasks: [
    { id: null, title: 'Ship the export', briefing: 'CSV, in reports.ts, with a test.', provider: 'claude', model: 'sonnet', effort: null, size: 'medium' },
  ] }],
});

function rig(over: Partial<PlanDeskOptions> = {}): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-desk-'));
  const calls: Call[] = [];
  const events: DeltaEvent[] = [];
  const replies: ServerFrame[] = [];
  const script: Rig['script'] = [];
  let clock = T0;
  const desk = createPlanDesk({
    stateDir: dir,
    providers: ['claude', 'codex'],
    model: 'sonnet',
    codexModel: null,
    snapshot: () => SNAPSHOT,
    cwdOf: (id) => (id === 'p1' ? '/tmp/alpha' : id === 'p2' ? '/tmp/beta' : undefined),
    converse: async (provider, prompt, o): Promise<CallEnd> => {
      const call = { provider, prompt, session: o.session };
      calls.push(call);
      // The real runner announces a minted id before it spawns.
      if (o.session.fresh) o.onSession(o.session.fresh);
      const answer = (script.shift() ?? (() => ({ text: PROPOSAL, failed: null })))(call);
      // A call refused before it starts never reaches the model: no text.
      if (answer.cause !== 'refused') o.onText(answer.text);
      o.reply(answer.text, true);
      return answer;
    },
    launch: () => ({ ok: false, jobId: null, reason: 'no fleet in this test' }),
    stop: () => false,
    stopChair: () => {},
    blockedReason: () => null,
    askJob: () => {},
    weightedSince: () => 0,
    closedSessions: () => [],
    broadcast: (evs) => { for (const e of evs) { assertSafe(e); events.push(e); } },
    now: () => (clock += 1),
    ...over,
  });
  return { desk, calls, events, replies, script, reply: (f) => replies.push(f) };
}

/** The turn is fire-and-forget behind `handle`: give it a beat to finish. */
const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

test('the first turn opens the meeting with all the material and an id of our own; the block makes the proposal', async () => {
  const r = rig();
  r.desk.handle({ t: 'plan.say', text: 'alpha: ship the export first' }, r.reply);
  await settled();

  assert.equal(r.calls.length, 1);
  const call = r.calls[0]!;
  assert.equal(call.provider, 'claude');
  assert.equal(call.session.resume, null);
  assert.match(call.session.fresh ?? '', /^[0-9a-f-]{36}$/);
  assert.match(call.prompt, /# Your role/);
  assert.match(call.prompt, /alpha: ship the export first/);
  assert.match(call.prompt, /code at \/tmp\/alpha/);

  const plan = r.desk.plan();
  assert.equal(plan.session, call.session.fresh);
  assert.equal(plan.status, 'proposed');
  assert.equal(plan.projects[0]?.projectId, 'p1');
  assert.equal(plan.projects[0]?.tasks[0]?.briefing, 'CSV, in reports.ts, with a test.');
  assert.deepEqual(plan.minutes.map((m) => m.role), ['user', 'ceo']);
  assert.equal(plan.minutes[1]?.text, 'Here is what I think.', 'the prose goes into the minutes without the block');

  const stream = r.replies.find((f) => f.t === 'ceo.stream');
  assert.ok(stream && stream.t === 'ceo.stream' && stream.surface === 'plan', 'the answer travels on the plan surface');
  // The say itself is announced idle, then the turn opens (thinking) and closes (idle).
  const meeting = r.events.filter((e) => e.t === 'plan').map((e) => (e.t === 'plan' ? e.meeting : ''));
  assert.ok(meeting.includes('thinking'), 'the panel knows the chair is answering');
  assert.equal(meeting.at(-1), 'idle');
});

test('a second turn resumes the same session and sends the compact plan', async () => {
  const r = rig();
  r.desk.handle({ t: 'plan.say', text: 'alpha first' }, r.reply);
  await settled();
  const id = r.desk.plan().session;
  r.desk.handle({ t: 'plan.say', text: 'and the badge' }, r.reply);
  await settled();

  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[1]!.session.resume, id);
  assert.equal(r.calls[1]!.session.fresh, null);
  assert.match(r.calls[1]!.prompt, /# The user says\nand the badge/);
  assert.match(r.calls[1]!.prompt, /"id": "t-/);
});

test('if the session cannot be resumed, the meeting restarts from the minutes in a new session, once', async () => {
  const r = rig();
  r.desk.handle({ t: 'plan.say', text: 'alpha first' }, r.reply);
  await settled();
  const old = r.desk.plan().session;
  r.script.push(() => ({ text: '', failed: 'No conversation found with session ID: x' }));
  r.desk.handle({ t: 'plan.say', text: 'and the badge' }, r.reply);
  await settled();

  assert.equal(r.calls.length, 3);
  assert.equal(r.calls[1]!.session.resume, old);
  assert.equal(r.calls[2]!.session.resume, null);
  assert.ok(r.calls[2]!.session.fresh);
  assert.match(r.calls[2]!.prompt, /# Minutes so far/);
  assert.match(r.calls[2]!.prompt, /CSV, in reports\.ts, with a test\./, 'the briefings go back to the new chair');
  const plan = r.desk.plan();
  assert.equal(plan.session, r.calls[2]!.session.fresh);
  assert.ok(plan.minutes.some((m) => m.role === 'system' && /could not be resumed/.test(m.text)));
});

test('an attachment added after the first turn reaches the chair on the next turn, only once', async () => {
  // On the field: the chair answered "I see no attached document" -- the
  // file was attached after the first turn, and later turns carried none.
  const r = rig();
  r.desk.handle({ t: 'plan.say', text: 'My Dashboard Todo' }, r.reply);
  await settled();
  r.desk.handle({ t: 'plan.attach', name: 'global_todo.txt', text: '1. the ship interior' }, r.reply);
  const before = r.replies.filter((f) => f.t === 'plan.doc').at(-1);
  assert.ok(before && before.t === 'plan.doc' && before.plan.attachments[0]?.sent === false, 'the panel says it will go with the next message');

  r.desk.handle({ t: 'plan.say', text: 'use the attached file' }, r.reply);
  await settled();
  assert.equal(r.calls[1]!.session.resume, r.desk.plan().session);
  assert.match(r.calls[1]!.prompt, /--- global_todo\.txt \(20 chars\) ---\n1\. the ship interior\n--- end ---/);
  assert.equal(r.desk.plan().attachments[0]?.sent, true);

  r.desk.handle({ t: 'plan.say', text: 'and the badge' }, r.reply);
  await settled();
  assert.ok(!r.calls[2]!.prompt.includes('the ship interior'), 'the resumed session already has it: it is not paid for again');
});

test('a turn stopped by the brake stays in the minutes, and the chair answers with what it has read', async () => {
  // On the field: twelve to-dos over three projects, 72 tool calls in seven
  // minutes, stopped at the cap with nothing written -- "No answer." twice.
  const r = rig();
  const brake = 'this call passed 2.06 USD, over the 2.00 per-call cap';
  r.desk.handle({ t: 'plan.attach', name: 'global_todo.txt', text: '1. the ship interior' }, r.reply);
  r.script.push(() => ({ text: '', failed: brake, cause: 'stopped' }));
  r.desk.handle({ t: 'plan.say', text: 'My Dashboard Todo' }, r.reply);
  await settled();
  const id = r.desk.plan().session;
  assert.ok(id);
  assert.equal(r.calls.length, 2, 'one more call, not a meeting from scratch');
  const wrap = r.calls[1]!;
  assert.equal(wrap.session.resume, id, 'the same session: what it read is there, and in cache');
  assert.equal(wrap.session.fresh, null);
  assert.match(wrap.prompt, /stopped before you answered: this call passed 2\.06 USD/);
  assert.match(wrap.prompt, /Do not open, search or\nlist any more files/);
  assert.ok(!wrap.prompt.includes('the ship interior'), 'the wrap-up does not send the material again');

  const plan = r.desk.plan();
  assert.equal(plan.attachments[0]?.sent, true, 'the turn did start: the file is in the session');
  assert.deepEqual(plan.minutes.map((m) => m.role), ['user', 'system', 'ceo']);
  assert.equal(plan.minutes[1]?.text, `the chair's turn was stopped: ${brake}`);
  assert.equal(plan.status, 'proposed', 'the wrap-up answer carries its block');

  // The panel hears ONE end for the whole turn, after the wrap-up.
  const ends = r.replies.filter((f) => f.t === 'ceo.stream' && f.done);
  assert.equal(ends.length, 1);
  const last = r.replies.filter((f) => f.t === 'ceo.stream').at(-1);
  assert.ok(last && last.t === 'ceo.stream' && last.done);
});

test('there is only one wrap-up after the brake: if it is stopped too, the meeting keeps the session and says so', async () => {
  const r = rig();
  r.desk.handle({ t: 'plan.say', text: 'alpha first' }, r.reply);
  await settled();
  const id = r.desk.plan().session;
  const brake = 'this call passed 2.06 USD, over the 2.00 per-call cap';
  r.script.push(() => ({ text: '', failed: brake, cause: 'stopped' }));
  r.script.push(() => ({ text: '', failed: brake, cause: 'stopped' }));
  r.desk.handle({ t: 'plan.say', text: 'go on' }, r.reply);
  await settled();
  assert.equal(r.calls.length, 3, 'the turn and one wrap-up, then that is it');
  assert.equal(r.calls[1]!.session.resume, id);
  assert.equal(r.calls[2]!.session.resume, id);
  assert.equal(r.desk.plan().session, id);
  const notes = r.desk.plan().minutes.filter((m) => m.role === 'system').map((m) => m.text);
  assert.equal(notes.length, 2);
  assert.ok(!notes.some((t) => /could not be resumed/.test(t)), 'a stopped turn is not a lost session');
});

test('a turn that does not start neither uses up the attachments nor throws away the session', async () => {
  const r = rig();
  r.desk.handle({ t: 'plan.say', text: 'alpha first' }, r.reply);
  await settled();
  const id = r.desk.plan().session;
  r.desk.handle({ t: 'plan.attach', name: 'TODO.md', text: '- export' }, r.reply);
  r.script.push(() => ({ text: '', failed: 'the 5h window is at 97%', cause: 'refused' }));
  r.desk.handle({ t: 'plan.say', text: 'use the file' }, r.reply);
  await settled();
  assert.equal(r.calls.length, 2);
  assert.equal(r.desk.plan().session, id);
  assert.equal(r.desk.plan().attachments[0]?.sent, false, 'the next turn still carries it');
  assert.ok(r.desk.plan().minutes.some((m) => m.role === 'system' && /did not start: the 5h window is at 97%/.test(m.text)));
});

test('while the chair is answering, a second turn is refused with the reason', async () => {
  const r = rig();
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  r.script.push(() => ({ text: PROPOSAL, failed: null }));
  const slow = rig({
    converse: async (_p, _prompt, o) => {
      await gate;
      o.onText(PROPOSAL);
      o.reply(PROPOSAL, true);
      return { text: PROPOSAL, failed: null };
    },
  });
  slow.desk.handle({ t: 'plan.say', text: 'alpha first' }, slow.reply);
  await settled();
  slow.desk.handle({ t: 'plan.say', text: 'too soon' }, slow.reply);
  const refused = slow.replies.filter((f) => f.t === 'plan.doc').at(-1);
  assert.ok(refused && refused.t === 'plan.doc');
  assert.match(refused.refused ?? '', /still answering/);
  release();
  await settled();
  assert.equal(slow.desk.plan().status, 'proposed');
});

test('starting over while the chair is answering stops it, and what the turn brings back does not enter the new plan', async () => {
  // On the field: reset answered "the chair is still answering", and the
  // only way out was to wait for an answer to a meeting being thrown away.
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  const stops: string[] = [];
  let calls = 0;
  const r = rig({
    stopChair: (provider, reason) => { stops.push(`${provider}: ${reason}`); release(); },
    converse: async (_p, _prompt, o) => {
      calls += 1;
      if (o.session.fresh) o.onSession(o.session.fresh);
      o.reply('Reading the code', false);
      await gate;
      // What a killed call hands back: some prose, and the reason we stopped it.
      o.onText(PROPOSAL);
      o.reply('', true);
      return { text: PROPOSAL, failed: 'the meeting was started over', cause: 'stopped' };
    },
  });
  r.desk.handle({ t: 'plan.attach', name: 'global_todo.txt', text: '1. the ship interior' }, r.reply);
  r.desk.handle({ t: 'plan.say', text: 'My Dashboard Todo' }, r.reply);
  await settled();
  const old = r.desk.plan().id;

  r.desk.handle({ t: 'plan.reset' }, r.reply);
  const after = r.replies.length;
  const answer = r.replies.at(-1);
  assert.ok(answer && answer.t === 'plan.doc' && answer.refused === null, 'the reset goes through even while the chair is answering');
  assert.deepEqual(stops, ['claude: the meeting was started over']);
  await settled();
  assert.equal(calls, 1, 'stopped by you, it is not wrapped up');

  const plan = r.desk.plan();
  assert.notEqual(plan.id, old);
  assert.equal(plan.session, null);
  assert.deepEqual(plan.minutes, [], 'the prose of the stopped turn does not end up in the new plan');
  assert.deepEqual(plan.projects, []);
  assert.deepEqual(plan.attachments, []);
  assert.equal(plan.todo, '');
  assert.ok(!r.replies.slice(after).some((f) => f.t === 'ceo.stream'), 'the panel does not receive the tail of a discarded answer');
  const last = r.events.filter((e) => e.t === 'plan').at(-1);
  assert.ok(last && last.t === 'plan' && last.meeting === 'idle');
});

test('starting over with nobody answering stops nothing', () => {
  const stops: string[] = [];
  const r = rig({ stopChair: (p) => { stops.push(p); } });
  r.desk.handle({ t: 'plan.reset' }, r.reply);
  assert.deepEqual(stops, []);
});

test('answering and approving without a message is refused; the next turn carries the answer and unblocks', async () => {
  const r = rig();
  const asking = block({
    ready: false, questions: [{ id: 'q1', text: 'CSV or JSON?' }],
    projects: [{ name: 'alpha', priority: 1, git: { tests: true, commit: true, push: false }, tasks: [
      { id: null, title: 'Ship the export', briefing: 'Format to be decided.', provider: 'claude', model: 'sonnet', effort: null, size: 'medium' },
    ] }],
  });
  r.script.push(() => ({ text: asking, failed: null }));
  r.desk.handle({ t: 'plan.say', text: 'alpha: export' }, r.reply);
  await settled();
  r.desk.handle({ t: 'plan.set', patch: { kind: 'question', id: 'q1', text: 'CSV' } }, r.reply);
  const doc = r.replies.filter((f) => f.t === 'plan.doc').at(-1);
  assert.ok(doc && doc.t === 'plan.doc' && doc.plan.questions[0]?.seen === false, 'the panel knows it is unread');

  r.desk.handle({ t: 'plan.approve' }, r.reply);
  const refused = r.replies.filter((f) => f.t === 'plan.doc').at(-1);
  assert.ok(refused && refused.t === 'plan.doc');
  assert.match(refused.refused ?? '', /1 answer the chair has not read yet/);
  assert.equal(r.desk.plan().status, 'proposed');
  assert.equal(r.calls.length, 1, 'answering calls no model');

  r.script.push(() => ({ text: asking, failed: null }));
  r.desk.handle({ t: 'plan.say', text: 'answered' }, r.reply);
  await settled();
  assert.match(r.calls[1]!.prompt, /Q \(q1\): CSV or JSON\?\nA: CSV/);
  assert.equal(r.desk.plan().questions[0]?.seen, true);
  r.desk.handle({ t: 'plan.approve' }, r.reply);
  assert.equal(r.desk.plan().status, 'approved');
});

test('a project without git: the document says so, commit and push are refused, the worker does not receive them', async () => {
  const launched: WorkOrder[] = [];
  const noGit: Snapshot = { ...SNAPSHOT, projects: [{ ...project('p1', 'alpha'), branch: null }, project('p2', 'beta')] };
  const r = rig({
    snapshot: () => noGit,
    launch: (order) => { launched.push(order); return { ok: true, jobId: order.id, reason: null }; },
  });
  r.desk.handle({ t: 'plan.say', text: 'alpha: export' }, r.reply);
  await settled();
  r.desk.handle({ t: 'plan.read' }, r.reply);
  const read = r.replies.at(-1);
  assert.ok(read && read.t === 'plan.doc');
  assert.deepEqual(read.plan.branches, { p1: null });

  r.desk.handle({ t: 'plan.set', patch: { kind: 'git', projectId: 'p1', rules: { tests: true, commit: true, push: true } } }, r.reply);
  const refused = r.replies.at(-1);
  assert.ok(refused && refused.t === 'plan.doc');
  assert.match(refused.refused ?? '', /no git versioning for this project/);

  r.desk.handle({ t: 'plan.approve' }, r.reply);
  assert.equal(launched.length, 1);
  assert.deepEqual(launched[0]!.allowed, { commit: false, push: false });
  assert.match(launched[0]!.task, /This directory is not under git/);
});

test('answering and pressing send with the box empty sends the answers to the chair, and unblocks approval', async () => {
  // On the field: all three questions answered, send pressed, and nothing
  // happened -- the box was empty, and an empty box sent nothing.
  const r = rig();
  const asking = block({
    ready: false, questions: [{ id: 'q1', text: 'CSV or JSON?' }],
    projects: [{ name: 'alpha', priority: 1, git: { tests: true, commit: true, push: false }, tasks: [
      { id: null, title: 'Ship the export', briefing: 'Format to be decided.', provider: 'claude', model: 'sonnet', effort: null, size: 'medium' },
    ] }],
  });
  r.script.push(() => ({ text: asking, failed: null }));
  r.desk.handle({ t: 'plan.say', text: 'alpha: export' }, r.reply);
  await settled();
  r.desk.handle({ t: 'plan.set', patch: { kind: 'question', id: 'q1', text: 'CSV' } }, r.reply);
  r.script.push(() => ({ text: asking, failed: null }));
  r.desk.handle({ t: 'plan.say', text: '' }, r.reply);
  await settled();
  assert.equal(r.calls.length, 2);
  assert.match(r.calls[1]!.prompt, /no message this turn: the user answered your questions/);
  assert.match(r.calls[1]!.prompt, /A: CSV/);
  assert.equal(r.desk.plan().questions[0]?.seen, true);
  r.desk.handle({ t: 'plan.approve' }, r.reply);
  assert.equal(r.desk.plan().status, 'approved');
});

test('the document counts your active sessions in the plan\'s projects, by the scheduler\'s rule', async () => {
  let clock = T0;
  const session = (over: object): Snapshot['sessions'][number] => ({
    projectId: 'p1', provider: 'claude', spawnedByCeo: null, status: 'idle', lastActivityAt: T0, ...over,
  }) as unknown as Snapshot['sessions'][number];
  const busy: Snapshot = {
    ...SNAPSHOT,
    sessions: [
      session({ status: 'busy' }),
      session({ lastActivityAt: T0 - 10 * 60_000 }),
      session({ spawnedByCeo: 'claude', status: 'busy' }),
    ],
  };
  const r = rig({ snapshot: () => busy, now: () => (clock += 1) });
  r.desk.handle({ t: 'plan.say', text: 'alpha: export' }, r.reply);
  await settled();
  r.desk.handle({ t: 'plan.read' }, r.reply);
  const read = r.replies.at(-1);
  assert.ok(read && read.t === 'plan.doc');
  assert.deepEqual(read.plan.active, { p1: 1 }, 'one at work counts; one quiet for 10 minutes and the CEO\'s own do not');
});

test('a block of questions only stays a draft, and the questions reach the document', async () => {
  const r = rig();
  r.script.push(() => ({ text: block({ ready: false, questions: [{ id: 'q1', text: 'CSV or JSON?' }], projects: [] }), failed: null }));
  r.desk.handle({ t: 'plan.say', text: 'alpha: export' }, r.reply);
  await settled();
  const plan = r.desk.plan();
  assert.equal(plan.status, 'drafting');
  assert.equal(plan.questions[0]?.text, 'CSV or JSON?');
  const last = r.events.filter((e) => e.t === 'plan').at(-1);
  assert.ok(last && last.t === 'plan' && last.questions === 1);
});

test('an answer without a block does not change the plan and says so in the minutes', async () => {
  const r = rig();
  r.script.push(() => ({ text: 'Let me think about it.', failed: null }));
  r.desk.handle({ t: 'plan.say', text: 'alpha: export' }, r.reply);
  await settled();
  const plan = r.desk.plan();
  assert.equal(plan.projects.length, 0);
  assert.ok(plan.minutes.some((m) => m.role === 'system' && /without a plan block/.test(m.text)));
});

test('a name the chair misspells does not become a project', async () => {
  const r = rig();
  r.script.push(() => ({ text: block({ ready: true, questions: [], projects: [
    { name: 'Alpha', priority: 1, git: {}, tasks: [{ id: null, title: 'x', briefing: 'y', provider: 'claude', model: null, effort: null, size: 'small' }] },
  ] }), failed: null }));
  r.desk.handle({ t: 'plan.say', text: 'go' }, r.reply);
  await settled();
  const plan = r.desk.plan();
  assert.equal(plan.projects.length, 0);
  assert.ok(plan.minutes.some((m) => m.role === 'system' && /not here.*: Alpha/.test(m.text)));
});

test('a name two projects share does not become either of them', async () => {
  // Two folders called alpha: the task -- push ticked by default -- went to
  // whichever the world listed first. Now neither, and the minutes say why.
  const r = rig({ snapshot: () => ({ ...SNAPSHOT, projects: [project('p1', 'alpha'), project('p3', 'alpha')] }) });
  r.script.push(() => ({ text: block({ ready: true, questions: [], projects: [
    { name: 'alpha', priority: 1, git: {}, tasks: [{ id: null, title: 'x', briefing: 'y', provider: 'claude', model: null, effort: null, size: 'small' }] },
  ] }), failed: null }));
  r.desk.handle({ t: 'plan.say', text: 'go' }, r.reply);
  await settled();
  const plan = r.desk.plan();
  assert.equal(plan.projects.length, 0);
  assert.ok(plan.minutes.some((m) => m.role === 'system' && /two projects share/.test(m.text)));
});
