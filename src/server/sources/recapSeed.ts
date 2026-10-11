import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { assertReadable, slugFor } from '../paths.ts';
import type { PathPolicy } from '../paths.ts';
import { createStats, parseLine } from '../parse/records.ts';
import { MAX_RECAP_CHARS } from '../../shared/protocol.ts';

/**
 * The recap a session enters the city with.
 *
 * `away_summary` is per session, and a newborn session has none: measured on
 * a long session, the first arrives 35 minutes after the start, and the
 * following intervals range from 11 to 765 minutes. Since `/clear` changes
 * the sessionId while keeping the same terminal, the summary vanished from
 * the card right while the work went on -- verified on three real projects:
 * the only one showing the recap was the one that had never been cleared.
 *
 * It looks FIRST in the session's own transcript: its recap is always the
 * right one, and the tail's warm-up window may have left it behind in a file
 * of tens of MB. Only if it is not there does it move on to the other
 * transcripts of the same project, and the result comes out marked as
 * inherited so that the card says so instead of passing it off as its own.
 */

/** How much tail is read per file: the farthest recap measured was 1.7 MB before the end. */
const TAIL_BYTES = 4 * 1024 * 1024;

/** How many transcripts are opened, from the most recent down. Beyond that is archaeology. */
const MAX_FILES = 4;

/**
 * Beyond this age an inherited summary is not inherited.
 *
 * It applies ONLY to one taken from another session: the session's own
 * recap stays what it is, however old, because it still describes the
 * session being looked at.
 */
const MAX_INHERITED_AGE_MS = 24 * 60 * 60_000;

export interface SeededRecap {
  text: string;
  at: number;
  /** Comes from ANOTHER transcript of the same project, not from its own. */
  inherited: boolean;
}

export function findRecap(opts: {
  claudeDir: string;
  cwd: string;
  sessionId: string;
  policy: PathPolicy;
  now?: number;
}): SeededRecap | null {
  const dir = path.join(opts.claudeDir, 'projects', slugFor(opts.cwd));
  const own = `${opts.sessionId}.jsonl`;
  const now = opts.now ?? Date.now();

  const mine = lastRecapIn(path.join(dir, own), opts.policy);
  if (mine) return { ...mine, inherited: false };

  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }

  const others: { file: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (name === own || !name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || now - st.mtimeMs > MAX_INHERITED_AGE_MS) continue;
      others.push({ file, mtimeMs: st.mtimeMs });
    } catch {
      // vanished between readdir and stat: we ignore it
    }
  }
  others.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let best: { text: string; at: number } | null = null;
  for (const cand of others.slice(0, MAX_FILES)) {
    // A file cannot contain a recap written after its own mtime: when the one
    // already found is more recent than the next candidate's mtime, none of
    // the remaining ones can beat it and nothing more is opened.
    if (best && best.at >= cand.mtimeMs) break;
    const hit = lastRecapIn(cand.file, opts.policy);
    if (!hit || now - hit.at > MAX_INHERITED_AGE_MS) continue;
    if (!best || hit.at > best.at) best = hit;
  }
  return best ? { ...best, inherited: true } : null;
}

/**
 * A transcript's last `away_summary`, searched from the end.
 *
 * Only the tail is read, and scanned backwards: the recap we want is the
 * last one written, and re-reading tens of MB to find it would be wasteful.
 * The line goes through the same defensive parser as the tail -- the JSONL
 * format is internal to Claude Code and changes between versions, and this
 * module must not have to know it too.
 */
function lastRecapIn(file: string, policy: PathPolicy): { text: string; at: number } | null {
  try {
    assertReadable(file, policy);
  } catch {
    return null; // outside the allow-list: it is not opened, period
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    if (len <= 0) return null;

    const buf = Buffer.allocUnsafe(len);
    const read = fs.readSync(fd, buf, 0, len, start);
    // StringDecoder and not buf.toString(): starting mid-file the first
    // character can be split, and so can the last one if the session is
    // writing right now.
    const text = new StringDecoder('utf8').write(buf.subarray(0, read));

    const lines = text.split('\n');
    // Starting mid-file the first line is almost always truncated.
    if (start > 0) lines.shift();

    const stats = createStats();
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      // The crude filter before the parse: on a transcript of millions of
      // characters, running JSON.parse on every line to find one would cost
      // more than the read.
      if (!line || !line.includes('away_summary')) continue;
      const rec = parseLine(line, stats);
      // The same cap as a recap read live (redact.ts): this one goes straight
      // into the session the page receives, without passing through there.
      if (rec?.kind === 'recap') return { text: rec.recap.slice(0, MAX_RECAP_CHARS), at: rec.timestamp };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed or gone: there is nothing to save
      }
    }
  }
}
