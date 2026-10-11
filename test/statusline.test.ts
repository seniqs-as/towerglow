import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  installStatusline, statuslineStatus, uninstallStatusline, dataPath, StatuslineError,
} from '../src/server/statusline/installer.ts';
import { StatuslineReader } from '../src/server/statusline/reader.ts';
import type { DeltaEvent } from '../src/shared/protocol.ts';

/** A fake $HOME: no test ever touches the real ~/.claude. */
function fakeHome(settings?: unknown): { claudeDir: string; stateDir: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sl-'));
  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  if (settings !== undefined) {
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  }
  return { claudeDir, stateDir: path.join(root, '.towerglow'), root };
}

/** What these settings really look like: many keys, and a status line of its own already. */
const REAL_SHAPE = {
  agentPushNotifEnabled: true,
  effortLevel: 'high',
  extraKnownMarketplaces: {},
  language: 'it',
  model: 'opus',
  modelSettings: { opus: { effortLevel: 'high' } },
  statusLine: { type: 'command', command: 'bash /Users/tester/.claude/statusline.sh' },
  tui: { theme: 'dark' },
  voice: 'off',
  voiceEnabled: false,
};

test('installs without touching the other keys, nor their order', () => {
  const p = fakeHome(REAL_SHAPE);
  installStatusline(p);

  const after = JSON.parse(fs.readFileSync(path.join(p.claudeDir, 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(after), Object.keys(REAL_SHAPE), 'key order changed');
  for (const k of Object.keys(REAL_SHAPE)) {
    if (k === 'statusLine') continue;
    assert.deepEqual(after[k], (REAL_SHAPE as Record<string, unknown>)[k], `key altered: ${k}`);
  }
  assert.match(after.statusLine.command, /statusline-bridge\.sh$/);
});

test('the bridge contains the status line that was there, and runs it', () => {
  const p = fakeHome(REAL_SHAPE);
  const status = installStatusline(p);
  assert.equal(status.installed, true);
  assert.equal(status.wrapped, 'bash /Users/tester/.claude/statusline.sh');

  const script = fs.readFileSync(status.bridgePath, 'utf8');
  assert.ok(script.includes('bash /Users/tester/.claude/statusline.sh'), 'original command lost');
  assert.ok(script.includes('latest.json'), 'the bridge saves nothing');
  // It must be executable, otherwise the bar disappears.
  assert.equal((fs.statSync(status.bridgePath).mode & 0o100) !== 0, true);
});

test('reinstalling updates, it does not wedge the bridge inside itself', () => {
  const p = fakeHome(REAL_SHAPE);
  installStatusline(p);
  const second = installStatusline(p);

  assert.equal(second.wrapped, 'bash /Users/tester/.claude/statusline.sh');
  const script = fs.readFileSync(second.bridgePath, 'utf8');
  assert.equal(script.includes('statusline-bridge.sh'), false, 'the bridge wraps itself');
});

test('uninstalling puts the file back exactly as it was', () => {
  const p = fakeHome(REAL_SHAPE);
  const file = path.join(p.claudeDir, 'settings.json');
  const before = fs.readFileSync(file, 'utf8');

  installStatusline(p);
  assert.notEqual(fs.readFileSync(file, 'utf8'), before);

  uninstallStatusline(p);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'settings.json did not come back identical');
  assert.equal(fs.existsSync(path.join(p.stateDir, 'statusline-bridge.sh')), false);
});

test('with no statusLine before, the key disappears entirely on uninstall', () => {
  const p = fakeHome({ model: 'opus' });
  installStatusline(p);
  uninstallStatusline(p);
  const after = JSON.parse(fs.readFileSync(path.join(p.claudeDir, 'settings.json'), 'utf8'));
  assert.equal('statusLine' in after, false);
  assert.equal(after.model, 'opus');
});

test('uninstalling without ever installing leaves your status line alone', () => {
  // It used to delete the statusLine key whenever there was no manifest:
  // the status line of someone who had never installed the bridge, gone.
  const p = fakeHome(REAL_SHAPE);
  const file = path.join(p.claudeDir, 'settings.json');
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(uninstallStatusline(p), 'not-installed');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a status line set by hand after installing survives an uninstall', () => {
  const p = fakeHome(REAL_SHAPE);
  const file = path.join(p.claudeDir, 'settings.json');
  installStatusline(p);
  const mine = { ...JSON.parse(fs.readFileSync(file, 'utf8')), statusLine: { type: 'command', command: 'bash ~/mine.sh' } };
  fs.writeFileSync(file, JSON.stringify(mine, null, 2) + '\n');
  assert.equal(uninstallStatusline(p), 'not-installed');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command, 'bash ~/mine.sh');
  assert.equal(fs.existsSync(path.join(p.stateDir, 'statusline-bridge.sh')), false, 'our own files still go');
});

test('a broken settings.json is NOT touched', () => {
  const p = fakeHome();
  const file = path.join(p.claudeDir, 'settings.json');
  fs.writeFileSync(file, '{ this is not json');
  assert.throws(() => installStatusline(p), StatuslineError);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json', 'file altered');
});

test('the reader projects ONLY the quota, not the rest of the payload', async () => {
  const p = fakeHome(REAL_SHAPE);
  const file = dataPath(p.stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const SECRET = '/Users/tester/topsecret/confidential-project';
  fs.writeFileSync(file, JSON.stringify({
    workspace: { current_dir: SECRET },
    model: { display_name: 'Opus 5' },
    cost: { total_cost_usd: 12.34 },
    session_id: 'aaaa-bbbb',
    rate_limits: {
      five_hour: { used_percentage: 34.5, resets_at: 1789044882 },
      seven_day: { used_percentage: 12, resets_at: 1789495107 },
    },
  }));

  const events: DeltaEvent[] = [];
  const reader = new StatuslineReader({ file, sessionsDir: path.join(p.stateDir, 'statusline', 'sessions'), emit: (e) => events.push(...e) });
  reader.start();
  reader.stop();

  assert.equal(events.length, 1);
  const ev = events[0]!;
  assert.equal(ev.t, 'limits');
  if (ev.t !== 'limits') return;
  assert.equal(ev.limits.provider, 'claude');
  // Sorted from the shortest to the longest.
  assert.deepEqual(ev.limits.windows.map((w) => w.label), ['5h', '7d']);
  assert.equal(ev.limits.windows[0]!.usedPercent, 34.5);
  assert.equal(ev.limits.windows[0]!.windowMinutes, 300);
  // Epoch seconds must be converted: without that, the reset lands in 1970.
  assert.equal(ev.limits.windows[0]!.resetsAt, 1789044882000);
  assert.equal(ev.limits.windows[1]!.usedPercent, 12);
  assert.equal(ev.limits.windows[1]!.windowMinutes, 10080);

  const serialised = JSON.stringify(events);
  assert.equal(serialised.includes(SECRET), false, 'a path got out');
  assert.equal(serialised.includes('12.34'), false, 'the cost got out');
  assert.equal(serialised.includes('aaaa-bbbb'), false, 'the session id got out');
});

test('a payload without rate_limits produces nothing', () => {
  const p = fakeHome(REAL_SHAPE);
  const file = dataPath(p.stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ model: { display_name: 'Opus 5' } }));

  const events: DeltaEvent[] = [];
  const reader = new StatuslineReader({ file, sessionsDir: path.join(p.stateDir, 'statusline', 'sessions'), emit: (e) => events.push(...e) });
  reader.start();
  reader.stop();
  assert.deepEqual(events, []);
});

test('a session just opened does not wipe the quota of the others', () => {
  // Field case: two sessions opened and never used were the last to draw the
  // status line, before any API call, so latest.json had no rate_limits. The
  // bars stayed empty for an hour with a good reading in the sessions folder.
  const p = fakeHome(REAL_SHAPE);
  const file = dataPath(p.stateDir);
  const dir = path.join(p.stateDir, 'statusline', 'sessions');
  fs.mkdirSync(dir, { recursive: true });

  const worked = path.join(dir, '11111111-2222-3333-4444-555555555555.json');
  fs.writeFileSync(worked, JSON.stringify({
    rate_limits: {
      five_hour: { used_percentage: 24, resets_at: 1789738800 },
      seven_day: { used_percentage: 14, resets_at: 1790182800 },
    },
  }));
  const fresh = JSON.stringify({ cost: { total_api_duration_ms: 0 }, model: { display_name: 'Opus 5' } });
  fs.writeFileSync(path.join(dir, '66666666-7777-8888-9999-000000000000.json'), fresh);
  fs.writeFileSync(file, fresh);
  const past = new Date(Date.now() - 180_000);
  fs.utimesSync(worked, past, past);

  const events: DeltaEvent[] = [];
  const reader = new StatuslineReader({ file, sessionsDir: dir, plan: 'max 5x', emit: (e) => events.push(...e) });
  reader.start();
  reader.stop();

  const limits = events.filter((e) => e.t === 'limits');
  assert.equal(limits.length, 1);
  const ev = limits[0]!;
  if (ev.t !== 'limits') return;
  assert.deepEqual(ev.limits.windows.map((w) => `${w.label} ${w.usedPercent}`), ['5h 24', '7d 14']);
  assert.equal(ev.limits.plan, 'max 5x');
  // The reading keeps the instant it was written: the forecast divides by it.
  assert.equal(ev.limits.at, fs.statSync(worked).mtimeMs);
});

test('a copy that names only the weekly window does not take the 5h away', () => {
  // Field case, 2026-09-20: Claude Code publishes the windows of the session's
  // LAST response, so a session that had not called the API since the 5h
  // window opened wrote `seven_day` alone -- and being the freshest copy, it
  // was the one the pass took. On screen the 5h bar came and went with every
  // turn, and the 5h reserve went with it.
  const p = fakeHome(REAL_SHAPE);
  const file = dataPath(p.stateDir);
  const dir = path.join(p.stateDir, 'statusline', 'sessions');
  fs.mkdirSync(dir, { recursive: true });

  const worked = path.join(dir, '11111111-2222-3333-4444-555555555555.json');
  fs.writeFileSync(worked, JSON.stringify({
    rate_limits: {
      five_hour: { used_percentage: 1, resets_at: 1789919400 },
      seven_day: { used_percentage: 58, resets_at: 1790182800 },
    },
  }));
  const idle = path.join(dir, '66666666-7777-8888-9999-000000000000.json');
  fs.writeFileSync(idle, JSON.stringify({
    rate_limits: { seven_day: { used_percentage: 57, resets_at: 1790182800 } },
  }));
  fs.writeFileSync(file, '{}');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(worked, past, past);

  const events: DeltaEvent[] = [];
  const reader = new StatuslineReader({ file, sessionsDir: dir, plan: 'max 5x', emit: (e) => events.push(...e) });
  reader.start();
  reader.stop();

  const ev = events.filter((e) => e.t === 'limits')[0]!;
  assert.equal(ev.t, 'limits');
  if (ev.t !== 'limits') return;
  // The freshest reading of each window, not the windows of the freshest
  // reading: a copy that says nothing about the 5h is not a 5h at zero.
  assert.deepEqual(ev.limits.windows.map((w) => `${w.label} ${w.usedPercent}`), ['5h 1', '7d 57']);
  assert.equal(ev.limits.at, fs.statSync(idle).mtimeMs);
});

test('among several quota readings the most recent wins, and an old one does not come back', () => {
  const p = fakeHome(REAL_SHAPE);
  const file = dataPath(p.stateDir);
  const dir = path.join(p.stateDir, 'statusline', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const quota = (pct: number): string => JSON.stringify({
    rate_limits: { five_hour: { used_percentage: pct, resets_at: 1789738800 } },
  });
  const at = (f: string, agoMs: number): void => {
    const t = new Date(Date.now() - agoMs);
    fs.utimesSync(f, t, t);
  };

  const a = path.join(dir, '11111111-2222-3333-4444-555555555555.json');
  const b = path.join(dir, '66666666-7777-8888-9999-000000000000.json');
  fs.writeFileSync(a, quota(30));
  fs.writeFileSync(b, quota(10));
  at(a, 60_000);
  at(b, 600_000);

  const events: DeltaEvent[] = [];
  const reader = new StatuslineReader({ file, sessionsDir: dir, plan: null, emit: (e) => events.push(...e) });
  reader.start();
  reader.stop();
  const pcts = (): number[] => events.flatMap((e) => (e.t === 'limits' ? [e.limits.windows[0]!.usedPercent] : []));
  assert.deepEqual(pcts(), [30], 'one emit, from the newest copy');

  // A copy that changes but is still older than what is shown does not win.
  fs.writeFileSync(b, quota(5));
  at(b, 300_000);
  reader.start();
  reader.stop();
  assert.deepEqual(pcts(), [30]);
});

test('status tells the truth before and after', () => {
  const p = fakeHome(REAL_SHAPE);
  assert.equal(statuslineStatus(p).installed, false);
  installStatusline(p);
  assert.equal(statuslineStatus(p).installed, true);
  uninstallStatusline(p);
  assert.equal(statuslineStatus(p).installed, false);
});

test('a window tied to a model would show up on its own', () => {
  // Today Claude Code declares two and neither is tied to a model -- verified
  // on the real payload. But the key DESCRIBES the window, so reading it
  // instead of listing two means that the day a third one appeared it would
  // be seen, instead of being dropped without anyone knowing.
  const p = fakeHome(REAL_SHAPE);
  const file = dataPath(p.stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    rate_limits: {
      five_hour: { used_percentage: 10, resets_at: 1789044882 },
      seven_day: { used_percentage: 20, resets_at: 1789495107 },
      seven_day_fable: { used_percentage: 55, resets_at: 1789495107 },
      thirty_minute: { used_percentage: 5 },
      something_unknown: { used_percentage: 99 },
    },
  }));

  const events: DeltaEvent[] = [];
  const reader = new StatuslineReader({ file, sessionsDir: path.join(p.stateDir, 'statusline', 'sessions'), emit: (e) => events.push(...e) });
  reader.start();
  reader.stop();

  const ev = events[0]!;
  assert.equal(ev.t, 'limits');
  if (ev.t !== 'limits') return;
  assert.deepEqual(
    ev.limits.windows.map((w) => `${w.label}${w.model ? ` (${w.model})` : ''}`),
    ['30m', '5h', '7d', '7d (fable)'],
    'the model qualifier must be kept, and the general limit comes before the model one',
  );
  // The model comes out as a field, not mashed into the label: they are two
  // windows of equal span, and on screen that is the only way to tell them apart.
  const fable = ev.limits.windows.find((w) => w.model !== null)!;
  assert.equal(fable.label, '7d');
  assert.equal(fable.model, 'fable');
  assert.equal(fable.usedPercent, 55);
  assert.equal(ev.limits.windows.filter((w) => w.model === null).every((w) => w.model === null), true);
  // A key that does not describe a window does not become a fake window.
  assert.equal(ev.limits.windows.some((w) => w.usedPercent === 99), false);
});

test('the plan comes out as a single word, the rest of oauthAccount never', async () => {
  // The plan is NOT in the status line -- verified on the real payload -- and
  // the only place it exists is `oauthAccount`, that is exactly the part of
  // ~/.claude.json the rest of the program avoids. It is read here, but only
  // three category fields: this test is the fence around that read.
  const { readPlanLabel } = await import('../src/server/sources/projectsSource.ts');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-plan-'));
  const account = {
    accountUuid: '11111111-2222-3333-4444-555555555555',
    displayName: 'First Last',
    emailAddress: 'person@example.com',
    fullName: 'First Middle Last',
    organizationName: 'Acme Inc.',
    organizationUuid: '99999999-8888-7777-6666-555555555555',
    organizationType: 'claude_max',
    organizationRateLimitTier: 'default_claude_max_5x',
    userRateLimitTier: null,
    billingType: 'stripe_subscription',
  };
  fs.writeFileSync(
    path.join(root, '.claude.json'),
    JSON.stringify({ oauthAccount: account, projects: { '/x/y': { history: ['secret'] } } }),
  );

  const policy = {
    claudeDir: path.join(root, '.claude'),
    codexDir: path.join(root, '.codex'),
    homeDir: root,
  };
  const plan = readPlanLabel(root, policy);

  assert.equal(plan, 'max 5x', 'the tier must be normalized, not repeated as is');
  for (const leak of [
    account.emailAddress, account.fullName, account.displayName,
    account.accountUuid, account.organizationName, account.organizationUuid,
    account.billingType, 'secret',
  ]) {
    assert.equal(String(plan).includes(leak), false, `got out: ${leak}`);
  }
});

test('an unknown tier does not become an invented plan', async () => {
  const { readPlanLabel } = await import('../src/server/sources/projectsSource.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-plan-'));
  fs.writeFileSync(
    path.join(root, '.claude.json'),
    JSON.stringify({ oauthAccount: { organizationRateLimitTier: 'something_new_x' } }),
  );
  const policy = {
    claudeDir: path.join(root, '.claude'), codexDir: path.join(root, '.codex'),
    homeDir: root,
  };
  assert.equal(readPlanLabel(root, policy), null);
});

test('the context arrives for EVERY session, not only for the last one', async () => {
  // latest.json only tells about the session that answered last: the context
  // of all the others would be lost. That is why the bridge writes one copy
  // per session, and here they are all read.
  const p = fakeHome(REAL_SHAPE);
  const dir = path.join(p.stateDir, 'statusline', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const A = '11111111-2222-3333-4444-555555555555';
  const B = '66666666-7777-8888-9999-000000000000';
  fs.writeFileSync(path.join(dir, `${A}.json`), JSON.stringify({ context_window: { used_percentage: 44 } }));
  fs.writeFileSync(path.join(dir, `${B}.json`), JSON.stringify({ context_window: { used_percentage: 91 } }));

  const events: DeltaEvent[] = [];
  const reader = new StatuslineReader({
    file: dataPath(p.stateDir), sessionsDir: dir, plan: null, emit: (e) => events.push(...e),
  });
  reader.start();
  reader.stop();

  const byId = new Map<string, number>();
  for (const e of events) {
    if (e.t === 'session.update' && typeof e.patch.contextPct === 'number') byId.set(e.id, e.patch.contextPct);
  }
  assert.equal(byId.get(A), 44);
  assert.equal(byId.get(B), 91);
});

test('a file not named like an id is not read', () => {
  // The file name becomes the session id: if it does not have that exact
  // shape, it is something else and stays out.
  const p = fakeHome(REAL_SHAPE);
  const dir = path.join(p.stateDir, 'statusline', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '../../outside.json'), '{}');
  fs.writeFileSync(path.join(dir, 'not-an-id.json'), JSON.stringify({ context_window: { used_percentage: 50 } }));

  const events: DeltaEvent[] = [];
  const reader = new StatuslineReader({
    file: dataPath(p.stateDir), sessionsDir: dir, plan: null, emit: (e) => events.push(...e),
  });
  reader.start();
  reader.stop();
  assert.equal(events.filter((e) => e.t === 'session.update').length, 0);
});

test('the bridge saves one copy per session, and only with a valid id', async () => {
  const { execFileSync } = await import('node:child_process');
  const p = fakeHome(REAL_SHAPE);
  const status = installStatusline(p);
  // The bridge wraps a command that does not exist in this fake home: it is
  // replaced with a harmless one, because here only what it saves matters.
  const script = fs.readFileSync(status.bridgePath, 'utf8')
    .replace('bash /Users/tester/.claude/statusline.sh', 'cat > /dev/null');
  fs.writeFileSync(status.bridgePath, script, { mode: 0o700 });

  const SID = 'b07ab83c-34c0-4606-91fa-3974e98512e8';
  execFileSync('bash', [status.bridgePath], {
    input: JSON.stringify({ session_id: SID, context_window: { used_percentage: 12 } }),
  });
  const saved = path.join(p.stateDir, 'statusline', 'sessions', `${SID}.json`);
  assert.equal(fs.existsSync(saved), true, 'per-session copy not written');
  // Written readable only by the owner.
  assert.equal(fs.statSync(saved).mode & 0o077, 0, 'the copy is readable by others');

  // An id with path characters must not become a file name.
  execFileSync('bash', [status.bridgePath], {
    input: JSON.stringify({ session_id: '../../escape', context_window: { used_percentage: 12 } }),
  });
  assert.equal(fs.existsSync(path.join(p.stateDir, 'escape.json')), false, 'malicious id used as a path');
  assert.equal(fs.readdirSync(path.join(p.stateDir, 'statusline', 'sessions')).length, 1);
});

test('a second copy of the tree does not see the bridge of the first copy as installed', () => {
  /*
   * Two copies of the same project have two --state-dir but the same bridge
   * file name. With the comparison on the basename, the second one read
   * `settings.json`, found "statusline-bridge.sh" and declared itself
   * installed: refreshBridge wrote it an orphan bridge that nobody runs, and a
   * `statusline install` from there would have recorded the other copy's
   * bridge as the previous command -- or nothing, losing the user's status line.
   */
  const first = fakeHome(REAL_SHAPE);
  installStatusline(first);

  const second = { claudeDir: first.claudeDir, stateDir: path.join(first.root, '.towerglow-test') };
  assert.equal(statuslineStatus(second).installed, false);
  // And the first one still sees itself installed: the comparison has not become useless.
  assert.equal(statuslineStatus(first).installed, true);
});
