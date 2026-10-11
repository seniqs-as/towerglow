import * as path from 'node:path';
import type { DeltaEvent, TargetRef, TokenTotals } from '../../shared/protocol.ts';
import { MAX_FIELD_CHARS, MAX_RECAP_CHARS, MAX_SUMMARY_CHARS } from '../../shared/protocol.ts';
import { categoryOf } from '../../shared/toolCategories.ts';
import { redactRelPath, fileIdFor } from '../state/ids.ts';
import { ToolPairing, UsageDedup } from './tools.ts';
import type { Record_ } from './records.ts';

/**
 * The ONLY place where transcript data becomes events for the client.
 *
 * Redaction happens by PROJECTION, not by removal: every event is BUILT field
 * by field from derived scalars. There is no spread of raw data anywhere, so a
 * new field introduced by a future version of Claude Code cannot end up on the
 * delta channel by oversight.
 */

export interface RedactOptions {
  projectId: string;
  cwd: string;
  /** Level 3: names hashed right here, before they even enter memory. */
  redactPaths: boolean;
  cmdNames: boolean;
  titles: boolean;
  /** The summary the session writes about itself. Switched off with --no-recap. */
  recap: boolean;
}

export interface RedactContext {
  pairing: ToolPairing;
  usage: UsageDedup;
}

export function createContext(): RedactContext {
  return { pairing: new ToolPairing(), usage: new UsageDedup() };
}

function firstSegment(rel: string): string {
  const i = rel.indexOf('/');
  return i < 0 ? '.' : rel.slice(0, i);
}

/**
 * A tool call's target: ONLY derived scalars, never raw values.
 *
 * Tools whose arguments are in fact content -- search patterns, URLs, message
 * text -- return null on purpose.
 */
export function targetOf(name: string, input: unknown, opts: RedactOptions): TargetRef | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;

  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'NotebookRead': {
      const p = typeof i['file_path'] === 'string' ? i['file_path'] : null;
      return p ? fileRef(p, opts) : null;
    }

    case 'Bash': {
      if (!opts.cmdNames) return null;
      // ONLY the first token, sanitized. Never the arguments: a command can
      // contain secrets, other people's paths, or a file's entire content.
      const c = typeof i['command'] === 'string' ? i['command'] : '';
      const bin = (c.trim().split(/\s+/)[0] ?? '').split('/').pop() ?? '';
      return /^[a-z0-9][a-z0-9._-]{0,23}$/i.test(bin) ? { kind: 'cmd', bin: bin.toLowerCase() } : null;
    }

    case 'Agent':
    case 'Task': {
      const t = typeof i['subagent_type'] === 'string' ? i['subagent_type'] : null;
      return t && /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/.test(t) ? { kind: 'agent', agentType: t } : null;
    }

    case 'Skill': {
      // Only the skill's NAME, which is an identifier chosen by whoever
      // installed it. `args` stays out: it is free text, and can contain
      // anything.
      const name = typeof i['skill'] === 'string' ? i['skill'] : null;
      return name && /^[a-z0-9][a-z0-9:_.-]{0,63}$/i.test(name) ? { kind: 'skill', name } : null;
    }

    case 'SendMessage': {
      const to = typeof i['to'] === 'string' ? i['to'] : null;
      return to && /^[A-Za-z0-9 _.\-[\]]{1,48}$/.test(to) ? { kind: 'peer', name: to } : null;
    }

    default:
      // Glob, Grep, WebFetch, WebSearch and everything else: patterns and URLs
      // are content, not metadata.
      return null;
  }
}

function fileRef(abs: string, opts: RedactOptions): TargetRef {
  const ext = (path.extname(abs).slice(0, 12) || '').toLowerCase();
  const rel = path.isAbsolute(abs) ? path.relative(opts.cwd, abs) : abs;
  const external = rel.startsWith('..') || path.isAbsolute(rel);

  if (external) {
    // A file outside the project has no place in this city, and its absolute
    // path would say things about the rest of the disk.
    return { kind: 'file', path: `<external>/*${ext}`, ext, dir: '<external>', external: true };
  }
  const shown = opts.redactPaths ? redactRelPath(rel) : rel;
  return { kind: 'file', path: shown, ext, dir: firstSegment(shown), external: false };
}

/** Measurements of a tool's result. `toolUseResult` is polymorphic: object OR string. */
function measureResult(result: unknown): { bytes: number; changed: number } {
  if (typeof result === 'string') return { bytes: result.length, changed: 0 };
  if (!result || typeof result !== 'object') return { bytes: 0, changed: 0 };
  const r = result as Record<string, unknown>;

  let bytes = 0;
  if (typeof r['stdout'] === 'string') bytes += r['stdout'].length;
  if (typeof r['stderr'] === 'string') bytes += r['stderr'].length;
  if (typeof r['content'] === 'string') bytes += r['content'].length;

  let changed = 0;
  const patch = r['structuredPatch'];
  if (Array.isArray(patch)) {
    for (const hunk of patch) {
      const h = hunk as Record<string, unknown> | null;
      if (h && Array.isArray(h['lines'])) changed += h['lines'].length;
    }
  }
  // A NEW file has no diff: `structuredPatch` stays empty and the line count
  // stayed at zero even after writing three hundred of them. Here we measure
  // the length of what was written -- a number, not the text.
  if (changed === 0 && r['type'] === 'create' && typeof r['content'] === 'string') {
    const text = r['content'];
    changed = text.length === 0 ? 0 : text.split('\n').length;
  }
  return { bytes, changed };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function tokensFrom(usage: unknown): TokenTotals {
  const u = (usage && typeof usage === 'object' ? usage : {}) as Record<string, unknown>;
  const details = (u['output_tokens_details'] ?? {}) as Record<string, unknown>;
  return {
    in: num(u['input_tokens']),
    out: num(u['output_tokens']),
    cacheRead: num(u['cache_read_input_tokens']),
    cacheWrite: num(u['cache_creation_input_tokens']),
    thinking: num(details['thinking_tokens']),
  };
}

/** Projects a record into events. It is the only road to the client. */
export function project(rec: Record_, ctx: RedactContext, opts: RedactOptions): DeltaEvent[] {
  const out: DeltaEvent[] = [];

  switch (rec.kind) {
    case 'assistant': {
      for (const use of rec.toolUses) {
        const cat = categoryOf(use.name);
        const target = targetOf(use.name, use.input, opts);
        ctx.pairing.start(use.id, {
          name: use.name,
          cat,
          target,
          startedAt: rec.timestamp,
          sessionId: rec.sessionId,
          agentId: rec.agentId,
        });
        out.push({
          t: 'tool.start',
          id: use.id,
          sessionId: rec.sessionId,
          agentId: rec.agentId,
          name: use.name,
          cat,
          at: rec.timestamp,
          target,
        });
      }

      if (ctx.usage.claim(rec.requestId)) {
        out.push({
          t: 'usage',
          sessionId: rec.sessionId,
          agentId: rec.agentId,
          at: rec.timestamp,
          model: rec.model ?? 'unknown',
          delta: tokensFrom(rec.usage),
        });
      }
      return out;
    }

    case 'tool_result': {
      const pending = ctx.pairing.finish(rec.toolUseId);
      const { bytes, changed } = measureResult(rec.result);
      // A subagent launched asynchronously returns `async_launched` at once
      // and keeps working: the duration of THIS call is not its lifetime.
      // So does a shell sent to the background, by `run_in_background` or by
      // a timeout: it returns a `backgroundTaskId` and keeps running.
      const r = rec.result;
      const fields = r !== null && typeof r === 'object' ? (r as Record<string, unknown>) : null;
      const shellId = fields?.['backgroundTaskId'];
      const asyncLaunch =
        fields?.['status'] === 'async_launched' ||
        (typeof shellId === 'string' && /^[a-z0-9]{4,32}$/i.test(shellId));
      // Only the exact shape of an id, nothing else: it is a key, not text.
      const rawAgentId = fields?.['agentId'];
      const spawnedAgentId =
        typeof rawAgentId === 'string' && /^[0-9a-f]{8,40}$/i.test(rawAgentId) ? rawAgentId : null;
      out.push({
        t: 'tool.end',
        id: rec.toolUseId,
        sessionId: rec.sessionId,
        at: rec.timestamp,
        // Without the start no duration is made up: it is declared an orphan.
        durationMs: pending ? Math.max(0, rec.timestamp - pending.startedAt) : null,
        ok: !rec.isError,
        bytes,
        changed,
        orphan: pending === null,
        asyncLaunch,
        spawnedAgentId,
      });

      // A touched file lights up its window. The target comes from when the
      // tool STARTED: the result is polymorphic and for `Read` it doesn't carry
      // the path, so rummaging inside it lost half the events.
      const ref = pending?.target;
      if (ref && ref.kind === 'file' && !ref.external) {
        out.push({
          t: 'file.touch',
          projectId: opts.projectId,
          sessionId: rec.sessionId,
          fileId: fileIdFor(opts.projectId, ref.path),
          path: ref.path,
          ext: ref.ext,
          dir: ref.dir,
          op: pending.cat === 'read' ? 'read' : pending.name === 'Write' ? 'write' : 'edit',
          changed,
          at: rec.timestamp,
          // Floor and column are assigned by the world model: it is the only
          // place that knows the project's already occupied windows.
          floor: -1,
          col: -1,
        });
      }
      return out;
    }

    case 'prompt':
      // Only the prompt's LENGTH: it feeds the on-screen wave without revealing anything.
      out.push({
        t: 'prompt',
        sessionId: rec.sessionId,
        promptId: rec.promptId.slice(0, 40),
        at: rec.timestamp,
        chars: rec.chars,
        source: rec.source,
      });
      return out;

    case 'agent_done':
      // The end of a background subagent. The id is that of the call that had
      // started it: whoever keeps the model already knows who it is.
      out.push({ t: 'agent.remove', id: rec.toolUseId, at: rec.timestamp, reason: 'stop' });
      return out;

    case 'turn_end':
      out.push({
        t: 'turn.end',
        sessionId: rec.sessionId,
        at: rec.timestamp,
        durationMs: rec.durationMs,
        messageCount: rec.messageCount,
      });
      return out;

    case 'context':
      out.push({ t: 'context', sessionId: rec.sessionId, at: rec.timestamp, tokensLeft: rec.tokensLeft });
      return out;

    case 'cost_state':
      // All scalars declared by the tool: no string except the model's name,
      // which is an identifier like `model` in `usage`.
      out.push({
        t: 'session.cost',
        sessionId: rec.sessionId,
        at: rec.timestamp,
        costUsd: rec.costUsd,
        tokens: rec.tokens,
        model: rec.model === null ? null : rec.model.slice(0, MAX_FIELD_CHARS - 1),
        apiMs: rec.apiMs,
        toolMs: rec.toolMs,
        wallMs: rec.wallMs,
        linesAdded: rec.linesAdded,
        linesRemoved: rec.linesRemoved,
      });
      return out;

    case 'title': {
      if (!opts.titles) return out;
      out.push({
        t: 'session.update',
        id: rec.sessionId,
        // The title is text generated by the model, not user content, and it
        // stays under assertSafe's threshold. Switched off with --no-titles.
        patch: { title: rec.title.slice(0, MAX_FIELD_CHARS - 1) },
        at: Date.now(),
      });
      return out;
    }

    case 'recap': {
      if (!opts.recap) return out;
      out.push({
        t: 'session.update',
        id: rec.sessionId,
        // It is text written by the model about itself, not user content: the
        // same nature as the title, and the same road. It has its own cap
        // because it is a paragraph instead of three words. Switched off with
        // --no-recap, and it switches itself off under --redact-paths: a recap
        // that names `css/style.css` would contradict the request to hide
        // paths, and unlike a path it cannot be hashed.
        // `recapInherited: false` is not redundant: this recap comes from the
        // session's own transcript, so it switches off the graft taken from a
        // previous session at the exact moment it writes one of its own.
        patch: {
          recap: rec.recap.slice(0, MAX_RECAP_CHARS),
          recapAt: rec.timestamp,
          recapInherited: false,
        },
        at: Date.now(),
      });
      return out;
    }

    default:
      return out;
  }
}

/**
 * The only strings allowed a higher cap, declared by name.
 *
 * Listing them here instead of widening the threshold for everyone is the
 * point: the day a new field carries a prompt by mistake, the guard stops it
 * anyway, because its name is not in this map.
 */
const LONG_FIELDS = new Map<string, number>([
  ['patch.recap', MAX_RECAP_CHARS],
  ['session.recap', MAX_RECAP_CHARS],
  // A proposal states itself in a sentence or two. It is written by a model,
  // like a recap, and it is the only other field this file lets past 128.
  ['summary', MAX_SUMMARY_CHARS],
  /*
   * What the worker says it actually did: one line, written by a model.
   *
   * Same allowance as a summary and for the same reason -- and it earns the
   * exception because it is the only place where the panel can show what was
   * DONE next to what was asked. The two used to be the same string: the
   * proposal's own sentence, numbers and all, even when the worker had opened
   * its answer by disproving them.
   *
   * The cap at the source is MAX_NOTE_CHARS (200) in the CEO module, below this
   * ceiling on purpose: this file must not name anything inside `ceo/`, which
   * `npm run check:passive` deletes.
   */
  ['workDid', MAX_SUMMARY_CHARS],
]);

/** A field's cap: the one declared by name, otherwise the general threshold. */
function capFor(keyPath: string): number {
  return LONG_FIELDS.get(keyPath) ?? MAX_FIELD_CHARS;
}

/**
 * Structural guard. A prompt or a shell output cannot end up on the delta
 * channel by mistake: any string over the threshold is a redaction bug and
 * must be made to fail right away, not discovered in production.
 */
export function assertSafe(event: DeltaEvent): void {
  const walk = (value: unknown, keyPath: string): void => {
    if (typeof value === 'string') {
      if (value.length > capFor(keyPath)) {
        throw new Error(`redaction violation at ${keyPath}: ${value.length} chars`);
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walk(v, keyPath ? `${keyPath}.${k}` : k);
    }
  };
  walk(event, '');
}

/**
 * The same guard, for production: instead of throwing, it TRUNCATES and counts.
 *
 * Two functions and not a flag, because the two cases really want two
 * behaviors. In development a violation is a bug to be seen right away, and a
 * throw is the loudest way to say it. In production the same throw would kill
 * the tail of a whole session over one field that is too long: it would do
 * more damage than the violation it reports.
 *
 * Without this variant the promise "only metadata leaves on the delta channel"
 * is verified ONLY when the tests run, that is, never on the machine of
 * whoever uses the tool. Truncating keeps it true anyway; the counter makes it
 * verifiable instead of hoped for.
 *
 * Returns how many strings it had to cut. In a healthy system it is always 0:
 * any other value is a redaction bug, not an operating event.
 */
export function clampUnsafe(event: DeltaEvent): number {
  let clamped = 0;
  const walk = (holder: Record<string, unknown>, keyPath: string): void => {
    for (const [k, v] of Object.entries(holder)) {
      const p = keyPath ? `${keyPath}.${k}` : k;
      if (typeof v === 'string') {
        const cap = capFor(p);
        if (v.length > cap) {
          holder[k] = v.slice(0, cap);
          clamped++;
        }
        continue;
      }
      if (v && typeof v === 'object') walk(v as Record<string, unknown>, p);
    }
  };
  walk(event as unknown as Record<string, unknown>, '');
  return clamped;
}
