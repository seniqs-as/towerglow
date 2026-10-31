import * as fs from 'node:fs';
import { assertReadable } from '../paths.ts';
import type { PathPolicy } from '../paths.ts';

/**
 * The project's own word on what is not its own: `.gitignore`.
 *
 * Seen on 2026-10-31: tycho had about 180 files of code and stood as a tower
 * of 2,490. The other 2,300 were ten repositories cloned into
 * `harvest/cache` and a few gigabytes of market data in `data/raw` and
 * `data/funding`, every one of them in its `.gitignore` ("large and
 * re-downloadable", "pinned source checkouts"). From a name alone nothing
 * tells a downloaded file from a written one -- a cloned strategy is a `.py`
 * like the project's own -- and the ignore rules are the one place where the
 * project says it, usually written by the same agent that downloaded them.
 *
 * Only the matching is git's. Git itself is never run, and neither the
 * patterns nor the names they match leave the server: they decide which
 * names are counted, and a count is all that goes out.
 */

/** One line of an ignore file, ready to match a path relative to the scan's top. */
export interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

/**
 * A `.gitignore` past this is read up to here. A real one is a few hundred
 * bytes; the cap is there for a file somebody generated, since every name
 * the scan meets is tried against every rule.
 */
export const MAX_IGNORE_BYTES = 64 * 1024;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** `[...]` at `i`, as a regex class; null when it never closes, and then `[` is a literal. */
function classAt(glob: string, i: number): { re: string; end: number } | null {
  let j = i + 1;
  let negate = false;
  if (glob[j] === '!' || glob[j] === '^') {
    negate = true;
    j++;
  }
  let body = '';
  // A `]` right after the opening is a member, not the end.
  if (glob[j] === ']') {
    body += '\\]';
    j++;
  }
  while (j < glob.length && glob[j] !== ']') {
    let c = glob[j]!;
    if (c === '\\' && j + 1 < glob.length) {
      j++;
      c = glob[j]!;
      body += /[\]\\^[-]/.test(c) ? `\\${c}` : c;
    } else {
      body += /[\]\\^[]/.test(c) ? `\\${c}` : c;
    }
    j++;
  }
  if (j >= glob.length) return null;
  // A class never matches the separator, as in git's wildmatch.
  return { re: negate ? `[^/${body}]` : `(?!/)[${body}]`, end: j + 1 };
}

/** git's wildmatch with a path separator, as a regex body. */
function globToRe(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*') {
      let run = 0;
      while (glob[i + run] === '*') run++;
      const whole = run === 2 && (i === 0 || glob[i - 1] === '/') &&
        (i + 2 === glob.length || glob[i + 2] === '/');
      if (whole && i + 2 === glob.length) {
        // `**` at the end: everything below.
        out += '.*';
        i += 2;
      } else if (whole) {
        // `**/`: any number of folders, none included.
        out += '(?:.*/)?';
        i += 3;
      } else {
        // Every other run of asterisks is one asterisk.
        out += '[^/]*';
        i += run;
      }
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i++;
      continue;
    }
    if (c === '[') {
      const cls = classAt(glob, i);
      if (cls) {
        out += cls.re;
        i = cls.end;
        continue;
      }
    }
    if (c === '\\' && i + 1 < glob.length) {
      out += escapeRe(glob[i + 1]!);
      i += 2;
      continue;
    }
    out += escapeRe(c);
    i++;
  }
  return out;
}

/**
 * The rules of one ignore file. `base` is the folder it sits in, relative to
 * the top of the scan and with `/` between names ('' for the top itself): a
 * rule applies only below it.
 *
 * `caseless` is git's `core.ignorecase`, which `git init` turns on where the
 * file system does not tell cases apart -- macOS and Windows by default. The
 * repository's own setting lives in `.git/config`, which is not read: that
 * file can hold credentials in a remote's URL.
 */
export function parseIgnore(text: string, base: string, caseless: boolean): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  const prefix = base === '' ? '' : `${escapeRe(base)}/`;
  for (let line of text.split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.startsWith('#')) continue;
    // Trailing spaces go, unless the last one is escaped.
    while (line.endsWith(' ') && !line.endsWith('\\ ')) line = line.slice(0, -1);
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (line === '') continue;
    // A separator at the start or in the middle ties the pattern to this
    // folder; without one it matches a name at any depth below it.
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    if (line === '') continue;
    const body = (anchored ? '' : '(?:.*/)?') + globToRe(line);
    try {
      rules.push({ re: new RegExp(`^${prefix}${body}$`, caseless ? 'si' : 's'), negate, dirOnly });
    } catch {
      // A pattern this translation gets wrong is one rule fewer, never a failed scan.
    }
  }
  return rules;
}

/** Whether `rel` is ignored: the last rule that matches decides, as in git. */
export function isIgnored(rules: readonly IgnoreRule[], rel: string, isDir: boolean): boolean {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (rule.dirOnly && !isDir) continue;
    if (rule.re.test(rel)) return !rule.negate;
  }
  return false;
}

/**
 * The first `maxBytes` of a small file, or null when there is none. Through
 * the allow-list like every other read, and never through a symlink.
 */
export function readPrefix(file: string, policy: PathPolicy, maxBytes: number): string | null {
  let fd: number;
  try {
    assertReadable(file, policy);
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** The text of an ignore file, at most `MAX_IGNORE_BYTES` of it. */
export const readIgnoreFile = (file: string, policy: PathPolicy): string | null =>
  readPrefix(file, policy, MAX_IGNORE_BYTES);
