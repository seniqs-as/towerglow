import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/server/state/world.ts';
import { parseLine, createStats } from '../src/server/parse/records.ts';
import { project, createContext } from '../src/server/parse/redact.ts';
import type { RedactOptions } from '../src/server/parse/redact.ts';
import type { DeltaEvent } from '../src/shared/protocol.ts';
import type { LiveSession } from '../src/server/providers/types.ts';

/**
 * A subagent in the background that stops to wait on background work of its own.
 *
 * Measured on tower_defense on 2026-10-15 (Claude Code 2.1.300): a subagent
 * ran 31 minutes, started the full test suite in the background and stopped
 * to wait for it, for an hour. Claude Code sends a `completed` notification
 * whose summary says it "is waiting on its own background work" -- not its
 * end, and only the first one names the call -- and its registry says
 * `shell`, because what still runs is the subagent's shell. The server read
 * the notification as the end and the `shell` as the user's `!`, and the
 * tower showed the "done" tick while the subagent was still at work.
 */

const CWD = '/Users/tester/code/tower_defense';
const CALL = 'toolu_011zcQVZqu6kUeSPBqKv3L3j';
const TASK = 'a6317cc5994dbab56';
const OUTPUT = '/private/tmp/claude-501/-Users-tester-code-tower-defense/s1/tasks/a6317cc5994dbab56.output';

const OPTS: RedactOptions = {
  projectId: 'p1', cwd: CWD, redactPaths: false, cmdNames: true, titles: true, recap: true,
};

function newWorld(): World {
  return new World({
    homeDir: '/Users/tester',
    placement: { slotOf: () => 0, assignMany: () => {}, save: () => {} },
    redactPaths: false,
    titles: true,
  });
}

const live = (over: Partial<LiveSession> = {}): LiveSession => ({
  sessionId: 's1', provider: 'claude', pid: 1, cwd: CWD, label: 'td-5c',
  title: null, status: 'busy', statusConfidence: 'reported', waitingFor: null,
  kind: 'interactive', version: '2.1.300', model: 'opus',
  startedAt: 1000, updatedAt: 1000, statusSince: 1000,
  ...over,
});

const registry = (world: World, s: LiveSession): DeltaEvent[] =>
  world.applyLiveSessions('claude', [s], () => true, () => 1000, () => 40);

// What the registry source makes of "status": "shell" and of "idle".
const shellOnly = (): LiveSession => live({ status: 'idle', backgroundShell: true, updatedAt: 2000 });
const idle = (): LiveSession => live({ status: 'idle', updatedAt: 3000 });

/** The shape of the real notification; `call` only on the first one of a task. */
function notification(outcome: string, interim: boolean, call: string | null): string {
  const note = interim
    ? 'This agent stopped with background work of its own still running. It may resume on its own when ' +
      'that work completes or reports, and the same task-id notifies again if it does; the result below may be interim.'
    : 'A task-notification fires each time this agent stops with no live background children of its own. ' +
      'The user can send it another message and resume it, so the same task-id may notify more than once.';
  return `<task-notification>\n<task-id>${TASK}</task-id>\n` +
    (call ? `<tool-use-id>${call}</tool-use-id>\n` : '') +
    `<output-file>${OUTPUT}</output-file>\n<status>completed</status>\n` +
    `<summary>Agent "Phase 2 builder" ${outcome}</summary>\n<note>${note}</note>\n` +
    `<result>the agent's report, which stays here</result>\n` +
    `<usage><subagent_tokens>273158</subagent_tokens><tool_uses>100</tool_uses>` +
    `<duration_ms>1887096</duration_ms></usage>\n</task-notification>`;
}

/** A notification arrives twice: queued, then as the message the session reads. */
const delivered = (at: string, content: string): string[] => [
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: 's1', timestamp: at, content }),
  JSON.stringify({
    type: 'user', sessionId: 's1', timestamp: at, promptSource: 'system',
    origin: { kind: 'task-notification', producer: 'session-task' },
    message: { role: 'user', content },
  }),
];

const launch = [
  JSON.stringify({
    type: 'assistant', sessionId: 's1', requestId: 'r1', timestamp: '2026-10-15T10:17:54.000Z',
    message: {
      model: 'claude-opus-5-5', usage: {},
      content: [{
        type: 'tool_use', id: CALL, name: 'Agent',
        input: { description: 'Phase 2 builder', subagent_type: 'general-purpose', prompt: 'the brief' },
      }],
    },
  }),
  JSON.stringify({
    type: 'user', sessionId: 's1', timestamp: '2026-10-15T10:17:55.036Z',
    message: { content: [{ type: 'tool_result', tool_use_id: CALL, is_error: false, content: 'Async agent launched' }] },
    toolUseResult: { isAsync: true, status: 'async_launched', agentId: TASK, description: 'Phase 2 builder' },
  }),
];

const waiting = 'is waiting on its own background work';

/** The transcript's events, routed into the model the way `cli.ts` routes them. */
function feed(world: World, lines: string[]): DeltaEvent[] {
  const stats = createStats();
  const ctx = createContext();
  const events: DeltaEvent[] = [];
  for (const line of lines) {
    const rec = parseLine(line, stats);
    if (!rec) continue;
    for (const ev of project(rec, ctx, OPTS)) {
      events.push(ev);
      if (ev.t === 'agent.remove') {
        world.endAgent(ev.id, ev.at);
        world.endShell(ev.id, ev.at);
        continue;
      }
      world.noteSessionEvent(ev);
      world.trackAgent(ev);
      world.openShell(ev);
    }
  }
  return events;
}

const statusOf = (world: World): string | undefined => world.session('s1')?.status;
const agentsOf = (world: World): string[] => world.snapshot().agents.map((a) => a.id);

test('a subagent waiting on its own background work keeps the tower working', () => {
  const world = newWorld();
  registry(world, live());
  feed(world, [
    ...launch,
    ...delivered('2026-10-15T10:49:24.736Z', notification(waiting, true, CALL)),
    ...delivered('2026-10-15T11:17:28.385Z', notification(waiting, true, null)),
  ]);
  assert.deepEqual(agentsOf(world), [CALL], 'a notification that it is waiting closed the subagent');

  // The session's turn is over; what runs is the subagent's shell.
  registry(world, shellOnly());
  assert.equal(statusOf(world), 'busy', 'the tower showed "done" while the subagent waited on its tests');
});

test('the subagent\'s last notification ends it even though it names only the task', () => {
  const world = newWorld();
  registry(world, live());
  feed(world, [...launch, ...delivered('2026-10-15T10:49:24.736Z', notification(waiting, true, CALL))]);
  registry(world, shellOnly());
  assert.deepEqual(agentsOf(world), [CALL]);

  // The real one was only ever queued: it arrived during a turn, which
  // absorbed it, and it never became a message.
  const [queued] = delivered('2026-10-15T12:06:16.002Z', notification('finished', false, null));
  feed(world, [queued!]);
  assert.deepEqual(agentsOf(world), [], 'a subagent that delivered stayed on stage');
  // A shell still runs -- the user's `!` -- and is not the agent's work.
  assert.equal(statusOf(world), 'idle');
  assert.equal(world.session('s1')?.agentsActive, 0);
});

test('a notification is never read as a prompt you typed', () => {
  const world = newWorld();
  registry(world, live());
  const events = feed(world, [
    ...launch,
    ...delivered('2026-10-15T10:49:24.736Z', notification(waiting, true, CALL)),
    ...delivered('2026-10-15T11:17:28.385Z', notification(waiting, true, null)),
    ...delivered('2026-10-15T12:10:00.000Z', notification('finished', false, null)),
  ]);
  assert.deepEqual(events.filter((e) => e.t === 'prompt'), [], 'a notification landed the prompt\'s lander');
  assert.equal(JSON.stringify(events).includes('report'), false, 'the report got out');
});

test('a subagent\'s report handed back is not a prompt you typed', () => {
  // A subagent that reports through SubagentHandback: the report reaches the
  // session as a message from another session, queued and then read, a few
  // milliseconds before the notification that it finished.
  const report = `<agent-message from="${TASK}">\n[Subagent hand-back] The text below is the final report ` +
    `of a subagent this session delegated to.\n\nthe report itself\n</agent-message>`;
  const world = newWorld();
  registry(world, live());
  const events = feed(world, [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: 's1', timestamp: '2026-10-15T12:06:15.972Z', content: report }),
    JSON.stringify({
      type: 'user', sessionId: 's1', timestamp: '2026-10-15T12:06:16.060Z', isMeta: true, promptSource: 'system',
      origin: { kind: 'peer', from: TASK, senderTaskId: TASK, name: 'general-purpose', body: '[Subagent hand-back] …' },
      message: { role: 'user', content: `Another Claude session sent a message:\n${report}\n` },
    }),
  ]);
  assert.deepEqual(events.filter((e) => e.t === 'prompt'), [], 'the report turned the astronaut back as if you had written');
});

test('the notes Claude Code adds around a turn are not prompts, what you type still is', () => {
  const user = (over: Record<string, unknown>, content: string): string => JSON.stringify({
    type: 'user', sessionId: 's1', timestamp: '2026-10-15T12:00:00.000Z', message: { role: 'user', content }, ...over,
  });
  const world = newWorld();
  registry(world, live());
  const events = feed(world, [
    user({ isMeta: true }, '<local-command-caveat>Caveat: the messages below were generated by the user</local-command-caveat>'),
    user({ isMeta: true }, '[Image: original 1440x900, displayed at 1440x900]'),
    user({ origin: { kind: 'human' }, promptSource: 'typed', promptId: 'p1' }, 'typed by you'),
    // `claude -p` and older versions write no origin at all.
    user({ promptSource: 'sdk', promptId: 'p2' }, 'the brief of a worker'),
  ]);
  assert.deepEqual(events.filter((e) => e.t === 'prompt').map((e) => (e as { promptId: string }).promptId), ['p1', 'p2']);
});

test('a background subagent outlives the age net while its tool says it runs', () => {
  // It ran 31 minutes before it first stopped: closed at 30, it was gone
  // before it could say it was waiting.
  const world = newWorld();
  registry(world, live());
  const longAgo = new Date(Date.now() - 95 * 60_000).toISOString();
  feed(world, launch.map((line) => line.replace(/"timestamp":"[^"]+"/, `"timestamp":"${longAgo}"`)));

  registry(world, live({ updatedAt: 1500 }));
  assert.deepEqual(agentsOf(world), [CALL], 'closed while the registry said a subagent runs');
  registry(world, shellOnly());
  assert.deepEqual(agentsOf(world), [CALL], 'closed while it waited on its own shell');
  assert.equal(statusOf(world), 'busy');

  // Idle: Claude Code itself says no subagent and no shell of this session
  // runs, so one still open is a delivery this model missed.
  registry(world, idle());
  assert.deepEqual(agentsOf(world), [], 'an orphan stayed on stage once nothing ran');
  assert.equal(statusOf(world), 'idle');
});

test('a synchronous subagent still open does not turn the user\'s shell into work', () => {
  // It ends with its call: open under a `shell`, its end was lost.
  const world = newWorld();
  registry(world, live());
  world.trackAgent({
    t: 'tool.start', id: 'toolu_sync', sessionId: 's1', agentId: null,
    name: 'Agent', cat: 'agent', at: Date.now(), target: { kind: 'agent', agentType: 'Explore' },
  });
  registry(world, shellOnly());
  assert.equal(statusOf(world), 'idle');
});
