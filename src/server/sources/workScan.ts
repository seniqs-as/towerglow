import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ProviderId } from '../../shared/protocol.ts';
import { assertReadable, slugFor } from '../paths.ts';
import type { PathPolicy } from '../paths.ts';
import { createStats, parseLine } from '../parse/records.ts';
import { discoverRollouts, parseRolloutLine } from '../providers/codex/rollouts.ts';
import { WorkMeter } from '../state/workMeter.ts';
import type { WorkTotals } from '../state/workMeter.ts';
import { validSessionId } from '../watch.ts';

/**
 * A session's hours, read from its whole transcript.
 *
 * Every other read at startup takes only a tail (`costSeed`, the tailer's
 * warm-up), because transcripts are huge: 1.4 GB over the last 30 days on
 * 2026-10-24. The hours cannot come from a tail -- a session's first turns
 * are at the top -- so this reads the whole file, ONCE per session: in
 * chunks, one file at a time, yielding between chunks so the server keeps
 * answering. Measured: all of them in sixteen seconds, the largest
 * (28 MB) in a quarter of a second. After that a session open on screen is
 * read only for what it has added since.
 *
 * What it keeps of a line is its instant and its kind, and of a reply the
 * model and effort it ran on: never its text.
 * Every file goes through the allow-list, and no new path is admitted: these
 * are the transcripts and rollouts the tailer already opens.
 */

export interface WorkSource {
  provider: ProviderId;
  sessionId: string;
  /** The project's folder, from the server's own model. */
  cwd: string;
  startedAt: number;
}

export interface WorkScanOptions {
  policy: PathPolicy;
  /** Bytes per read: small enough that a parse between two never stalls the server. */
  chunkBytes?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK_BYTES = 1 << 20;
/**
 * Past this a line is skipped unparsed. Only a tool's output gets this long,
 * and it is one instant among thousands: parsing fifty megabytes for it
 * would stall the server for the one timestamp that changes nothing.
 */
const MAX_LINE = 4 << 20;
/** A `claude -p`: a worker, a CEO's call, a script. Nobody typed its messages. */
const RE_SDK = /"entrypoint":"sdk/;
/** Codex sessions a person drives: the terminal and the desktop app. `exec` is a script. */
const CODEX_HUMAN = new Set(['cli', 'vscode']);
/**
 * What a model's name looks like: `claude-opus-5-5`, `gpt-6.1-sol`,
 * `claude-sonnet-5-5[1m]`. Anything else is not counted as a model -- Claude
 * Code's `<synthetic>` stand-in for a reply it made up, or a field that is not
 * a name -- because the card sends it to the page as written.
 */
const RE_MODEL = /^[A-Za-z0-9][\w.:@/[\]-]{0,63}$/;
/** `low` ... `max`, `xhigh`, `minimal`: a word. */
const RE_EFFORT = /^[a-z]{1,16}$/;

interface Entry {
  file: string;
  offset: number;
  carry: string;
  /** The rest of a line too long to parse is being thrown away. */
  skipping: boolean;
  decoder: StringDecoder;
  meter: WorkMeter;
  /** Codex says it once, in `session_meta`: who is typing into this session. */
  human: boolean;
  /** The first line has not been read yet. */
  fresh: boolean;
}

export class WorkScanner {
  #policy: PathPolicy;
  #chunk: number;
  #entries = new Map<string, Entry>();
  /**
   * Finished sessions with no file to read: deleted by the tool, or
   * compressed by Codex. Looked for once per run, not at every card that
   * opens. Only finished ones: an open session has no transcript until its
   * first message.
   */
  #missing = new Set<string>();
  #queue: (() => Promise<void>)[] = [];
  #running = false;
  /** Its own counters: what this pass skips is not a fault for /healthz. */
  #stats = createStats();

  constructor(opts: WorkScanOptions) {
    this.#policy = opts.policy;
    this.#chunk = opts.chunkBytes ?? CHUNK_BYTES;
  }

  /**
   * The session's totals so far, reading what it has added since last time.
   * `urgent` goes ahead of the queue: a card is open and waiting for it.
   */
  measure(src: WorkSource, urgent = false): Promise<WorkTotals | null> {
    return this.#enqueue(() => this.#advance(src, false), urgent);
  }

  /** The session is over: its final totals, and nothing of it is kept here. */
  finish(src: WorkSource, urgent = false): Promise<WorkTotals | null> {
    return this.#enqueue(async () => {
      const totals = await this.#advance(src, true);
      this.#entries.delete(src.sessionId);
      return totals;
    }, urgent);
  }

  #enqueue(job: () => Promise<WorkTotals | null>, urgent: boolean): Promise<WorkTotals | null> {
    return new Promise((resolve) => {
      const run = async (): Promise<void> => {
        try {
          resolve(await job());
        } catch {
          resolve(null);
        }
      };
      if (urgent) this.#queue.unshift(run);
      else this.#queue.push(run);
      void this.#pump();
    });
  }

  async #pump(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (let job = this.#queue.shift(); job; job = this.#queue.shift()) await job();
    } finally {
      this.#running = false;
    }
  }

  async #advance(src: WorkSource, final: boolean): Promise<WorkTotals | null> {
    let e = this.#entries.get(src.sessionId);
    if (!e) {
      if (final && this.#missing.has(src.sessionId)) return null;
      const file = this.#locate(src);
      if (!file) {
        if (final) this.#missing.add(src.sessionId);
        return null;
      }
      e = fresh(file);
      this.#entries.set(src.sessionId, e);
    }

    let fh: fs.promises.FileHandle | null = null;
    try {
      assertReadable(e.file, this.#policy);
      fh = await fs.promises.open(e.file, 'r');
      const size = (await fh.stat()).size;
      // Transcripts only grow: a shorter one is another file, read anew.
      if (size < e.offset) {
        e = fresh(e.file);
        this.#entries.set(src.sessionId, e);
      }
      const buf = Buffer.allocUnsafe(this.#chunk);
      while (e.offset < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(this.#chunk, size - e.offset), e.offset);
        if (bytesRead <= 0) break;
        e.offset += bytesRead;
        this.#feed(e, src.provider, e.decoder.write(buf.subarray(0, bytesRead)));
      }
    } catch {
      // Gone, or refused by the allow-list: what was read so far still stands.
      if (e.offset === 0) {
        this.#entries.delete(src.sessionId);
        return null;
      }
    } finally {
      await fh?.close().catch(() => {});
    }
    // A last line written without its newline is complete only once the
    // session is over.
    if (final && e.carry && !e.skipping) this.#line(e, src.provider, e.carry);
    return e.meter.totals();
  }

  #feed(e: Entry, provider: ProviderId, piece: string): void {
    let start = 0;
    for (let nl = piece.indexOf('\n'); nl >= 0; nl = piece.indexOf('\n', start)) {
      const tail = piece.slice(start, nl);
      if (e.skipping) e.skipping = false;
      else this.#line(e, provider, e.carry ? e.carry + tail : tail);
      e.carry = '';
      start = nl + 1;
    }
    if (e.skipping) return;
    e.carry += piece.slice(start);
    if (e.carry.length > MAX_LINE) {
      e.carry = '';
      e.skipping = true;
    }
  }

  #line(e: Entry, provider: ProviderId, line: string): void {
    if (!line) return;
    if (provider === 'codex' && e.fresh) {
      e.fresh = false;
      e.human = codexHuman(line);
      return;
    }
    e.fresh = false;
    // Both parsers stand in "now" for a missing instant, which in a file
    // from last week would be an hour of work that never happened.
    if (!line.includes('"timestamp"')) return;

    if (provider === 'codex') {
      const ev = parseRolloutLine(line);
      if (!ev) return;
      if (ev.kind === 'model') this.#model(e, ev.model, ev.effort);
      else if (ev.kind === 'turn_started') e.meter.prompt(ev.atMs, e.human);
      else if (ev.kind === 'turn_completed') e.meter.turnEnd(ev.atMs, ev.durationMs);
      else if (ev.kind === 'turn_aborted') e.meter.abort(ev.atMs);
      else e.meter.activity(ev.atMs);
      return;
    }

    const rec = parseLine(line, this.#stats);
    if (!rec) return;
    switch (rec.kind) {
      case 'prompt':
        e.meter.prompt(rec.timestamp, !RE_SDK.test(line), rec.source === 'queued');
        return;
      case 'turn_end':
        e.meter.turnEnd(rec.timestamp, rec.durationMs);
        return;
      case 'assistant':
        // A subagent's reply is its own model, inside the session's turn.
        if (rec.agentId === null && rec.model) this.#model(e, rec.model, rec.effort);
        e.meter.activity(rec.timestamp);
        return;
      case 'tool_result':
      case 'agent_done':
      case 'limit':
      case 'compact':
      case 'context':
        e.meter.activity(rec.timestamp);
        return;
      // A recap is written while you are away, and a closing tally carries
      // the session's START as its instant: neither is the session at work.
      default:
        return;
    }
  }

  #model(e: Entry, model: string, effort: string | null): void {
    if (!RE_MODEL.test(model)) return;
    e.meter.model(model, effort !== null && RE_EFFORT.test(effort) ? effort : null);
  }

  #locate(src: WorkSource): string | null {
    if (!validSessionId(src.sessionId)) return null;
    if (src.provider === 'claude') {
      const file = path.join(this.#policy.claudeDir, 'projects', slugFor(src.cwd), `${src.sessionId}.jsonl`);
      try {
        const ok = assertReadable(file, this.#policy);
        return fs.existsSync(ok) ? ok : null;
      } catch {
        return null;
      }
    }
    // A rollout is touched last when its session ends, never before it began.
    const found = discoverRollouts(this.#policy.codexDir, this.#policy, src.startedAt - DAY_MS)
      .filter((r) => r.sessionId === src.sessionId && !r.subagent)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    return found ? found.file : null;
  }
}

function fresh(file: string): Entry {
  return {
    file, offset: 0, carry: '', skipping: false, decoder: new StringDecoder('utf8'),
    meter: new WorkMeter(), human: false, fresh: true,
  };
}

/** `session_meta.payload.source`: a string for a chat, an object for a subagent. */
function codexHuman(line: string): boolean {
  try {
    const rec = JSON.parse(line) as { type?: unknown; payload?: { source?: unknown } } | null;
    const source = rec?.type === 'session_meta' ? rec.payload?.source : undefined;
    return typeof source === 'string' && CODEX_HUMAN.has(source);
  } catch {
    return false;
  }
}
