import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { billingLines, buildConfig, isOwnState, meteredBy } from '../src/server/config.ts';

/*
 * `buildConfig` creates the token inside `~/.towerglow`: HOME is moved to a
 * temporary directory, because a test must not write into the home of whoever
 * runs it. On POSIX `os.homedir()` reads HOME, so this is enough.
 */
function inFakeHome<T>(fn: () => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cfg-'));
  const prev = process.env['HOME'];
  process.env['HOME'] = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('execute mode is on by default', () => {
  // The observed bug: once a proposal was accepted, nothing started and the card
  // said "restart with --execute". Whoever starts with --ceo has already chosen
  // the CEOs, and a yes that makes nothing happen is a trap, not a precaution.
  assert.equal(inFakeHome(() => buildConfig({}).execute), true);
});

test('--no-execute turns it off: the advice stays, nothing starts', () => {
  assert.equal(inFakeHome(() => buildConfig({ 'no-execute': true }).execute), false);
});

test('the CEOs start only with --ceo: a plain start is the observatory alone', () => {
  // The user's call (2026-10-08, reversing the one of 2026-09-24): without
  // --ceo the tool is observation only and fully offline. `--no-ceo` is still
  // accepted and wins, so an old command line keeps meaning what it meant.
  assert.equal(inFakeHome(() => buildConfig({}).ceo), false);
  assert.equal(inFakeHome(() => buildConfig({ ceo: true }).ceo), true);
  assert.equal(inFakeHome(() => buildConfig({ 'no-ceo': true }).ceo), false);
  assert.equal(inFakeHome(() => buildConfig({ ceo: true, 'no-ceo': true }).ceo), false);
});

test('the dollar budget does not close after four questions', () => {
  /*
   * Measured on 14 September 2026: four analyses used up 1.60 dollars and with
   * the budget at two NOTHING started any more -- not even a seven-cent
   * analysis -- because there was no room left for the reserve of a whole
   * call. A cap that closes after four questions does not brake usage: it
   * prevents it, and whoever runs into it raises it without looking.
   */
  const cfg = inFakeHome(() => buildConfig({}));
  assert.equal(cfg.ceoBudgetUsd, 10);
  // Two, not one: a planning meeting over every project passed one dollar
  // twice in a row, reading the code it had to plan.
  assert.equal(cfg.ceoMaxCallUsd, 2);
  assert.ok(
    cfg.ceoBudgetUsd >= cfg.ceoMaxCallUsd * 5,
    'the reserve eats too much of the budget: the CEO would stop with money still in the till',
  );
});

test('the per-call cap drops to the budget when the budget is smaller', () => {
  // `--ceo-budget 0.40` with a default of 1 produced a CEO blocked forever:
  // the reason was correct and the situation absurd.
  const cfg = inFakeHome(() => buildConfig({ 'ceo-budget': '0.40' }));
  assert.equal(cfg.ceoMaxCallUsd, 0.4);
});

/* ───────────── which tool is billed by the token ───────────── */

test('an API key in the environment puts that tool on the dollar cap, and only that tool', () => {
  // The CEOs' processes inherit this environment, and `claude -p` always uses
  // a key that is set. Until 2026-10-12 the server did not look: it took any
  // usage window it could read as proof of a subscription.
  assert.equal(meteredBy('claude', { ANTHROPIC_API_KEY: 'sk-test' }), 'ANTHROPIC_API_KEY');
  assert.equal(meteredBy('codex', { ANTHROPIC_API_KEY: 'sk-test' }), null);
  assert.equal(meteredBy('codex', { CODEX_API_KEY: 'sk-test' }), 'CODEX_API_KEY');
  // A gateway token and a cloud provider outrank the plan login the same way.
  assert.equal(meteredBy('claude', { ANTHROPIC_AUTH_TOKEN: 'tok' }), 'ANTHROPIC_AUTH_TOKEN');
  assert.equal(meteredBy('claude', { CLAUDE_CODE_USE_BEDROCK: '1' }), 'CLAUDE_CODE_USE_BEDROCK');

  assert.deepEqual(inFakeHome(() => buildConfig({ ceo: true }, { ANTHROPIC_API_KEY: 'sk-test' })).ceoMetered, ['claude']);
  assert.deepEqual(inFakeHome(() => buildConfig({ ceo: true }, {})).ceoMetered, []);
  // The observatory starts nothing that could be billed: it does not look.
  assert.deepEqual(inFakeHome(() => buildConfig({}, { ANTHROPIC_API_KEY: 'sk-test' })).ceoMetered, []);
});

test('what does not take a tool off its plan is not read as a key', () => {
  // Calling a subscriber metered would take the quota ceiling and the reserve
  // away from them, so every doubt stays on the plan's side.
  assert.equal(meteredBy('claude', {}), null);
  assert.equal(meteredBy('claude', { ANTHROPIC_API_KEY: '' }), null);
  assert.equal(meteredBy('claude', { ANTHROPIC_API_KEY: '   ' }), null);
  // The subscription's own long-lived token is still the subscription.
  assert.equal(meteredBy('claude', { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }), null);
  // A switch that is off, or that says nothing a switch says.
  assert.equal(meteredBy('claude', { CLAUDE_CODE_USE_VERTEX: '0' }), null);
  assert.equal(meteredBy('claude', { CLAUDE_CODE_USE_VERTEX: 'false' }), null);
  // Exported in many shells for other programs while Codex is on ChatGPT.
  assert.equal(meteredBy('codex', { OPENAI_API_KEY: 'sk-test' }), null);
});

test('start says which guard holds for a tool on a key, and never prints the key', () => {
  const cfg = { ceoMetered: ['claude', 'codex'] as const, ceoBudgetUsd: 10 };
  const env = { ANTHROPIC_API_KEY: 'sk-secret', CODEX_API_KEY: 'sk-secret' };
  const out = billingLines(cfg, ['claude', 'codex'], env);
  assert.match(out, /claude by the token \(ANTHROPIC_API_KEY is set\): no quota gates, capped at 10\.00 USD per 24h\n/);
  // The budget adds up declared costs, and `codex exec` declares none.
  assert.match(out, /codex by the token \(CODEX_API_KEY is set\): it declares no cost, so only the time limits hold\n/);
  assert.ok(!out.includes('sk-secret'));
  // On its plan a tool has no line, and neither has a CEO that is not running.
  assert.equal(billingLines({ ceoMetered: [], ceoBudgetUsd: 10 }, ['claude', 'codex'], {}), '');
  assert.equal(billingLines(cfg, [], env), '');
});

/* ───────────── the state next to home, not inside it ───────────── */

/** Like inFakeHome, but with one more directory to use as state. */
function inFakeHomeWithState<T>(fn: (state: string) => T): T {
  return inFakeHome(() => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-state-'));
    try {
      return fn(state);
    } finally {
      fs.rmSync(state, { recursive: true, force: true });
    }
  });
}

test('without --state-dir the state stays in ~/.towerglow', () => {
  const cfg = inFakeHome(() => buildConfig({}));
  assert.equal(cfg.stateDir, path.join(cfg.homeDir, '.towerglow'));
});

test('--state-dir moves ONLY the state: sessions are still watched in ~/.claude', () => {
  /*
   * It is the condition for running two copies of the tree side by side. The
   * temptation was to move HOME, but ~/.claude and ~/.codex are derived from
   * homeDir too: the second copy would have had its own state and no city to show.
   */
  const cfg = inFakeHomeWithState((state) => buildConfig({ 'state-dir': state }));
  assert.equal(cfg.stateDir.startsWith(os.tmpdir()), true);
  assert.equal(cfg.claudeDir, path.join(cfg.homeDir, '.claude'));
  assert.equal(cfg.codexDir, path.join(cfg.homeDir, '.codex'));
  assert.notEqual(cfg.stateDir, path.join(cfg.homeDir, '.towerglow'));
});

test('the token is created in the chosen state directory, not in the default one', () => {
  // Two copies with the same token would not be two independent servers: the
  // browser keeps only one per origin, and the other would overwrite it.
  // The checks sit INSIDE the callback: the temporary directory is deleted
  // on the way out, and from outside every existsSync would say false.
  inFakeHomeWithState((state) => {
    const cfg = buildConfig({ 'state-dir': state });
    assert.ok(cfg.token.length >= 24);
    assert.equal(fs.existsSync(path.join(cfg.stateDir, 'token')), true);
    assert.equal(fs.existsSync(path.join(cfg.homeDir, '.towerglow', 'token')), false);
  });
});

test('TOWERGLOW_STATE_DIR works like the flag, and the flag wins', () => {
  const prev = process.env['TOWERGLOW_STATE_DIR'];
  try {
    const fromEnv = inFakeHomeWithState((state) => {
      process.env['TOWERGLOW_STATE_DIR'] = state;
      return buildConfig({});
    });
    assert.equal(fromEnv.stateDir.startsWith(os.tmpdir()), true);

    const flagWins = inFakeHomeWithState((state) => {
      process.env['TOWERGLOW_STATE_DIR'] = path.join(state, 'env');
      return buildConfig({ 'state-dir': path.join(state, 'flag') });
    });
    assert.equal(path.basename(flagWins.stateDir), 'flag');
  } finally {
    if (prev === undefined) delete process.env['TOWERGLOW_STATE_DIR'];
    else process.env['TOWERGLOW_STATE_DIR'] = prev;
  }
});

test('the CEO home stays out of the city, and a prefix is not the same directory', () => {
  // The CEOs run `claude -p` in ~/.towerglow/ceo/claude, which creates a
  // Claude Code project like any other: without this, a "CLAUDE" building
  // popped up next to the HQ, its slot frozen in layout.json.
  const cfg = { stateDir: '/Users/me/.towerglow' };
  assert.equal(isOwnState('/Users/me/.towerglow/ceo/claude', cfg), true);
  assert.equal(isOwnState('/Users/me/.towerglow', cfg), true);
  assert.equal(isOwnState('/Users/me/.towerglow-test/ceo/claude', cfg), false);
  assert.equal(isOwnState('/Users/me/Desktop/my_dashboard', cfg), false);
});

test('a token another user could read or plant is replaced, and a link is never followed', () => {
  // Under a --state-dir in a shared place someone else could have left a
  // token they know, or a link to one: the existing file was trusted as is.
  inFakeHomeWithState((state) => {
    const file = path.join(state, 'token');
    fs.writeFileSync(file, 'k'.repeat(32) + '\n', { mode: 0o644 });
    const open = buildConfig({ 'state-dir': state });
    assert.notEqual(open.token, 'k'.repeat(32), 'a world-readable token was kept');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(buildConfig({ 'state-dir': state }).token, open.token, 'a private token is kept across starts');

    const elsewhere = path.join(state, 'theirs');
    fs.writeFileSync(elsewhere, 'p'.repeat(32) + '\n', { mode: 0o600 });
    fs.rmSync(file);
    fs.symlinkSync(elsewhere, file);
    const linked = buildConfig({ 'state-dir': state });
    assert.notEqual(linked.token, 'p'.repeat(32), 'the token came through a link');
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'p'.repeat(32) + '\n', 'the link target is left alone');
  });
});

test('a state folder open to others is made private', () => {
  inFakeHomeWithState((state) => {
    fs.chmodSync(state, 0o755);
    buildConfig({ 'state-dir': state });
    assert.equal(fs.statSync(state).mode & 0o777, 0o700);
  });
});
