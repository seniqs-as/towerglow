import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProviderId } from '../shared/protocol.ts';
import { assertReadable, slugFor } from './paths.ts';
import type { PathPolicy } from './paths.ts';
import { discoverRollouts } from './providers/codex/rollouts.ts';

/**
 * A terminal window for a session that has none.
 *
 * A CEO's worker is a headless process with pipes and no tty: there is no
 * window to bring forward, and the user wanted one anyway -- "with the
 * option to open the terminal", like every other session on a lot.
 * This is what that window runs: `towerglow watch`, which prints what the
 * session has written to its transcript and follows it while it grows.
 *
 * Read-only by construction. It never writes to the session (no live session
 * is ever written to), it opens one file and only through the allow-list, and
 * what it prints goes to the user's own terminal, never to the browser: the
 * redaction rule is about the delta channel, and nothing here touches it.
 * When the session's process ends it says so and shows how to resume it by
 * hand, which is safe only then.
 */

/** Session ids as both tools write them. Anything else never reaches a path. */
const RE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
/** How much of a long transcript is replayed before following: the latest part is what matters. */
export const REPLAY_BYTES = 4 * 1024 * 1024;
/** How many lines of a tool's output are shown: enough to recognise it, not to read it. */
const RESULT_LINES = 3;
/** The briefing a worker starts with is long; its head says what the task is. */
const PROMPT_LINES = 24;
const LINE_CAP = 240;

export function validSessionId(id: string): boolean {
  return RE_SESSION_ID.test(id);
}

/* ───────────────────────── the transcript ───────────────────────── */

/**
 * Where a session's transcript is, or null.
 *
 * The same places the sources tail: Claude's `projects/<slug>/<id>.jsonl`,
 * Codex's rollout whose `session_meta` names the id. Every candidate goes
 * through `assertReadable` before it is returned.
 */
export function transcriptFor(
  provider: ProviderId,
  sessionId: string,
  cwd: string,
  policy: PathPolicy,
  now: number,
): string | null {
  if (!validSessionId(sessionId)) return null;
  if (provider === 'claude') {
    const file = path.join(policy.claudeDir, 'projects', slugFor(cwd), `${sessionId}.jsonl`);
    try {
      // The allow-list judges the path, not whether it is there yet.
      const ok = assertReadable(file, policy);
      return fs.existsSync(ok) ? ok : null;
    } catch {
      return null;
    }
  }
  // A week back is far more than any live session: the tree is by day.
  const found = discoverRollouts(policy.codexDir, policy, now - 7 * 86_400_000)
    .filter((r) => r.sessionId === sessionId && !r.subagent)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!found) return null;
  try {
    return assertReadable(found.file, policy);
  } catch {
    return null;
  }
}

/* ───────────────────────── one record, a few lines ───────────────────────── */

export interface Paint {
  prompt: (s: string) => string;
  tool: (s: string) => string;
  dim: (s: string) => string;
  error: (s: string) => string;
}

const PLAIN: Paint = { prompt: (s) => s, tool: (s) => s, dim: (s) => s, error: (s) => s };

/** ANSI colours for a terminal, nothing for a pipe. */
export function paintFor(tty: boolean): Paint {
  if (!tty) return PLAIN;
  const wrap = (open: string) => (s: string): string => `\x1b[${open}m${s}\x1b[0m`;
  return { prompt: wrap('1;36'), tool: wrap('1;33'), dim: wrap('2'), error: wrap('31') };
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A character a terminal acts on instead of showing: C0 but line break and tab, DEL, C1. */
function isControl(code: number): boolean {
  return (code < 0x20 && code !== 0x0a && code !== 0x09) || (code >= 0x7f && code <= 0x9f);
}

/**
 * The record with every string stripped of control characters.
 *
 * A transcript holds text from outside the session -- a fetched page, a
 * command's output -- and printed as it is, an escape sequence in it drives
 * this terminal: it can move the cursor over earlier lines, hide text, or
 * rename the window. Only line breaks and tabs survive; the colours below
 * are ours and are added after.
 */
export function scrub(value: unknown): unknown {
  if (typeof value === 'string') {
    let out = '';
    for (const ch of value) if (!isControl(ch.charCodeAt(0))) out += ch;
    return out;
  }
  if (Array.isArray(value)) return value.map(scrub);
  const o = obj(value);
  if (!o) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = scrub(v);
  return out;
}

function clipLine(s: string): string {
  return s.length > LINE_CAP ? `${s.slice(0, LINE_CAP - 1)}…` : s;
}

/** The first `n` lines of a text, and how many were left out. */
function head(text: string, n: number): string[] {
  const lines = text.replace(/\s+$/, '').split('\n');
  const out = lines.slice(0, n).map(clipLine);
  if (lines.length > n) out.push(`… ${lines.length - n} more lines`);
  return out;
}

/** A path inside the project, relative to it: the project is the context already. */
function short(p: unknown, cwd: string): string {
  if (typeof p !== 'string') return '';
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
}

/** What a tool call was asked to do, in one short line. */
export function toolSummary(name: string, input: unknown, cwd: string): string {
  const i = obj(input) ?? {};
  const first = (v: unknown): string => (typeof v === 'string' ? v.split('\n')[0]! : '');
  let what: string;
  switch (name) {
    case 'Bash': what = first(i['command']); break;
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      what = short(i['file_path'] ?? i['notebook_path'], cwd); break;
    case 'Grep': case 'Glob': what = first(i['pattern']); break;
    case 'Task': case 'Agent': what = first(i['description']); break;
    case 'WebFetch': what = first(i['url']); break;
    case 'WebSearch': what = first(i['query']); break;
    case 'TodoWrite': what = Array.isArray(i['todos']) ? `${i['todos'].length} to-dos` : ''; break;
    default: {
      const json = JSON.stringify(input ?? {});
      what = json === '{}' ? '' : json;
    }
  }
  return clipLine(`${name}(${what.length > 120 ? `${what.slice(0, 119)}…` : what})`);
}

/** The text of a tool result, however the tool shaped it. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => { const o = obj(b); return o && typeof o['text'] === 'string' ? o['text'] : ''; })
    .filter(Boolean)
    .join('\n');
}

/**
 * One Claude Code transcript record, as the lines to print.
 *
 * Defensive like every parser of a format we do not own: a record it does
 * not know prints nothing, and a field of the wrong type is an empty one.
 */
export function claudeLines(record: unknown, cwd: string, paint: Paint = PLAIN): string[] {
  const r = obj(scrub(record));
  if (!r || r['isMeta'] === true) return [];
  const message = obj(r['message']);
  const content = message?.['content'];
  const out: string[] = [];

  if (r['type'] === 'user') {
    if (typeof content === 'string') {
      // Local commands leave their echo as a user record: not a prompt.
      if (content.startsWith('<')) return [];
      const lines = head(content, PROMPT_LINES);
      return ['', paint.prompt(`› ${lines[0] ?? ''}`), ...lines.slice(1).map((l) => paint.prompt(`  ${l}`))];
    }
    if (!Array.isArray(content)) return [];
    for (const block of content) {
      const b = obj(block);
      if (!b) continue;
      if (b['type'] === 'tool_result') {
        const lines = head(resultText(b['content']), RESULT_LINES);
        const tint = b['is_error'] === true ? paint.error : paint.dim;
        lines.forEach((l, n) => out.push(tint(`${n === 0 ? '  ⎿ ' : '    '}${l}`)));
      } else if (b['type'] === 'text' && typeof b['text'] === 'string' && !b['text'].startsWith('<')) {
        const lines = head(b['text'], PROMPT_LINES);
        out.push('', paint.prompt(`› ${lines[0] ?? ''}`), ...lines.slice(1).map((l) => paint.prompt(`  ${l}`)));
      }
    }
    return out;
  }

  if (r['type'] === 'assistant' && Array.isArray(content)) {
    for (const block of content) {
      const b = obj(block);
      if (!b) continue;
      if (b['type'] === 'text' && typeof b['text'] === 'string' && b['text'].trim()) {
        const text = b['text'].replace(/\s+$/, '');
        out.push('', ...(r['isApiErrorMessage'] === true ? [paint.error(text)] : text.split('\n')));
      } else if (b['type'] === 'tool_use' && typeof b['name'] === 'string') {
        out.push(paint.tool(`● ${toolSummary(b['name'], b['input'], cwd)}`));
      }
    }
  }
  return out;
}

/** One Codex rollout record, as the lines to print. Only `response_item`: the events repeat them. */
export function codexLines(record: unknown, paint: Paint = PLAIN): string[] {
  const r = obj(scrub(record));
  if (!r || r['type'] !== 'response_item') return [];
  const p = obj(r['payload']);
  if (!p) return [];
  if (p['type'] === 'message' && Array.isArray(p['content'])) {
    const text = p['content']
      .map((b) => { const o = obj(b); return o && typeof o['text'] === 'string' ? o['text'] : ''; })
      .join('\n')
      .trim();
    // The environment and the instructions travel as user messages in tags.
    if (!text || text.startsWith('<')) return [];
    if (p['role'] === 'user') {
      const lines = head(text, PROMPT_LINES);
      return ['', paint.prompt(`› ${lines[0] ?? ''}`), ...lines.slice(1).map((l) => paint.prompt(`  ${l}`))];
    }
    return p['role'] === 'assistant' ? ['', ...text.split('\n')] : [];
  }
  if (p['type'] === 'function_call' && typeof p['name'] === 'string') {
    let args: unknown = p['arguments'];
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { /* shown as it is */ }
    }
    const a = obj(args);
    const cmd = a && Array.isArray(a['command']) ? a['command'].join(' ') : null;
    return [paint.tool(`● ${cmd !== null ? clipLine(`${p['name']}(${cmd})`) : toolSummary(p['name'], args, '')}`)];
  }
  if (p['type'] === 'function_call_output') {
    let text = typeof p['output'] === 'string' ? p['output'] : '';
    try {
      const o = obj(JSON.parse(text));
      if (o && typeof o['output'] === 'string') text = o['output'];
    } catch { /* plain text */ }
    return head(text, RESULT_LINES).map((l, n) => paint.dim(`${n === 0 ? '  ⎿ ' : '    '}${l}`));
  }
  return [];
}

/* ───────────────────────── following the file ───────────────────────── */

export interface FollowOptions {
  provider: ProviderId;
  sessionId: string;
  cwd: string;
  policy: PathPolicy;
  /** The session's process: when it is gone, so is the session. `null` follows until Ctrl-C. */
  alive: (() => boolean) | null;
  /**
   * Print what is on disk and stop: the log of a session that is over.
   *
   * The whole file and not its last `REPLAY_BYTES`: a live view wants the
   * latest work, a log read afterwards wants all of it -- the first thing a
   * planning worker does is read the briefing and decide, and that is the
   * part a four-megabyte tail would drop from an eleven-megabyte transcript.
   * A transcript that is not there is said, never waited for.
   */
  once?: boolean;
  write: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  paint: Paint;
  pollMs?: number;
}

/** A transcript line into printed lines, whichever tool wrote it. */
function render(provider: ProviderId, line: string, cwd: string, paint: Paint): string[] {
  if (!line.trim()) return [];
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return [];
  }
  return provider === 'claude' ? claudeLines(rec, cwd, paint) : codexLines(rec, paint);
}

/**
 * Print the transcript and follow it until the session ends.
 *
 * One open, through the allow-list, kept for the whole run: the file is only
 * ever appended to, so reading by position is enough and no path is resolved
 * twice. A file that is not there yet is waited for -- a worker is on its lot
 * a moment before its first line is on disk.
 */
export async function follow(o: FollowOptions): Promise<number> {
  const poll = o.pollMs ?? 400;
  const once = o.once === true;
  const resume = o.provider === 'claude' ? `claude --resume ${o.sessionId}` : `codex resume ${o.sessionId}`;
  const tool = o.provider === 'claude' ? 'Claude Code' : 'Codex';
  o.write(`${o.paint.dim('Towerglow')} · ${once ? 'the log of' : 'following'} ${tool} session ${o.sessionId}\n`);
  o.write(`${o.paint.dim(scrub(o.cwd) as string)}\n`);
  o.write(o.paint.dim(once
    ? 'Read-only: everything the session wrote to its transcript, start to end.\n'
    : 'Read-only: this window shows what the session writes. Nothing typed here reaches it.\n'));

  let file: string | null = null;
  let waitedNoted = false;
  while (file === null) {
    file = transcriptFor(o.provider, o.sessionId, o.cwd, o.policy, o.now());
    if (file !== null) break;
    if (once) {
      o.write('\nThere is no transcript on disk for this session.\n');
      return 1;
    }
    if (o.alive !== null && !o.alive()) {
      o.write('\nThe session ended before it wrote a transcript.\n');
      return 1;
    }
    if (!waitedNoted) {
      o.write(o.paint.dim('Waiting for the transcript…\n'));
      waitedNoted = true;
    }
    await o.sleep(poll);
  }

  const fd = fs.openSync(file, 'r');
  try {
    let pos = 0;
    const size = fs.fstatSync(fd).size;
    if (!once && size > REPLAY_BYTES) {
      pos = size - REPLAY_BYTES;
      o.write(o.paint.dim(`… ${Math.round(pos / 1024)} KB of earlier work not shown\n`));
    }
    let carry = '';
    // A replayed tail starts mid-line: that first fragment is dropped.
    let skipFirst = pos > 0;
    const drain = (): void => {
      const end = fs.fstatSync(fd).size;
      while (pos < end) {
        const buf = Buffer.alloc(Math.min(1 << 20, end - pos));
        const n = fs.readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        pos += n;
        carry += buf.subarray(0, n).toString('utf8');
        const lines = carry.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) {
          if (skipFirst) { skipFirst = false; continue; }
          const printed = render(o.provider, line, o.cwd, o.paint);
          if (printed.length > 0) o.write(`${printed.join('\n')}\n`);
        }
      }
    };

    for (;;) {
      drain();
      if (once) {
        o.write(`\n${o.paint.dim('── end of the transcript ──')}\n`);
        o.write(`To pick it up yourself, from this folder:  ${resume}\n`);
        return 0;
      }
      if (o.alive !== null && !o.alive()) {
        drain();
        o.write(`\n${o.paint.dim('── the session has ended ──')}\n`);
        o.write(`To pick it up yourself, from this folder:  ${resume}\n`);
        return 0;
      }
      await o.sleep(poll);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether a process id is still running. EPERM is a process that exists and is not ours. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
