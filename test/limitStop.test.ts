import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { World } from '../src/server/state/world.ts';
import type { LiveSession } from '../src/server/providers/types.ts';
import { parseLine, createStats } from '../src/server/parse/records.ts';
import { project, createContext, assertSafe } from '../src/server/parse/redact.ts';
import type { RedactOptions } from '../src/server/parse/redact.ts';
import { CodexProvider } from '../src/server/providers/codex/provider.ts';
import { parseRolloutLine, readLimitStop } from '../src/server/providers/codex/rollouts.ts';
import { crewStatus } from '../src/client/state/status.ts';
import { limitStopText } from '../src/client/ui/format.ts';
import type { DeltaEvent } from '../src/shared/protocol.ts';

/*
 * A session stopped at the usage limit, as the page learns it.
 *
 * Field case, 2026-10-15/16: three Claude Code sessions on this machine, one
 * of them in tower_defense, were refused with "You've hit your session
 * limit", and none of them went on when the limit reset: an interactive
 * session waits for you to type. On screen they looked done. The user asked
 * for a red cross on the project, saying it stopped on credit and has to be
 * restarted; these tests hold what it is fed. Every id below is made up.
 */

const CWD = '/Users/tester/proj';
const SID = '8f44d010-1111-4222-8333-444455556666';
const NOW = Date.parse('2026-10-16T09:20:53.364Z');
/** 09:40 UTC, as the refusal declares it: seconds. */
const RESETS_S = Date.parse('2026-10-16T09:40:00.000Z') / 1000;

const OPTS: RedactOptions = {
  projectId: 'proj123', cwd: CWD, redactPaths: false, cmdNames: true, titles: true, recap: true,
};

const TEXT = "You've hit your session limit · resets 9:40am (UTC)";

/** The refusal as Claude Code 2.1.301 writes it, trimmed of fields nobody reads. */
const refusal = (extra: Record<string, unknown> = {}): string => JSON.stringify({
  parentUuid: '11111111-2222-4333-8444-555555555555', isSidechain: false, type: 'assistant',
  uuid: '66666666-7777-4888-8999-aaaaaaaaaaaa', timestamp: new Date(NOW).toISOString(),
  message: {
    id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', model: '<synthetic>', role: 'assistant',
    stop_reason: 'stop_sequence', type: 'message',
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    content: [{ type: 'text', text: TEXT }],
  },
  requestId: 'req_0000000000000000000test',
  apiError: 'usage_limit_reached',
  apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: RESETS_S, rateLimitType: 'five_hour' } },
  quotaLimits: { status: 'rejected', resetsAt: RESETS_S, rateLimitType: 'five_hour' },
  error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429,
  cwd: CWD, sessionId: SID, version: '2.1.301', gitBranch: 'main',
  ...extra,
});

function projected(line: string): DeltaEvent[] {
  const rec = parseLine(line, createStats());
  if (!rec) return [];
  const out = project(rec, createContext(), OPTS);
  for (const ev of out) assertSafe(ev);
  return out;
}

test('a refusal at the usage limit reaches the page as two times, and not its text', () => {
  const events = projected(refusal());
  assert.equal(events.length, 1);
  const ev = events[0]!;
  assert.ok(ev.t === 'session.update');
  assert.equal(ev.id, SID);
  assert.deepEqual(ev.patch, { limitStoppedAt: NOW, limitResetsAt: RESETS_S * 1000 });
  assert.equal(JSON.stringify(events).includes('hit your'), false, 'the refusal text got out');
});

test('a refusal from before 2.1.29x is a stop with no reset', () => {
  // Measured: 2.1.273 to 2.1.28x write `error: "rate_limit"` and the text,
  // with no `apiError` and no `resetsAt`.
  const old = JSON.parse(refusal()) as Record<string, unknown>;
  delete old['apiError'];
  delete old['apiErrorParams'];
  delete old['quotaLimits'];
  old['version'] = '2.1.284';
  const [ev] = projected(JSON.stringify(old));
  assert.ok(ev && ev.t === 'session.update');
  assert.deepEqual(ev.patch, { limitStoppedAt: NOW, limitResetsAt: null });
});

test("a subagent refused inside a session is not the session stopping", () => {
  assert.deepEqual(projected(refusal({ isSidechain: true, agentId: 'a0123456789abcdef' })), []);
  assert.deepEqual(projected(refusal({ agentId: 'a0123456789abcdef' })), []);
});

test('an API error that is not about usage is not a stop at the limit', () => {
  // "API Error: Can't reach the API server" stops a turn too, but nothing
  // about it waits for a reset.
  const events = projected(refusal({ error: 'server_error', apiErrorStatus: undefined }));
  assert.equal(events.some((e) => e.t === 'session.update' && 'limitStoppedAt' in e.patch), false);
});

test("an API key's empty balance is the same stop", () => {
  const [ev] = projected(refusal({ error: 'billing_error', apiError: undefined, apiErrorParams: undefined, quotaLimits: undefined }));
  assert.ok(ev && ev.t === 'session.update');
  assert.equal(ev.patch.limitStoppedAt, NOW);
});

function world(): World {
  const slots = new Map<string, number>();
  return new World({
    homeDir: '/Users/tester',
    placement: {
      slotOf: (id) => {
        if (!slots.has(id)) slots.set(id, slots.size);
        return slots.get(id)!;
      },
      assignMany: () => {},
      save: () => {},
    },
    redactPaths: false,
    titles: true,
    seedRecap: () => null,
  });
}

const live = (provider: 'claude' | 'codex', stop?: { at: number | null; resets?: number | null }): LiveSession => ({
  sessionId: SID, provider, pid: 1, cwd: CWD, label: 'proj-7b',
  title: null, status: 'idle', statusConfidence: 'reported', waitingFor: null,
  kind: 'interactive', version: '2.1.301', model: 'opus',
  startedAt: NOW - 3_600_000, updatedAt: NOW, statusSince: NOW,
  ...(stop === undefined ? {} : { limitStoppedAt: stop.at, limitResetsAt: stop.resets ?? null }),
});

const usage = (tokens: number, agentId: string | null = null): DeltaEvent => ({
  t: 'usage', sessionId: SID, agentId, at: NOW + 60_000, model: 'claude-opus-5-5',
  delta: { in: 0, out: tokens, cacheRead: tokens * 10, cacheWrite: 0, thinking: 0 },
});

/** A Claude Code session the transcript said was refused at the limit. */
function stoppedClaude(): World {
  const w = world();
  w.applyLiveSessions('claude', [live('claude')], () => true, () => NOW, () => ({ files: 40, dirs: 0 }));
  w.applySessionPatch(SID, { limitStoppedAt: NOW, limitResetsAt: RESETS_S * 1000 }, NOW);
  return w;
}

test('a registry pass does not erase the stop the transcript told', () => {
  // The registry says `idle` and knows nothing of why: a pass a second later
  // putting the field back to null would make the cross last one tick.
  const w = stoppedClaude();
  const events = w.applyLiveSessions('claude', [live('claude')], () => true, () => NOW + 1000, () => ({ files: 40, dirs: 0 }));
  assert.equal(w.session(SID)?.limitStoppedAt, NOW);
  assert.equal(events.some((e) => e.t === 'session.update' && 'limitStoppedAt' in e.patch), false);
});

test('the stop ends when you type, and says so once', () => {
  const w = stoppedClaude();
  const prompt: DeltaEvent = {
    t: 'prompt', sessionId: SID, promptId: 'p1', at: NOW + 1_200_000, chars: 8, source: 'typed',
  };
  const events = w.resumeAfterLimit(prompt);
  assert.deepEqual(events.map((e) => e.t === 'session.update' && e.patch),
    [{ limitStoppedAt: null, limitResetsAt: null }]);
  assert.equal(w.session(SID)?.limitStoppedAt, null);
  assert.deepEqual(w.resumeAfterLimit(prompt), [], 'a session that is not stopped has nothing to clear');
});

test('a reply the API served ends the stop; the refusal and a subagent do not', () => {
  // The refusal is written with zero usage, and it is projected like any
  // reply: if it cleared the stop it would end it the instant it began.
  const w = stoppedClaude();
  assert.deepEqual(w.resumeAfterLimit(usage(0)), []);
  assert.deepEqual(w.resumeAfterLimit(usage(317, 'afedcba9876543210')), []);
  assert.equal(w.session(SID)?.limitStoppedAt, NOW);
  assert.equal(w.resumeAfterLimit(usage(317)).length, 1);
  assert.equal(w.session(SID)?.limitStoppedAt, null);
});

test('a Codex stop is its provider\'s to say, both ways', () => {
  const w = world();
  const born = w.applyLiveSessions('codex', [live('codex', { at: null })], () => true, () => NOW, () => ({ files: 40, dirs: 0 }));
  const added = born.find((e) => e.t === 'session.add');
  assert.ok(added && added.t === 'session.add');
  assert.equal(added.session.limitStoppedAt, null);

  const stopped = w.applyLiveSessions('codex', [live('codex', { at: NOW, resets: NOW + 3_600_000 })],
    () => true, () => NOW, () => ({ files: 40, dirs: 0 }));
  assert.ok(stopped.some((e) => e.t === 'session.update' &&
    e.patch.limitStoppedAt === NOW && e.patch.limitResetsAt === NOW + 3_600_000));
  // A served reply does not clear it here: the provider says it on every
  // pass, and two places deciding would fight over it.
  assert.deepEqual(w.resumeAfterLimit(usage(317)), []);

  const again = w.applyLiveSessions('codex', [live('codex', { at: NOW, resets: NOW + 3_600_000 })],
    () => true, () => NOW, () => ({ files: 40, dirs: 0 }));
  assert.equal(again.some((e) => e.t === 'session.update' && 'limitStoppedAt' in e.patch), false,
    'the same stop sent again on every provider tick');
  const restarted = w.applyLiveSessions('codex', [live('codex', { at: null })], () => true, () => NOW, () => ({ files: 40, dirs: 0 }));
  assert.ok(restarted.some((e) => e.t === 'session.update' &&
    e.patch.limitStoppedAt === null && e.patch.limitResetsAt === null));
});

test('a session stopped at the limit is blocked, even with a shell left running', () => {
  const base = { status: 'idle' as const, statusSince: NOW, lastActivityAt: NOW };
  assert.equal(crewStatus({ ...base, limitStoppedAt: NOW }, null, NOW), 'blocked');
  assert.equal(crewStatus({ ...base, status: 'busy', limitStoppedAt: NOW }, null, NOW), 'blocked');
  assert.equal(crewStatus({ ...base, limitStoppedAt: null }, null, NOW), 'idle');
  // A server older than the field sends none: no stop, not a crash.
  assert.equal(crewStatus(base as never, null, NOW), 'idle');
});

test('the words say what it takes to start it again, before and after the reset', () => {
  const resets = NOW + 80 * 60_000;
  const before = limitStopText({ limitStoppedAt: NOW - 600_000, limitResetsAt: resets }, NOW);
  assert.ok(before);
  assert.equal(before.since, '10m 00s');
  assert.match(before.next, /^The limit resets at .+, in 1h 20m\. It will not start again by itself/);

  const after = limitStopText({ limitStoppedAt: NOW - 600_000, limitResetsAt: resets }, resets + 1);
  assert.match(after!.next, /^The limit has reset: send it a message/);

  const unknown = limitStopText({ limitStoppedAt: NOW, limitResetsAt: null }, NOW);
  assert.match(unknown!.next, /once the limit resets$/);

  assert.equal(limitStopText({ limitStoppedAt: null, limitResetsAt: null }, NOW), null);
});

/* ─────────────────────────── Codex ─────────────────────────── */

const CODEX_SID = '01a00000-0000-7000-8000-000000000001';
const line = (o: unknown): string => JSON.stringify(o) + '\n';
const iso = (ms: number): string => new Date(ms).toISOString();

/** A turn refused at the limit, as Codex wrote 17 of them in September and October. */
const refusedTurn = (turnId: string, at: number): string =>
  line({ timestamp: iso(at - 3000), ordinal: 30, type: 'event_msg',
    payload: { type: 'task_started', turn_id: turnId, started_at: Math.floor((at - 3000) / 1000) } }) +
  // The account's windows, then the credit balance with none: measured, in this order.
  line({ timestamp: iso(at - 600), ordinal: 31, type: 'event_msg',
    payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex',
      primary: { used_percent: 99.0, window_minutes: 300, resets_at: Math.floor((at + 7_200_000) / 1000) },
      secondary: { used_percent: 49.0, window_minutes: 10080, resets_at: Math.floor((at + 400_000_000) / 1000) },
      plan_type: 'plus' } } }) +
  line({ timestamp: iso(at - 500), ordinal: 32, type: 'event_msg',
    payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'premium',
      primary: null, secondary: null, credits: { has_credits: false, unlimited: false, balance: '0' },
      plan_type: 'plus' } } }) +
  line({ timestamp: iso(at), ordinal: 33, type: 'event_msg',
    payload: { type: 'task_complete', turn_id: turnId, last_agent_message: null,
      error: { message: "You've hit your usage limit. Upgrade to Pro or try again at Oct 6th, 2026 12:44 AM.",
               codex_error_info: 'usage_limit_exceeded' },
      duration_ms: 3000 } });

function codexDir(body: string, ageMs: number): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-limit-'));
  const day = path.join(dir, 'sessions', '2026', '10', '05');
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-2026-10-05T20-40-00-${CODEX_SID}.jsonl`);
  fs.writeFileSync(file, body);
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
  fs.writeFileSync(path.join(dir, 'state_5.sqlite'), '');
  return { dir, file };
}

const head = (at: number): string =>
  line({ timestamp: iso(at), ordinal: 0, type: 'session_meta',
    payload: { session_id: CODEX_SID, cwd: CWD, cli_version: '0.154.0' } }) +
  line({ timestamp: iso(at), ordinal: 1, type: 'turn_context', payload: { model: 'gpt-6-astra', cwd: CWD } });

async function codexSessions(dir: string): Promise<LiveSession[]> {
  const provider = new CodexProvider({
    codexDir: dir,
    policy: { claudeDir: '/nowhere/.claude', codexDir: dir, homeDir: '/Users/tester' },
    redactPaths: false, cmdNames: true, titles: true,
    known: () => true, produces: () => true, devAssert: true, stats: createStats(),
  });
  const sessions: LiveSession[] = [];
  provider.start({
    onProjects: () => {},
    onSessions: (s) => sessions.splice(0, sessions.length, ...s),
    onEvents: () => {},
  });
  await new Promise((r) => setTimeout(r, 1400));
  provider.stop();
  return sessions;
}

test('a Codex turn refused at the limit is told by its code, not its message', () => {
  const at = Date.parse('2026-10-05T18:48:09.390Z');
  const ev = parseRolloutLine(refusedTurn('t1', at).trim().split('\n').pop()!);
  assert.ok(ev && ev.kind === 'turn_completed');
  assert.equal(ev.limited, true);
  const plain = parseRolloutLine(line({ timestamp: iso(at), type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 't2', duration_ms: 4500, last_agent_message: 'done' } }));
  assert.ok(plain && plain.kind === 'turn_completed');
  assert.equal(plain.limited, false);
});

test('a Codex chat stopped at the limit says when, and the reset of its fullest window', async () => {
  // Past the four seconds a closed turn still reads as busy (`SETTLE_MS`).
  const at = Date.now() - 6000;
  const { dir } = codexDir(head(at - 10_000) + refusedTurn('t1', at), 0);
  const [s] = await codexSessions(dir);
  assert.ok(s);
  assert.equal(s.limitStoppedAt, at);
  // The 5h at 99% over the 7d at 49%, not the credit balance that came after.
  assert.equal(s.limitResetsAt, Math.floor((at + 7_200_000) / 1000) * 1000);
  assert.equal(s.status, 'idle');
});

test('a turn that starts after the stop ends it', async () => {
  const at = Date.now() - 5000;
  const resumed = line({ timestamp: iso(at + 2000), ordinal: 40, type: 'event_msg',
    payload: { type: 'task_started', turn_id: 't2', started_at: Math.floor((at + 2000) / 1000) } });
  const { dir } = codexDir(head(at - 10_000) + refusedTurn('t1', at) + resumed, 0);
  const [s] = await codexSessions(dir);
  assert.equal(s?.limitStoppedAt, null);
});

test('a Codex chat stopped hours ago stays on stage, also after a restart of the server', async () => {
  // Off the live window by its events and its mtime: discovery would not
  // open it, and the stop of the night would be gone in the morning. The
  // first tick runs while its rollout is still being read: closed then, it
  // never came on stage.
  const at = Date.now() - 5 * 3_600_000;
  const { dir, file } = codexDir(head(at - 10_000) + refusedTurn('t1', at), 5 * 3_600_000);
  assert.deepEqual(readLimitStop(file, { claudeDir: '/nowhere', codexDir: dir, homeDir: '/Users/tester' }),
    { atMs: at, resetsAt: Math.floor((at + 7_200_000) / 1000) * 1000 });
  const sessions = await codexSessions(dir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.limitStoppedAt, at);
});

test('a Codex chat stopped more than a day ago, or that went on, is not held', async () => {
  const old = Date.now() - 26 * 3_600_000;
  const stale = codexDir(head(old - 10_000) + refusedTurn('t1', old), 26 * 3_600_000);
  assert.deepEqual(await codexSessions(stale.dir), []);

  const at = Date.now() - 5 * 3_600_000;
  const done = line({ timestamp: iso(at + 60_000), ordinal: 41, type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 't2', duration_ms: 4500, last_agent_message: 'ok' } });
  const restarted = line({ timestamp: iso(at + 50_000), ordinal: 40, type: 'event_msg',
    payload: { type: 'task_started', turn_id: 't2', started_at: Math.floor((at + 50_000) / 1000) } });
  const resumed = codexDir(head(at - 10_000) + refusedTurn('t1', at) + restarted + done, 5 * 3_600_000);
  assert.deepEqual(await codexSessions(resumed.dir), []);
});
