import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { isIgnored, parseIgnore, MAX_IGNORE_BYTES } from '../src/server/sources/ignoreRules.ts';
import { measureProject } from '../src/server/sources/projectsSource.ts';
import type { PathPolicy } from '../src/server/paths.ts';

/**
 * A tower is the project's own files, not what it downloaded.
 *
 * Seen on 2026-10-31: tycho, about 180 files of code, stood as a tower of
 * 2,490. The rest were ten strategy repositories cloned into `harvest/cache`
 * and a few gigabytes of market data in `data/raw` and `data/funding` --
 * all of it in the project's `.gitignore`, which is where the project says
 * what is not its own. With its rules the scan counted 179, what
 * `git ls-files --cached --others --exclude-standard` counted.
 */

const ignored = (text: string, rel: string, isDir = false, base = '', caseless = false): boolean =>
  isIgnored(parseIgnore(text, base, caseless), rel, isDir);

test('a name without a slash is ignored at any depth, a pattern with one only from its folder', () => {
  assert.equal(ignored('*.duckdb', 'data/market.duckdb'), true);
  assert.equal(ignored('*.duckdb', 'market.duckdb'), true);
  assert.equal(ignored('data/*.duckdb', 'data/market.duckdb'), true);
  assert.equal(ignored('data/*.duckdb', 'old/data/market.duckdb'), false, 'a middle slash anchors it');
  assert.equal(ignored('/todo.md', 'todo.md'), true);
  assert.equal(ignored('/todo.md', 'docs/todo.md'), false, 'a leading slash anchors it');
  assert.equal(ignored('data/*', 'data/raw/x.parquet'), false, 'a star does not cross a folder');
  assert.equal(ignored('data/*', 'data/raw', true), true, 'but it takes the folder, and with it what is inside');
});

test('a trailing slash takes only folders', () => {
  assert.equal(ignored('raw/', 'data/raw', true), true);
  assert.equal(ignored('raw/', 'data/raw', false), false);
  assert.equal(ignored('harvest/cache/', 'harvest/cache', true), true);
});

test('the last rule that matches decides, and a bang takes a name back', () => {
  const text = 'reports/*\n!reports/keep.md\n';
  assert.equal(ignored(text, 'reports/trades.csv'), true);
  assert.equal(ignored(text, 'reports/keep.md'), false);
  assert.equal(ignored('!a.txt\n*.txt\n', 'a.txt'), true, 'a later rule wins over an earlier bang');
});

test('double stars span folders only as whole names', () => {
  assert.equal(ignored('**/fixtures', 'tests/unit/fixtures', true), true);
  assert.equal(ignored('**/fixtures', 'fixtures', true), true);
  assert.equal(ignored('logs/**', 'logs/2026/10/run.log'), true);
  assert.equal(ignored('logs/**', 'logs', true), false, 'everything inside, not the folder itself');
  assert.equal(ignored('a/**/b', 'a/b'), true);
  assert.equal(ignored('a/**/b', 'a/x/y/b'), true);
  assert.equal(ignored('a**b', 'a/x/b'), false, 'two stars inside a name are one star');
  assert.equal(ignored('a**b', 'axxb'), true);
});

test('classes, question marks and escapes', () => {
  assert.equal(ignored('run[0-9].log', 'run7.log'), true);
  assert.equal(ignored('run[!0-9].log', 'run7.log'), false);
  assert.equal(ignored('run[!0-9].log', 'runx.log'), true);
  assert.equal(ignored('fil?.txt', 'file.txt'), true);
  assert.equal(ignored('fil?.txt', 'fil/.txt'), false, 'a question mark is never the separator');
  assert.equal(ignored('\\#notes', '#notes'), true);
  assert.equal(ignored('\\!bang', '!bang'), true);
  assert.equal(ignored('[unclosed', '[unclosed'), true, 'a bracket that never closes is itself');
  assert.equal(ignored('a.b', 'axb'), false, 'a dot is a dot');
});

test('comments, blank lines, Windows line ends and trailing spaces say nothing', () => {
  const text = '# market data\r\n\r\ndata/raw/   \r\n   \r\n';
  assert.equal(ignored(text, 'data/raw', true), true);
  assert.equal(ignored(text, '# market data'), false);
  assert.equal(ignored('trail\\ ', 'trail '), true, 'an escaped trailing space stays');
});

test('a rule of a deeper file applies only below its folder', () => {
  assert.equal(ignored('*.csv', 'harvest/batches.csv', false, 'harvest'), true);
  assert.equal(ignored('*.csv', 'reports/batches.csv', false, 'harvest'), false);
  assert.equal(ignored('/cache', 'harvest/cache', true, 'harvest'), true);
});

test('on a file system that does not tell cases apart, neither does a rule', () => {
  // decsim2 ignores `config.php` and keeps a `Config.php`: git on macOS
  // matches the two (`core.ignorecase`, set by `git init` there).
  assert.equal(ignored('config.php', 'lib/Config.php', false, '', true), true);
  assert.equal(ignored('config.php', 'lib/Config.php', false, '', false), false);
});

/* ───────────────────────── the scan ───────────────────────── */

function fixture(): { home: string; policy: PathPolicy; done: () => void } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'towerglow-ignore-')));
  return {
    home,
    policy: { claudeDir: path.join(home, '.claude'), codexDir: path.join(home, '.codex'), homeDir: home },
    done: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

const CLONE_REFLOG =
  '0000000000000000000000000000000000000000 1111111111111111111111111111111111111111 ' +
  'Someone <someone@example.com> 1761900000 +0100\tclone: from https://github.com/x/strategies\n';

test('what the project ignores does not make its tower taller', () => {
  const { home, policy, done } = fixture();
  try {
    const p = path.join(home, 'python', 'tycho');
    write(p, {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.gitignore': '# Market data: large and re-downloadable\ndata/raw/\ndata/funding/\ndata/*.duckdb\nharvest/cache/\n',
      'config.py': '', 'engine/backtest.py': '', 'data/fetch.py': '',
      'data/raw/exchange/a.parquet': '', 'data/raw/exchange/b.parquet': '',
      'data/funding/exchange/a.parquet': '', 'data/market.duckdb': '',
      'harvest/cache/upstream/strategy.py': '', 'harvest/promote.py': '',
    });
    // .gitignore, config.py, engine/backtest.py, data/fetch.py, harvest/promote.py;
    // folders: engine, data, harvest.
    assert.deepEqual(measureProject(p, policy), { files: 5, dirs: 3 });
  } finally {
    done();
  }
});

test('what code makes and the project keeps is counted', () => {
  // tycho's agent writes a draft per harvested strategy into
  // `harvest/drafts`, which no rule ignores: 471 of them on the same day.
  const { home, policy, done } = fixture();
  try {
    const p = path.join(home, 'tycho');
    write(p, {
      '.git/HEAD': '', '.gitignore': 'harvest/cache/\n',
      'harvest/drafts/ft_adx.py': '', 'harvest/drafts/ft_adx.json': '', 'harvest/cache/x/s.py': '',
    });
    assert.equal(measureProject(p, policy).files, 3);
  } finally {
    done();
  }
});

test('a repository cloned inside the project is somebody else\'s code, one made there with git init is not', () => {
  const { home, policy, done } = fixture();
  try {
    const p = path.join(home, 'site');
    write(p, {
      '.git/HEAD': '', 'index.html': '',
      // Cloned, and not in any .gitignore: git would see one untracked folder.
      'refs/strategies/.git/logs/HEAD': CLONE_REFLOG, 'refs/strategies/a.py': '', 'refs/strategies/b.py': '',
      // seniqs_website_redesign's `labs`: an empty `git init` over files the outer repository tracks.
      'labs/.git/HEAD': '', 'labs/index.html': '', 'labs/css/style.css': '',
      // One made here and committed to: its reflog begins with the first commit.
      'tools/.git/logs/HEAD': CLONE_REFLOG.replace('clone: from https://github.com/x/strategies', 'commit (initial): first'),
      'tools/run.sh': '',
      // A submodule: its `.git` is a file pointing into the outer repository.
      'lib/engine/.git': 'gitdir: ../../.git/modules/engine\n', 'lib/engine/core.c': '',
    });
    // index.html, labs/index.html, labs/css/style.css, tools/run.sh;
    // folders: refs, labs, labs/css, tools, lib.
    assert.deepEqual(measureProject(p, policy), { files: 4, dirs: 5 });
  } finally {
    done();
  }
});

test('outside a repository a clone is what the folder holds', () => {
  // A folder of repositories opened as one project: they are the project.
  const { home, policy, done } = fixture();
  try {
    const p = path.join(home, 'games');
    write(p, { 'decsim2/.git/logs/HEAD': CLONE_REFLOG, 'decsim2/index.php': '', 'notes.md': '' });
    assert.equal(measureProject(p, policy).files, 2);
  } finally {
    done();
  }
});

test('a project inside a repository follows the rules written above it', () => {
  const { home, policy, done } = fixture();
  try {
    const top = path.join(home, 'mono');
    write(top, {
      '.git/HEAD': '', '.git/info/exclude': 'scratch/\n',
      '.gitignore': 'apps/web/data/\n*.log\n',
      'apps/.gitignore': 'web/tmp-*\n',
      'apps/web/src/main.ts': '', 'apps/web/data/dump.json': '', 'apps/web/run.log': '',
      'apps/web/tmp-1.txt': '', 'apps/web/scratch/x.ts': '',
    });
    // Only src/main.ts survives: data/ from the top, *.log from the top at any
    // depth, tmp-* from apps/, scratch/ from info/exclude.
    assert.deepEqual(measureProject(path.join(top, 'apps', 'web'), policy), { files: 1, dirs: 1 });
  } finally {
    done();
  }
});

test('a home kept under git does not empty the projects in it', () => {
  // A dotfiles repository in the home often ignores everything with `*`.
  const { home, policy, done } = fixture();
  try {
    write(home, { '.git/HEAD': '', '.gitignore': '*\n', 'notes/a.md': '', 'notes/b.md': '' });
    assert.equal(measureProject(path.join(home, 'notes'), policy).files, 2);
  } finally {
    done();
  }
});

test('the Finder\'s .DS_Store is nobody\'s file', () => {
  const { home, policy, done } = fixture();
  try {
    const p = path.join(home, 'web');
    write(p, { '.DS_Store': 'x', 'img/.DS_Store': 'x', 'img/logo.png': '', 'index.html': '' });
    assert.equal(measureProject(p, policy).files, 2);
  } finally {
    done();
  }
});

test('an ignore file is never read through a symlink, nor past its cap', () => {
  const { home, policy, done } = fixture();
  try {
    const p = path.join(home, 'linked');
    write(p, { '.git/HEAD': '', 'a.txt': '', 'b.txt': '' });
    write(home, { 'elsewhere/rules': '*.txt\n' });
    fs.symlinkSync(path.join(home, 'elsewhere', 'rules'), path.join(p, '.gitignore'));
    assert.equal(measureProject(p, policy).files, 2, 'the link is not followed, and a link is not a file');

    const q = path.join(home, 'huge');
    write(q, { '.git/HEAD': '', '.gitignore': `${'#'.repeat(MAX_IGNORE_BYTES)}\n*.txt\n`, 'a.txt': '' });
    assert.equal(measureProject(q, policy).files, 2, 'a rule past the cap is not read: .gitignore and a.txt');
  } finally {
    done();
  }
});
