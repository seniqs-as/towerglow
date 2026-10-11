import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { assertReadable, isReadable, slugFor, PathDenied } from '../src/server/paths.ts';
import type { PathPolicy } from '../src/server/paths.ts';

const HOME = '/Users/tester';
const CLAUDE = path.join(HOME, '.claude');
const CODEX = path.join(HOME, '.codex');
const policy: PathPolicy = { claudeDir: CLAUDE, codexDir: CODEX, homeDir: HOME };

const SID = '8f44d010-1111-4222-8333-444455556666';
const p = (...s: string[]) => path.join(CLAUDE, ...s);

test('allows the registry of live sessions', () => {
  assert.equal(isReadable(p('sessions', '47539.json'), policy), true);
  assert.equal(isReadable(p('sessions', '1.json'), policy), true);
});

test('DENIES the session keys, by construction of the regex', () => {
  assert.equal(isReadable(p('sessions', '47539.0946f762abc.key'), policy), false);
  assert.equal(isReadable(p('sessions', '47539.json.key'), policy), false);
  assert.equal(isReadable(p('sessions', 'notes.json'), policy), false);
  assert.equal(isReadable(p('sessions'), policy), false);
});

test('allows the main transcript', () => {
  assert.equal(isReadable(p('projects', '-Users-x-proj', `${SID}.jsonl`), policy), true);
});

test('DENIES memory and non-conforming names', () => {
  const proj = ['projects', '-Users-x-proj'];
  assert.equal(isReadable(p(...proj, 'memory', 'MEMORY.md'), policy), false);
  assert.equal(isReadable(p(...proj, 'something.jsonl'), policy), false);
});

test('DENIES what sits beside a transcript: subagent transcripts and tool outputs', () => {
  // They were on the list and nothing ever read them. The list now says what
  // is read, and no more: a subagent's transcript holds its whole work, and a
  // tool output can hold a file's contents.
  const proj = ['projects', '-Users-x-proj', SID];
  assert.equal(isReadable(p(...proj, 'subagents', 'agent-a7a99d29da94ade29.jsonl'), policy), false);
  assert.equal(isReadable(p(...proj, 'tool-results', 'toolu_01ABCD.txt'), policy), false);
});

test('DENIES the rest of ~/.claude', () => {
  for (const rel of [
    ['history.jsonl'],
    ['settings.json'],
    ['plans', 'plan.md'],
    ['session-env', SID, 'env'],
    ['shell-snapshots', 'snapshot-bash-1.sh'],
    ['debug', 'latest.txt'],
    ['backups', '.claude.json.backup.1'],
    ['cache', 'changelog.md'],
    ['file-history', SID, 'abc@v1'],
    ['statusline.sh'],
    ['todos', 'x.json'],
  ]) {
    assert.equal(isReadable(p(...rel), policy), false, `should have denied: ${rel.join('/')}`);
  }
});

test('allows ~/.claude.json but nothing that looks like it', () => {
  assert.equal(isReadable(path.join(HOME, '.claude.json'), policy), true);
  assert.equal(isReadable(path.join(HOME, '.claude.json.backup.123'), policy), false);
  assert.equal(isReadable(path.join(HOME, '.claude.json', 'x'), policy), false);
});

test('git: allows only HEAD and logs/HEAD', () => {
  const repo = '/Users/tester/code/app';
  assert.equal(isReadable(path.join(repo, '.git', 'HEAD'), policy), true);
  assert.equal(isReadable(path.join(repo, '.git', 'logs', 'HEAD'), policy), true);
});

test('git: DENIES config, objects, COMMIT_EDITMSG and the rest', () => {
  const g = (...s: string[]) => path.join('/Users/tester/code/app/.git', ...s);
  for (const f of [
    g('config'),
    g('COMMIT_EDITMSG'),
    g('objects', 'ab', 'cdef'),
    g('logs', 'refs', 'heads', 'main'),
    g('refs', 'heads', 'main'),
    g('index'),
    g('hooks', 'pre-commit'),
    g('..', 'src', 'main.ts'),
  ]) {
    assert.equal(isReadable(f, policy), false, `should have denied: ${f}`);
  }
});

test('DENIES messaging sockets and arbitrary paths', () => {
  for (const f of [
    '/tmp/cc-socks/47539.sock',
    '/etc/passwd',
    '/Users/tester/.ssh/id_rsa',
    '/Users/tester/Desktop/project/src/index.ts',
    '/Users/tester/.claude-other/sessions/1.json',
  ]) {
    assert.equal(isReadable(f, policy), false, `should have denied: ${f}`);
  }
});

test('DENIES climbing out of claudeDir', () => {
  assert.equal(isReadable(p('projects', '..', '..', '.ssh', 'id_rsa'), policy), false);
  assert.equal(isReadable(p('sessions', '..', 'history.jsonl'), policy), false);
});

test('assertReadable throws PathDenied and names the target', () => {
  assert.throws(
    () => assertReadable(p('history.jsonl'), policy),
    (e: unknown) => e instanceof PathDenied && e.target.endsWith('history.jsonl'),
  );
});

test('slugFor, and confirmation that it is NOT invertible', () => {
  assert.equal(
    slugFor('/Users/me/Desktop/code/my_dashboard'),
    '-Users-me-Desktop-code-my-dashboard',
  );
  // two different cwds collapse onto the same slug: that is why the cwd
  // must always be read from the record, never derived from the directory.
  assert.equal(slugFor('/a/dec_game/x'), slugFor('/a/dec-game-x'));
});

/* ───────────────────────── Codex ───────────────────────── */

const cx = (...s: string[]) => path.join(CODEX, ...s);
const ROLLOUT = 'rollout-2026-09-08T20-06-46-01a08233-77fd-79a0-8c31-ba49a8ff0daa.jsonl';

test('Codex: allows the logs index, the config and the session index', () => {
  for (const f of ['logs_2.sqlite', 'config.toml', 'session_index.jsonl']) {
    assert.equal(isReadable(cx(f), policy), true, `should have allowed: ${f}`);
  }
});

test('Codex: DENIES the thread and item databases, which nothing reads', () => {
  // Listed once, never opened: the rollouts carry everything the city shows.
  for (const f of ['state_5.sqlite', 'thread_history_1.sqlite']) {
    assert.equal(isReadable(cx(f), policy), false, `should have denied: ${f}`);
  }
});

test('Codex: DENIES the credentials and everything that holds user text', () => {
  for (const f of [
    ['auth.json'],                 // credentials: never, for any reason
    ['history.jsonl'],             // global user prompts
    ['queue_1.sqlite'],            // payloads of queued messages
    ['memories_1.sqlite'],
    ['goals_1.sqlite'],
    ['installation_id'],
    ['models_cache.json'],
    ['version.json'],
    ['log', 'codex-login.log'],
    ['shell_snapshots', 'x.sh'],
    ['thread-writer-locks', 'abc.lock'],
    ['packages', 'standalone', 'current', 'bin', 'codex'],
    ['plugins', 'x', 'y'],
    ['.tmp', 'plugins', 'z'],
  ]) {
    assert.equal(isReadable(cx(...f), policy), false, `should have denied: ${f.join('/')}`);
  }
});

test('Codex: allows rollouts only in their exact form', () => {
  assert.equal(isReadable(cx('sessions', '2026', '09', '08', ROLLOUT), policy), true);
  // non-conforming name, wrong depth, or non-numeric date segments
  assert.equal(isReadable(cx('sessions', '2026', '09', '08', 'other.jsonl'), policy), false);
  assert.equal(isReadable(cx('sessions', '2026', '09', ROLLOUT), policy), false);
  assert.equal(isReadable(cx('sessions', 'something', '09', '08', ROLLOUT), policy), false);
  assert.equal(isReadable(cx('sessions', '2026', '09', '08', 'rollout-x.txt'), policy), false);
});

test('Codex: nothing is read from the app-server daemon', () => {
  // Verified in the field: the TUI keeps its own app-server inside the
  // process and never connects to the shared daemon, so no information about
  // the sessions would ever come from there. A path granted and never used
  // is just extra surface.
  for (const f of [
    ['app-server-daemon', 'app-server.pid'],
    ['app-server-daemon', 'settings.json'],
    ['app-server-control', 'app-server-control.sock'],
    ['app-server-control', 'app-server-startup.lock'],
  ]) {
    assert.equal(isReadable(cx(...f), policy), false, `should have denied: ${f.join('/')}`);
  }
});

test('Codex: no climbing out of ~/.codex', () => {
  assert.equal(isReadable(cx('sessions', '..', '..', 'auth.json'), policy), false);
  assert.equal(isReadable(cx('..', '.codex', 'auth.json'), policy), false);
});
