import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { createFleet } from '../src/server/ceo/fleet.ts';
import type { FleetOptions, WorkOrder } from '../src/server/ceo/fleet.ts';
import type { JobEnd } from '../src/server/ceo/jobs.ts';
import type { Proposal } from '../src/server/ceo/proposals.ts';
import { weigh } from '../src/server/ceo/spend.ts';
import type { Snapshot } from '../src/shared/protocol.ts';

/*
 * A planned task through the fleet: the order's own model and rules on the
 * command line, one worker per repository, the silence clock, the tokens
 * and the session id read off the stream. Fake children, as always.
 */

const NOW = Date.parse('2026-09-18T09:00:00.000Z');

interface Fake {
  child: ChildProcess;
  stdout: PassThrough;
  killed: () => boolean;
}

function fakeChild(pid: number): Fake {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new PassThrough();
  let killed = false;
  Object.assign(child, {
    pid, stdout, stderr: new PassThrough(), stdin: new PassThrough(),
    kill: () => {
      if (killed) return true;
      killed = true;
      setImmediate(() => child.emit('close', null, 'SIGTERM'));
      return true;
    },
  });
  return { child, stdout, killed: () => killed };
}

function order(over: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: 't1:1', provider: 'claude', projectId: 'p-alpha', projectName: 'alpha', kind: 'plan',
    summary: 'Ship the export', task: 'do the export', model: 'opus', effort: null,
    allowed: { tests: true, commit: true, push: false }, resume: null, ceilingMs: null,
    origin: { planId: 'plan-1', taskId: 't1', attempt: 1 }, ...over,
  };
}

const snapshot = (): Snapshot => ({ at: NOW, limits: [], projects: [], sessions: [], agents: [], files: [], recent: [] });

interface Harness {
  fleet: ReturnType<typeof createFleet>;
  spawned: { bin: string; args: string[]; cwd: string }[];
  fakes: Fake[];
  ended: JobEnd[];
  sessions: string[];
}

function harness(t: TestContext, over: Partial<FleetOptions> = {}): Harness {
  const spawned: Harness['spawned'] = [];
  const fakes: Fake[] = [];
  const ended: JobEnd[] = [];
  const sessions: string[] = [];
  const fleet = createFleet({
    model: 'sonnet',
    codexModel: null,
    ledger: { blockedReason: () => null, record: () => {}, spentUsd: () => 0, save: () => {} } as never,
    execute: true,
    snapshot,
    cwdOf: (id) => (id === 'p-alpha' ? '/tmp/alpha' : id === 'p-beta' ? '/tmp/beta' : undefined),
    // No notes unless a test gives some: the real reader lists the folders of whoever runs the tests.
    memoryOf: () => null,
    authorized: () => null,
    onStart: () => {},
    onProgress: () => {},
    onAdopt: () => {},
    onSession: (_ref, id) => sessions.push(id),
    onEnd: (_ref, out) => ended.push(out),
    spawn: ((bin: string, args: string[], o: { cwd: string }) => {
      const f = fakeChild(1000 + fakes.length);
      fakes.push(f);
      spawned.push({ bin, args, cwd: o.cwd });
      return f.child;
    }) as never,
    ...over,
  });
  t.after(() => fleet.stopAll());
  return { fleet, spawned, fakes, ended, sessions };
}

const resultLine = (text: string, usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }): string =>
  `${JSON.stringify({ type: 'result', total_cost_usd: 0.3, result: text, session_id: 'sess-1', usage })}\n`;

test('an order carries its own model, the git rules as allow and deny, and no permission prompts', (t) => {
  const h = harness(t);
  const out = h.fleet.launch(order());
  assert.equal(out.ok, true, out.reason);
  const { bin, args, cwd } = h.spawned[0]!;
  assert.equal(bin, 'claude');
  assert.equal(cwd, '/tmp/alpha', 'the worker runs in the project');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.ok(args.includes('--permission-prompts'));
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  assert.ok(allowed.includes('Bash(npm test:*)'));
  assert.ok(allowed.includes('Bash(git commit:*)'));
  assert.ok(!allowed.includes('Bash(git push:*)'));
  const denied = args.slice(args.indexOf('--disallowedTools') + 1);
  assert.equal(denied[0], 'Bash(git push:*)');
  assert.ok(denied.includes('WebFetch') && denied.includes('Read(~/.ssh/**)'), 'what lives outside the sandbox is denied too');
  assert.ok(!args.includes('--resume'));
});

const settingsOf = (h: Harness, n: number): { sandbox: Record<string, unknown> } => {
  const args = h.spawned[n]!.args;
  return JSON.parse(args[args.indexOf('--settings') + 1]!) as { sandbox: Record<string, unknown> };
};

test('a Claude worker runs in the OS sandbox: no way out, no network unless it pushes, and inside it nothing asks', (t) => {
  // The allow-list alone was a fence: npm run, npx and the test runners run
  // whatever an injected worker writes into package.json or a Makefile, so
  // it could push with push unticked. The sandbox is the boundary -- and
  // since 2026-10-13 the only gate: with a list in front of it, seven workers
  // of one plan were refused 52 commands nobody was there to allow.
  const h = harness(t);
  assert.equal(h.fleet.launch(order()).ok, true);
  assert.equal(h.fleet.launch(order({ id: 't2:1', projectId: 'p-beta', projectName: 'beta', allowed: { tests: true, commit: true, push: true } } as never)).ok, true);
  const off = settingsOf(h, 0).sandbox;
  assert.equal(off['enabled'], true);
  assert.equal(off['failIfUnavailable'], true, 'no sandbox must mean no worker, not an unsandboxed one');
  assert.equal(off['allowUnsandboxedCommands'], false);
  assert.equal(off['autoAllowBashIfSandboxed'], true, 'what runs inside the boundary does not wait for a yes');
  assert.equal(off['excludedCommands'], undefined, 'push off: nothing runs outside');
  assert.deepEqual(off['network'], { strictAllowlist: true });
  assert.ok((off['filesystem'] as { denyRead: string[] }).denyRead.includes('~/.ssh'));
  const on = settingsOf(h, 1).sandbox;
  assert.deepEqual(on['excludedCommands'], ['git fetch', 'git fetch *', 'git pull', 'git pull *', 'git push', 'git push *']);
  for (const n of [0, 1]) assert.ok(h.spawned[n]!.args.includes('--strict-mcp-config'));
});

test('with commit unticked the shell cannot write in the repository\'s .git, and only where there is one', (t) => {
  // Once any command runs inside the sandbox, the deny on `git commit` typed
  // as such is no longer what keeps the history still: a `git stash`, a
  // `git update-ref` or a script that commits would go through it.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fleet-repo-'));
  fs.mkdirSync(path.join(repo, '.git'));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fleet-bare-'));
  const h = harness(t, { cwdOf: (id) => (id === 'p-alpha' ? repo : id === 'p-beta' ? bare : undefined) });
  const quiet = { tests: true, commit: false, push: false };
  assert.equal(h.fleet.launch(order({ allowed: quiet } as never)).ok, true);
  assert.equal(h.fleet.launch(order({ id: 't2:1', projectId: 'p-beta', projectName: 'beta', allowed: quiet } as never)).ok, true);
  const fsOf = (n: number): { denyWrite?: string[] } => settingsOf(h, n).sandbox['filesystem'] as { denyWrite?: string[] };
  assert.deepEqual(fsOf(0).denyWrite, [path.join(repo, '.git')]);
  // A missing path is never denied: on Linux the sandbox would hold it with
  // a placeholder file named `.git` in a folder that is not a repository.
  assert.equal(fsOf(1).denyWrite, undefined);
  const denied = h.spawned[1]!.args.slice(h.spawned[1]!.args.indexOf('--disallowedTools') + 1);
  assert.ok(denied.includes('Bash(git init:*)'), 'and no repository is made where you chose to have none');

  const h2 = harness(t, { cwdOf: () => repo });
  assert.equal(h2.fleet.launch(order()).ok, true);
  assert.equal((settingsOf(h2, 0).sandbox['filesystem'] as { denyWrite?: string[] }).denyWrite, undefined, 'a worker that may commit writes there');
});

test('with no model in the order the fleet model applies; with a session to resume there is --resume', (t) => {
  const h = harness(t);
  h.fleet.launch(order({ model: null, resume: 'sess-9' }));
  const { args } = h.spawned[0]!;
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.equal(args[args.indexOf('--resume') + 1], 'sess-9');
});

test('a worker of a project with notes may read them, by tool and by shell, and nothing beside them', (t) => {
  // The decsim2 worker asked three times for two notes of its own project:
  // the whole of ~/.claude/projects was one deny rule.
  const dir = '/Users/me/.claude/projects/-tmp-alpha/memory';
  const h = harness(t, { memoryOf: (cwd) => (cwd === '/tmp/alpha' ? { dir, slug: '-tmp-alpha' } : null) });
  assert.equal(h.fleet.launch(order()).ok, true);
  assert.equal(h.fleet.launch(order({ id: 't2:1', projectId: 'p-beta', projectName: 'beta' })).ok, true);
  const deniedOf = (n: number): string[] => h.spawned[n]!.args.slice(h.spawned[n]!.args.indexOf('--disallowedTools') + 1);
  const withNotes = deniedOf(0);
  assert.deepEqual((settingsOf(h, 0).sandbox['filesystem'] as { allowRead?: string[] }).allowRead, [dir]);
  assert.ok(!withNotes.includes('Read(~/.claude/projects/**)'));
  // The other projects, whole, without one of them being named on the command line.
  assert.ok(withNotes.includes('Read(~/.claude/projects/-tmp-alpha[0-9A-Za-z_.-]*/**)'), 'a longer name than its own');
  assert.ok(withNotes.includes('Read(~/.claude/projects/-tmp-[0-9B-Zb-z_.-]*/**)'), 'a name that parts from its own');
  assert.ok(!h.spawned[0]!.args.some((a) => a.includes('beta')));
  assert.ok(withNotes.includes('Read(~/.claude/projects/**/*.jsonl)'), 'every transcript');
  assert.ok(withNotes.includes('Edit(~/.claude/projects/**)'), 'and no note can be written');
  // A project with no notes: the whole folder, as before.
  assert.equal((settingsOf(h, 1).sandbox['filesystem'] as { allowRead?: string[] }).allowRead, undefined);
  assert.ok(deniedOf(1).includes('Read(~/.claude/projects/**)'));
});

test('with web ticked a Claude worker gets the two web tools, and its shell no network', (t) => {
  const h = harness(t);
  h.fleet.launch(order({ allowed: { commit: true, push: false, web: true } }));
  h.fleet.launch(order({ id: 't2:1', projectId: 'p-beta', projectName: 'beta' }));
  const part = (n: number): { allowed: string[]; denied: string[] } => {
    const a = h.spawned[n]!.args;
    return { allowed: a.slice(a.indexOf('--allowedTools') + 1, a.indexOf('--disallowedTools')), denied: a.slice(a.indexOf('--disallowedTools') + 1) };
  };
  for (const tool of ['WebFetch', 'WebSearch']) {
    assert.ok(part(0).allowed.includes(tool), `${tool} allowed with the box ticked`);
    assert.ok(!part(0).denied.includes(tool));
    assert.ok(part(1).denied.includes(tool), `${tool} denied without it`);
    assert.ok(!part(1).allowed.includes(tool));
  }
  assert.deepEqual(settingsOf(h, 0).sandbox['network'], { strictAllowlist: true }, 'the shell reaches no host either way');
  assert.equal(settingsOf(h, 0).sandbox['excludedCommands'], undefined);
});

test('a Claude order carries the effort you chose, and none when you chose none', (t) => {
  // A Claude task ran at Claude Code's default, whatever the plan said: the
  // effort was Codex's lever only and never reached this command line.
  const h = harness(t);
  h.fleet.launch(order({ effort: 'xhigh' }));
  const chosen = h.spawned[0]!.args;
  assert.equal(chosen[chosen.indexOf('--effort') + 1], 'xhigh');
  assert.ok(!chosen.some((a) => a.includes('model_reasoning_effort')), 'that is Codex\'s flag');
  h.fleet.launch(order({ id: 't2:1', projectId: 'p-beta', projectName: 'beta', effort: null }));
  assert.ok(!h.spawned[1]!.args.includes('--effort'), 'the default is Claude Code\'s own: nothing is passed');
  // A resumed session keeps what the task says now.
  h.fakes[0]!.child.kill();
  return new Promise<void>((done) => setImmediate(() => {
    h.fleet.launch(order({ id: 't1:2', effort: 'max', resume: 'sess-9', origin: { planId: 'plan-1', taskId: 't1', attempt: 2 } }));
    const resumed = h.spawned[2]!.args;
    assert.equal(resumed[resumed.indexOf('--effort') + 1], 'max');
    assert.equal(resumed[resumed.indexOf('--resume') + 1], 'sess-9');
    done();
  }));
});

test('a Codex order: no Claude aliases, sandbox with network only for the push, resume without -s', (t) => {
  const h = harness(t);
  h.fleet.launch(order({ provider: 'codex', model: null, effort: 'high', allowed: { tests: true, commit: true, push: true } }));
  const first = h.spawned[0]!.args;
  assert.equal(h.spawned[0]!.bin, 'codex');
  assert.ok(!first.includes('-m'));
  assert.ok(first.includes('model_reasoning_effort="high"'));
  assert.ok(first.includes('sandbox_workspace_write.network_access=true'));
  h.fleet.launch(order({ id: 't2:2', projectId: 'p-beta', projectName: 'beta', provider: 'codex', model: null, resume: 'thr-1', origin: { planId: 'plan-1', taskId: 't2', attempt: 2 } }));
  const second = h.spawned[1]!.args;
  assert.deepEqual(second.slice(0, 4), ['exec', 'resume', 'thr-1', '--json']);
  assert.ok(!second.includes('-s') && !second.includes('-C'));
  assert.ok(second.includes('sandbox_mode="workspace-write"'));
});

test('never two workers on the same repository, whichever path they come from', (t) => {
  const h = harness(t);
  assert.equal(h.fleet.launch(order()).ok, true);
  const again = h.fleet.launch(order({ id: 't2:1', origin: { planId: 'plan-1', taskId: 't2', attempt: 1 } }));
  assert.equal(again.ok, false);
  assert.match(again.reason, /another worker is on alpha \(t1:1\)/);
  const proposal = h.fleet.start({
    id: 'p1', at: NOW, provider: 'claude', kind: 'audit', summary: 's', projectId: 'p-alpha',
    projectName: 'alpha', task: 'audit', status: 'accepted', decidedAt: NOW, sessionId: null,
  });
  assert.equal(proposal.ok, false);
  assert.match(proposal.reason, /another worker is on alpha/);
  assert.equal(h.fleet.launch(order({ id: 't3:1', projectId: 'p-beta', projectName: 'beta', origin: { planId: 'plan-1', taskId: 't3', attempt: 1 } })).ok, true, 'another project does');
});

test('the second guardian: without authorization it does not start, and says why', (t) => {
  const h = harness(t, { authorized: () => 'the plan is paused' });
  const out = h.fleet.launch(order());
  assert.equal(out.ok, false);
  assert.match(out.reason, /the plan is paused/);
  assert.equal(h.spawned.length, 0);
  const none = harness(t, { authorized: undefined });
  assert.match(none.fleet.launch(order()).reason, /no authorizer/);
});

test('the worker delivers the weighted tokens and the session id read off the stream', async (t) => {
  const h = harness(t);
  h.fleet.launch(order());
  const f = h.fakes[0]!;
  f.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' })}\n`);
  f.stdout.write(resultLine('done'));
  await new Promise((r) => setTimeout(r, 5));
  f.child.emit('close', 0, null);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.sessions, ['sess-1']);
  assert.equal(h.ended[0]!.ok, true);
  assert.equal(h.ended[0]!.weighted, weigh({ in: 100, out: 50, cacheRead: 1000, cacheWrite: 0 }));
});

test('a silent worker is stopped, and its end says it went quiet', async (t) => {
  const h = harness(t, { silenceMs: 30 });
  h.fleet.launch(order());
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(h.fakes[0]!.killed());
  assert.equal(h.ended[0]!.ok, false);
  assert.match(h.ended[0]!.reason, /went quiet/);
});

test('every output line resets the silence clock: a worker that is working is not stopped', async (t) => {
  const h = harness(t, { silenceMs: 40 });
  h.fleet.launch(order());
  const f = h.fakes[0]!;
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 20));
    f.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } })}\n`);
  }
  assert.equal(f.killed(), false);
  f.stdout.write(resultLine('done'));
  await new Promise((r) => setTimeout(r, 5));
  f.child.emit('close', 0, null);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.ended[0]!.ok, true);
});

test('stopping a job by hand leaves the reason on its end', async (t) => {
  const h = harness(t);
  h.fleet.launch(order());
  assert.equal(h.fleet.stop({ id: 't1:1', kind: 'work' }, 'stopped: it was waiting for an answer'), true);
  // The end comes after the kill, the close and the fleet's own bookkeeping,
  // a few turns of the loop. A fixed 5 ms was enough alone and failed about
  // once in five under the full suite, with the machine busy: wait for the
  // end itself, bounded so a real hang still fails.
  for (const giveUp = Date.now() + 2000; h.ended.length === 0 && Date.now() < giveUp;) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(h.ended.length, 1, 'the stopped job never reported its end');
  assert.match(h.ended[0]!.reason, /waiting for an answer/);
  assert.equal(h.fleet.stop({ id: 'nope', kind: 'work' }, 'x'), false);
});

test('a Codex worker delivers its final message as the outcome', async (t) => {
  const h = harness(t);
  h.fleet.launch(order({ provider: 'codex', model: null }));
  const f = h.fakes[0]!;
  f.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'thr-7' })}\n`);
  f.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done: added the export.' } })}\n`);
  await new Promise((r) => setTimeout(r, 5));
  f.child.emit('close', 0, null);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.sessions, ['thr-7']);
  assert.equal(h.ended[0]!.ok, true);
  assert.equal(h.ended[0]!.outcome, 'Done: added the export.');
});

/* ───────── work started outside the plan: the same fence, the same reserve ───────── */

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1', at: NOW, provider: 'claude', kind: 'audit', summary: 'tidy up',
    projectId: 'p-alpha', projectName: 'alpha', task: 'tidy it up', status: 'accepted',
    decidedAt: NOW, sessionId: null, ...over,
  };
}

/** A session of yours, as the world model has it. */
const yours = (over: Record<string, unknown> = {}): Snapshot['sessions'][number] => ({
  projectId: 'p-alpha', provider: 'claude', spawnedByCeo: null, status: 'busy', lastActivityAt: Date.now(), ...over,
}) as never;

test('a worker from an accepted proposal is fenced: no commit, no push, no permission prompts', (t) => {
  // It used to run with no list at all: acceptEdits, and the shell whatever
  // the installation allowed. Measured on the audit of 13 September: twelve
  // shell commands that nothing had allowed.
  const h = harness(t);
  assert.equal(h.fleet.start(proposal()).ok, true);
  const { args } = h.spawned[0]!;
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  assert.ok(allowed.includes('Bash(npm test:*)'), 'the tests still run');
  assert.ok(allowed.includes('Bash(git log:*)'), 'the history can still be read');
  assert.ok(!allowed.includes('Bash(git commit:*)'));
  const denied = args.slice(args.indexOf('--disallowedTools') + 1);
  for (const d of ['Bash(git push:*)', 'Bash(git add:*)', 'Bash(git commit:*)']) assert.ok(denied.includes(d), d);
});

test('no worker goes where you are working, from a proposal or from the plan', (t) => {
  // The fleet was meant to guard this as well as the scheduler; only the
  // scheduler did, and an accepted proposal started on your repository at once.
  const busy = harness(t, { snapshot: () => ({ ...snapshot(), sessions: [yours()] }) });
  const fromCard = busy.fleet.start(proposal());
  assert.equal(fromCard.ok, false);
  assert.match(fromCard.reason ?? '', /you have a session active on alpha/);
  assert.equal(busy.fleet.launch(order()).ok, false, 'the plan has the same second guardian');
  assert.equal(busy.spawned.length, 0);

  // A CEO's own worker is not you, and a session quiet past the grace is not working.
  const quiet = harness(t, {
    snapshot: () => ({
      ...snapshot(),
      sessions: [yours({ spawnedByCeo: 'claude' }), yours({ status: 'idle', lastActivityAt: Date.now() - 60 * 60_000 })],
    }),
  });
  assert.equal(quiet.fleet.start(proposal()).ok, true);
});

test('the reserve holds for work started outside the plan too, and stops it on the line', (t) => {
  let breach: string | null = '5h at 74% reached the 30% reserve';
  const h = harness(t, { reserveBreach: () => breach });
  const refused = h.fleet.start(proposal());
  assert.equal(refused.ok, false);
  assert.match(refused.reason ?? '', /the reserve: 5h at 74%/);
  assert.equal(h.fleet.review(proposal(), '').ok, false, 'a second opinion is a session too');

  breach = null;
  assert.equal(h.fleet.start(proposal()).ok, true);
  assert.equal(h.fleet.launch(order({ projectId: 'p-beta', projectName: 'beta' })).ok, true);
  breach = '5h at 71% reached the 30% reserve';
  h.fleet.guardReserve(Date.now());
  assert.equal(h.fakes[0]!.killed(), true, "the proposal's worker is stopped");
  assert.equal(h.fakes[1]!.killed(), false, "the plan's task is the desk's to stop, with the plan paused");
});

test('a Codex second opinion that continues a session is held read-only', (t) => {
  // `exec fork` takes no -s, and without an override it ran with whatever
  // sandbox the user's Codex config sets.
  const h = harness(t);
  assert.equal(h.fleet.review(proposal({ provider: 'codex' }), 'thr-1').ok, true);
  const { args } = h.spawned[0]!;
  assert.deepEqual(args.slice(0, 3), ['exec', 'fork', 'thr-1']);
  assert.equal(args[args.indexOf('-c') + 1], 'sandbox_mode="read-only"');
});

test('a Claude second opinion changes nothing and loads no MCP server', (t) => {
  const h = harness(t);
  assert.equal(h.fleet.review(proposal(), 'sess-1').ok, true);
  const { args } = h.spawned[0]!;
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  assert.ok(args.includes('--fork-session'), 'it continues a copy, never the session itself');
  assert.ok(args.includes('--strict-mcp-config'));
});
