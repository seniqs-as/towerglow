import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkScanner } from '../src/server/sources/workScan.ts';
import type { WorkSource } from '../src/server/sources/workScan.ts';
import { slugFor } from '../src/server/paths.ts';
import type { PathPolicy } from '../src/server/paths.ts';
import { OPERATOR_CAP_MS } from '../src/shared/protocol.ts';

/**
 * A session's hours read from its whole transcript (the user's request,
 * 2026-10-24). The records below have the shape of the real ones on disk.
 */

const CWD = '/Users/tester/proj';
const S1 = '8f44d010-1111-4222-8333-444455556666';
const C1 = '01a16aa1-3550-7f23-8c04-3320c4538974';
const T0 = Date.parse('2026-10-20T09:00:00.000Z');
const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

interface Fixture {
  policy: PathPolicy;
  claude(lines: string[], append?: boolean): string;
  codex(lines: string[]): string;
}

function fixture(): Fixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-work-'));
  const claudeDir = path.join(home, '.claude');
  const codexDir = path.join(home, '.codex');
  const dir = path.join(claudeDir, 'projects', slugFor(CWD));
  fs.mkdirSync(dir, { recursive: true });
  return {
    policy: { claudeDir, codexDir, homeDir: home },
    claude(lines, append = false) {
      const file = path.join(dir, `${S1}.jsonl`);
      const text = lines.map((l) => `${l}\n`).join('');
      if (append) fs.appendFileSync(file, text);
      else fs.writeFileSync(file, text);
      return file;
    },
    codex(lines) {
      const day = path.join(codexDir, 'sessions', '2026', '10', '20');
      fs.mkdirSync(day, { recursive: true });
      const file = path.join(day, `rollout-2026-10-20T09-00-00-${C1}.jsonl`);
      fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
      return file;
    },
  };
}

const claudeSrc: WorkSource = { provider: 'claude', sessionId: S1, cwd: CWD, startedAt: T0 };
const codexSrc: WorkSource = { provider: 'codex', sessionId: C1, cwd: CWD, startedAt: T0 };

function prompt(at: number, entrypoint = 'cli'): string {
  return JSON.stringify({
    parentUuid: null, isSidechain: false, promptId: `p${at}`, type: 'user',
    message: { role: 'user', content: 'do the thing' }, uuid: `u${at}`, timestamp: iso(at),
    origin: { kind: 'human' }, promptSource: 'typed', entrypoint, cwd: CWD, sessionId: S1,
  });
}

function reply(at: number): string {
  return JSON.stringify({
    type: 'assistant', uuid: `a${at}`, timestamp: iso(at), sessionId: S1, entrypoint: 'cli',
    message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1 } },
  });
}

function turnEnd(at: number, durationMs: number): string {
  return JSON.stringify({
    type: 'system', subtype: 'turn_duration', durationMs, messageCount: 3,
    timestamp: iso(at), sessionId: S1, isSidechain: false,
  });
}

function codexMeta(source: unknown): string {
  return JSON.stringify({
    timestamp: iso(T0), type: 'session_meta',
    payload: { session_id: C1, cwd: CWD, cli_version: '0.200.0', originator: 'Codex Desktop', source },
  });
}

function codexEvent(at: number, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload });
}

const session = (): string[] => [
  prompt(T0),
  reply(T0 + 2 * MIN),
  turnEnd(T0 + 3 * MIN, 3 * MIN),
  prompt(T0 + 5 * MIN),
  reply(T0 + 6 * MIN),
  turnEnd(T0 + 7 * MIN, 2 * MIN),
];

test('an interactive session gives the turns\' own durations and the gaps you filled', async () => {
  const f = fixture();
  f.claude(session());
  const work = await new WorkScanner({ policy: f.policy }).finish(claudeSrc);
  assert.deepEqual(work, { aiMs: 5 * MIN, operator: [T0 + 3 * MIN, T0 + 5 * MIN] });
});

test('a worker\'s session has the AI\'s hours and none of yours', async () => {
  const f = fixture();
  f.claude([
    prompt(T0, 'sdk-cli'), reply(T0 + 10 * MIN), reply(T0 + 20 * MIN),
    prompt(T0 + 40 * MIN, 'sdk-cli'), reply(T0 + 45 * MIN),
  ]);
  const work = await new WorkScanner({ policy: f.policy }).finish(claudeSrc);
  assert.deepEqual(work, { aiMs: 25 * MIN, operator: [] });
});

test('an open session read twice counts what it added once, like a full read', async () => {
  // The card reads open sessions every time it opens: only the new bytes.
  const f = fixture();
  const lines = session();
  f.claude(lines.slice(0, 3));
  const scanner = new WorkScanner({ policy: f.policy });
  const first = await scanner.measure(claudeSrc);
  assert.equal(first?.aiMs, 3 * MIN);
  f.claude(lines.slice(3), true);
  const second = await scanner.measure(claudeSrc);
  f.claude(lines);
  const whole = await new WorkScanner({ policy: f.policy }).finish(claudeSrc);
  assert.deepEqual(second, whole);
});

test('a turn still running counts up to now on the card, without being closed', async () => {
  const f = fixture();
  f.claude([prompt(T0), reply(T0 + 4 * MIN)]);
  const scanner = new WorkScanner({ policy: f.policy });
  assert.equal((await scanner.measure(claudeSrc))?.aiMs, 4 * MIN);
  f.claude([reply(T0 + 9 * MIN), turnEnd(T0 + 10 * MIN, 10 * MIN)], true);
  assert.equal((await scanner.measure(claudeSrc))?.aiMs, 10 * MIN);
});

test('any chunk size reads the same, even with a character cut in two', async () => {
  const f = fixture();
  const lines = session();
  lines.splice(1, 0, JSON.stringify({
    type: 'user', sessionId: S1, timestamp: iso(T0 + MIN),
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'città ✓ 東京' }] },
  }));
  f.claude(lines);
  const big = await new WorkScanner({ policy: f.policy }).finish(claudeSrc);
  const small = await new WorkScanner({ policy: f.policy, chunkBytes: 7 }).finish(claudeSrc);
  assert.deepEqual(small, big);
});

test('a record with no instant adds no hour of work that never happened', async () => {
  // The parser stands in "now" for a missing timestamp: read from a file of
  // last week, that is a week-long turn.
  const f = fixture();
  f.claude([prompt(T0), JSON.stringify({
    type: 'assistant', uuid: 'x', sessionId: S1,
    message: { model: 'm', content: [{ type: 'text', text: 'no time' }] },
  }), reply(T0 + MIN)]);
  const work = await new WorkScanner({ policy: f.policy }).finish(claudeSrc);
  assert.equal(work?.aiMs, MIN);
});

test('a line too long to parse is skipped, and the ones after it still count', async () => {
  const f = fixture();
  const huge = JSON.stringify({
    type: 'user', sessionId: S1, timestamp: iso(T0 + MIN),
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(5 << 20) }] },
  });
  f.claude([prompt(T0), huge, reply(T0 + 2 * MIN), turnEnd(T0 + 3 * MIN, 3 * MIN), prompt(T0 + 4 * MIN)]);
  const work = await new WorkScanner({ policy: f.policy }).finish(claudeSrc);
  assert.deepEqual(work, { aiMs: 3 * MIN, operator: [T0 + 3 * MIN, T0 + 4 * MIN] });
});

test('a session whose transcript is gone has no hours, not zero hours', async () => {
  const f = fixture();
  assert.equal(await new WorkScanner({ policy: f.policy }).finish(claudeSrc), null);
});

test('a Codex chat gives its turns\' durations and the gaps between them', async () => {
  const f = fixture();
  f.codex([
    codexMeta('vscode'),
    codexEvent(T0, { type: 'task_started', turn_id: 't1' }),
    codexEvent(T0 + 4 * MIN, { type: 'task_complete', turn_id: 't1', duration_ms: 4 * MIN }),
    codexEvent(T0 + 20 * MIN, { type: 'task_started', turn_id: 't2' }),
    codexEvent(T0 + 21 * MIN, { type: 'turn_aborted', turn_id: 't2' }),
  ]);
  const work = await new WorkScanner({ policy: f.policy }).finish(codexSrc);
  assert.deepEqual(work, {
    aiMs: 5 * MIN,
    operator: [T0 + 20 * MIN - OPERATOR_CAP_MS, T0 + 20 * MIN],
  });
});

test('a codex exec session is a script: the AI\'s hours, none of yours', async () => {
  const f = fixture();
  f.codex([
    codexMeta('exec'),
    codexEvent(T0, { type: 'task_started', turn_id: 't1' }),
    codexEvent(T0 + 4 * MIN, { type: 'task_complete', turn_id: 't1', duration_ms: 4 * MIN }),
    codexEvent(T0 + 6 * MIN, { type: 'task_started', turn_id: 't2' }),
    codexEvent(T0 + 7 * MIN, { type: 'task_complete', turn_id: 't2', duration_ms: MIN }),
  ]);
  const work = await new WorkScanner({ policy: f.policy }).finish(codexSrc);
  assert.deepEqual(work, { aiMs: 5 * MIN, operator: [] });
});
