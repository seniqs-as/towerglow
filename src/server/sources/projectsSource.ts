import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertReadable, slugFor } from '../paths.ts';
import type { PathPolicy } from '../paths.ts';
import { MAX_SCANNED_DEPTH, MAX_SCANNED_FILES } from '../../shared/protocol.ts';
import { isIgnored, parseIgnore, readIgnoreFile, readPrefix } from './ignoreRules.ts';
import type { IgnoreRule } from './ignoreRules.ts';

/**
 * List of known projects.
 *
 * The ~/.claude/projects directory uses a NON-invertible slug (every
 * non-alphanumeric character becomes a hyphen), so the real cwd cannot be
 * recovered from there. The only reliable source is ~/.claude.json.
 *
 * WARNING: that file also contains oauthAccount, userID, machineID and the
 * per-project history. This module extracts ONLY the keys of `projects` and
 * drops everything else without ever passing it downstream.
 */
export function readKnownProjectPaths(homeDir: string, policy: PathPolicy): string[] {
  const file = path.join(homeDir, '.claude.json');
  try {
    assertReadable(file, policy);
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== 'object') return [];
  const projects = (parsed as Record<string, unknown>)['projects'];
  if (!projects || typeof projects !== 'object') return [];

  // Only the keys. No value from that file is ever read.
  return Object.keys(projects as Record<string, unknown>).filter(
    (p) => typeof p === 'string' && path.isAbsolute(p),
  );
}

/**
 * A project's last known activity: the mtime of the most recent transcript.
 *
 * NOT the directory's mtime, which is the easy mistake to make here: that one
 * changes only when a file is created or deleted, not when a session appends
 * to an existing transcript. Verified: a project with a long session had its
 * directory stuck ten hours before its last turn.
 *
 * These are only `stat`s: no file is opened, so it stays outside the read
 * allow-list, which governs contents.
 */
export function projectLastActive(claudeDir: string, cwd: string): number {
  const dir = path.join(claudeDir, 'projects', slugFor(cwd));
  let newest = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const st = fs.statSync(path.join(dir, name));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        // vanished between readdir and stat: we ignore it
      }
    }
    if (newest === 0) newest = fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
  return newest;
}

/** A project that is registered but no longer on disk becomes a ruined building. */
export function existsOnDisk(cwd: string): boolean {
  try {
    return fs.statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

/** --exclude filter: substring match, sufficient and predictable. */
export function makeExcluder(patterns: readonly string[]): (cwd: string) => boolean {
  if (patterns.length === 0) return () => false;
  const needles = patterns.map((p) => p.replace(/\*/g, ''));
  return (cwd: string) => needles.some((n) => n.length > 0 && cwd.includes(n));
}


/**
 * Directories that would inflate the count without saying anything about the
 * project. They are also the biggest, so skipping them is what makes the
 * scan fast.
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  'vendor', '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.cache',
  'coverage', 'Pods', '.gradle', '.idea', '.terraform', 'tmp',
]);

/** What a scan of a project's folder found: it sizes the tower, and the details say it. */
export interface ProjectMeasure {
  files: number;
  /** The folders the scan went into: the skipped ones and those past the depth are not counted. */
  dirs: number;
}

export const NOTHING_MEASURED: ProjectMeasure = { files: 0, dirs: 0 };

/** git's `core.ignorecase` where `git init` turns it on by default. */
const CASELESS_FS = process.platform === 'darwin' || process.platform === 'win32';

/**
 * The repository a project's folder belongs to: the nearest folder holding a
 * `.git`, the folder itself included. Never the home folder or above it: a
 * home kept under git for its dotfiles often ignores `*`, and would leave
 * every project in it that is not a repository of its own with no files.
 * Only `lstat`s: nothing is opened.
 */
function repositoryTop(cwd: string, homeDir: string): { top: string; gitDir: boolean } | null {
  const home = path.resolve(homeDir);
  let dir = path.resolve(cwd);
  for (;;) {
    if (dir === home) return null;
    try {
      const st = fs.lstatSync(path.join(dir, '.git'));
      // A `.git` FILE is a worktree or a submodule: its info/exclude is elsewhere.
      return { top: dir, gitDir: st.isDirectory() };
    } catch {
      // not here
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** `a/b/c` from the top to `dir`, whatever the platform's separator. */
const relUnder = (top: string, dir: string): string =>
  path.relative(top, dir).split(path.sep).join('/');

/**
 * The rules in force at the scan's root, before its own `.gitignore`: the
 * repository's `info/exclude`, then every `.gitignore` from the top down to
 * the root's parent, in git's order -- a deeper file overrides a shallower
 * one, and both override `info/exclude`.
 */
function inheritedRules(root: string, repo: { top: string; gitDir: boolean }, policy: PathPolicy): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  if (repo.gitDir) {
    const text = readIgnoreFile(path.join(repo.top, '.git', 'info', 'exclude'), policy);
    if (text !== null) rules.push(...parseIgnore(text, '', CASELESS_FS));
  }
  // The top is the root or one of its ancestors: `repositoryTop` walked up to it.
  const between: string[] = [];
  for (let dir = root; dir !== repo.top && dir !== path.dirname(dir); ) {
    dir = path.dirname(dir);
    between.unshift(dir);
  }
  for (const dir of between) {
    const text = readIgnoreFile(path.join(dir, '.gitignore'), policy);
    if (text !== null) rules.push(...parseIgnore(text, relUnder(repo.top, dir), CASELESS_FS));
  }
  return rules;
}

/**
 * Size of the project in number of files. It decides the building's height.
 *
 * It is a BOUNDED scan: it stops at 20,000 files and 10 levels, and skips the
 * heavy directories. The files counted are the project's own, as git would
 * see them (2026-10-31, the user's request after tycho's tower grew with the
 * data it downloaded): what the project's `.gitignore` files and
 * `.git/info/exclude` leave out is not entered, and inside a repository a
 * folder that is a repository of its own -- a clone, a submodule -- is
 * somebody else's code. Those ignore files and the first line of a nested
 * repository's reflog are the only contents read, through the allow-list
 * (`ignoreRules.ts`); everything else is entry names and types. The folders
 * are counted on the same pass, from the same names.
 */
export function measureProject(cwd: string, policy: PathPolicy): ProjectMeasure {
  // The home directory registered as a project is not a project: scanning it
  // is slow and produces a towering building that means nothing.
  if (path.resolve(cwd) === path.resolve(policy.homeDir)) return NOTHING_MEASURED;

  const root = path.resolve(cwd);
  const repo = repositoryTop(root, policy.homeDir);
  // Paths are matched from the repository's top, so a rule written there for
  // `sub/data/` holds when the project is `sub`. Outside a repository, the
  // scan's own root is the top.
  const top = repo?.top ?? root;
  const rootRules = repo ? inheritedRules(root, repo, policy) : [];

  let count = 0;
  let dirs = 0;
  const stack: { dir: string; depth: number; rules: IgnoreRule[] }[] = [{ dir: root, depth: 0, rules: rootRules }];

  while (stack.length > 0 && count < MAX_SCANNED_FILES) {
    const { dir, depth, rules: inherited } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // permissions, broken links, vanished directory: carry on
    }
    const base = relUnder(top, dir);
    let rules = inherited;
    if (entries.some((e) => e.name === '.gitignore' && e.isFile())) {
      const text = readIgnoreFile(path.join(dir, '.gitignore'), policy);
      if (text !== null) rules = [...inherited, ...parseIgnore(text, base, CASELESS_FS)];
    }
    const relOf = (name: string): string => (base === '' ? name : `${base}/${name}`);
    for (const entry of entries) {
      if (count >= MAX_SCANNED_FILES) break;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || depth >= MAX_SCANNED_DEPTH) continue;
        const sub = path.join(dir, entry.name);
        if (rules.length > 0 && isIgnored(rules, relOf(entry.name), true)) continue;
        // Outside a repository there is no outer project to keep a clone
        // apart from: a folder of repositories is what its folders hold.
        if (repo && isForeignRepository(sub, policy)) continue;
        dirs++;
        stack.push({ dir: sub, depth: depth + 1, rules });
      } else if (entry.isFile()) {
        if (SKIP_FILES.has(entry.name)) continue;
        if (rules.length > 0 && isIgnored(rules, relOf(entry.name), false)) continue;
        count++;
      }
    }
  }
  return { files: count, dirs };
}

/**
 * Files that are never a project's: macOS leaves one in every folder the
 * Finder opens. Git leaves them out through the user's global excludes,
 * which are not read.
 */
const SKIP_FILES = new Set(['.DS_Store']);

/** Where a reflog's first line says how the repository began. */
const REFLOG_HEAD_BYTES = 4096;

/**
 * Inside a repository, a folder that is a repository of its own is somebody
 * else's code when git says so. A `.git` FILE is a submodule or a linked
 * worktree, which the outer repository records as one entry, not as files;
 * a reflog that begins with `clone:` is a download -- the ten strategy
 * repositories in tycho's `harvest/cache` all begin that way. A nested
 * repository made with `git init` is still work done here: seniqs_website_redesign
 * has one in `labs`, empty, while the outer repository tracks its files.
 * A clone whose first reflog line was expired by `git gc` (90 days by
 * default) is counted: what cannot be shown to be a download is not called one.
 */
function isForeignRepository(dir: string, policy: PathPolicy): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
  if (!st.isDirectory()) return true;
  const head = readPrefix(path.join(dir, '.git', 'logs', 'HEAD'), policy, REFLOG_HEAD_BYTES);
  if (head === null) return false;
  // `<old> <new> <who> <when> <tz>\t<action>`: only the action's verb is
  // looked at; the clone's URL and the author are dropped with the rest.
  const first = head.split('\n', 1)[0] ?? '';
  const tab = first.indexOf('\t');
  return tab >= 0 && first.slice(tab + 1).startsWith('clone:');
}

/**
 * The subscription plan, and nothing else.
 *
 * Claude Code does NOT declare it in the statusline -- verified on the real
 * payload: forty-four fields, and the plan is not there. The only place it
 * exists on this machine is `oauthAccount` inside `~/.claude.json`, which is
 * exactly the part of that file the rest of the program avoids.
 *
 * So here the read is widened by EXACTLY three fields, all category strings:
 * `organizationType`, `organizationRateLimitTier`, `userRateLimitTier`. Left
 * out -- and not even touched -- are `emailAddress`, `fullName`,
 * `displayName`, `accountUuid`, `organizationName`, `organizationUuid` and
 * everything else. What comes out of here is a single word such as `max 5x`,
 * and `redaction.test.ts` checks that it really is so.
 */
export function readPlanLabel(homeDir: string, policy: PathPolicy): string | null {
  const file = path.join(homeDir, '.claude.json');
  try {
    assertReadable(file, policy);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const account = (parsed as Record<string, unknown>)['oauthAccount'];
  if (!account || typeof account !== 'object') return null;
  const a = account as Record<string, unknown>;

  // In order of specificity: the personal tier beats the organization's,
  // which in turn is more precise than the organization type.
  for (const key of ['userRateLimitTier', 'organizationRateLimitTier', 'organizationType']) {
    const raw = a[key];
    if (typeof raw !== 'string') continue;
    const label = planLabel(raw);
    if (label) return label;
  }
  return null;
}

/**
 * From `default_claude_max_5x` to `max 5x`.
 *
 * Only known plan names are recognized, and the string is rebuilt from
 * scratch: that way whatever is in that field -- today or after an update --
 * cannot get out as is.
 */
function planLabel(raw: string): string | null {
  const m = /(free|pro|max|team|enterprise)(?:_(\d{1,2})x)?/i.exec(raw);
  if (!m) return null;
  const tier = m[1]!.toLowerCase();
  return m[2] ? `${tier} ${m[2]}x` : tier;
}
