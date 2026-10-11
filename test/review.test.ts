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
import type { JobStart } from '../src/server/ceo/fleet.ts';
import { freshReviewTask, parseVerdict, reviewTask } from '../src/server/ceo/review.ts';
import { createCeoMemory, MAX_NOTE_CHARS } from '../src/server/ceo/memory.ts';
import { buildBrief } from '../src/server/ceo/brief.ts';
import type { BriefNote } from '../src/server/ceo/brief.ts';
import { OUTCOME_FENCE } from '../src/server/ceo/outcome.ts';
import type { Proposal } from '../src/server/ceo/proposals.ts';
import type { ProjectInfo, Snapshot } from '../src/shared/protocol.ts';

/*
 * The second opinion: whoever works on that project is asked whether the
 * advice holds up, by resuming THEIR session with a fork. The CEO sees the
 * statistics and not the reasons; whoever works there has the context, and it
 * is on disk.
 */

const NOW = Date.parse('2026-09-13T20:00:00.000Z');
const CWD = '/Users/tester/proj';
const SESSION = '157fc912-9f85-464a-8ee4-6620db840646';

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1', at: NOW, provider: 'claude', kind: 'audit',
    summary: 'too many tool calls', projectId: 'proj', projectName: 'proj',
    task: 'cut down the calls', status: 'accepted', decidedAt: NOW, sessionId: null, ...over,
  };
}

function snapshot(): Snapshot {
  return { at: NOW, limits: [], projects: [], sessions: [], agents: [], files: [], recent: [] };
}

interface Spawned { bin: string; args: string[]; cwd: string | undefined }

/**
 * The fleet with fake processes, and the guarantee that they get closed.
 *
 * `t.after` and not a manual call at the end of the test: the hard timeout is
 * a twenty-minute timer, and a live timer keeps node alive. With a manual
 * close, a test that fails BEFORE reaching it leaves the timer running and the
 * suite does not fail -- it hangs, which is much worse to diagnose.
 */
function harness(t: TestContext, over: { blocked?: string; execute?: boolean } = {}): {
  fleet: ReturnType<typeof createFleet>;
  spawned: Spawned[];
  started: JobStart[];
} {
  const spawned: Spawned[] = [];
  const started: JobStart[] = [];
  const fleet = createFleet({
    model: 'sonnet',
    ledger: {
      blockedReason: () => over.blocked ?? null,
      record: () => {}, spentUsd: () => 0, save: () => {},
    },
    execute: over.execute ?? true,
    snapshot,
    cwdOf: () => CWD,
    onStart: (j) => started.push(j),
    onProgress: () => {},
    onAdopt: () => {},
    onEnd: () => {},
    spawn: (bin, args, o) => {
      spawned.push({ bin, args: args as string[], cwd: (o as { cwd?: string })?.cwd });
      const child = new EventEmitter() as unknown as ChildProcess;
      // One stdin PER CHILD: sharing a single one makes the second `end()`
      // fail with "write after end", which is a defect of the test and not of
      // the code -- two real processes have two pipes.
      Object.assign(child, {
        pid: 4242, stdout: new PassThrough(), stderr: new PassThrough(),
        stdin: new PassThrough(), kill: () => true,
      });
      return child;
    },
  });
  t.after(() => fleet.stopAll());
  return { fleet, spawned, started };
}

/* ─────────────────────── the review command ─────────────────────── */

test('the review resumes the session with a fork, and does not enter the live one', (t) => {
  // It is the difference between asking and intruding: --fork-session creates
  // a new id, so the live session receives nothing and does not lose its turn.
  const h = harness(t);
  const out = h.fleet.review(proposal(), SESSION);
  assert.equal(out.ok, true);
  assert.equal(out.jobId, 'p1', 'the review hooks onto the job: a single turret');

  const args = h.spawned[0]!.args;
  assert.equal(h.spawned[0]!.bin, 'claude');
  assert.ok(args.includes('--resume'), 'it does not resume the session: it would not have the context');
  assert.equal(args[args.indexOf('--resume') + 1], SESSION);
  assert.ok(args.includes('--fork-session'), 'without a fork it would write into the live session');
});

test('a review touches nothing: it is a second opinion, not the job', (t) => {
  // Asking for a judgement and getting changes back would be the opposite.
  const h = harness(t);
  h.fleet.review(proposal(), SESSION);
  const args = h.spawned[0]!.args;
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
});

test('the real job does write, and that is what you asked it to do', (t) => {
  const h = harness(t);
  h.fleet.start(proposal());
  const args = h.spawned[0]!.args;
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(!args.includes('--fork-session'));
});

test('work and review are two processes of the SAME job', (t) => {
  const h = harness(t);
  h.fleet.start(proposal());
  h.fleet.review(proposal(), SESSION);
  assert.deepEqual(h.started.map((j) => [j.id, j.kind]), [['p1', 'work'], ['p1', 'review']]);
  assert.equal(h.started[1]!.reviewOf, SESSION);
});

test('the review goes through the same gates as the job', (t) => {
  // A path that starts a process with fewer guards than its twin is the path
  // that will be used to get things wrong.
  assert.match(harness(t, { execute: false }).fleet.review(proposal(), SESSION).reason, /executive mode/);
  assert.match(harness(t, { blocked: 'quota at 92%' }).fleet.review(proposal(), SESSION).reason, /92%/);
  assert.match(
    harness(t).fleet.review(proposal({ status: 'pending' }), SESSION).reason,
    /pending/,
  );
});

test('with no session to resume a fresh one is opened in the project', (t) => {
  /*
   * Before, in this case, nothing started: work on a project happens in
   * shifts, and a proposal accepted in the evening found nobody to ask. A
   * fresh session does not know WHY the work was done that way -- and its
   * prompt tells it not to make that up -- but it knows how the repository is
   * built, which is enough to check the premises of a proposal.
   */
  const h = harness(t);
  const out = h.fleet.review(proposal(), '');
  assert.equal(out.ok, true, out.ok ? '' : out.reason);

  const args = h.spawned[0]?.args ?? [];
  assert.equal(args.includes('--resume'), false, 'there was no session to resume');
  assert.equal(args.includes('--fork-session'), false);
  // Headless and touching nothing, like the other form of the review.
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('plan'), 'a check must not be able to write');
  assert.equal(h.spawned[0]?.cwd, CWD, 'it must be opened INSIDE the project, or it has nothing to read');
});

test('a fresh session is asked to verify, not to guess the why', (t) => {
  // The worst possible answer from someone who arrived five minutes ago is a
  // made-up explanation that sounds plausible: the prompt forbids it by name.
  const task = freshReviewTask(proposal());
  assert.match(task, /nobody can tell you WHY/);
  assert.match(task, /Do not guess/);
  assert.match(task, /check the premises against the repository/);
  assert.match(task, /CLAUDE\.md/);
  assert.match(task, /Change nothing/);
  assert.ok(task.includes(OUTCOME_FENCE), 'without a fence the verdict cannot be read');
});

test('the two questions are different, and the wrong one would be a lie', (t) => {
  // Whoever was there is asked for the context the CEO lacks; whoever arrives
  // now is not, because they do not have it -- and asking would invite them to
  // make it up.
  const resumed = reviewTask(proposal());
  const fresh = freshReviewTask(proposal());
  assert.match(resumed, /You have the context it does not/);
  assert.equal(fresh.includes('You have the context it does not'), false);
});

/* ─────────────────────── the question ─────────────────────── */

test('the question asks for objections, not approval', (t) => {
  // An agent of the same family is asked to judge a remark about its own
  // habits: its "these are good suggestions" is the default answer and is
  // worth nothing.
  const text = reviewTask(proposal());
  assert.match(text, /do\s+NOT apply/i);
  assert.match(text, /Agreeing is the cheap answer/);
  assert.match(text, /Change nothing/);
  assert.ok(text.includes(OUTCOME_FENCE), 'it does not ask for the block: the verdict would be unreadable');
  assert.ok(text.includes('too many tool calls'), 'it does not say what it must judge');
});

/* ─────────────────────── the verdict ─────────────────────── */

const withBlock = (obj: unknown): string =>
  `I disagree on two points.\n\n${OUTCOME_FENCE}\n${JSON.stringify(obj)}\n\`\`\`\n`;

test('the verdict is read from the fenced block', (t) => {
  const v = parseVerdict(withBlock({ verdict: 'point 1 ignores constraint X', holds: false }));
  assert.deepEqual(v, { verdict: 'point 1 ignores constraint X', holds: false });
});

test('a verdict without holds counts as "it holds"', () => {
  // Only an explicit false is an objection: a missing field is a model that
  // did not answer the question, not a model that agrees.
  assert.equal(parseVerdict(withBlock({ verdict: 'all sensible' }))?.holds, true);
});

test('an answer without a block makes nothing get noted', (t) => {
  // Better not to know than to remember a sentence invented by an optimistic parser.
  assert.equal(parseVerdict('a long answer with no fence'), null);
  assert.equal(parseVerdict(`${OUTCOME_FENCE}\nnot json\n\`\`\``), null);
  assert.equal(parseVerdict(withBlock({ holds: false })), null, 'a block without a verdict is empty');
  assert.equal(parseVerdict(withBlock({ verdict: '   ' })), null);
});

test('a very long verdict is cut: it is a line, not a paragraph', (t) => {
  const v = parseVerdict(withBlock({ verdict: 'x'.repeat(MAX_NOTE_CHARS + 300) }));
  assert.equal(v?.verdict.length, MAX_NOTE_CHARS);
});

/* ─────────────────────── the memory ─────────────────────── */

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mem-'));
const note = (text: string, over: Partial<Parameters<ReturnType<typeof createCeoMemory>['note']>[0]> = {}) =>
  ({ at: NOW, provider: 'claude' as const, kind: 'done' as const, project: 'proj', text, ...over });

test('the same note twice does not pile up', (t) => {
  // Ten rejected audits on the same project would fill the memory with ten
  // copies of the same sentence, and evict everything else: the memory would
  // turn into noise exactly in the case where it is needed most.
  const m = createCeoMemory(tmp());
  m.note(note('already done: audit'));
  m.note(note('already done: audit', { at: NOW + 1000 }));
  assert.equal(m.list('claude').length, 1);
});

test('one CEO memory does not erase the other', (t) => {
  const m = createCeoMemory(tmp());
  for (let i = 0; i < 40; i++) m.note(note(`claude ${i}`));
  m.note(note('codex knows this', { provider: 'codex' }));
  assert.equal(m.list('codex').length, 1);
  assert.ok(m.list('claude').length <= 24, 'the cap was not applied');
});

test('the oldest leaves first, the most recent is on top', (t) => {
  const m = createCeoMemory(tmp());
  for (let i = 0; i < 30; i++) m.note(note(`note ${i}`, { at: NOW + i }));
  const list = m.list('claude');
  assert.equal(list[0]!.text, 'note 29');
  assert.ok(!list.some((n) => n.text === 'note 0'), 'the oldest one remained');
});

test('the memory survives a restart: a CEO that forgets starts over', (t) => {
  const dir = tmp();
  const first = createCeoMemory(dir);
  first.note(note('you turned this down: audit'));
  first.save();
  assert.equal(createCeoMemory(dir).list('claude')[0]?.text, 'you turned this down: audit');
});

/* ─────────────────────── the memory in the brief ─────────────────────── */

function project(id: string, name: string): ProjectInfo {
  return {
    id, name, realName: name, disabled: false, slot: 0, exists: true,
    firstSeenAt: NOW, lastActiveAt: NOW, size: 120,
    lastCommit: null, branch: 'main', commits: 3, providers: ['claude'],
  };
}

const snap = (): Snapshot => ({
  at: NOW, limits: [], projects: [project('p1', 'PROJ')], sessions: [],
  agents: [], files: [], recent: [],
});

const notes: BriefNote[] = [
  { kind: 'done', project: 'PROJ', text: 'already done: audit of the tool calls' },
  { kind: 'objection', project: 'PROJ', text: 'the session objected: Bash is imposed here' },
];

test('what the CEO already knows goes into the brief, and it is told not to propose it again', (t) => {
  const text = buildBrief(snap(), { provider: 'claude', now: NOW, memory: notes });
  assert.match(text, /What you already know/);
  assert.match(text, /already done: audit of the tool calls/);
  assert.match(text, /Bash is imposed here/);
  assert.match(text, /Do not propose again/);
});

test('with nothing to remember the section is not paid for', (t) => {
  const text = buildBrief(snap(), { provider: 'claude', now: NOW });
  assert.ok(!text.includes('What you already know'));
});

test('the memory fits even in the tightest brief: it is one line per note', (t) => {
  // That is why a note is a headline and not minutes. Pasting a five-thousand
  // character outcome into a six-thousand character brief would evict everything.
  const many: BriefNote[] = Array.from({ length: 24 }, (_, i) => ({
    kind: 'done' as const, project: 'PROJ', text: `already done: thing number ${i}`,
  }));
  const text = buildBrief(snap(), { provider: 'claude', now: NOW, memory: many, budget: 2000 });
  assert.match(text, /What you already know/);
  assert.ok(text.length <= 2000, `the brief overran: ${text.length}`);
});
