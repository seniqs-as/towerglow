import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { CeoRunner, consumeLine } from '../src/server/ceo/runner.ts';
import type { CeoResult } from '../src/server/ceo/runner.ts';
import { MEETING_SYSTEM } from '../src/server/ceo/planning.ts';
import { createSpendLedger } from '../src/server/ceo/spend.ts';
import type { SpendCaps } from '../src/server/ceo/spend.ts';
import type { ProviderId, Snapshot } from '../src/shared/protocol.ts';

/*
 * The meeting's process: a conversation that is resumed turn after turn.
 *
 * Same fake child as the analyst's tests, plus a spawn that records what it
 * was asked to start: the whole point here is the command line.
 */

const CAPS: SpendCaps = { quotaMaxPercent: 85, budgetUsd: 2, maxCallUsd: 0.5 };
const FRESH = '0f0f0f0f-1111-4222-8333-444444444444';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-converse-'));
}

interface Fake {
  child: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
}

function fakeChild(): Fake {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    pid: 4243, stdout, stderr, stdin: new PassThrough(),
    kill: () => { setImmediate(() => child.emit('close', null, 'SIGTERM')); return true; },
  });
  return { child, stdout, stderr };
}

const SNAPSHOT: Snapshot = {
  at: 0, limits: [], projects: [], sessions: [], agents: [], files: [], recent: [],
};

interface Rig {
  runner: CeoRunner;
  spawned: { bin: string; args: string[] }[];
  fakes: Fake[];
  results: CeoResult[];
}

function rig(provider: ProviderId = 'claude'): Rig {
  const dir = tmp();
  const spawned: Rig['spawned'] = [];
  const fakes: Fake[] = [];
  const results: CeoResult[] = [];
  const runner = new CeoRunner({
    provider,
    model: 'sonnet',
    codexModel: null,
    stateDir: dir,
    ledger: createSpendLedger(dir, CAPS),
    snapshot: () => SNAPSHOT,
    perimeter: () => [{ name: 'alpha', root: '/tmp/alpha' }],
    history: (days) => ({ days, byProject: [] }),
    memory: () => [],
    weightedSince: () => 0,
    onState: () => {},
    onResult: (r) => results.push(r),
    spawn: ((bin: string, args: string[]) => {
      const f = fakeChild();
      fakes.push(f);
      spawned.push({ bin, args });
      return f.child;
    }) as never,
    silenceMs: 1000,
    ceilingMs: 60_000,
  });
  return { runner, spawned, fakes, results };
}

const text = (t: string): string =>
  JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: t }], usage: { input_tokens: 5, output_tokens: 5 } } });
const done = (sessionId: string): string =>
  JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.01, session_id: sessionId, usage: { input_tokens: 5, output_tokens: 5 } });

/** Feeds the child the lines, then closes it, once the runner has spawned it. */
async function answer(r: Rig, lines: string[], code = 0, err = ''): Promise<void> {
  for (let i = 0; i < 50 && r.fakes.length === 0; i++) await new Promise((res) => setTimeout(res, 2));
  const f = r.fakes.at(-1)!;
  for (const l of lines) f.stdout.write(`${l}\n`);
  if (err) f.stderr.write(err);
  await new Promise((res) => setTimeout(res, 5));
  f.child.emit('close', code, null);
}

test('the first turn opens a session with an id we mint, and announces it before it even starts', async () => {
  const r = rig();
  const ids: string[] = [];
  let full = '';
  const turn = r.runner.converse('hello', {
    model: 'sonnet', effort: null, session: { resume: null, fresh: FRESH }, system: MEETING_SYSTEM,
    onSession: (id) => ids.push(id), onText: (t) => { full = t; },
  });
  assert.deepEqual(ids, [FRESH], 'the id is known before the spawn: there is nothing to read');
  await answer(r, [JSON.stringify({ type: 'system', subtype: 'init', session_id: FRESH }), text('ok'), done(FRESH)]);
  const end = await turn;

  const { bin, args } = r.spawned[0]!;
  assert.equal(bin, 'claude');
  assert.equal(args[args.indexOf('--session-id') + 1], FRESH);
  assert.equal(args[args.indexOf('--system-prompt') + 1], MEETING_SYSTEM);
  assert.ok(!args.includes('--resume'));
  assert.ok(args.includes('--add-dir'), 'the perimeter is there: the chair reads the code');
  assert.deepEqual(ids, [FRESH], 'the id the CLI echoes back is not announced again');
  assert.equal(full, 'ok');
  assert.equal(end.failed, null);
  assert.equal(r.results.length, 0, 'a meeting does not post reports');
});

test('a later turn resumes the session, and does not mint a new one', async () => {
  const r = rig();
  const turn = r.runner.converse('more', {
    model: 'sonnet', effort: null, session: { resume: FRESH, fresh: null }, system: MEETING_SYSTEM,
    onSession: () => {}, onText: () => {},
  });
  await answer(r, [text('ok'), done(FRESH)]);
  await turn;
  const { args } = r.spawned[0]!;
  assert.equal(args[args.indexOf('--resume') + 1], FRESH);
  assert.ok(!args.includes('--session-id'));
});

test('the analyst carries neither --resume nor --session-id, and keeps its own system prompt', async () => {
  const r = rig();
  const asked = r.runner.ask('q', null, 'fast');
  await answer(r, [text('answer'), done('x')]);
  await asked;
  const { args } = r.spawned[0]!;
  assert.ok(!args.includes('--resume'));
  assert.ok(!args.includes('--session-id'));
  assert.notEqual(args[args.indexOf('--system-prompt') + 1], MEETING_SYSTEM);
  assert.equal(r.results.length, 1, 'the analyst, yes, posts its report');
});

test('with Codex the thread is read from the thread.started line, and resume has neither -s nor -C', async () => {
  const r = rig('codex');
  const ids: string[] = [];
  const first = r.runner.converse('hello', {
    model: null, effort: 'medium', session: { resume: null, fresh: null }, system: MEETING_SYSTEM,
    onSession: (id) => ids.push(id), onText: () => {},
  });
  await answer(r, [
    JSON.stringify({ type: 'thread.started', thread_id: 'thr-1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
  ]);
  await first;
  assert.deepEqual(ids, ['thr-1']);
  const opening = r.spawned[0]!.args;
  assert.deepEqual(opening.slice(0, 2), ['exec', '--json']);
  assert.ok(opening.includes('-s') && opening.includes('-C'));
  assert.ok(!opening.includes('-m'), 'with no declared model Codex uses its own');

  const second = r.runner.converse('more', {
    model: null, effort: 'medium', session: { resume: 'thr-1', fresh: null }, system: MEETING_SYSTEM,
    onSession: (id) => ids.push(id), onText: () => {},
  });
  await answer(r, [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })]);
  await second;
  const resume = r.spawned[1]!.args;
  assert.deepEqual(resume.slice(0, 4), ['exec', 'resume', 'thr-1', '--json']);
  assert.ok(!resume.includes('-s') && !resume.includes('-C'), 'resume does not accept them');
  assert.ok(resume.includes('sandbox_mode="read-only"'), 'the sandbox goes through the config');
  assert.equal(resume.at(-1), '-', 'the prompt arrives on stdin');
});

test('a session that cannot be resumed is a failure stated out loud, not a silence', async () => {
  const r = rig();
  const turn = r.runner.converse('more', {
    model: 'sonnet', effort: null, session: { resume: 'gone', fresh: null }, system: MEETING_SYSTEM,
    onSession: () => {}, onText: () => {},
  });
  await answer(r, [], 1, 'No conversation found with session ID: gone\n');
  const end = await turn;
  assert.match(end.failed ?? '', /No conversation found/);
  assert.equal(end.text, '');
});

test('consumeLine reads the session id from init, from result and from thread.started', () => {
  assert.equal(consumeLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'a' })).sessionId, 'a');
  assert.equal(consumeLine(done('b')).sessionId, 'b');
  assert.equal(consumeLine(JSON.stringify({ type: 'thread.started', thread_id: 'c' })).sessionId, 'c');
  assert.equal(consumeLine(text('no id')).sessionId, null);
});

test('a turn you stop ends as stopped, not as an error, and the plate goes back to idle', async () => {
  // On the field: starting the meeting over killed the chair with a bare
  // SIGTERM, and the plate read "error: claude exited" for a call nobody
  // had broken.
  const dir = tmp();
  const states: string[] = [];
  const fakes: Fake[] = [];
  const runner = new CeoRunner({
    provider: 'claude', model: 'sonnet', codexModel: null, stateDir: dir,
    ledger: createSpendLedger(dir, CAPS), snapshot: () => SNAPSHOT,
    perimeter: () => [], history: (days) => ({ days, byProject: [] }), memory: () => [],
    weightedSince: () => 0, onState: (s) => states.push(s.state), onResult: () => {},
    spawn: (() => { const f = fakeChild(); fakes.push(f); return f.child; }) as never,
    silenceMs: 1000, ceilingMs: 60_000,
  });
  const turn = runner.converse('hello', {
    model: 'sonnet', effort: null, session: { resume: null, fresh: FRESH }, system: MEETING_SYSTEM,
    onSession: () => {}, onText: () => {},
  });
  for (let i = 0; i < 50 && fakes.length === 0; i++) await new Promise((res) => setTimeout(res, 2));
  runner.stop('the meeting was started over');
  const end = await turn;
  assert.equal(end.failed, 'the meeting was started over');
  assert.equal(end.cause, 'stopped');
  assert.ok(!states.includes('error'), `no error on screen: ${states.join(' > ')}`);
  assert.equal(states.at(-1), 'idle');
});
