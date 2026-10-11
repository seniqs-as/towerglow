import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertReadable, slugFor } from '../paths.ts';
import type { PathPolicy } from '../paths.ts';

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
  'coverage', 'Pods', '.gradle', '.idea', '.terraform', 'tmp', '.DS_Store',
]);

const MAX_FILES = 20000;
const MAX_DEPTH = 10;

/**
 * Size of the project in number of files. It decides the building's height.
 *
 * It is a BOUNDED scan: it stops at 20,000 files and 10 levels, and skips the
 * heavy directories. It reads only entry names and types, never a file's
 * contents, so it does not touch the read allow-list -- which governs
 * contents.
 */
export function measureProject(cwd: string, homeDir?: string): number {
  // The home directory registered as a project is not a project: scanning it
  // is slow and produces a towering building that means nothing.
  if (homeDir && path.resolve(cwd) === path.resolve(homeDir)) return 0;

  let count = 0;
  const stack: { dir: string; depth: number }[] = [{ dir: cwd, depth: 0 }];

  while (stack.length > 0 && count < MAX_FILES) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // permissions, broken links, vanished directory: carry on
    }
    for (const entry of entries) {
      if (count >= MAX_FILES) break;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || depth >= MAX_DEPTH) continue;
        stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      } else if (entry.isFile()) {
        count++;
      }
    }
  }
  return count;
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
