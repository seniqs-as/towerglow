import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Places in the row of buildings, assigned ONCE and then frozen.
 *
 * The slot sequence is 0 in the center, then 1 to the right, 2 to the left,
 * 3 to the right, and so on outward. On first startup the known projects are
 * sorted by recent activity, so the most recent takes the center and the
 * oldest end up at the edges.
 *
 * From then on the map is persisted: a project never moves again, neither
 * when it becomes active again nor between one restart and the next. A
 * latecomer takes the first free slot, which is always on the outside,
 * without disturbing anyone.
 */
export interface PlacementStore {
  slotOf(projectId: string): number;
  assignMany(projects: readonly { id: string; lastActiveAt: number }[]): void;
  save(): void;
}

interface LayoutFile {
  version: number;
  slots: Record<string, number>;
}

const VERSION = 1;

export function createPlacementStore(stateDir: string): PlacementStore {
  const file = path.join(stateDir, 'layout.json');
  const slots = new Map<string, number>();
  const used = new Set<number>();
  let dirty = false;

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as LayoutFile;
    if (raw && raw.version === VERSION && raw.slots && typeof raw.slots === 'object') {
      for (const [id, slot] of Object.entries(raw.slots)) {
        if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0) continue;
        slots.set(id, slot);
        used.add(slot);
      }
    }
  } catch {
    // no saved layout, or an unreadable file: start from zero
  }

  function nextFreeSlot(): number {
    let i = 0;
    while (used.has(i)) i++;
    return i;
  }

  return {
    slotOf(projectId) {
      const known = slots.get(projectId);
      if (known !== undefined) return known;
      const slot = nextFreeSlot();
      slots.set(projectId, slot);
      used.add(slot);
      dirty = true;
      return slot;
    },

    /**
     * Assigns in bulk, respecting recency. Must be called at startup with
     * all known projects: it is the only moment when the order matters.
     * Projects already placed keep their place.
     */
    assignMany(projects) {
      const pending = projects.filter((p) => !slots.has(p.id));
      pending.sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.id.localeCompare(b.id));
      for (const p of pending) {
        const slot = nextFreeSlot();
        slots.set(p.id, slot);
        used.add(slot);
        dirty = true;
      }
    },

    save() {
      if (!dirty) return;
      try {
        fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        const payload: LayoutFile = { version: VERSION, slots: Object.fromEntries(slots) };
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(tmp, file);
        dirty = false;
      } catch {
        // Failing to save the layout must not stop the tool from working:
        // only the stability across restarts is lost.
      }
    },
  };
}
