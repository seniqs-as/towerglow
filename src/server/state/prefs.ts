import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The DISPLAY preferences for projects: what you call them, and which ones
 * you have disabled.
 *
 * "Disabled" and not "hidden": it is not just that you do not see it. A
 * disabled project counts nowhere -- not in the totals, not in the
 * forecasts, and above all not among the ones a session can come from. You
 * declare that the project is no longer in play, and the rest of the program
 * treats it as if it were not there.
 *
 * It touches nothing outside of here. Renaming a project does not rename a
 * directory, and disabling it deletes nothing: the building stops being drawn
 * and its slot stays reserved, so re-enabling it puts it back exactly where
 * it was. They live in `~/.towerglow/`, never in `~/.claude`.
 */

/** An alias longer than this becomes an unreadable sign, not a name. */
export const MAX_ALIAS = 48;

export interface Prefs {
  aliasOf(projectId: string): string | null;
  isDisabled(projectId: string): boolean;
  disabledCount(): number;
  /** `null` clears the alias and brings back the real name. */
  setAlias(projectId: string, alias: string | null): void;
  setDisabled(projectId: string, disabled: boolean): void;
  /** Re-enables everything: it is the way out of "I disabled it by mistake". */
  showAll(): string[];
  save(): void;
}

interface PrefsFile {
  version: number;
  aliases: Record<string, string>;
  disabled: string[];
  /** What it was called up to version 1. It is read, never written anymore. */
  hidden?: string[];
}

// v2: `hidden` becomes `disabled`. The old file is still read: whoever had
// already set some projects aside must not find them all back in their face
// on the first startup after the upgrade.
const VERSION = 2;

/** Control characters: on a sign they carry no meaning at all. */
const RE_CONTROL = /[\u0000-\u001f\u007f]/g;

/** A single, short line: it is a name, not a document. */
function cleanAlias(raw: string): string | null {
  const text = raw.replace(RE_CONTROL, ' ').trim().slice(0, MAX_ALIAS);
  return text.length > 0 ? text : null;
}

export function createPrefs(stateDir: string): Prefs {
  const file = path.join(stateDir, 'prefs.json');
  const aliases = new Map<string, string>();
  const disabled = new Set<string>();
  let dirty = false;

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as PrefsFile;
    if (raw && (raw.version === VERSION || raw.version === 1)) {
      for (const [id, alias] of Object.entries(raw.aliases ?? {})) {
        if (typeof alias !== 'string') continue;
        const clean = cleanAlias(alias);
        if (clean) aliases.set(id, clean);
      }
      for (const id of raw.disabled ?? raw.hidden ?? []) {
        if (typeof id === 'string') disabled.add(id);
      }
    }
  } catch {
    // no saved preferences: start from the real names with everything visible
  }

  return {
    aliasOf: (id) => aliases.get(id) ?? null,
    isDisabled: (id) => disabled.has(id),
    disabledCount: () => disabled.size,

    setAlias(id, alias) {
      const clean = alias === null ? null : cleanAlias(alias);
      if (clean === null) aliases.delete(id);
      else aliases.set(id, clean);
      dirty = true;
    },

    setDisabled(id, off) {
      if (off) disabled.add(id);
      else disabled.delete(id);
      dirty = true;
    },

    showAll() {
      const back = [...disabled];
      disabled.clear();
      dirty = true;
      return back;
    },

    save() {
      if (!dirty) return;
      try {
        fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        const payload: PrefsFile = {
          version: VERSION,
          aliases: Object.fromEntries(aliases),
          disabled: [...disabled],
        };
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(tmp, file);
        dirty = false;
      } catch {
        // Failing to save must not stop the tool: the preferences are lost.
      }
    },
  };
}
