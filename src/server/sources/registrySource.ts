import * as fs from 'node:fs';
import * as path from 'node:path';
import { DirWatcher } from '../watch/watchDir.ts';
import { assertReadable } from '../paths.ts';
import type { PathPolicy } from '../paths.ts';
import type { SessionKind, SessionStatus } from '../../shared/protocol.ts';
import type { LiveSession } from '../providers/types.ts';

export type { LiveSession };

/**
 * Safety net for abandoned registry files, NOT a liveness criterion.
 * Verified in the field: `updatedAt` is refreshed on status changes, not at
 * regular intervals, so a session busy for several minutes has an old
 * `updatedAt` while being perfectly alive. A short window here declared
 * active sessions dead.
 *
 * The authority is `process.kill(pid, 0)`: if the process is gone, the file
 * drops out of this list anyway. This threshold only covers the edge case of
 * a PID recycled by an unrelated process after a crash, which remains a
 * known and documented cosmetic risk.
 */
const STALE_MS = 24 * 60 * 60_000;
const RETRY_MS = 150;
const MAX_RETRIES = 3;

/** A session's name, as a nameplate shows it. */
const MAX_LABEL_CHARS = 64;
/** "2.1.143" and the like. */
const MAX_VERSION_CHARS = 32;
const KNOWN_STATUS = new Set<SessionStatus>(['busy', 'idle', 'waiting']);
const KNOWN_KIND = new Set<SessionKind>(['interactive', 'background', 'sdk']);

/**
 * Does the PID exist? EPERM means it exists but belongs to another user.
 * No subprocess: no `ps`, no shell.
 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * The registry is written non-atomically: reading mid-write yields partial
 * JSON. A few retries are made instead of declaring a live session dead.
 */
function readJsonWithRetry(file: string): unknown | null {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (attempt === MAX_RETRIES) return null;
      // very short busy-wait: we are in a watcher tick, not in the render loop
      const until = Date.now() + RETRY_MS;
      while (Date.now() < until) { /* nop */ }
    }
  }
  return null;
}

export function parseRegistryEntry(raw: unknown, now: number): LiveSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const pid = typeof r['pid'] === 'number' ? r['pid'] : NaN;
  const sessionId = str(r['sessionId']);
  const cwd = str(r['cwd']);
  if (!Number.isInteger(pid) || !sessionId || !cwd) return null;

  const updatedAt = typeof r['updatedAt'] === 'number' ? r['updatedAt'] : 0;
  const startedAt = typeof r['startedAt'] === 'number' ? r['startedAt'] : now;
  const statusUpdatedAt = typeof r['statusUpdatedAt'] === 'number' ? r['statusUpdatedAt'] : 0;

  if (!isAlive(pid)) return null;
  if (updatedAt > 0 && now - updatedAt > STALE_MS) return null;

  const rawStatus = str(r['status']);
  /*
   * "shell": the turn is over but a shell still runs in the background --
   * Claude Code says "1 shell still running". It does not say whose. On
   * 2026-10-08 (2.1.293) both kinds were measured on tower_defense: Claude
   * waiting on a long simulation, which is work, and read as idle it put the
   * "done" tick on the tower; then the `npm run dev` the user typed with `!`,
   * which never ends, and read as busy it kept the tower working for twenty
   * minutes after the work was done. Here it is idle and flagged; the world
   * model makes it busy only for a shell Claude started (`openShell`).
   */
  const backgroundShell = rawStatus === 'shell';
  const status: SessionStatus =
    rawStatus && KNOWN_STATUS.has(rawStatus as SessionStatus) ? (rawStatus as SessionStatus) : 'idle';

  const rawKind = str(r['kind']);
  const kind: SessionKind =
    rawKind && KNOWN_KIND.has(rawKind as SessionKind) ? (rawKind as SessionKind) : 'unknown';

  // waitingFor is free text: we normalize it instead of passing it on as is.
  const rawWaiting = str(r['waitingFor']);
  const waitingFor = rawWaiting ? (rawWaiting.length > 40 ? 'input' : rawWaiting) : null;

  return {
    sessionId,
    provider: 'claude',
    pid,
    cwd,
    // Free text too, and it reaches the page as it is: capped here, where it
    // enters, so that the snapshot a page receives on connecting is capped as
    // well, not only the events.
    label: (str(r['name']) ?? `pid-${pid}`).slice(0, MAX_LABEL_CHARS),
    title: null,
    status,
    // Claude Code DECLARES its own status in the registry: we do not deduce it.
    statusConfidence: 'reported',
    waitingFor,
    kind,
    version: (str(r['version']) ?? '?').slice(0, MAX_VERSION_CHARS),
    model: null,
    startedAt,
    updatedAt: updatedAt || startedAt,
    statusSince: statusUpdatedAt || updatedAt || startedAt,
    backgroundShell,
  };
}

/**
 * Authoritative source of the live sessions.
 * It always emits the COMPLETE SET: the world model does the diff, so the
 * add/update/remove logic lives in one place only.
 */
export class RegistrySource {
  #dir: string;
  #policy: PathPolicy;
  #watcher: DirWatcher | null = null;
  #onSessions: (sessions: LiveSession[]) => void;

  constructor(claudeDir: string, policy: PathPolicy, onSessions: (s: LiveSession[]) => void) {
    this.#dir = path.join(claudeDir, 'sessions');
    this.#policy = policy;
    this.#onSessions = onSessions;
  }

  start(): void {
    this.#watcher = new DirWatcher(
      this.#dir,
      // The <pid>.<sha>.key files are excluded BY CONSTRUCTION by this regex,
      // not by a check on the extension.
      { filter: (name) => /^\d+\.json$/.test(name), intervalMs: 1000, debounceMs: 80 },
      () => this.#emit(),
    );
    this.#watcher.start();
    this.#emit();
  }

  stop(): void {
    this.#watcher?.stop();
    this.#watcher = null;
  }

  /** Full re-read: it is small (a few files) and spares us inconsistent states. */
  #emit(): void {
    this.#onSessions(this.readAll());
  }

  readAll(): LiveSession[] {
    const now = Date.now();
    const out: LiveSession[] = [];
    let names: string[];
    try {
      names = fs.readdirSync(this.#dir);
    } catch {
      return out;
    }
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      const full = path.join(this.#dir, name);
      try {
        assertReadable(full, this.#policy);
      } catch {
        continue;
      }
      const parsed = parseRegistryEntry(readJsonWithRetry(full), now);
      if (parsed) out.push(parsed);
    }
    return out;
  }
}
