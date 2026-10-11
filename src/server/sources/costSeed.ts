import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { assertReadable, slugFor } from '../paths.ts';
import type { PathPolicy } from '../paths.ts';
import { createStats, parseLine } from '../parse/records.ts';
import type { CostStateRecord } from '../parse/records.ts';

/**
 * The final tallies of sessions already finished, recovered once at startup.
 *
 * The tailer follows only the sessions in the registry: a closed transcript
 * is never opened, so without this read the history would start empty and
 * fill only going forward, one row for each session you close from now on.
 * Measured: there were already 33 on disk, for 1430 declared dollars.
 *
 * Two measurements decide the shape of this file:
 *
 *  1. TRANSCRIPTS ARE HUGE -- 275 MB across thirty-six files, the largest
 *     78 MB. A full scan at startup is out of the question, so only the TAIL
 *     is read: the final tally is always in the last lines.
 *  2. THE TAIL DOES NOT CARRY THE COUNTERS. `cost-state` declares cost,
 *     tokens, lines and durations, but not turns or tool calls: those are
 *     counted by watching the events go by, and for a session already closed
 *     that is no longer possible. The rows therefore come out with
 *     `watched: false`, and it is up to the reader not to sum them as if they
 *     were complete.
 *
 * It goes through the allow-list like every other server read: these files
 * are already admitted -- they are the same ones the tailer opens -- and no
 * new path is granted.
 */

/**
 * How much tail is read per file.
 *
 * The final tally is among the last three lines, but the line before it can
 * be an assistant message of hundreds of kilobytes. Half a megabyte is ample
 * and still costs eighteen MB across all transcripts together.
 */
const TAIL_BYTES = 512 * 1024;

export interface SeededCost {
  cwd: string;
  record: CostStateRecord;
}

export interface CostSeedOptions {
  claudeDir: string;
  policy: PathPolicy;
  /**
   * Nothing further back than this is looked at.
   *
   * Beyond the row window the history is already aggregated by month, and an
   * aggregate built from a partial scan would be worse than no aggregate: it
   * would state a number, and the number would be wrong.
   */
  maxAgeMs: number;
  now?: number;
}

/** Only the main transcripts: subagents have no final tally of their own. */
const RE_TRANSCRIPT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

export function readClosedCosts(
  cwds: readonly string[],
  opts: CostSeedOptions,
): SeededCost[] {
  const now = opts.now ?? Date.now();
  const out: SeededCost[] = [];

  for (const cwd of cwds) {
    const dir = path.join(opts.claudeDir, 'projects', slugFor(cwd));
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue; // project with no transcripts: not an error
    }

    for (const name of names) {
      if (!RE_TRANSCRIPT.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || now - st.mtimeMs > opts.maxAgeMs) continue;
      } catch {
        continue; // vanished between readdir and stat
      }
      const record = lastCostIn(file, opts.policy);
      if (record) out.push({ cwd, record });
    }
  }

  return out;
}

/** A transcript's last final tally, searched from the end. */
function lastCostIn(file: string, policy: PathPolicy): CostStateRecord | null {
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
    // character can be split.
    const text = new StringDecoder('utf8').write(buf.subarray(0, read));

    const lines = text.split('\n');
    // Starting mid-file the first line is almost always truncated. It is
    // thrown away instead of being handed to the parser: it would end up among
    // the `badLines` of /healthz, which is a diagnostic counter and must not
    // go off for something intended.
    if (start > 0) lines.shift();

    const stats = createStats();
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      // The crude filter before the parse: running JSON.parse over half a
      // megabyte of lines to find one would cost more than the read.
      if (!line || !line.includes('"cost-state"')) continue;
      const rec = parseLine(line, stats);
      if (rec?.kind === 'cost_state') return rec;
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
