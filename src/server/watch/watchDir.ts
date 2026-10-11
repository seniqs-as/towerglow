import * as fs from 'node:fs';
import * as path from 'node:path';

export type DirChangeKind = 'add' | 'change' | 'unlink';

export interface DirChange {
  kind: DirChangeKind;
  name: string;
  full: string;
}

export interface WatchDirOptions {
  /** Only names that pass this filter are watched. */
  filter: (name: string) => boolean;
  /** Safety poll: fs.watch on macOS loses events, so it is not the source of truth. */
  intervalMs?: number;
  /** Wait after an fs.watch event, so the same write is not re-read N times. */
  debounceMs?: number;
}

interface Entry {
  mtimeMs: number;
  size: number;
}

/**
 * Watches a flat directory.
 *
 * fs.watch only serves to lower the latency; the truth is always established
 * by the periodic poll. If fs.watch is unavailable or loses events, the
 * watcher keeps working, more slowly, instead of silently stopping.
 */
export class DirWatcher {
  #dir: string;
  #opts: Required<WatchDirOptions>;
  #onChange: (changes: DirChange[]) => void;
  #known = new Map<string, Entry>();
  #watcher: fs.FSWatcher | null = null;
  #timer: NodeJS.Timeout | null = null;
  #debounce: NodeJS.Timeout | null = null;
  #stopped = false;
  #scanning = false;

  constructor(dir: string, opts: WatchDirOptions, onChange: (changes: DirChange[]) => void) {
    this.#dir = dir;
    this.#opts = {
      filter: opts.filter,
      intervalMs: opts.intervalMs ?? 1000,
      debounceMs: opts.debounceMs ?? 80,
    };
    this.#onChange = onChange;
  }

  /** First scan is synchronous: the caller gets the initial state right away. */
  start(): DirChange[] {
    const initial = this.#scan(true);
    this.#attachWatch();
    this.#timer = setInterval(() => this.#tick(), this.#opts.intervalMs);
    this.#timer.unref?.();
    return initial;
  }

  stop(): void {
    this.#stopped = true;
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#timer = null;
    this.#debounce = null;
  }

  #attachWatch(): void {
    try {
      this.#watcher = fs.watch(this.#dir, { persistent: false }, () => {
        if (this.#debounce) clearTimeout(this.#debounce);
        this.#debounce = setTimeout(() => this.#tick(), this.#opts.debounceMs);
        this.#debounce.unref?.();
      });
      // A directory that vanishes must not kill the process.
      this.#watcher.on('error', () => {
        this.#watcher?.close();
        this.#watcher = null;
      });
    } catch {
      // The directory may not exist yet: the poll takes care of it, and we
      // retry attaching fs.watch on the first tick that finds it.
      this.#watcher = null;
    }
  }

  #tick(): void {
    if (this.#stopped || this.#scanning) return;
    const changes = this.#scan(false);
    if (!this.#watcher) this.#attachWatch();
    if (changes.length > 0) this.#onChange(changes);
  }

  #scan(initial: boolean): DirChange[] {
    this.#scanning = true;
    const changes: DirChange[] = [];
    try {
      let names: string[];
      try {
        names = fs.readdirSync(this.#dir);
      } catch {
        // directory missing: everything we knew must be considered removed
        names = [];
      }

      const seen = new Set<string>();
      for (const name of names) {
        if (!this.#opts.filter(name)) continue;
        const full = path.join(this.#dir, name);
        let st: fs.Stats;
        try {
          st = fs.statSync(full);
        } catch {
          continue; // vanished between readdir and stat
        }
        if (!st.isFile()) continue;
        seen.add(name);

        const prev = this.#known.get(name);
        const cur: Entry = { mtimeMs: st.mtimeMs, size: st.size };
        if (!prev) {
          this.#known.set(name, cur);
          changes.push({ kind: 'add', name, full });
        } else if (prev.mtimeMs !== cur.mtimeMs || prev.size !== cur.size) {
          this.#known.set(name, cur);
          changes.push({ kind: 'change', name, full });
        }
      }

      for (const name of [...this.#known.keys()]) {
        if (seen.has(name)) continue;
        this.#known.delete(name);
        changes.push({ kind: 'unlink', name, full: path.join(this.#dir, name) });
      }
    } finally {
      this.#scanning = false;
    }
    return initial ? changes : changes;
  }
}
