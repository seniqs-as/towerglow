import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { CallMeter, CeoRunner, consumeLine, readQuota } from '../src/server/ceo/runner.ts';
import type { CeoResult } from '../src/server/ceo/runner.ts';
import { createSpendLedger, weigh } from '../src/server/ceo/spend.ts';
import type { SpendCaps } from '../src/server/ceo/spend.ts';
import type { CeoState, Snapshot } from '../src/shared/protocol.ts';

/*
 * The CEO's own process, driven by a fake child: no test here launches a model.
 *
 * The stream lines are the shape of a real `claude -p --output-format
 * stream-json --verbose` call (haiku, two turns, two parallel Globs), trimmed
 * to the fields the runner reads. The numbers are the measured ones.
 */

const CAPS: SpendCaps = { quotaMaxPercent: 85, budgetUsd: 2, maxCallUsd: 0.5 };

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-runner-'));
}

const usage = (i: number, o: number, cw: number, cr: number): object => ({
  input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr,
});

const assistant = (id: string, block: object, u: object): string =>
  JSON.stringify({ type: 'assistant', message: { id, content: [block], usage: u } });

const TURN_1 = usage(9, 1, 8406, 9038);
const TURN_2 = usage(8, 2, 328, 17444);
const RESULT = usage(17, 282, 8734, 26482);

/** The measured call, line by line, as the CLI printed it. */
const STREAM = [
  JSON.stringify({ type: 'system', subtype: 'init' }),
  JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50, estimated_tokens_delta: 50 }),
  JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 171, estimated_tokens_delta: 121 }),
  assistant('msg_1', { type: 'thinking', thinking: '' }, TURN_1),
  assistant('msg_1', { type: 'tool_use', name: 'Glob', input: { pattern: '*.txt' } }, TURN_1),
  JSON.stringify({ type: 'user', message: { content: [] } }),
  assistant('msg_1', { type: 'tool_use', name: 'Glob', input: { pattern: '*.md' } }, TURN_1),
  JSON.stringify({ type: 'user', message: { content: [] } }),
  assistant('msg_2', { type: 'thinking', thinking: '' }, TURN_2),
  assistant('msg_2', { type: 'text', text: 'done' }, TURN_2),
];
const RESULT_LINE = JSON.stringify({
  type: 'result', subtype: 'success', total_cost_usd: 0.0225142, usage: RESULT,
});

test('stream-json repeats one usage on every block: a message is counted once', () => {
  const meter = new CallMeter();
  for (const line of STREAM) meter.add(consumeLine(line));

  // The context of each turn once, not once per block.
  assert.equal(meter.usage.in, 17);
  assert.equal(meter.usage.cacheWrite, 8734);
  assert.equal(meter.usage.cacheRead, 26482);
  // The output the stream declares is the one of the first instant (1 and 2):
  // the thinking estimates are the only running figure the CLI gives.
  assert.equal(meter.usage.out, 1 + 2 + 171);

  let naive = 0;
  for (const line of STREAM) {
    const u = (JSON.parse(line) as { message?: { usage?: Record<string, number> } }).message?.usage;
    if (u) {
      naive += weigh({
        in: u['input_tokens']!, out: u['output_tokens']!,
        cacheRead: u['cache_read_input_tokens']!, cacheWrite: u['cache_creation_input_tokens']!,
      });
    }
  }
  assert.ok(naive > 2 * weigh(meter.usage), `adding every block counted ${naive}`);
});

test('once result arrives, its total is the only number', () => {
  const meter = new CallMeter();
  for (const line of [...STREAM, RESULT_LINE]) meter.add(consumeLine(line));
  assert.deepEqual(meter.usage, { in: 17, out: 282, cacheRead: 26482, cacheWrite: 8734 });
});

test('the CLI starting up is not the model answering', () => {
  assert.equal(consumeLine(STREAM[0]!).fromModel, false);
  assert.equal(consumeLine(STREAM[4]!).fromModel, true, 'a tool call is already work');
});

/* ───────────────────────── the process ───────────────────────── */

interface Fake {
  child: ChildProcess;
  stdout: PassThrough;
  killed: () => boolean;
}

function fakeChild(): Fake {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new PassThrough();
  let killed = false;
  Object.assign(child, {
    pid: 4242, stdout, stderr: new PassThrough(), stdin: new PassThrough(),
    // A killed process closes with no code and a signal, some time later.
    kill: () => {
      if (killed) return true;
      killed = true;
      setImmediate(() => child.emit('close', null, 'SIGTERM'));
      return true;
    },
  });
  return { child, stdout, killed: () => killed };
}

const SNAPSHOT: Snapshot = {
  at: 0, limits: [], projects: [], sessions: [], agents: [], files: [], recent: [],
};

interface Rig {
  runner: CeoRunner;
  fake: Fake;
  dir: string;
  states: { state: CeoState; reason: string | null }[];
  results: CeoResult[];
}

function rig(clocks: { silenceMs: number; ceilingMs: number }): Rig {
  const dir = tmp();
  const fake = fakeChild();
  const states: Rig['states'] = [];
  const results: CeoResult[] = [];
  const runner = new CeoRunner({
    provider: 'claude',
    model: 'sonnet',
    codexModel: null,
    stateDir: dir,
    ledger: createSpendLedger(dir, CAPS),
    snapshot: () => SNAPSHOT,
    perimeter: () => [],
    history: (days) => ({ days, byProject: [] }),
    memory: () => [],
    weightedSince: () => 0,
    onState: (ev) => states.push({ state: ev.state, reason: ev.reason }),
    onResult: (r) => results.push(r),
    spawn: (() => fake.child) as never,
    ...clocks,
  });
  return { runner, fake, dir, states, results };
}

/** Writes `lines` one every `everyMs`, until they end or the process is killed. */
function drip(fake: Fake, lines: readonly string[], everyMs: number, then?: () => void): void {
  let i = 0;
  const timer = setInterval(() => {
    if (fake.killed()) {
      clearInterval(timer);
      return;
    }
    if (i < lines.length) {
      fake.stdout.write(`${lines[i++]}\n`);
      return;
    }
    clearInterval(timer);
    then?.();
  }, everyMs);
}

test('a timed out call says why: close does not wipe the reason with an empty stderr', async () => {
  // Observed: the panel read "error" and nothing else. The timeout wrote its
  // reason, then `close` wrote the first line of an empty stderr over it.
  const r = rig({ silenceMs: 40, ceilingMs: 60_000 });
  await r.runner.ask('q', 'structure', 'standard');

  assert.ok(r.fake.killed());
  const last = r.states.at(-1)!;
  assert.equal(last.state, 'error');
  assert.match(last.reason ?? '', /no output for/);
});

test('a call that keeps reading files is working, not stuck', async () => {
  // Observed: a structure analysis read files for three minutes, one event
  // every 1 to 43 seconds, and a flat 180s timeout killed it with no answer.
  const r = rig({ silenceMs: 150, ceilingMs: 60_000 });
  const tools = Array.from({ length: 12 }, (_, n) =>
    assistant(`msg_${n}`, { type: 'tool_use', name: 'Read', input: {} }, TURN_2));
  let answer = '';
  r.runner.setReplyChannel((delta) => { answer += delta; });

  const asked = r.runner.ask('q', 'structure', 'standard');
  // 12 x 25ms = 300ms of work, twice the silence allowed.
  drip(r.fake, [...tools, assistant('msg_x', { type: 'text', text: 'the answer' }, TURN_2), RESULT_LINE], 25, () => {
    r.fake.child.emit('close', 0, null);
  });
  await asked;

  assert.equal(r.fake.killed(), false);
  assert.ok(!r.states.some((s) => s.state === 'error'), JSON.stringify(r.states));
  assert.equal(answer, 'the answer');
  assert.equal(r.results[0]?.hadText, true);
});

test('the panel says answering as soon as the model works, not at its first word', async () => {
  const r = rig({ silenceMs: 1000, ceilingMs: 60_000 });
  const asked = r.runner.ask('q', 'structure', 'standard');
  drip(r.fake, [STREAM[0]!, STREAM[4]!], 5, () => r.fake.child.emit('close', 0, null));
  await asked;

  const seen = r.states.map((s) => s.state);
  assert.deepEqual(seen.slice(0, 2), ['starting', 'thinking']);
});

test('a call that never stops working hits the ceiling, and says so', async () => {
  const r = rig({ silenceMs: 1000, ceilingMs: 120 });
  const endless = Array.from({ length: 1000 }, (_, n) =>
    assistant(`msg_${n}`, { type: 'tool_use', name: 'Grep', input: {} }, usage(1, 1, 0, 0)));
  const asked = r.runner.ask('q', 'structure', 'deep');
  drip(r.fake, endless, 10);
  await asked;

  assert.ok(r.fake.killed());
  const last = r.states.at(-1)!;
  assert.equal(last.state, 'error');
  assert.match(last.reason ?? '', /still working after/);
});

test('the ledger gets the call total from result, not the sum of repeated blocks', async () => {
  const r = rig({ silenceMs: 1000, ceilingMs: 60_000 });
  const asked = r.runner.ask('q', null, 'fast');
  drip(r.fake, [...STREAM, RESULT_LINE], 2, () => r.fake.child.emit('close', 0, null));
  await asked;

  const file = JSON.parse(fs.readFileSync(path.join(r.dir, 'ceo', 'spend.json'), 'utf8')) as {
    calls: { usd: number; w: number }[];
  };
  assert.equal(file.calls.length, 1);
  assert.equal(file.calls[0]!.usd, 0.0225142);
  assert.equal(file.calls[0]!.w, weigh({ in: 17, out: 282, cacheRead: 26482, cacheWrite: 8734 }));
});

test('rate_limit_event: the quota read from the call itself, in the status line\'s windows', () => {
  // Captured from `claude -p --output-format stream-json` on 2026-09-19.
  const line = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1789816200,'
    + '"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled",'
    + '"isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.02,"resetsAt":1789816200},'
    + '"seven_day":{"utilization":0.32,"resetsAt":1790182800}}},"uuid":"f594808b","session_id":"41a8ceb0"}';
  const piece = consumeLine(line);
  assert.deepEqual(piece.quota, [
    { label: '5h', usedPercent: 2, windowMinutes: 300, model: null, resetsAt: 1789816200_000 },
    { label: '7d', usedPercent: 32, windowMinutes: 10_080, model: null, resetsAt: 1790182800_000 },
  ]);
  assert.equal(piece.text, '', 'it is not text of the answer');
  assert.equal(piece.sessionId, '41a8ceb0');
});

test('rate_limit_event without named windows: the window the event declares counts', () => {
  assert.deepEqual(readQuota({ status: 'allowed_warning', rateLimitType: 'seven_day_opus', utilization: 0.91, resetsAt: 100 }), [
    { label: '7d', usedPercent: 91, windowMinutes: 10_080, model: 'opus', resetsAt: 100_000 },
  ]);
  // over 1 is overage: the bar is full, not past full
  assert.equal(readQuota({ rateLimitType: 'five_hour', utilization: 1.4 })![0]!.usedPercent, 100);
  // nothing measurable is nothing, not a zero
  assert.equal(readQuota({ status: 'allowed' }), null);
  assert.equal(readQuota(null), null);
  assert.equal(readQuota({ unifiedWindows: { five_hour: { utilization: 'high' } } }), null);
});

test('a CEO can read, and nothing else: no editing, no shell, no web, no MCP server', async () => {
  // The brief carries text from outside -- session titles, recaps, file
  // names -- so what a CEO can call is what an injected sentence can call.
  const dir = tmp();
  const fake = fakeChild();
  let argv: string[] = [];
  const runner = new CeoRunner({
    provider: 'claude', model: 'sonnet', codexModel: null, stateDir: dir,
    ledger: createSpendLedger(dir, CAPS), snapshot: () => SNAPSHOT, perimeter: () => [],
    history: (days) => ({ days, byProject: [] }), memory: () => [], weightedSince: () => 0,
    onState: () => {}, onResult: () => {},
    spawn: ((_bin: string, args: string[]) => { argv = args; return fake.child; }) as never,
    silenceMs: 60_000, ceilingMs: 60_000,
  });
  const done = runner.ask('q', null, 'fast');
  await new Promise((r) => setImmediate(r));
  fake.child.emit('close', 0, null);
  await done;
  assert.ok(argv.includes('--strict-mcp-config'), 'your MCP servers would load');
  const denied = (argv[argv.indexOf('--disallowed-tools') + 1] ?? '').split(',');
  for (const tool of ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch']) assert.ok(denied.includes(tool), tool);
});
