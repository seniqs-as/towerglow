import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allBut, allowedToolsFor, codexResumeSandboxFor, codexSandboxFor, commandPattern, commandProblem, commandsOf,
  disallowedToolsFor, GIT_NETWORK, gitDirOf, mergeCommands, outsideSandboxDenied, projectMemoryOf, sandboxFor,
  TEST_COMMANDS,
} from '../src/server/ceo/allow.ts';
import type { GitRules } from '../src/shared/protocol.ts';
import { MAX_PROJECT_COMMANDS } from '../src/shared/protocol.ts';

const rules = (commit: boolean, push: boolean): GitRules => ({ commit, push });

test('with no git rights the runners and the read-only git stay, and push and commit are denied by name', () => {
  assert.deepEqual(allowedToolsFor(rules(false, false)), [
    ...TEST_COMMANDS, 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
  ]);
  assert.deepEqual(disallowedToolsFor(rules(false, false)), [
    'Bash(git push:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git init:*)',
  ]);
});

test('the tests always run: the runners come with every order, git that changes anything never with them', () => {
  const allowed = allowedToolsFor(rules(false, false));
  assert.ok(allowed.includes('Bash(npm test:*)'));
  assert.ok(allowed.includes('Bash(php -l:*)'), 'a PHP project can at least lint what it touched');
  assert.ok(allowed.includes('Bash(node --check:*)'));
  for (const writes of ['git pull', 'git fetch', 'git add', 'git commit', 'git push']) {
    assert.ok(!allowed.some((a) => a.includes(writes)), `${writes} came with no git rights`);
  }
});

/*
 * The sandbox as the only gate (2026-10-13).
 *
 * One approved plan, seven workers: 52 commands refused because no rule
 * named them -- `grep ... | cut`, `awk`, `mkdir`, `php tests/x.php` -- and
 * `git push 2>&1 | tail -2` failing inside the sandbox while `git push
 * origin main` alone went through. Tried on the real `claude` the same day:
 * with these settings the refused commands run, a write in the home folder,
 * a request to the network and a read of ~/.ssh still fail, and with commit
 * off `git add`, `git commit` and a `git update-ref` from a script do too.
 */
test('inside the sandbox a command runs without asking, and the boundary is what it was', () => {
  for (const r of [rules(false, false), rules(true, false), rules(true, true)]) {
    const s = sandboxFor(r, '/repo/.git').sandbox;
    assert.equal(s['autoAllowBashIfSandboxed'], true);
    assert.equal(s['enabled'], true);
    assert.equal(s['failIfUnavailable'], true);
    assert.equal(s['allowUnsandboxedCommands'], false, 'the model still cannot ask to run outside');
    assert.deepEqual(s['network'], { strictAllowlist: true }, 'and no host is allowed');
    const denyRead = (s['filesystem'] as { denyRead: string[] }).denyRead;
    for (const secret of ['~/.ssh', '~/.aws', '~/.claude/projects', '~/.towerglow']) assert.ok(denyRead.includes(secret), secret);
  }
});

test('git reaches the remote outside the sandbox only with push ticked, fetch included', () => {
  assert.equal(sandboxFor(rules(true, false), '/repo/.git').sandbox['excludedCommands'], undefined);
  assert.deepEqual(sandboxFor(rules(true, true), '/repo/.git').sandbox['excludedCommands'], [...GIT_NETWORK]);
  // Every excluded command needs its allow rule: outside the sandbox nothing
  // is approved by itself, and a `git fetch` with no rule was refused.
  const allowed = allowedToolsFor(rules(true, true));
  for (const verb of ['fetch', 'pull', 'push']) {
    assert.ok(GIT_NETWORK.includes(`git ${verb} *`), verb);
    assert.ok(allowed.includes(`Bash(git ${verb}:*)`), verb);
  }
});

test('with commit off the shell cannot write in .git; with commit on, or with no .git, nothing is denied', () => {
  const denyWrite = (r: GitRules, dir: string | null): unknown =>
    (sandboxFor(r, dir).sandbox['filesystem'] as { denyWrite?: string[] }).denyWrite;
  assert.deepEqual(denyWrite(rules(false, false), '/repo/.git'), ['/repo/.git']);
  assert.equal(denyWrite(rules(true, false), '/repo/.git'), undefined);
  assert.equal(denyWrite(rules(false, false), null), undefined);
  assert.equal(gitDirOf('/repo', (p) => p === '/repo/.git'), '/repo/.git');
  assert.equal(gitDirOf('/plain', () => false), null);
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

/*
 * A worker reads its own project's notes, and nothing else under
 * ~/.claude/projects (2026-10-13).
 *
 * The whole folder was denied, because the transcripts of your other
 * sessions are in it; so were the notes Claude Code keeps for the project,
 * whose index every session is given. The decsim2 worker asked three times
 * for two of them. The rules below were tried on the real `claude`, and the
 * first two drafts failed the wrong way round: see `allBut`.
 */

/** The three things these patterns use: a literal, a class of ranges, a star that stays in its segment. */
function matches(pattern: string, name: string, ignoreCase: boolean): boolean {
  let re = '';
  for (let i = 0; i < pattern.length;) {
    const c = pattern[i]!;
    if (c === '[') {
      const end = pattern.indexOf(']', i);
      re += pattern.slice(i, end + 1);
      i = end + 1;
    } else {
      re += c === '*' ? '[^/]*' : c.replace(/[.+?^$(){}|\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${re}$`, ignoreCase ? 'i' : '').test(name);
}

const NOT_MEMORY = [
  '013b324f-740d-447a-a4c9-240a976850b2.jsonl', '12696853-7172-4725-aedd-6845cd9d3fd0', 'bridge-pointer.json',
  'zz', 'n', 'l', '_x', '.hidden', '9', 'm', 'me', 'mem', 'memo', 'memor', 'memorz', 'memoirs', 'memory2',
  'memory-old', 'memory.bak', 'metadata.json', 'mcp', 'mm',
];

test('the complement of "memory" matches every other name and never the name itself', () => {
  const patterns = allBut('memory');
  for (const ignoreCase of [true, false]) {
    assert.ok(!patterns.some((p) => matches(p, 'memory', ignoreCase)), `memory is denied (ignoreCase ${ignoreCase})`);
    for (const name of NOT_MEMORY) {
      assert.ok(patterns.some((p) => matches(p, name, ignoreCase)), `${name} is readable (ignoreCase ${ignoreCase})`);
    }
  }
  // Names are compared ignoring case where this was tried: a class holding
  // A-Z matched `memory` by its M, and every note was denied.
  assert.ok(!patterns.some((p) => matches(p, 'MEMORY', true)));
  for (const name of ['Mem-probe.txt', 'Zed', 'MEMORY2']) {
    assert.ok(patterns.some((p) => matches(p, name, true)), name);
  }
});

test('no pattern of the complement negates a class: that syntax matched the opposite', () => {
  // `[!m]*` and `[^m]*` are read as "! or m", "^ or m": the rule meant for
  // everything but the notes matched only them, and transcripts could be read.
  const patterns = allBut('memory');
  for (const p of patterns) assert.ok(!/\[[!^]/.test(p), p);
  assert.deepEqual(patterns, [
    '[0-9A-LN-Za-ln-z_.-]*', 'm[0-9A-DF-Za-df-z_.-]*', 'me[0-9A-LN-Za-ln-z_.-]*', 'mem[0-9A-NP-Za-np-z_.-]*',
    'memo[0-9A-QS-Za-qs-z_.-]*', 'memor[0-9A-XZa-xz_.-]*', 'm', 'me', 'mem', 'memo', 'memor',
    'memory[0-9A-Za-z_.-]*',
  ], 'the set that was tried on the real claude');
});

const HOME = '/Users/me';
const PROJECTS = `${HOME}/.claude/projects`;
const listing = (names: string[]) => (dir: string): string[] => {
  assert.equal(dir, PROJECTS);
  return names;
};

test('a project with notes names its memory folder and itself, and no other project', () => {
  const m = projectMemoryOf('/Users/me/code/alpha', HOME, listing(['-Users-me-code-alpha', '-Users-me-code-beta', '-Users-me-notes']), () => true);
  assert.deepEqual(m, { dir: `${PROJECTS}/-Users-me-code-alpha/memory`, slug: '-Users-me-code-alpha' });
});

test('the complement of a project folder covers every other one, without naming any', () => {
  // The first version wrote a rule per folder: the names of all your
  // projects were on every worker's command line, for `ps` to show.
  const own = '-Users-me-code-alpha';
  const patterns = allBut(own);
  const others = [
    '-Users-me-code-beta', '-Users-me-notes', '-Users-me-code-alpha-v2', '-Users-me-code-alph', '-Users-me-code',
    '-', 'Users-me-code-alpha', '-Users-me-code-alpha2', '-Users-you-code-alpha', '-private-tmp-x', '-Users-me-code-9lpha',
  ];
  for (const ignoreCase of [true, false]) {
    assert.ok(!patterns.some((p) => matches(p, own, ignoreCase)), `the project's own folder stays open (ignoreCase ${ignoreCase})`);
    for (const name of others) assert.ok(patterns.some((p) => matches(p, name, ignoreCase)), `${name} (ignoreCase ${ignoreCase})`);
  }
  for (const p of patterns) assert.ok(!/\[[!^]/.test(p), p);
});

test('whenever the rules could not be exact there is no memory, and the whole folder stays denied', () => {
  const cwd = '/Users/me/code/alpha';
  const own = '-Users-me-code-alpha';
  assert.equal(projectMemoryOf(cwd, HOME, listing(['-Users-me-code-beta']), () => true), null, 'the project has no folder');
  assert.equal(projectMemoryOf(cwd, HOME, listing([own, '-Users-me-code-beta']), () => false), null, 'it has no notes yet');
  assert.equal(projectMemoryOf(cwd, HOME, () => { throw new Error('ENOENT'); }, () => true), null, 'nothing to list');
  // A folder named with a pattern character cannot be written into a rule as it is.
  for (const odd of ['evil*', 'a)b', 'x[y]', 'with space', '!bang']) {
    assert.equal(projectMemoryOf(cwd, HOME, listing([own, odd]), () => true), null, odd);
  }
  // Any number of other projects: none of them is written into a rule.
  const many = Array.from({ length: 2000 }, (_, i) => `-p-${i}`);
  assert.deepEqual(projectMemoryOf(cwd, HOME, listing([own, ...many]), () => true)?.slug, own);
});

test('with notes to read, the transcripts, the session folders and the other projects stay denied to Read', () => {
  const memory = { dir: `${PROJECTS}/-Users-me-code-alpha/memory`, slug: '-Users-me-code-alpha' };
  const denied = outsideSandboxDenied(rules(true, true), memory);
  assert.ok(!denied.includes('Read(~/.claude/projects/**)'), 'the whole folder is no longer one rule');
  // Every other project, whole, by the complement of this one's name...
  for (const p of allBut('-Users-me-code-alpha')) assert.ok(denied.includes(`Read(~/.claude/projects/${p}/**)`), p);
  // ...so the only project a rule spells out is the worker's own, which its folder already says.
  assert.ok(!denied.some((d) => d.includes('beta') || d.includes('notes')));
  // The plain rule, which holds whatever a class turns out to mean.
  assert.ok(denied.includes('Read(~/.claude/projects/**/*.jsonl)'));
  for (const p of allBut('memory')) assert.ok(denied.includes(`Read(~/.claude/projects/*/${p})`), p);
  // No rule covers the notes themselves...
  assert.ok(!denied.includes('Read(~/.claude/projects/-Users-me-code-alpha/**)'));
  assert.ok(!denied.some((d) => d.startsWith('Read(') && /projects\/(\*|-Users-me-code-alpha)\/memory(\/|\))/.test(d)));
  // ...and none of them can be written: a note is loaded into every later session of the project.
  assert.ok(denied.includes('Edit(~/.claude/projects/**)'));
  for (const secret of ['Read(~/.ssh/**)', 'Read(~/.towerglow/**)', 'Read(~/.claude.json)']) assert.ok(denied.includes(secret), secret);
});

test('with no notes the whole of ~/.claude/projects is denied, as it was', () => {
  const denied = outsideSandboxDenied(rules(true, true), null);
  assert.ok(denied.includes('Read(~/.claude/projects/**)'));
  assert.ok(denied.includes('Edit(~/.claude/projects/**)'));
  assert.ok(!denied.some((d) => d.includes('*.jsonl')));
});

test('the shell reads the notes through a hole in the sandbox as narrow as their folder', () => {
  const dir = `${PROJECTS}/-Users-me-code-alpha/memory`;
  const fsOf = (m: string | null): { denyRead: string[]; allowRead?: string[] } =>
    sandboxFor(rules(true, true), '/repo/.git', m).sandbox['filesystem'] as { denyRead: string[]; allowRead?: string[] };
  assert.deepEqual(fsOf(dir).allowRead, [dir]);
  assert.ok(fsOf(dir).denyRead.includes('~/.claude/projects'), 'around it, the folder stays closed');
  assert.equal(fsOf(null).allowRead, undefined);
});

/*
 * The web box (2026-10-13): off unless you tick it, for each project.
 */
test('the web tools are denied unless web is ticked, and then they need their allow rule', () => {
  const off = rules(true, true);
  const on: GitRules = { commit: true, push: true, web: true };
  for (const tool of ['WebFetch', 'WebSearch']) {
    assert.ok(outsideSandboxDenied(off, null).includes(tool), `${tool} denied`);
    assert.ok(!allowedToolsFor(off).includes(tool));
    assert.ok(!outsideSandboxDenied(on, null).includes(tool), `${tool} open`);
    // Outside the sandbox nothing is approved by itself.
    assert.ok(allowedToolsFor(on).includes(tool), `${tool} allowed`);
  }
  // The bare tool name, never a domain rule: `WebFetch(domain:*)` would open
  // every host to the shell as well.
  assert.ok(!allowedToolsFor(on).some((a) => a.includes('domain:')));
  // And the shell's network is what it was: no host, no exclusion for the web.
  assert.deepEqual(sandboxFor(on, null).sandbox['network'], { strictAllowlist: true });
  assert.deepEqual(sandboxFor({ commit: true, push: false, web: true }, null).sandbox['excludedCommands'], undefined);
});

test('the Codex sandbox opens the network only for a push', () => {
  assert.deepEqual(codexSandboxFor(rules(true, false)), ['-s', 'workspace-write']);
  assert.deepEqual(codexSandboxFor(rules(true, true)), ['-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true']);
  assert.deepEqual(codexResumeSandboxFor(rules(false, false)), ['-c', 'sandbox_mode="workspace-write"']);
  assert.ok(codexResumeSandboxFor(rules(true, true)).includes('sandbox_workspace_write.network_access=true'));
  // ...or for the web: Codex has one switch for both.
  const reading: GitRules = { commit: true, push: false, web: true };
  assert.ok(codexSandboxFor(reading).includes('sandbox_workspace_write.network_access=true'));
  assert.ok(codexResumeSandboxFor(reading).includes('sandbox_workspace_write.network_access=true'));
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
