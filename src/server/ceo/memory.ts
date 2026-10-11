import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProviderId } from '../../shared/protocol.ts';

/**
 * A CEO's memory: what it already knows, and therefore must not ask again.
 *
 * The brief is a snapshot of the now -- projects, sessions, files, two
 * periods compared -- and it never carried a line about DECISIONS. The result
 * is a consultant without memory: it does not know what it proposed, does not
 * know what you said no to, does not know what was already done. It can only
 * start over.
 *
 * In here there are notes, one line each, and nothing else. It is a narrow
 * and deliberate choice: the brief has a cap, and the rule that holds it up
 * -- two periods, never a series -- applies here too. Pasting the outcome of
 * a job (measured: about five thousand characters) into a six-thousand brief
 * would evict everything else, and every question would cost more than the
 * previous one forever. A note is the headline of a known thing, not its
 * minutes: the minutes live in Reports, where you read them.
 *
 * The cap is double -- how many notes, and how long each one -- because a
 * limit on only one of the two dimensions is not a limit.
 */

const VERSION = 1;

/**
 * How many notes a CEO keeps.
 *
 * Twenty-four lines of two hundred characters are under five thousand, i.e.
 * under the lowest brief cap: the section can fit whole even in the cheapest
 * question, and the oldest one drops out first.
 */
const MAX_NOTES = 24;
/** The headline of a known thing. Beyond this it is not a note, it is a paragraph. */
export const MAX_NOTE_CHARS = 200;

/**
 * What kind of known thing.
 *
 * There are three and not a free string because the brief prints them
 * grouped, and saying "already done" or "you said no" or "whoever works there
 * objected" are three different reasons not to propose the same thing again.
 * A model that reads them undifferentiated loses exactly the information that
 * matters.
 */
/**
 * `effect` is the only one that does not come from a sentence: it comes from
 * a tally.
 *
 * It says how the project went AFTER an accepted job, and it is the only note
 * the CEO neither wrote nor heard. It closes the loop: without it, the memory
 * knows what was done and never whether it helped, and tomorrow's advice
 * starts again from the same premises as yesterday's.
 */
export type NoteKind = 'done' | 'rejected' | 'objection' | 'effect';

export interface Note {
  at: number;
  provider: ProviderId;
  kind: NoteKind;
  /** The project it refers to, as it is called on screen. */
  project: string | null;
  /** One line. The brief carries this and nothing else. */
  text: string;
  /**
   * The job this note is about, for the notes that come from one:
   * `work:<id>`, `review:<id>`, `effect:<id>`.
   *
   * A keyed note is REPLACED by the next one with the same key, never stacked
   * next to it. Measured on disk: the effect of one audit sat in memory as
   * four lines -- +382% over 3 sessions, +200% over 4, +17% over 8, and the
   * judgement that none of it was the audit's -- and the CEO took the first,
   * already disowned, as a fresh trend and proposed a diagnosis of it. One job
   * is one line per part: the latest reading, or the verdict that closes it.
   */
  key?: string;
}

export interface CeoMemory {
  /**
   * Takes a note. The same note twice is updated, not accumulated.
   *
   * With a `key`, the same key is the same note: the text is replaced, and the
   * same text again changes nothing -- not even the date, or rebuilding a note
   * at every start would make an old job read as the newest thing known.
   */
  note(n: Omit<Note, 'at'> & { at: number }): Note;
  /** What this CEO knows, most recent first. */
  list(provider: ProviderId): Note[];
  /** Drops the notes that match. For the ones rebuilt from another record. */
  forget(match: (n: Note) => boolean): void;
  save(): void;
}

interface MemoryFile {
  version: number;
  notes: Note[];
}

const KINDS = new Set<NoteKind>(['done', 'rejected', 'objection', 'effect']);

function isNote(v: unknown): v is Note {
  const n = v as Note | null;
  return !!n && typeof n.text === 'string' && typeof n.at === 'number' && KINDS.has(n.kind)
    && (n.key === undefined || typeof n.key === 'string');
}

export function createCeoMemory(stateDir: string): CeoMemory {
  const dir = path.join(stateDir, 'ceo');
  const file = path.join(dir, 'memory.json');
  let notes: Note[] = [];
  let dirty = false;

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as MemoryFile;
    if (raw && raw.version === VERSION) notes = (raw.notes ?? []).filter(isNote);
  } catch {
    // No memory: first time. A CEO without notes is yesterday's CEO.
  }

  return {
    note(n) {
      const text = n.text.trim().slice(0, MAX_NOTE_CHARS);
      if (text.length === 0) return { ...n, text };
      const full: Note = { ...n, text };
      /*
       * Same note, same CEO: the date is updated instead of adding a second
       * one. Without this, ten rejected audits on the same project would fill
       * the memory with ten copies of the same sentence and evict everything
       * else -- i.e. the memory would become noise precisely in the case where
       * it is needed most.
       */
      const same = n.key !== undefined
        ? notes.findIndex((x) => x.provider === n.provider && x.key === n.key)
        : notes.findIndex(
          (x) => x.provider === n.provider && x.key === undefined
            && x.kind === n.kind && x.text === text,
        );
      if (same >= 0) {
        const old = notes[same]!;
        if (n.key !== undefined && old.kind === full.kind && old.text === text) return old;
        notes.splice(same, 1);
      }
      // In date order, not arrival order: a note rebuilt at start carries the
      // date of the job it is about, and the cap below must drop the oldest.
      let at = notes.length;
      while (at > 0 && notes[at - 1]!.at > full.at) at -= 1;
      notes.splice(at, 0, full);

      // The cap is per CEO: one that works a lot must not be able to erase the
      // other's memory.
      const mine = notes.filter((x) => x.provider === n.provider);
      if (mine.length > MAX_NOTES) {
        const toDrop = new Set(mine.slice(0, mine.length - MAX_NOTES));
        notes = notes.filter((x) => !toDrop.has(x));
      }
      dirty = true;
      return full;
    },

    list: (provider) => notes.filter((n) => n.provider === provider).reverse(),

    forget(match) {
      const kept = notes.filter((n) => !match(n));
      if (kept.length === notes.length) return;
      notes = kept;
      dirty = true;
    },

    save() {
      if (!dirty) return;
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const payload: MemoryFile = { version: VERSION, notes };
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(tmp, file);
        dirty = false;
      } catch {
        // Being unable to save does not stop the tool: the CEO restarts with no
        // memory, which is exactly how it was before this file existed.
      }
    },
  };
}
