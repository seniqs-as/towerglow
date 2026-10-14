import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodexProvider } from '../src/server/providers/codex/provider.ts';
import { parseRolloutLine, readLastLimits, readLastPlan, readLastWindows, readMeta } from '../src/server/providers/codex/rollouts.ts';
import type { DeltaEvent } from '../src/shared/protocol.ts';
import type { LiveSession } from '../src/server/providers/types.ts';
import { assertSafe } from '../src/server/parse/redact.ts';
import { createStats } from '../src/server/parse/records.ts';
import { categoryOf } from '../src/shared/toolCategories.ts';

const SECRET = 'sk-live-supersecret-must-never-get-out';
const PROJECT = '/Users/tester/code/webapp';
const SID = '01a08a4a-affb-7ab1-8879-9810c8fec8b0';

const line = (o: unknown): string => JSON.stringify(o) + '\n';
const iso = (ms: number): string => new Date(ms).toISOString();

/** Builds a synthetic ~/.codex with the real shape of the rollouts. */
function fakeCodexDir(opts: { nowMs: number; closeTurn: boolean; ageMs?: number; ask?: 'pending' | 'answered' }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-codex-'));
  const day = path.join(dir, 'sessions', '2026', '09', '10');
  fs.mkdirSync(day, { recursive: true });

  const t = opts.nowMs;
  let body = '';
  body += line({ timestamp: iso(t - 5000), ordinal: 0, type: 'session_meta',
    payload: { session_id: SID, cwd: PROJECT, cli_version: '0.153.4',
               base_instructions: { text: SECRET } } });
  body += line({ timestamp: iso(t - 4000), ordinal: 1, type: 'turn_context',
    payload: { model: 'gpt-6-astra', effort: 'high', cwd: PROJECT } });
  body += line({ timestamp: iso(t - 4000), ordinal: 2, type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'turn-1', started_at: Math.floor(t / 1000) } });
  body += line({ timestamp: iso(t - 3000), ordinal: 3, type: 'event_msg',
    payload: { type: 'item_completed', completed_at_ms: t - 3000,
      item: { type: 'CommandExecution', id: 'exec-1',
        command: ['/bin/bash', '-lc', `curl -H "Authorization: Bearer ${SECRET}" https://api.example.com`],
        cwd: PROJECT, status: 'completed', exit_code: '0',
        duration: { secs: 0, nanos: 842_000_000 }, aggregated_output: SECRET } } });
  body += line({ timestamp: iso(t - 2000), ordinal: 4, type: 'event_msg',
    payload: { type: 'item_completed', completed_at_ms: t - 2000,
      item: { type: 'FileChange', id: 'fc-1', status: 'completed',
        changes: [
          { path: `${PROJECT}/src/app.ts`, kind: { type: 'modify' }, diff: 'a\nb\nc' },
          { path: '/etc/passwd', kind: { type: 'modify' }, diff: 'outside the project' },
        ] } } });
  body += line({ timestamp: iso(t - 2000), ordinal: 5, type: 'event_msg',
    payload: { type: 'item_completed', completed_at_ms: t - 2000,
      item: { type: 'Reasoning', id: 'r-1', summary_text: SECRET } } });
  // A huge line, like real tool outputs: it must not even be parsed.
  body += line({ timestamp: iso(t - 1500), ordinal: 6, type: 'response_item',
    payload: { type: 'custom_tool_call_output', call_id: 'c1', output: SECRET.repeat(20000) } });
  body += line({ timestamp: iso(t - 1000), ordinal: 7, type: 'token_usage_record',
    payload: { thread_token_usage: { total_tokens: 1143477 } } });
  if (opts.ask) {
    body += line({ timestamp: iso(t - 1200), ordinal: 20, type: 'response_item',
      payload: { type: 'function_call', name: 'request_user_input_async', call_id: 'call-ask-1',
                 arguments: JSON.stringify({ questions: [{ title: SECRET }] }) } });
    if (opts.ask === 'answered') {
      body += line({ timestamp: iso(t - 900), ordinal: 21, type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-ask-1', output: SECRET } });
    }
  }
  if (opts.closeTurn) {
    body += line({ timestamp: iso(t - 500), ordinal: 8, type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-1', duration_ms: 4500,
                 last_agent_message: SECRET } });
  }

  const file = path.join(day, `rollout-2026-09-10T09-49-05-${SID}.jsonl`);
  fs.writeFileSync(file, body);
  if (opts.ageMs) {
    const when = new Date(t - opts.ageMs);
    fs.utimesSync(file, when, when);
  }
  fs.writeFileSync(path.join(dir, 'state_5.sqlite'), '');
  fs.writeFileSync(path.join(dir, 'config.toml'),
    `model = "gpt-6-astra"\n\n[projects."${PROJECT}"]\ntrust_level = "trusted"\n`);
  // These must stay outside the allow-list: if they were read it would show here.
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ token: SECRET }));
  fs.writeFileSync(path.join(dir, 'history.jsonl'), JSON.stringify({ text: SECRET }) + '\n');
  return dir;
}

async function collect(dir: string): Promise<{ sessions: LiveSession[]; events: DeltaEvent[]; projects: string[] }> {
  const provider = new CodexProvider({
    codexDir: dir,
    policy: { claudeDir: '/nowhere/.claude', codexDir: dir, homeDir: '/Users/tester' },
    redactPaths: false, cmdNames: true, titles: true,
    known: () => true, produces: () => true, devAssert: true, stats: createStats(),
  });
  const sessions: LiveSession[] = [];
  const events: DeltaEvent[] = [];
  const projects: string[] = [];
  provider.start({
    onProjects: (p) => projects.push(...p),
    onSessions: (s) => sessions.splice(0, sessions.length, ...s),
    onEvents: (e) => events.push(...e),
  });
  await new Promise((r) => setTimeout(r, 1400));
  provider.stop();
  return { sessions, events, projects };
}

test('the cwd comes from the first rollout line', () => {
  const dir = fakeCodexDir({ nowMs: Date.now(), closeTurn: false });
  const file = fs.readdirSync(path.join(dir, 'sessions', '2026', '09', '10'))[0]!;
  const meta = readMeta(path.join(dir, 'sessions', '2026', '09', '10', file), {
    claudeDir: '/nowhere', codexDir: dir, homeDir: '/Users/tester',
  });
  assert.equal(meta?.cwd, PROJECT);
  assert.equal(meta?.sessionId, SID);
  assert.equal(meta?.cliVersion, '0.153.4');
});

test('an open turn means busy; a closed one means idle', async () => {
  // It is the signal the SQLite registry does not give: `threads` is a
  // historical index, updated much later, while the rollout is written live.
  const open = await collect(fakeCodexDir({ nowMs: Date.now(), closeTurn: false }));
  assert.equal(open.sessions.length, 1);
  assert.equal(open.sessions[0]!.status, 'busy', 'task_started without task_complete');
  assert.equal(open.sessions[0]!.statusConfidence, 'inferred');
  assert.equal(open.sessions[0]!.model, 'gpt-6-astra');
  assert.equal(open.sessions[0]!.cwd, PROJECT);

  const closed = await collect(fakeCodexDir({ nowMs: Date.now() - 30_000, closeTurn: true }));
  assert.equal(closed.sessions[0]!.status, 'idle');
});

test('a rollout untouched for a long time is not a live session', async () => {
  const { sessions } = await collect(fakeCodexDir({ nowMs: Date.now(), closeTurn: true, ageMs: 60 * 60_000 }));
  assert.deepEqual(sessions, []);
});

test('the declared project appears even with no live session', async () => {
  const { projects } = await collect(fakeCodexDir({ nowMs: Date.now(), closeTurn: true, ageMs: 60 * 60_000 }));
  assert.ok(projects.includes(PROJECT));
});

test('no secret escapes, not even from a multi-megabyte line', async () => {
  const { events } = await collect(fakeCodexDir({ nowMs: Date.now(), closeTurn: true }));
  const serialised = JSON.stringify(events);
  assert.equal(serialised.includes(SECRET), false, 'the secret got out');
  assert.equal(serialised.includes('api.example.com'), false, 'the URL got out');
  assert.equal(serialised.includes('/etc/passwd'), false, 'an outside path got out');
  for (const e of events) assertSafe(e);
});

test('a command yields only its binary, and reasoning yields nothing', async () => {
  const { events } = await collect(fakeCodexDir({ nowMs: Date.now(), closeTurn: true }));
  const cmd = events.find((e) => e.t === 'tool.start' && e.name === 'CommandExecution');
  assert.ok(cmd && cmd.t === 'tool.start');
  assert.deepEqual(cmd.target, { kind: 'cmd', bin: 'curl' }, 'no /bin/bash wrapper, no arguments');
  const end = events.find((e) => e.t === 'tool.end');
  assert.ok(end && end.t === 'tool.end');
  assert.equal(end.durationMs, 842, 'duration from {secs, nanos}');
  assert.equal(events.some((e) => e.t === 'tool.start' && e.name === 'Reasoning'), false);
});

test('the page reads from the name of a Codex call the same category the server sends', async () => {
  // The spark reads `cat`, the window and the lamp read the name: when the two
  // disagreed, a Codex shell command left in red and lit a grey window.
  const { events } = await collect(fakeCodexDir({ nowMs: Date.now(), closeTurn: true }));
  const calls = events.filter((e) => e.t === 'tool.start');
  assert.deepEqual(calls.map((e) => e.t === 'tool.start' && e.cat), ['exec', 'edit']);
  for (const e of calls) {
    assert.ok(e.t === 'tool.start');
    assert.equal(categoryOf(e.name), e.cat, `${e.name}: the window would not match the spark`);
  }
});

test('a file change lights the right window, only inside the project', async () => {
  const { events } = await collect(fakeCodexDir({ nowMs: Date.now(), closeTurn: true }));
  const touches = events.filter((e) => e.t === 'file.touch');
  assert.equal(touches.length, 1);
  const t = touches[0]!;
  assert.ok(t.t === 'file.touch');
  assert.equal(t.path, 'src/app.ts');
  assert.equal(t.dir, 'src');
  assert.equal(t.changed, 3);
});

test('an oversized line is skipped before parsing, not after', () => {
  const huge = JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed' } }) + 'x'.repeat(300_000);
  assert.equal(parseRolloutLine(huge), null);
  assert.equal(parseRolloutLine('{broken'), null);
  assert.equal(parseRolloutLine('null'), null);
});

test('an unanswered question means waiting, not idle', async () => {
  // It is the distinction that matters: "I am done" and "I am stopped because
  // I am waiting for you" are two very different things, and Codex separates
  // them only here.
  const dir = fakeCodexDir({ nowMs: Date.now(), closeTurn: true, ask: 'pending' });
  const { sessions } = await collect(dir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.status, 'waiting');
  assert.equal(sessions[0]!.waitingFor, 'input');
});

test('once answered, the session goes back to being merely idle', async () => {
  const dir = fakeCodexDir({ nowMs: Date.now() - 30_000, closeTurn: true, ask: 'answered' });
  const { sessions } = await collect(dir);
  assert.equal(sessions[0]!.status, 'idle');
  assert.equal(sessions[0]!.waitingFor, null);
});

test('a pending question outranks an open turn', async () => {
  // If the turn is still open but the question is pending, what matters to
  // whoever is watching is that an answer from them is needed.
  const dir = fakeCodexDir({ nowMs: Date.now(), closeTurn: false, ask: 'pending' });
  const { sessions } = await collect(dir);
  assert.equal(sessions[0]!.status, 'waiting');
});

test('the question text never leaves the server', async () => {
  const dir = fakeCodexDir({ nowMs: Date.now(), closeTurn: true, ask: 'pending' });
  const { sessions, events } = await collect(dir);
  const serialised = JSON.stringify({ sessions, events });
  assert.equal(serialised.includes(SECRET), false, 'the question text got out');
});

test('a finished turn reports the duration Codex declares, not the time since', async () => {
  // The defect this test pins down: the scene showed the time elapsed SINCE
  // the end of the turn instead of how long the turn had lasted, and a
  // minute-and-a-half task read as twenty-five minutes. The right duration
  // is the one in the payload -- the same one the terminal prints as
  // "worked for 1m 29s" -- and must not be derived from the gap between two
  // records.
  const nowMs = Date.now() - 30_000;
  const { events } = await collect(fakeCodexDir({ nowMs, closeTurn: true }));

  const ends = events.filter((e) => e.t === 'turn.end');
  assert.equal(ends.length, 1, 'one closed turn, a single turn.end');
  assert.equal(ends[0]!.durationMs, 4500, 'the duration is the one Codex declares');

  // The turn closed half a second before `nowMs`, that is about 30s ago: if
  // the duration were the elapsed time, that is what would read here.
  assert.ok(ends[0]!.durationMs < 10_000, 'it is not the time elapsed since the end');
});

test('a turn still open reports no duration', async () => {
  const { events } = await collect(fakeCodexDir({ nowMs: Date.now(), closeTurn: false }));
  assert.equal(events.filter((e) => e.t === 'turn.end').length, 0);
});

/**
 * A chat as Codex Desktop 0.155 leaves it: a turn that started a dev server
 * and closed `workedAgoMs` ago, then maybe a second turn, then the dev
 * server's exit, written now under the first turn's id.
 */
function backgroundExitDir(nowMs: number, workedAgoMs: number, next: 'none' | 'aborted'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-codex-late-'));
  const day = path.join(dir, 'sessions', '2026', '10', '13');
  fs.mkdirSync(day, { recursive: true });
  const worked = nowMs - workedAgoMs;
  let body = '';
  body += line({ timestamp: iso(worked - 60_000), type: 'session_meta',
    payload: { session_id: SID, cwd: PROJECT, cli_version: '0.155.0' } });
  body += line({ timestamp: iso(worked - 50_000), type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'turn-1' } });
  body += line({ timestamp: iso(worked - 40_000), type: 'event_msg',
    payload: { type: 'item_completed', turn_id: 'turn-1', completed_at_ms: worked - 40_000,
      item: { type: 'FileChange', id: 'fc-1', status: 'completed',
        changes: [{ path: `${PROJECT}/src/app.ts`, kind: { type: 'modify' }, diff: 'a' }] } } });
  body += line({ timestamp: iso(worked), type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'turn-1', duration_ms: 50_000 } });
  if (next === 'aborted') {
    body += line({ timestamp: iso(nowMs - 20_000), type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-2' } });
    body += line({ timestamp: iso(nowMs - 10_000), type: 'event_msg',
      payload: { type: 'turn_aborted', turn_id: 'turn-2', reason: 'interrupted', duration_ms: 10_000 } });
  }
  body += line({ timestamp: iso(nowMs - 500), type: 'event_msg',
    payload: { type: 'item_completed', turn_id: 'turn-1',
      started_at_ms: worked - 45_000, completed_at_ms: nowMs - 500,
      item: { type: 'CommandExecution', id: 'exec-dev', command: ['/bin/bash', '-lc', 'npm run dev'],
        source: 'unified_exec_startup', status: 'failed', exit_code: 137 } } });
  fs.writeFileSync(path.join(day, `rollout-2026-10-13T22-30-03-${SID}.jsonl`), body);
  return dir;
}

test('a background process that exits hours after its turn does not bring the session back', async () => {
  // Field case, 2026-10-14: a dev server started in a chat's first turn the
  // night before was killed in the afternoon. Its exit freshened the rollout,
  // and tower_defense stood lit in Codex white while the last Codex work had
  // been on another project.
  const { sessions, events } = await collect(backgroundExitDir(Date.now(), 18 * 3_600_000, 'none'));
  assert.deepEqual(sessions, [], 'a session that last worked eighteen hours ago is on stage');
  assert.equal(events.some((e) => e.t === 'tool.start' && e.id === 'cx:exec-dev'), false,
    'the exit lit a window as if a command had just run');
});

test('an interrupted turn is over: the session is idle, not working', async () => {
  const { sessions } = await collect(backgroundExitDir(Date.now(), 18 * 3_600_000, 'aborted'));
  assert.equal(sessions.length, 1, 'the interrupt is the user at work: the session is there');
  assert.equal(sessions[0]!.status, 'idle', 'turn_aborted left the turn open');
});

test('the Codex context comes from token_count, as a share of the request', () => {
  // Same record as the quotas, different recipients: the context belongs to
  // the session, the quota to the account. Returning only one lost the other.
  const ev = parseRolloutLine(JSON.stringify({
    timestamp: new Date().toISOString(), type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { model_context_window: 258400, last_token_usage: { input_tokens: 51086 } },
      rate_limits: {
        primary: { used_percent: 4, window_minutes: 300, resets_at: 1789044882 },
        secondary: { used_percent: 5, window_minutes: 10080, resets_at: 1789495107 },
        plan_type: 'plus',
      },
    },
  }));
  assert.equal(ev?.kind, 'limits');
  if (ev?.kind !== 'limits') return;
  assert.equal(Math.round(ev.contextPct! * 10) / 10, 19.8, 'wrong context');
  assert.equal(ev.windows.length, 2, 'the quotas were lost');
  assert.equal(ev.plan, 'plus');
});

/** A rollout where the allow-list expects it: `<codexDir>/sessions/YYYY/MM/DD`. */
function rolloutPath(dir: string): string {
  const day = path.join(dir, 'sessions', '2026', '09', '20');
  fs.mkdirSync(day, { recursive: true });
  return path.join(day, 'rollout-2026-09-20T07-45-08-01a0bd58-cc85-74c1-a516-dfd312224086.jsonl');
}

/** The opening record: the tail always drops its first line, truncated or not. */
const head = (): string => line({
  timestamp: iso(Date.parse('2026-09-20T05:45:08.000Z')), type: 'session_meta',
  payload: { session_id: SID, cwd: PROJECT, cli_version: '0.154.0' },
});

test('the credit record, which names no window, does not hide the quota behind it', () => {
  // Field case, 2026-09-20: Codex writes two `rate_limits` records six tenths
  // of a second apart -- `limit_id: "codex"` with the 5h and the 7d, then
  // `limit_id: "premium"` with `primary` and `secondary` null, which is the
  // credit balance. Reading backwards to the first match found the second, so
  // a server restarted after such a turn showed the CODEX row with no bars
  // until Codex was run again.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-codex-limits-'));
  const file = rolloutPath(dir);
  const record = (limits: unknown, at: number): string => line({
    timestamp: iso(at), type: 'event_msg',
    payload: { type: 'token_count', info: { model_context_window: 258400 }, rate_limits: limits },
  });
  fs.writeFileSync(file, head() + record({
    limit_id: 'codex',
    primary: { used_percent: 99, window_minutes: 300, resets_at: 1789900494 },
    secondary: { used_percent: 99, window_minutes: 10080, resets_at: 1790164648 },
    plan_type: 'plus',
  }, Date.parse('2026-09-20T05:47:42.732Z')) + record({
    limit_id: 'premium',
    primary: null,
    secondary: null,
    credits: { has_credits: false, unlimited: false, balance: '0' },
    plan_type: 'plus',
  }, Date.parse('2026-09-20T05:47:43.366Z')));

  const policy = { claudeDir: '/nowhere/.claude', codexDir: dir, homeDir: '/Users/tester' };
  const ev = readLastLimits(file, policy);
  assert.equal(ev?.kind, 'limits');
  if (ev?.kind !== 'limits') return;
  assert.deepEqual(ev.windows.map((w) => `${w.label} ${w.usedPercent}`), ['5h 99', '7d 99']);
  assert.equal(ev.plan, 'plus');
});

test('with no window anywhere in the tail, the plan still comes back', () => {
  // It is what makes the tool's row appear: the windows may only be in an
  // older rollout, and the row with the plan and no bars says the truth --
  // this tool is here, its quota is not known yet.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-codex-plan-'));
  const file = rolloutPath(dir);
  fs.writeFileSync(file, head() + line({
    timestamp: iso(Date.now()), type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { model_context_window: 258400, last_token_usage: { input_tokens: 162_600 } },
      rate_limits: { limit_id: 'premium', primary: null, secondary: null, plan_type: 'plus' },
    },
  }));

  const ev = readLastLimits(file, { claudeDir: '/nowhere/.claude', codexDir: dir, homeDir: '/Users/tester' });
  assert.equal(ev?.kind, 'limits');
  if (ev?.kind !== 'limits') return;
  assert.deepEqual(ev.windows, []);
  assert.equal(ev.plan, 'plus');
});

test('a plan Codex stopped naming is the last one it named, not none', () => {
  // Measured on 2026-10-08: halfway through a session Codex 0.154 went from
  // "plan_type": "plus" to null in every record after, and the CODEX row lost
  // its plan, because the plan was read from the record with the windows.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-codex-null-plan-'));
  const file = rolloutPath(dir);
  const record = (plan: string | null, used: number, at: number): string => line({
    timestamp: iso(at), type: 'event_msg',
    payload: {
      type: 'token_count', info: { model_context_window: 258400 },
      rate_limits: {
        limit_id: 'codex', plan_type: plan,
        primary: { used_percent: used, window_minutes: 300, resets_at: 1789900494 },
        secondary: { used_percent: 90, window_minutes: 10080, resets_at: 1790164648 },
      },
    },
  });
  const t = Date.parse('2026-10-05T19:00:00.000Z');
  fs.writeFileSync(file, head() + record('plus', 60, t) + record(null, 67, t + 60_000) + record(null, 68, t + 120_000));
  const policy = { claudeDir: '/nowhere/.claude', codexDir: dir, homeDir: '/Users/tester' };
  const ev = readLastLimits(file, policy);
  assert.equal(ev?.kind, 'limits');
  if (ev?.kind !== 'limits') return;
  assert.equal(ev.windows[0]?.usedPercent, 68, 'the windows are still the latest');
  assert.equal(ev.plan, 'plus');

  // A rollout that never names it falls back on the ones before it.
  const silent = path.join(path.dirname(file), 'rollout-2026-10-06T08-12-35-01a10fd7-add9-7a70-8d64-3554cd717dd8.jsonl');
  fs.writeFileSync(silent, head() + record(null, 70, t + 3_600_000));
  assert.equal(readLastLimits(silent, policy)?.plan ?? null, null);
  assert.equal(readLastPlan([silent, file], policy), 'plus');
  assert.equal(readLastPlan([silent], policy), null, 'never guessed');
});

/**
 * A guardian rollout as Codex Desktop 0.154 writes it: the approvals reviewer
 * is a thread of its own (`id`), but its `session_id` is the calling chat's.
 */
function writeGuardian(dir: string, nowMs: number, inputTokens: number): void {
  const day = path.join(dir, 'sessions', '2026', '09', '10');
  const own = '01a08a4d-91ce-7c31-a236-50b23118288c';
  let body = '';
  body += line({ timestamp: iso(nowMs - 3000), type: 'session_meta',
    payload: { session_id: SID, id: own, parent_thread_id: SID, cwd: PROJECT,
               originator: 'Codex Desktop', cli_version: '0.154.0-alpha.6.2',
               source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review' } });
  body += line({ timestamp: iso(nowMs - 2000), type: 'event_msg',
    payload: { type: 'token_count', info: { model_context_window: 258400,
               last_token_usage: { input_tokens: inputTokens } } } });
  // The name sorts BEFORE the chat's: if the guardian counted, it would be
  // attached in the chat's place.
  fs.writeFileSync(path.join(day, `rollout-2026-09-10T09-38-34-${own}.jsonl`), body);
}

test('an archived chat is not kept on stage by its guardian', async () => {
  // Seen in the field: archiving a chat in Codex Desktop moves its rollout to
  // `archived_sessions/`, but the guardian stayed in `sessions/` with the chat's
  // session_id -- and for half an hour the scene still showed the old context.
  const now = Date.now();
  const dir = fakeCodexDir({ nowMs: now, closeTurn: true });
  const day = path.join(dir, 'sessions', '2026', '09', '10');
  const archived = path.join(dir, 'archived_sessions');
  fs.mkdirSync(archived);
  const chat = fs.readdirSync(day)[0]!;
  fs.renameSync(path.join(day, chat), path.join(archived, chat));
  writeGuardian(dir, now, 80_000);

  const { sessions } = await collect(dir);
  assert.deepEqual(sessions, []);
});

test('a chat and its guardian never swap context', async () => {
  const now = Date.now();
  const dir = fakeCodexDir({ nowMs: now, closeTurn: true });
  writeGuardian(dir, now, 80_000);

  const { sessions } = await collect(dir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.sessionId, SID);
  assert.equal(sessions[0]!.model, 'gpt-6-astra', 'the guardian rollout was attached in place of the chat');
  assert.equal(sessions[0]!.contextPct, null, 'the guardian context landed on the chat');
});

/*
 * The bars that did not come back after a restart.
 *
 * Field case, 2026-10-13: the newest rollout was a session that had handed
 * its work to subagents and held no `rate_limits` in its tail; the subagents'
 * rollouts, written half an hour before it, carried the 5h at 99% and the 7d
 * at 15%. The server had read those live. Restarted, it read the newest
 * rollout alone: the CODEX row kept its plan and lost its bars.
 */
function quotaDir(): { dir: string; day: string; policy: { claudeDir: string; codexDir: string; homeDir: string } } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-codex-seed-'));
  const now = new Date();
  const day = path.join(dir, 'sessions', String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  return { dir, day, policy: { claudeDir: '/nowhere/.claude', codexDir: dir, homeDir: '/Users/tester' } };
}

const quota = (used5h: number, used7d: number, at: number): string => line({
  timestamp: iso(at), type: 'event_msg',
  payload: {
    type: 'token_count', info: { model_context_window: 258400 },
    rate_limits: {
      limit_id: 'codex', plan_type: 'plus',
      primary: { used_percent: used5h, window_minutes: 300, resets_at: Math.round(at / 1000) + 3600 },
      secondary: { used_percent: used7d, window_minutes: 10080, resets_at: Math.round(at / 1000) + 86400 },
    },
  },
});

/** A rollout with its own session id, last written at `mtime`. */
function rollout(day: string, id: string, body: string, mtime: number): string {
  const file = path.join(day, `rollout-2026-10-13T14-49-08-${id}.jsonl`);
  fs.writeFileSync(file, line({
    timestamp: iso(mtime - 60_000), type: 'session_meta',
    payload: { session_id: id, cwd: PROJECT, cli_version: '0.154.0' },
  }) + body);
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

test('the quota is read from the rollout that holds it, not only from the newest one', () => {
  const { day, policy } = quotaDir();
  const now = Date.now();
  const silent = rollout(day, '01a00000-0000-7000-8000-00000000000a',
    line({ timestamp: iso(now - 100 * 60_000), type: 'event_msg', payload: { type: 'agent_message', message: 'handed over' } }), now - 100 * 60_000);
  const sub = rollout(day, '01a00000-0000-7000-8000-00000000000b', quota(99, 15, now - 140 * 60_000), now - 140 * 60_000);
  const older = rollout(day, '01a00000-0000-7000-8000-00000000000c', quota(53, 8, now - 260 * 60_000), now - 260 * 60_000);

  assert.equal(readLastLimits(silent, policy), null, 'the newest names no quota at all');
  const ev = readLastWindows([silent, sub, older], policy);
  assert.equal(ev?.windows.length, 2);
  assert.equal(ev?.windows[0]?.usedPercent, 99, 'the freshest reading that names a window');
  assert.equal(ev?.windows[1]?.usedPercent, 15);
  // By its own time, whatever the order of the files: a rollout written to
  // later can hold an older reading in its tail.
  assert.equal(readLastWindows([older, sub, silent], policy)?.windows[0]?.usedPercent, 99);
  assert.equal(readLastWindows([silent], policy), null, 'never invented');
  assert.equal(readLastWindows([silent, sub, older], policy, 1), null, 'and only as far as it is told to look');
});

test('a server that starts shows Codex\'s bars even when the newest rollout names none', async () => {
  const { dir, day } = quotaDir();
  const now = Date.now();
  rollout(day, '01a00000-0000-7000-8000-00000000000a',
    line({ timestamp: iso(now - 100 * 60_000), type: 'event_msg', payload: { type: 'agent_message', message: 'handed over' } }), now - 100 * 60_000);
  rollout(day, '01a00000-0000-7000-8000-00000000000b', quota(99, 15, now - 140 * 60_000), now - 140 * 60_000);

  const { events } = await collect(dir);
  const seeded = events.find((e) => e.t === 'limits' && e.limits.provider === 'codex');
  assert.ok(seeded && seeded.t === 'limits', 'the tool\'s row is seeded at start');
  if (!seeded || seeded.t !== 'limits') return;
  assert.deepEqual(seeded.limits.windows.map((w) => w.usedPercent), [99, 15], 'with the windows of the rollout before');
  assert.equal(seeded.limits.plan, 'plus');
});

