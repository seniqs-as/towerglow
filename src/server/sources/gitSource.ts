import * as fs from 'node:fs';
import * as path from 'node:path';
import { Tailer } from '../watch/tailer.ts';
import { assertReadable } from '../paths.ts';
import type { PathPolicy } from '../paths.ts';
import type { DeltaEvent } from '../../shared/protocol.ts';
import { projectIdFor } from '../state/ids.ts';

/**
 * Commits and branch changes from the reflog.
 *
 * `.git/logs/HEAD` is an append-only PLAIN TEXT file: it is read with the
 * same Tailer as the transcripts, without launching `git`, without
 * decompressing zlib objects and without adding dependencies. Line format:
 *
 *   <old-sha> <new-sha> Name <email> <epoch> <tz>\t<action>: <subject>
 *
 * From that line only the event type, the short sha and the subject come
 * out: author and email are ALWAYS discarded, at every privacy level. They
 * are personal data that add nothing in a single-user tool.
 */

const POLL_MS = 2000;
const MAX_SUBJECT = 96;

/**
 * Reflog lines: old sha, new sha, author, EPOCH, timezone, tab, action.
 *
 * The epoch must be captured: without it, the only instant available would
 * be the one at which the line is read, and at server startup all the
 * commits already on disk would look freshly made.
 */
const RE_LINE = /^([0-9a-f]{7,40})\s+([0-9a-f]{7,40})\s+.*?\s(\d{9,})\s+[+-]\d{4}\t(.+)$/;

export interface GitSourceOptions {
  policy: PathPolicy;
  commitText: boolean;
  emit: (events: readonly DeltaEvent[]) => void;
}

type GitKind = Extract<DeltaEvent, { t: 'git' }>['kind'];

function kindOf(action: string): GitKind {
  const verb = action.split(':')[0]?.trim() ?? '';
  if (verb.startsWith('commit')) return 'commit';
  if (verb.startsWith('checkout')) return 'checkout';
  if (verb.startsWith('merge')) return 'merge';
  if (verb.startsWith('rebase')) return 'rebase';
  if (verb.startsWith('reset')) return 'reset';
  if (verb.startsWith('pull')) return 'merge';
  if (verb.startsWith('clone')) return 'commit';
  return 'other';
}

interface Attached {
  cwd: string;
  projectId: string;
  tailer: Tailer;
  branch: string | null;
}

export class GitSource {
  #opts: GitSourceOptions;
  #attached = new Map<string, Attached>();
  #timer: NodeJS.Timeout | null = null;

  constructor(opts: GitSourceOptions) {
    this.#opts = opts;
  }

  start(): void {
    this.#timer = setInterval(() => this.#pump(), POLL_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const a of this.#attached.values()) void a.tailer.close();
    this.#attached.clear();
  }

  /** Attaches the projects that are git repositories. Idempotent. */
  watch(cwds: readonly string[]): void {
    for (const cwd of cwds) {
      if (this.#attached.has(cwd)) continue;
      void this.#attach(cwd);
    }
  }

  async #attach(cwd: string): Promise<void> {
    const reflog = path.join(cwd, '.git', 'logs', 'HEAD');
    try {
      assertReadable(reflog, this.#opts.policy);
    } catch {
      return;
    }
    if (!fs.existsSync(reflog)) return; // not a repo, or no commits yet

    const attached: Attached = {
      cwd,
      projectId: projectIdFor(cwd),
      tailer: null as unknown as Tailer,
      branch: this.#readBranch(cwd),
    };
    // Only the tail: the whole history of a large repo would fill the tower
    // with rings years old, which is not what a live monitor should show.
    //
    // But this window also decides HOW MANY commits the CEO believes exist,
    // and that is not obvious from here. Measured on decsim2: 192 bytes per
    // reflog line, so 4096 bytes make 21 lines, minus the first which starts
    // truncated -- twenty, against 72 real commits. That is why `brief.ts`
    // writes "20+" and declares the number a floor: widening the window would
    // move the cap without removing the cap. If one day it is widened, that
    // declaration stays true anyway.
    attached.tailer = new Tailer(reflog, 4096, (line) => this.#onLine(attached, line));
    this.#attached.set(cwd, attached);

    try {
      await attached.tailer.open();
    } catch {
      this.#attached.delete(cwd);
    }
  }

  /** `.git/HEAD` is a single line: `ref: refs/heads/main`. */
  #readBranch(cwd: string): string | null {
    const head = path.join(cwd, '.git', 'HEAD');
    try {
      assertReadable(head, this.#opts.policy);
      const text = fs.readFileSync(head, 'utf8').trim();
      const m = /^ref:\s+refs\/heads\/(.+)$/.exec(text);
      return m?.[1]?.slice(0, 64) ?? null;
    } catch {
      return null;
    }
  }

  #onLine(a: Attached, line: string): void {
    if (line.length > 4096) return;
    const m = RE_LINE.exec(line);
    if (!m) return;

    const sha = (m[2] ?? '').slice(0, 7);
    const epochSec = Number(m[3]);
    const action = m[4] ?? '';
    const kind = kindOf(action);
    // When the commit was MADE, not when we read it.
    const at = Number.isFinite(epochSec) && epochSec > 0 ? epochSec * 1000 : Date.now();

    // Only the SUBJECT, i.e. the first line of the message. The body does not
    // appear in the reflog, and `.git/COMMIT_EDITMSG` -- which would contain
    // it -- is outside the allow-list precisely for this reason.
    const afterColon = action.indexOf(':');
    const rawSubject = afterColon >= 0 ? action.slice(afterColon + 1).trim() : action.trim();
    const subject = this.#opts.commitText && rawSubject.length > 0
      ? rawSubject.slice(0, MAX_SUBJECT)
      : null;

    if (kind === 'checkout') a.branch = this.#readBranch(a.cwd);

    this.#opts.emit([
      { t: 'git', projectId: a.projectId, at, kind, sha, branch: a.branch, subject },
    ]);
  }

  #pump(): void {
    for (const a of this.#attached.values()) void a.tailer.pump();
  }

  get attachedCount(): number {
    return this.#attached.size;
  }
}
