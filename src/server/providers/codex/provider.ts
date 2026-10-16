import * as path from 'node:path';
import type { DeltaEvent, SessionStatus, TargetRef } from '../../../shared/protocol.ts';
import { CODEX_CALLS } from '../../../shared/toolCategories.ts';
import { assertSafe, clampUnsafe } from '../../parse/redact.ts';
import type { ParseStats } from '../../parse/records.ts';
import { fileIdFor, projectIdFor, redactRelPath } from '../../state/ids.ts';
import { Tailer } from '../../watch/tailer.ts';
import { CodexStore } from './store.ts';
import {
  LimitWatch, discoverRollouts, newestRollout, parseRolloutLine, readLastLimits, readLastPlan, readLastWindows,
  readLimitStop,
} from './rollouts.ts';
import type { RolloutMeta } from './rollouts.ts';
import type { LiveSession, Provider, ProviderContext } from '../types.ts';
import type { PathPolicy } from '../../paths.ts';

const POLL_MS = 900;
/**
 * How often to re-read the PIDs from the logs.
 *
 * It does not drive the scene's pulse -- the rollout tells the status -- it
 * only lets us bring the right terminal to the front, so the SQLite query is
 * paid rarely instead of on every tick.
 */
const PID_REFRESH_MS = 30_000;
/**
 * A session with no activity for this long is no longer live.
 *
 * The rollout's mtime only says which rollouts are worth opening; whether the
 * session stays on stage is decided on its events. A rollout is also written
 * to by what is not the agent's work: measured on 2026-10-14, a dev server
 * started in a chat's first turn was killed eighteen hours later, its exit
 * landed in the rollout, and a chat that had last worked in the morning lit
 * its tower in Codex white for half an hour in the afternoon.
 */
const LIVE_WINDOW_MS = 30 * 60_000;
/**
 * How long a chat stopped at the usage limit stays on stage with nothing
 * written after the stop: a day. Codex keeps no registry of live chats, so
 * past the live window nothing says whether the terminal is still open; but
 * the stop is the one thing on that tower you have to act on, and a chat that
 * left the stage after half an hour, at 1 a.m., said nothing about it in the
 * morning. A 7d limit that resets later than this goes quiet first.
 */
const LIMIT_HOLD_MS = 24 * 3_600_000;
/** How far back the quota is looked for at start: the longest window Codex names is seven days. */
const SEED_WINDOW_MS = 7 * 86_400_000;
/** After a turn closes, how long it stays "active" before it waits again. */
const SETTLE_MS = 4000;

export interface CodexProviderOptions {
  codexDir: string;
  policy: PathPolicy;
  redactPaths: boolean;
  cmdNames: boolean;
  titles: boolean;
  /** The project exists for the program (startup rule `--exclude`). */
  known: (cwd: string) => boolean;
  /** A session can come from this project: also excludes the disabled ones. */
  produces: (cwd: string) => boolean;
  devAssert: boolean;
  /** Shared with the rest of the server: the redaction guard counts here. */
  stats: ParseStats;
}

/**
 * First line of the user's message, truncated. Never the whole body.
 *
 * It is the same thing Codex derives the thread name from, so it does not
 * introduce a new category of data; the only difference is that here it is
 * the LAST prompt instead of the first, and it is governed by the same
 * --no-titles flag.
 */
function firstLineOf(item: Record<string, unknown>): string | null {
  const content = item['content'];
  let text: string | null = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as Record<string, unknown> | null;
      if (b && b['type'] === 'text' && typeof b['text'] === 'string') {
        text = b['text'];
        break;
      }
    }
  }
  if (!text) return null;
  const line = text.split('\n')[0]?.trim() ?? '';
  return line.length > 0 ? line.slice(0, 90) : null;
}

/** Stopped at the usage limit recently enough to stay on stage: see `LIMIT_HOLD_MS`. */
function held(a: Attached, now: number): boolean {
  return a.limit.stop !== null && now - a.limit.stop.atMs < LIMIT_HOLD_MS;
}

interface Attached {
  meta: RolloutMeta;
  tailer: Tailer;
  /** Open turn: `task_started` without its `task_complete`. */
  openTurn: string | null;
  /**
   * Turns that have ended. An item that still names one is a process the
   * turn left running in the background (a dev server, a watcher) that has
   * just exited: not work, and not a sign of life. 21 of 10 333 items in the
   * rollouts of this machine on 2026-10-14, every one of them
   * `unified_exec_startup`.
   */
  closedTurns: Set<string>;
  /** Questions to the user still unanswered: if there are any, it is waiting for you. */
  openAsks: Set<string>;
  lastActivityMs: number;
  statusSince: number;
  model: string | null;
  tokens: number;
  /**
   * First line of the user's last message.
   *
   * Codex, unlike Claude Code, does NOT regenerate a title on every turn:
   * `session_index.jsonl` carries the name assigned at the first prompt and
   * never updates it, so after a few hours it describes work that is no
   * longer the one in progress. The only trace of the current task is the
   * last prompt -- which is also the very thing Codex derives the thread
   * name from.
   */
  currentTask: string | null;
  /**
   * Time spent reasoning, summed.
   *
   * Codex stamps every item with its start and end instants, so for
   * `Reasoning` items the duration is a measured figure, not an estimate.
   * That is the difference from Claude Code, which writes its thinking blocks
   * without any timing of their own.
   */
  reasoningMs: number;
  /** Context window used by the last request, 0-100. */
  contextPct: number | null;
  /** The last time Codex compacted the conversation. */
  compactedAt: number | null;
  /** Stopped at the usage limit: its last turn was refused for the account's usage. */
  limit: LimitWatch;
}

/**
 * Codex provider, based on the rollouts.
 *
 * Codex does not publish a registry of live sessions the way Claude Code
 * does. The rollout, though, is appended in real time and carries two
 * decisive things: the `cwd` in the first line, and the `task_started` /
 * `task_complete` pair that says whether a turn is in progress. From there an
 * honest status can be derived without subprocesses.
 *
 * One difference from Claude Code remains, declared via `statusConfidence`:
 * items are written only on COMPLETION, so a long command produces no pulse
 * until it finishes.
 */
export class CodexProvider implements Provider {
  readonly id = 'codex' as const;

  #opts: CodexProviderOptions;
  #store: CodexStore;
  #ctx: ProviderContext | null = null;
  #timer: NodeJS.Timeout | null = null;
  #attached = new Map<string, Attached>();
  #announcedProjects = new Set<string>();
  #names = new Map<string, string>();
  #pids = new Map<string, { pid: number; lastTs: number }>();
  #pidsReadAt = 0;
  #limitsSeeded = false;
  #heldSeeded = false;
  /**
   * Rollouts still being read by `#attach`. The read goes in chunks, and a
   * tick in between would see a chat `#seedHeld` attached as neither alive
   * nor held -- its first turn read, not yet its stop -- and close it.
   */
  #reading = new Set<string>();

  constructor(opts: CodexProviderOptions) {
    this.#opts = opts;
    this.#store = new CodexStore(opts.codexDir, opts.policy);
  }

  isAvailable(): boolean {
    return this.#store.available;
  }

  start(ctx: ProviderContext): void {
    this.#ctx = ctx;
    this.#seedLimits();
    this.#seedHeld();
    this.#tick();
    this.#timer = setInterval(() => this.#tick(), POLL_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const a of this.#attached.values()) void a.tailer.close();
    this.#attached.clear();
    this.#ctx = null;
  }

  /**
   * Quota used at startup, from the most recent rollout there is.
   *
   * It lets the scene start already knowing where you stand, instead of
   * staying silent until you run a turn. If a live session later sends a
   * fresher one, that one replaces it.
   *
   * The windows from the rollouts of the last week, newest first: the newest
   * one may name none (`readLastWindows`), and a reading older than a week
   * names no window that is still open. The plan alone is worth sending,
   * once: it is what makes the tool's row appear at all. Nothing is erased by
   * it -- the model merges readings.
   */
  #seedLimits(): void {
    if (this.#limitsSeeded) return;
    this.#limitsSeeded = true;
    const newest = newestRollout(this.#opts.codexDir, this.#opts.policy);
    if (!newest) return;
    const recent = discoverRollouts(this.#opts.codexDir, this.#opts.policy, Date.now() - SEED_WINDOW_MS)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((m) => m.file);
    const ev = readLastWindows(recent, this.#opts.policy) ?? readLastLimits(newest.file, this.#opts.policy);
    // The plan from an older rollout when this one never names it.
    const plan = ev?.plan ?? readLastPlan(
      discoverRollouts(this.#opts.codexDir, this.#opts.policy, 0)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .map((m) => m.file),
      this.#opts.policy,
    );
    if (!ev && plan === null) return;
    this.#ctx?.onEvents([
      {
        t: 'limits',
        limits: { provider: 'codex', at: ev?.atMs ?? Date.now(), windows: ev?.windows ?? [], plan },
      },
    ]);
  }

  /**
   * The chats stopped at the usage limit before the server started, in
   * rollouts older than the live window: discovery opens none of those, and
   * the stop would be lost with every restart. Looked for once, by the tail
   * of each rollout of the hold; from then on such a chat stays attached.
   */
  #seedHeld(): void {
    if (this.#heldSeeded) return;
    this.#heldSeeded = true;
    const now = Date.now();
    const older = discoverRollouts(this.#opts.codexDir, this.#opts.policy, now - LIMIT_HOLD_MS)
      .filter((m) => !m.subagent && m.mtimeMs < now - LIVE_WINDOW_MS && this.#opts.produces(m.cwd));
    for (const meta of older) {
      const stop = readLimitStop(meta.file, this.#opts.policy);
      if (stop && now - stop.atMs < LIMIT_HOLD_MS) void this.#attach(meta, now);
    }
  }

  #tick(): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    const now = Date.now();

    if (this.#opts.titles) this.#names = this.#store.readThreadNames();
    if (now - this.#pidsReadAt >= PID_REFRESH_MS) {
      this.#pids = this.#store.readThreadPids();
      this.#pidsReadAt = now;
    }

    // A subagent rollout carries its parent's session_id. Counted as a session,
    // the approvals guardian kept an archived chat on stage for half an hour,
    // with the old chat's context, and could be attached in the chat's place.
    const found = discoverRollouts(this.#opts.codexDir, this.#opts.policy, now - LIVE_WINDOW_MS)
      .filter((m) => !m.subagent && this.#opts.produces(m.cwd));

    const projects = [
      ...this.#store.readDeclaredProjects().filter((p) => this.#opts.known(p)),
      ...found.map((m) => m.cwd),
    ];
    const fresh = projects.filter((p) => !this.#announcedProjects.has(p));
    if (fresh.length > 0) {
      for (const p of fresh) this.#announcedProjects.add(p);
      ctx.onProjects(projects);
    }

    for (const meta of found) {
      if (this.#attached.has(meta.sessionId)) continue;
      void this.#attach(meta, now);
    }

    const alive = new Set(found.map((m) => m.sessionId));
    for (const [id, a] of this.#attached) {
      if (alive.has(id) || held(a, now) || this.#reading.has(id)) continue;
      void a.tailer.close();
      this.#attached.delete(id);
    }

    for (const a of this.#attached.values()) void a.tailer.pump();

    ctx.onSessions(this.#sessions(now));
  }

  async #attach(meta: RolloutMeta, now: number): Promise<void> {
    const attached: Attached = {
      meta,
      // Placeholder replaced right below: it only exists so `attached` can be
      // referenced inside the Tailer's callback.
      tailer: null as unknown as Tailer,
      openTurn: null,
      closedTurns: new Set(),
      openAsks: new Set(),
      // Zero and not the mtime: activity is told by the rollout's EVENTS. The
      // mtime also changes for writes that are not the agent's work, and
      // seeding from it kept a session "busy" with its turn already closed.
      lastActivityMs: 0,
      statusSince: 0,
      model: null,
      tokens: 0,
      currentTask: null,
      reasoningMs: 0,
      contextPct: null,
      compactedAt: null,
      limit: new LimitWatch(),
    };

    // The whole rollout is read: it is a few hundred KB net of tool outputs,
    // which are discarded by size before parsing. It is needed in full
    // because `task_started` can sit at the start of the file while the turn
    // is still open right now.
    attached.tailer = new Tailer(meta.file, Number.MAX_SAFE_INTEGER, (line) =>
      this.#onLine(attached, line),
    );
    this.#attached.set(meta.sessionId, attached);

    this.#reading.add(meta.sessionId);
    try {
      await attached.tailer.open();
    } catch {
      this.#attached.delete(meta.sessionId);
      return;
    } finally {
      this.#reading.delete(meta.sessionId);
    }
    // If the rollout contained not a single useful event, the mtime remains
    // the only available reference.
    if (attached.lastActivityMs === 0) attached.lastActivityMs = meta.mtimeMs;
    if (attached.statusSince === 0) attached.statusSince = attached.lastActivityMs;
    this.#ctx?.onSessions(this.#sessions(now));
  }

  #onLine(a: Attached, line: string): void {
    const ev = parseRolloutLine(line);
    if (!ev) return;
    a.limit.see(ev);

    switch (ev.kind) {
      case 'model':
        a.model = ev.model;
        return;
      case 'compacted':
        a.compactedAt = Math.max(a.compactedAt ?? 0, ev.atMs);
        return;
      case 'limits':
        // The context belongs to the SESSION, the quota to the ACCOUNT: they
        // arrive in the same record but go to two different recipients.
        if (ev.contextPct !== null) a.contextPct = ev.contextPct;
        if (ev.windows.length > 0) {
          this.#ctx?.onEvents([
            {
              t: 'limits',
              limits: { provider: 'codex', at: ev.atMs, windows: ev.windows, plan: ev.plan },
            },
          ]);
        }
        return;
      case 'tokens': {
        a.tokens = Math.max(a.tokens, ev.total);
        const d = ev.delta;
        if (d.in + d.out + d.cacheRead + d.cacheWrite + d.thinking > 0) {
          this.#ctx?.onEvents([
            {
              t: 'usage',
              sessionId: a.meta.sessionId,
              agentId: null,
              at: ev.atMs,
              model: a.model ?? 'unknown',
              delta: d,
            },
          ]);
        }
        return;
      }
      case 'ask_started':
        a.openAsks.add(ev.callId);
        a.statusSince = ev.atMs;
        a.lastActivityMs = Math.max(a.lastActivityMs, ev.atMs);
        return;
      case 'ask_answered':
        if (a.openAsks.delete(ev.callId)) a.statusSince = ev.atMs;
        a.lastActivityMs = Math.max(a.lastActivityMs, ev.atMs);
        return;
      case 'turn_started':
        a.openTurn = ev.turnId;
        a.statusSince = ev.atMs;
        a.lastActivityMs = Math.max(a.lastActivityMs, ev.atMs);
        return;
      case 'turn_aborted':
        if (a.openTurn === ev.turnId) a.openTurn = null;
        a.closedTurns.add(ev.turnId);
        a.statusSince = ev.atMs;
        a.lastActivityMs = Math.max(a.lastActivityMs, ev.atMs);
        return;
      case 'turn_completed': {
        if (a.openTurn === ev.turnId) a.openTurn = null;
        a.closedTurns.add(ev.turnId);
        a.statusSince = ev.atMs;
        a.lastActivityMs = Math.max(a.lastActivityMs, ev.atMs);
        // Codex declares the duration in the payload, and it is the same one
        // the terminal prints as "worked for 1m 29s". Deriving it from the gap
        // between two records would give a different and worse number.
        if (ev.durationMs > 0) {
          this.#ctx?.onEvents([
            {
              t: 'turn.end',
              sessionId: a.meta.sessionId,
              at: ev.atMs,
              durationMs: ev.durationMs,
              messageCount: 0,
            },
          ]);
        }
        return;
      }
      case 'item': {
        if (ev.turnId !== null && a.closedTurns.has(ev.turnId)) return;
        a.lastActivityMs = Math.max(a.lastActivityMs, ev.atMs);
        if (ev.itemType === 'UserMessage') a.currentTask = firstLineOf(ev.item);
        if (ev.itemType === 'Reasoning' && ev.startedAtMs !== null) {
          a.reasoningMs += Math.max(0, ev.atMs - ev.startedAtMs);
        }
        const events = this.#project(a, ev.itemType, ev.itemId, ev.atMs, ev.item);
        if (events.length === 0) return;
        if (this.#opts.devAssert) for (const e of events) assertSafe(e);
        else for (const e of events) this.#opts.stats.redactionClamps += clampUnsafe(e);
        this.#ctx?.onEvents(events);
        return;
      }
    }
  }

  #sessions(now: number): LiveSession[] {
    const out: LiveSession[] = [];
    for (const a of this.#attached.values()) {
      // Still attached, so a late write is not paid as a full re-read on
      // every tick; off stage until it works again, unless it is stopped at
      // the usage limit and waits for you.
      if (now - a.lastActivityMs >= LIVE_WINDOW_MS && !held(a, now)) continue;
      // Three distinct states, all derivable from the rollout:
      //  - waiting: a question to the user is still unanswered
      //  - busy:    turn open, `task_started` without `task_complete`
      //  - idle:    turn closed, i.e. task finished
      const waiting = a.openAsks.size > 0;
      const busy = a.openTurn !== null || now - a.lastActivityMs < SETTLE_MS;
      const status: SessionStatus = waiting ? 'waiting' : busy ? 'busy' : 'idle';
      out.push({
        sessionId: a.meta.sessionId,
        provider: 'codex',
        // The PID comes from an index that may be stale, and a stale PID is a
        // PID that may meanwhile belong to another process: it only serves to
        // find the terminal, and whoever uses it checks that there really is
        // a `codex` on the other end before doing anything.
        pid: this.#pids.get(a.meta.sessionId)?.pid ?? 0,
        cwd: a.meta.cwd,
        label: this.#names.get(a.meta.sessionId) ?? `codex-${a.meta.sessionId.slice(0, 6)}`,
        title: this.#opts.titles ? a.currentTask : null,
        status,
        // Deduced from the files, not declared by Codex: the scene must say so.
        statusConfidence: 'inferred',
        waitingFor: waiting ? 'input' : null,
        kind: 'interactive',
        version: a.meta.cliVersion ?? '?',
        model: a.model,
        startedAt: a.meta.startedAtMs,
        updatedAt: a.lastActivityMs,
        statusSince: a.statusSince,
        reasoningMs: a.reasoningMs,
        contextPct: a.contextPct,
        compactedAt: a.compactedAt,
        limitStoppedAt: a.limit.stop?.atMs ?? null,
        limitResetsAt: a.limit.stop?.resetsAt ?? null,
      });
    }
    return out;
  }

  /** Projection: BUILT field by field, never a spread of raw data. */
  #project(
    a: Attached,
    itemType: string,
    itemId: string,
    atMs: number,
    item: Record<string, unknown>,
  ): DeltaEvent[] {
    // The shared table, the one the page colours the window from: two tables
    // would agree only until the next item type.
    const cat = CODEX_CALLS[itemType];
    if (!cat) return [];

    const cwd = a.meta.cwd;
    const sessionId = a.meta.sessionId;
    const projectId = projectIdFor(cwd);
    const out: DeltaEvent[] = [];
    const id = `cx:${itemId}`;

    out.push({
      t: 'tool.start',
      id,
      sessionId,
      agentId: null,
      name: itemType,
      cat,
      at: atMs,
      target: this.#targetOf(itemType, item, cwd),
    });

    // Codex writes the item only on completion: the duration comes from the
    // payload instead of from the difference between two records.
    const duration = item['duration'];
    let durationMs: number | null = null;
    if (typeof item['durationMs'] === 'number') durationMs = item['durationMs'];
    else if (duration && typeof duration === 'object') {
      const d = duration as Record<string, unknown>;
      const secs = typeof d['secs'] === 'number' ? d['secs'] : 0;
      const nanos = typeof d['nanos'] === 'number' ? d['nanos'] : 0;
      durationMs = Math.round(secs * 1000 + nanos / 1e6);
    }

    const status = item['status'];
    const exit = item['exit_code'] ?? item['exitCode'];
    const ok = status !== 'failed' && exit !== 1 && exit !== '1';

    out.push({
      t: 'tool.end',
      id,
      sessionId,
      at: atMs,
      durationMs,
      ok,
      bytes: 0,
      changed: 0,
      orphan: false,
      // Codex writes the item only on completion: when we see it, it is done.
      asyncLaunch: false,
      spawnedAgentId: null,
    });

    if (itemType === 'FileChange') {
      const changes = item['changes'];
      const list = Array.isArray(changes)
        ? changes
        : changes && typeof changes === 'object'
          ? Object.values(changes as Record<string, unknown>)
          : [];
      for (const change of list.slice(0, 24)) {
        const c = change as Record<string, unknown> | null;
        const abs = c && typeof c['path'] === 'string' ? c['path'] : null;
        if (!abs) continue;
        const ref = this.#fileRef(abs, cwd);
        if (ref.kind !== 'file' || ref.external) continue;
        const diff = c && typeof c['diff'] === 'string' ? c['diff'] : '';
        const kindType = (c?.['kind'] as Record<string, unknown> | undefined)?.['type'];
        out.push({
          t: 'file.touch',
          projectId,
          sessionId,
          fileId: fileIdFor(projectId, ref.path),
          path: ref.path,
          ext: ref.ext,
          dir: ref.dir,
          op: kindType === 'add' ? 'write' : 'edit',
          changed: diff ? diff.split('\n').length : 0,
          at: atMs,
          floor: -1,
          col: -1,
        });
      }
    }

    return out;
  }

  #targetOf(itemType: string, item: Record<string, unknown>, cwd: string): TargetRef | null {
    if (itemType === 'CommandExecution') {
      if (!this.#opts.cmdNames) return null;
      // `command` can be an array (["/bin/bash","-lc","..."]) or a string.
      // In both cases ONLY the first executable token is taken, skipping the
      // shell wrapper: the arguments can contain anything.
      const raw = item['command'];
      const text = Array.isArray(raw) ? raw.join(' ') : typeof raw === 'string' ? raw : '';
      const inner = /-lc\s+"?(.*?)"?\s*$/s.exec(text)?.[1] ?? text;
      const bin = (inner.trim().split(/\s+/)[0] ?? '').split('/').pop() ?? '';
      return /^[a-z0-9][a-z0-9._-]{0,23}$/i.test(bin) ? { kind: 'cmd', bin: bin.toLowerCase() } : null;
    }
    if (itemType === 'ImageView') {
      const p = typeof item['path'] === 'string' ? item['path'] : null;
      return p ? this.#fileRef(p, cwd) : null;
    }
    // Extension (web search): the query is content, like WebFetch on the Claude side.
    return null;
  }

  #fileRef(abs: string, cwd: string): TargetRef {
    const clean = abs.startsWith('file://') ? abs.slice('file://'.length) : abs;
    const ext = (path.extname(clean).slice(0, 12) || '').toLowerCase();
    const rel = path.isAbsolute(clean) ? path.relative(cwd, clean) : clean;
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { kind: 'file', path: `<external>/*${ext}`, ext, dir: '<external>', external: true };
    }
    const shown = this.#opts.redactPaths ? redactRelPath(rel) : rel;
    const i = shown.indexOf('/');
    return { kind: 'file', path: shown, ext, dir: i < 0 ? '.' : shown.slice(0, i), external: false };
  }
}
