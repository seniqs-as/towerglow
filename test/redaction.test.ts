import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, createStats } from '../src/server/parse/records.ts';
import { project, createContext, assertSafe, clampUnsafe, targetOf } from '../src/server/parse/redact.ts';
import type { RedactOptions } from '../src/server/parse/redact.ts';
import { MAX_FIELD_CHARS, MAX_RECAP_CHARS } from '../src/shared/protocol.ts';

const OPTS: RedactOptions = {
  projectId: 'proj123',
  cwd: '/Users/tester/code/app',
  redactPaths: false,
  cmdNames: true,
  titles: true,
  recap: true,
};

/** Strings that must NEVER appear in an event, whatever happens. */
const SECRETS = [
  'AKIAIOSFODNN7EXAMPLE',
  'sk-ant-api03-supersecret',
  '-----BEGIN RSA PRIVATE KEY-----',
  'tester@example.com',
  'password123',
  'my confidential prompt with the business plan inside it',
];

function runLines(lines: string[]): unknown[] {
  const stats = createStats();
  const ctx = createContext();
  const events: unknown[] = [];
  for (const line of lines) {
    const rec = parseLine(line, stats);
    if (!rec) continue;
    for (const ev of project(rec, ctx, OPTS)) {
      assertSafe(ev); // fails at once on any string that is too long
      events.push(ev);
    }
  }
  return events;
}

test('no secret survives projection, from any field', () => {
  const lines = [
    JSON.stringify({
      type: 'assistant', sessionId: 's1', uuid: 'u1', requestId: 'r1',
      timestamp: '2026-09-10T10:00:00.000Z',
      message: {
        model: 'claude-opus-5',
        usage: { input_tokens: 2, output_tokens: 10 },
        content: [
          { type: 'thinking', thinking: SECRETS[5] },
          { type: 'text', text: SECRETS[0] },
          {
            type: 'tool_use', id: 'toolu_1', name: 'Bash',
            input: { command: `aws configure set aws_access_key_id ${SECRETS[0]}` },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'user', sessionId: 's1', timestamp: '2026-09-10T10:00:02.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: SECRETS[1] }] },
      toolUseResult: { stdout: SECRETS[1], stderr: SECRETS[2], interrupted: false },
    }),
    JSON.stringify({
      type: 'user', sessionId: 's1', timestamp: '2026-09-10T10:00:03.000Z',
      promptId: 'p1', promptSource: 'typed', message: { content: SECRETS[5] },
    }),
    JSON.stringify({
      type: 'attachment', sessionId: 's1', timestamp: '2026-09-10T10:00:04.000Z',
      attachment: { type: 'session_context', context: `{"userEmail":"${SECRETS[3]}"}` },
    }),
    JSON.stringify({
      type: 'attachment', sessionId: 's1', timestamp: '2026-09-10T10:00:05.000Z',
      attachment: { type: 'prompt_snapshot', systemPrompt: SECRETS[4] },
    }),
  ];

  const serialised = JSON.stringify(runLines(lines));
  for (const secret of SECRETS) {
    assert.equal(serialised.includes(secret), false, `leaked: ${secret.slice(0, 24)}`);
  }
});

test('a Bash tool yields only the binary name, never its arguments', () => {
  const ref = targetOf('Bash', { command: `curl -H "Authorization: Bearer ${SECRETS[1]}" https://x.dev` }, OPTS);
  assert.deepEqual(ref, { kind: 'cmd', bin: 'curl' });
});

test('--no-cmd-names drops even the binary name', () => {
  assert.equal(targetOf('Bash', { command: 'psql' }, { ...OPTS, cmdNames: false }), null);
});

test('search and network tools expose no target at all', () => {
  // Patterns and URLs are content: they would reveal what you are looking for and where you go.
  assert.equal(targetOf('Grep', { pattern: 'SECRET_KEY=(.*)' }, OPTS), null);
  assert.equal(targetOf('Glob', { pattern: '**/*.pem' }, OPTS), null);
  assert.equal(targetOf('WebFetch', { url: 'https://internal.example.com/keys' }, OPTS), null);
});

test('a file outside the project never leaks its absolute path', () => {
  const ref = targetOf('Read', { file_path: '/Users/tester/.ssh/id_rsa' }, OPTS);
  assert.deepEqual(ref, { kind: 'file', path: '<external>/*', ext: '', dir: '<external>', external: true });
});

test('--redact-paths hashes the names but keeps the shape', () => {
  const plain = targetOf('Edit', { file_path: '/Users/tester/code/app/src/secretPlan.ts' }, OPTS);
  const hidden = targetOf('Edit', { file_path: '/Users/tester/code/app/src/secretPlan.ts' }, { ...OPTS, redactPaths: true });
  assert.ok(plain?.kind === 'file' && plain.path === 'src/secretPlan.ts');
  assert.ok(hidden?.kind === 'file');
  assert.equal(hidden.path.includes('secretPlan'), false, 'the name must be gone');
  assert.equal(hidden.path.endsWith('.ts'), true, 'the extension stays: it colours the tower');
  assert.equal(hidden.path.split('/').length, 2, 'the depth stays: the topology survives');
});

test('a prompt yields its length, never its text', () => {
  const events = runLines([
    JSON.stringify({
      type: 'user', sessionId: 's1', timestamp: '2026-09-10T10:00:00.000Z',
      promptId: 'p1', message: { content: SECRETS[5] },
    }),
  ]) as { t: string; chars?: number }[];
  assert.equal(events.length, 1);
  assert.equal(events[0]!.t, 'prompt');
  assert.equal(events[0]!.chars, SECRETS[5].length);
});

test('assertSafe rejects any oversized string', () => {
  assert.throws(
    () => assertSafe({ t: 'notice', sessionId: 'x'.repeat(MAX_FIELD_CHARS + 1), at: 0, code: 'idle' }),
    /redaction violation/,
  );
});

test('a malformed line is counted, never thrown', () => {
  const stats = createStats();
  assert.equal(parseLine('{not json', stats), null);
  assert.equal(parseLine('null', stats), null);
  assert.equal(stats.badLines, 2);
});

test('an unknown record type is counted for the doctor, not fatal', () => {
  const stats = createStats();
  assert.equal(parseLine(JSON.stringify({ type: 'something-new', sessionId: 's' }), stats), null);
  assert.equal(stats.unknownTypes['something-new'], 1);
});

test('token usage is counted once per requestId, not once per line', () => {
  // One API response is split over several lines with the SAME usage repeated:
  // summing them all overestimates by 2-4 times.
  const line = (blockIndex: number): string =>
    JSON.stringify({
      type: 'assistant', sessionId: 's1', requestId: 'req_same', apiBlockIndex: blockIndex,
      timestamp: '2026-09-10T10:00:00.000Z',
      message: { model: 'm', usage: { output_tokens: 426, cache_read_input_tokens: 27652 }, content: [] },
    });
  const events = runLines([line(0), line(1), line(2)]) as { t: string }[];
  assert.equal(events.filter((e) => e.t === 'usage').length, 1);
});

test('tool duration is derived from the pair, and orphans admit it', () => {
  const events = runLines([
    JSON.stringify({
      type: 'assistant', sessionId: 's1', requestId: 'r1', timestamp: '2026-09-10T10:00:00.000Z',
      message: { model: 'm', usage: {}, content: [{ type: 'tool_use', id: 'toolu_a', name: 'Read', input: { file_path: '/Users/tester/code/app/src/x.ts' } }] },
    }),
    JSON.stringify({
      type: 'user', sessionId: 's1', timestamp: '2026-09-10T10:00:01.500Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a', is_error: false, content: 'ok' }] },
      toolUseResult: { type: 'text', file: {} },
    }),
    // A result without a start: it happens when attaching to a session midway.
    JSON.stringify({
      type: 'user', sessionId: 's1', timestamp: '2026-09-10T10:00:02.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_unknown', is_error: true, content: 'x' }] },
    }),
  ]) as { t: string; durationMs?: number | null; orphan?: boolean; ok?: boolean }[];

  const ends = events.filter((e) => e.t === 'tool.end');
  assert.equal(ends[0]!.durationMs, 1500);
  assert.equal(ends[0]!.orphan, false);
  assert.equal(ends[1]!.durationMs, null, 'no start means no invented duration');
  assert.equal(ends[1]!.orphan, true);
  assert.equal(ends[1]!.ok, false);
});

test('a shell sent to the background is an async launch, and its id stays home', () => {
  // Measured on tower_defense, 2026-10-08: Claude ended its turn while a
  // shell it had started waited on a long simulation. The call returns at
  // once with a `backgroundTaskId`, by `run_in_background` or after a
  // timeout, and the shell runs on: it is a launch, not a finished call.
  const call = (id: string): string => JSON.stringify({
    type: 'assistant', sessionId: 's1', requestId: `r_${id}`, timestamp: '2026-10-08T13:01:03.000Z',
    message: { model: 'm', usage: {}, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 600' } }] },
  });
  const result = (id: string, toolUseResult: Record<string, unknown>): string => JSON.stringify({
    type: 'user', sessionId: 's1', timestamp: '2026-10-08T13:01:03.500Z',
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'Command running in background' }] },
    toolUseResult,
  });
  const events = runLines([
    call('toolu_bg'), result('toolu_bg', { stdout: '', stderr: '', backgroundTaskId: 'b3rgqbl5a' }),
    call('toolu_late'), result('toolu_late', { stdout: '', backgroundTaskId: 'bhdp6agcr', timedOutAfterMs: 600000 }),
    call('toolu_fg'), result('toolu_fg', { stdout: 'done', stderr: '' }),
  ]) as { t: string; id?: string; asyncLaunch?: boolean }[];

  const ends = events.filter((e) => e.t === 'tool.end');
  assert.deepEqual(ends.map((e) => [e.id, e.asyncLaunch]), [
    ['toolu_bg', true], ['toolu_late', true], ['toolu_fg', false],
  ]);
  assert.equal(JSON.stringify(events).includes('b3rgqbl5a'), false, 'the shell id got out');
});

test('from a subagent delivery ONLY the id comes out, never the report', async () => {
  // The delivery notification is the only announcement that a background agent
  // has finished, but its body is the agent report: text, often long. Here we
  // take the id of the call and nothing else.
  const { parseLine, createStats } = await import('../src/server/parse/records.ts');
  const SECRET = 'the confidential report that must not leave this place';

  const rec = parseLine(JSON.stringify({
    type: 'user',
    sessionId: 's1',
    timestamp: '2026-09-10T21:13:00.780Z',
    origin: { kind: 'task-notification' },
    promptSource: 'system',
    message: {
      role: 'user',
      content:
        `<task-notification><task-id>afe3c035a53b557f9</task-id>` +
        `<tool-use-id>toolu_01N2VyiW4Mxu54MTcb12ETWc</tool-use-id>` +
        `<result>${SECRET}</result></task-notification>`,
    },
  }), createStats());

  assert.equal(rec?.kind, 'agent_done');
  if (rec?.kind !== 'agent_done') return;
  assert.equal(rec.toolUseId, 'toolu_01N2VyiW4Mxu54MTcb12ETWc');

  const serialised = JSON.stringify(rec);
  assert.equal(serialised.includes(SECRET), false, 'the report got out');
  assert.equal(serialised.includes('task-notification'), false, 'the envelope got out');
});

test('a notification without a call id closes nothing', async () => {
  const { parseLine, createStats } = await import('../src/server/parse/records.ts');
  const rec = parseLine(JSON.stringify({
    type: 'user',
    sessionId: 's1',
    timestamp: '2026-09-10T21:13:00.780Z',
    origin: { kind: 'task-notification' },
    message: { role: 'user', content: '<task-notification>without id</task-notification>' },
  }), createStats());
  assert.notEqual(rec?.kind, 'agent_done');
});

test('the delivery is recognized even while it is still queued', async () => {
  // Verified on two real sessions: the end notification first goes through the
  // queue and becomes a message only when the session consumes it -- which can
  // be twenty minutes later, or never if the session stays idle. Looking only
  // at the message means leaving the window lit for an agent that has already
  // delivered.
  const { parseLine, createStats } = await import('../src/server/parse/records.ts');
  const SECRET = 'report content that stays inside';

  const rec = parseLine(JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    sessionId: 's1',
    timestamp: '2026-09-10T21:07:56.625Z',
    content:
      `<task-notification><task-id>acee913f4df4534fe</task-id>` +
      `<tool-use-id>toolu_017AtLuJaUz1XS5c93gbXfWe</tool-use-id>` +
      `<result>${SECRET}</result></task-notification>`,
  }), createStats());

  assert.equal(rec?.kind, 'agent_done');
  if (rec?.kind !== 'agent_done') return;
  assert.equal(rec.toolUseId, 'toolu_017AtLuJaUz1XS5c93gbXfWe');
  assert.equal(JSON.stringify(rec).includes(SECRET), false, 'the report got out');
});

test('an enqueue that is not a delivery is ignored', async () => {
  const { parseLine, createStats } = await import('../src/server/parse/records.ts');
  const rec = parseLine(JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    sessionId: 's1',
    timestamp: '2026-09-10T21:07:56.625Z',
    content: 'some message or other queued by the user',
  }), createStats());
  assert.equal(rec, null);
});

test('from a skill the NAME comes out, never the arguments', async () => {
  const { targetOf } = await import('../src/server/parse/redact.ts');
  const opts = { projectId: 'p', cwd: '/x', redactPaths: false, cmdNames: true, titles: true };
  const t = targetOf('Skill', { skill: 'claude-in-chrome', args: 'open the admin app with the password 1234' }, opts);
  assert.deepEqual(t, { kind: 'skill', name: 'claude-in-chrome' });
  assert.equal(JSON.stringify(t).includes('password'), false, 'the arguments got out');
});

test('a skill name that is not an identifier is dropped', async () => {
  const { targetOf } = await import('../src/server/parse/redact.ts');
  const opts = { projectId: 'p', cwd: '/x', redactPaths: false, cmdNames: true, titles: true };
  assert.equal(targetOf('Skill', { skill: 'name with spaces and weird stuff <script>' }, opts), null);
  assert.equal(targetOf('Skill', { skill: 'x'.repeat(200) }, opts), null);
});


/**
 * The recap: the only string the delta channel allows a paragraph for.
 *
 * The risk cuts both ways and these tests pin both sides. On one side the
 * exception must stay an exception: widened to everything, the guard would
 * stop catching a prompt. On the other the cap must not be so tight that it
 * cuts off the "next step", which is the useful half of the sentence -- and
 * that is exactly what happened at 128 characters.
 */

const RECAP =
  'Goal: show in My Dashboard a summary of what a session is doing. ' +
  'Implemented and verified the trail of finished gestures at the bottom of the card, tests and ' +
  'typecheck green. Next step: decide whether the "doing" line should switch off once the ' +
  'call is over.';

const recapLine = (recap: string, at = '2026-09-10T10:00:00.000Z'): string =>
  JSON.stringify({ type: 'system', subtype: 'away_summary', sessionId: 's1', timestamp: at, content: recap });

function projectLine(line: string, opts: RedactOptions): any[] {
  const rec = parseLine(line, createStats());
  if (!rec) return [];
  const out = [...project(rec, createContext(), opts)];
  for (const ev of out) assertSafe(ev);
  return out;
}

test('the recap arrives whole, with its timestamp', () => {
  const [ev] = projectLine(recapLine(RECAP), OPTS);
  assert.equal(ev.t, 'session.update');
  assert.equal(ev.id, 's1');
  assert.equal(ev.patch.recap, RECAP, 'the recap arrived cut');
  assert.ok(RECAP.length > MAX_FIELD_CHARS, 'the test case does not even exceed the normal threshold');
  assert.equal(ev.patch.recapAt, Date.parse('2026-09-10T10:00:00.000Z'));
});

test('past the recap cap it is cut, instead of blowing up the guard', () => {
  const [ev] = projectLine(recapLine('x'.repeat(MAX_RECAP_CHARS + 500)), OPTS);
  assert.equal(ev.patch.recap.length, MAX_RECAP_CHARS);
});

test("the exception applies ONLY to the recap: every other field stays at 128", () => {
  // A title as long as a recap: if the exception were on the event type
  // instead of the field name, this would pass, and a prompt along with it.
  const line = JSON.stringify({ type: 'ai-title', sessionId: 's1', aiTitle: 'y'.repeat(300) });
  const [ev] = projectLine(line, OPTS);
  assert.ok(ev.patch.title.length <= MAX_FIELD_CHARS, 'the title took the recap cap');
  assert.throws(
    () => assertSafe({ t: 'session.update', id: 's1', at: 0, patch: { title: 'y'.repeat(300) } } as any),
    /redaction violation at patch.title/,
  );
});

test('with --no-recap nothing comes out', () => {
  const events = projectLine(recapLine(RECAP), { ...OPTS, recap: false });
  assert.equal(events.length, 0);
});

test('an away_summary without text does not produce an empty recap', () => {
  assert.equal(projectLine(recapLine(''), OPTS).length, 0);
});

/* ── the guard holds even when the tests are not running ───────────────── */

test('in production the guard truncates and counts, instead of letting it through', () => {
  // The bug this test exists to prevent: `assertSafe` ran only behind --dev,
  // so on the machine of whoever USES the tool a redaction regression met no
  // safety net and went straight into the delta channel.
  const ev = {
    t: 'session.update', id: 's1', at: 0,
    patch: { title: 'p'.repeat(MAX_FIELD_CHARS + 400) },
  } as any;

  const clamped = clampUnsafe(ev);

  assert.equal(clamped, 1, 'the violation was not counted');
  assert.equal(ev.patch.title.length, MAX_FIELD_CHARS, 'the field was not truncated');
  assertSafe(ev); // after the cut the hard guard must pass too
});

test('the per-name cap applies to truncation too', () => {
  // If clampUnsafe used the general threshold instead of the map of declared
  // fields, every recap would arrive mangled at 128 characters.
  const ev = {
    t: 'session.update', id: 's1', at: 0,
    patch: { recap: 'r'.repeat(MAX_RECAP_CHARS + 100) },
  } as any;

  assert.equal(clampUnsafe(ev), 1);
  assert.equal(ev.patch.recap.length, MAX_RECAP_CHARS);
});

test('an already clean event is not touched', () => {
  const ev = { t: 'session.update', id: 's1', at: 0, patch: { title: 'short' } } as any;
  assert.equal(clampUnsafe(ev), 0);
  assert.equal(ev.patch.title, 'short');
});

/* ───────────────── the closing cost statement of a session ───────────────── */

/** The real shape, taken from a transcript on disk. */
const COST_STATE = JSON.stringify({
  type: 'cost-state',
  sessionId: 's1',
  totalCostUSD: 1.792087,
  totalAPIDuration: 296506,
  totalAPIDurationWithoutRetries: 296415,
  totalToolDuration: 10239,
  totalLinesAdded: 40,
  totalLinesRemoved: 12,
  totalDuration: 515470,
  startTime: 1789156995312,
  hasUnknownModelCost: false,
  modelUsage: {
    'claude-haiku-4-5-20251001': {
      inputTokens: 918, outputTokens: 20, cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 100, thinkingTokens: 0, costUSD: 0.01, webSearchRequests: 0,
    },
    'claude-opus-5': {
      inputTokens: 4000, outputTokens: 9000, cacheReadInputTokens: 80000,
      cacheCreationInputTokens: 12000, thinkingTokens: 700, costUSD: 1.78, webSearchRequests: 0,
    },
  },
});

test('the closing cost statement no longer ends up among the unknown types', () => {
  // Until yesterday this line was read, counted as unknown and thrown away:
  // it carries the COMPLETE numbers of the session, and there is nothing new
  // to open to get them.
  const stats = createStats();
  const rec = parseLine(COST_STATE, stats);
  assert.ok(rec, 'the line was dropped');
  assert.equal(stats.unknownTypes['cost-state'], undefined);
});

test('the statement tokens are summed across all models, the name goes to the biggest', () => {
  // A session touches haiku for the title and opus for the work: calling it
  // "haiku" because it is the last one seen would be worse than saying nothing.
  const [ev] = runLines([COST_STATE]) as [{
    t: string; tokens: { in: number; out: number; cacheRead: number; cacheWrite: number; thinking: number };
    model: string; costUsd: number; at: number; linesAdded: number; linesRemoved: number;
  }];
  assert.equal(ev.t, 'session.cost');
  assert.equal(ev.model, 'claude-opus-5');
  assert.equal(ev.tokens.in, 4918);
  assert.equal(ev.tokens.out, 9020);
  assert.equal(ev.tokens.cacheRead, 81000);
  assert.equal(ev.tokens.cacheWrite, 12100);
  assert.equal(ev.tokens.thinking, 700);
  assert.equal(Math.round(ev.costUsd * 100), 179);
  assert.equal(ev.linesAdded, 40);
  assert.equal(ev.linesRemoved, 12);
  // The timestamp is the START of the session: it is the day the work belongs
  // to, and a session that runs past midnight would land on the next one.
  assert.equal(ev.at, 1789156995312);
});

test('a statement without modelUsage breaks nothing and counts as zero', () => {
  // The format belongs to a program we do not control: a shape we do not
  // understand must count as zero, not bring down the session tail.
  const [ev] = runLines([
    JSON.stringify({ type: 'cost-state', sessionId: 's1', totalCostUSD: 'a lot', modelUsage: null }),
  ]) as [{ tokens: { in: number }; costUsd: number; model: string | null }];
  assert.equal(ev.tokens.in, 0);
  assert.equal(ev.costUsd, 0);
  assert.equal(ev.model, null);
});

test('a statement without sessionId produces nothing: there would be no one to give it to', () => {
  assert.deepEqual(runLines([JSON.stringify({ type: 'cost-state', totalCostUSD: 3 })]), []);
});
