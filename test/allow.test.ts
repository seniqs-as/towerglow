import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedToolsFor, codexResumeSandboxFor, codexSandboxFor, commandPattern, commandProblem, commandsOf,
  disallowedToolsFor, mergeCommands, TEST_COMMANDS,
} from '../src/server/ceo/allow.ts';
import type { GitRules } from '../src/shared/protocol.ts';
import { MAX_PROJECT_COMMANDS } from '../src/shared/protocol.ts';

const rules = (commit: boolean, push: boolean): GitRules => ({ commit, push });

test('with no git rights the runners and the read-only git stay, and push and commit are denied by name', () => {
  assert.deepEqual(allowedToolsFor(rules(false, false)), [
    ...TEST_COMMANDS, 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
  ]);
  assert.deepEqual(disallowedToolsFor(rules(false, false)), ['Bash(git push:*)', 'Bash(git add:*)', 'Bash(git commit:*)']);
});

test('the tests always run: the runners come with every order, git that changes anything never with them', () => {
  const allowed = allowedToolsFor(rules(false, false));
  assert.ok(allowed.includes('Bash(npm test:*)'));
  assert.ok(allowed.includes('Bash(php -l:*)'), 'a PHP project can at least lint what it touched');
  assert.ok(allowed.includes('Bash(node --check:*)'));
  for (const writes of ['git pull', 'git add', 'git commit', 'git push']) {
    assert.ok(!allowed.some((a) => a.includes(writes)), `${writes} came with no git rights`);
  }
});

test('an audit with commits off can still read the history', () => {
  // The CEO proposed "review 20 commits" on a repository with 72: a git log
  // was enough to refute it. A proposal's worker has commits off, and without
  // the read-only commands it could not have looked.
  const allowed = allowedToolsFor(rules(false, false));
  for (const reads of ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)']) {
    assert.ok(allowed.includes(reads), reads);
  }
});

test('a project\'s own commands are allowed as Bash rules, besides the runners', () => {
  // decsim2: its tests are PHP scripts, UI checks in node and a bash smoke
  // test, and a worker told to run them was refused all three, three times.
  const allowed = allowedToolsFor(rules(true, true), ['php tests/*', 'node tests/ui/*', 'bash tests/api_smoke.sh']);
  assert.ok(allowed.includes('Bash(php tests/*)'));
  assert.ok(allowed.includes('Bash(node tests/ui/*)'));
  assert.ok(allowed.includes('Bash(bash tests/api_smoke.sh)'));
});

test('commit opens reading the repo state and committing, but not pushing', () => {
  const allowed = allowedToolsFor(rules(true, false));
  assert.ok(allowed.includes('Bash(git commit:*)'));
  assert.ok(allowed.includes('Bash(git pull:*)'));
  assert.ok(!allowed.includes('Bash(git push:*)'));
  assert.deepEqual(disallowedToolsFor(rules(true, false)), ['Bash(git push:*)']);
});

test('with push allowed no git ban remains', () => {
  assert.ok(allowedToolsFor(rules(true, true)).includes('Bash(git push:*)'));
  assert.deepEqual(disallowedToolsFor(rules(true, true)), []);
});

test('the Codex sandbox opens the network only for a push', () => {
  assert.deepEqual(codexSandboxFor(rules(true, false)), ['-s', 'workspace-write']);
  assert.deepEqual(codexSandboxFor(rules(true, true)), ['-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true']);
  assert.deepEqual(codexResumeSandboxFor(rules(false, false)), ['-c', 'sandbox_mode="workspace-write"']);
  assert.ok(codexResumeSandboxFor(rules(true, true)).includes('sandbox_workspace_write.network_access=true'));
});

test('a test command is kept as the worker or the chair wrote it, unwrapped and on one line', () => {
  assert.equal(commandPattern('php tests/*'), 'php tests/*');
  assert.equal(commandPattern('Bash(php -l *)'), 'php -l *');
  assert.equal(commandPattern('`bash tests/api_smoke.sh`'), 'bash tests/api_smoke.sh');
  assert.equal(commandPattern('  DECSIM_DB_PREFIX=ds_   bash tests/api_smoke.sh '), 'DECSIM_DB_PREFIX=ds_ bash tests/api_smoke.sh');
  assert.equal(commandPattern('npm test:*'), 'npm test:*');
  assert.equal(commandPattern('pytest'), 'pytest', 'an exact command with no arguments is one command');
  assert.equal(commandPattern(42), null);
});

test('a command that would allow anything, or reach git, is refused with the reason', () => {
  assert.match(commandProblem('php *')!, /any command/);
  assert.match(commandProblem('php:*')!, /any command/);
  assert.match(commandProblem('*')!, /wildcard/);
  assert.match(commandProblem('node -e *')!, /inline code/);
  assert.match(commandProblem('bash -c *')!, /inline code/);
  assert.match(commandProblem('git push*')!, /commit and push boxes/);
  assert.match(commandProblem('rm -rf tests/tmp')!, /does not run tests/);
  assert.match(commandProblem('curl http://example.com/*')!, /does not run tests/);
  assert.match(commandProblem('php tests/a.php | tail')!, /one command only/);
  assert.match(commandProblem('php tests/a.php && git push')!, /one command only/);
  assert.match(commandProblem('php $(echo tests)/a.php')!, /one command only/);
  assert.match(commandProblem('node -e "x()"')!, /one command only/, 'a paren would close the Bash(...) rule');
  assert.match(commandProblem('A=1')!, /no program/);
  assert.match(commandProblem('')!, /empty/);
  assert.match(commandProblem(`php ${'x'.repeat(200)}`)!, /cap/);
  assert.match(commandProblem('php tests/\x01a.php')!, /control character/);
});

test('a list keeps the valid commands once each, in order, up to the cap', () => {
  assert.deepEqual(commandsOf(['php tests/*', 'php *', 'php tests/*', 'Bash(php tests/*)', 'node --check *']), ['php tests/*', 'node --check *']);
  assert.deepEqual(commandsOf('php tests/*'), [], 'not a list');
  const many = Array.from({ length: 40 }, (_, i) => `make test-${i}`);
  assert.equal(commandsOf(many).length, MAX_PROJECT_COMMANDS);
  assert.deepEqual(mergeCommands(['a b'], ['c d', 'a b']), ['a b', 'c d'], 'an addition never reorders');
});
