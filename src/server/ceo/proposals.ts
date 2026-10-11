import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProposalStatus, ProviderId } from '../../shared/protocol.ts';

/**
 * The proposals registry, and the only road they can travel.
 *
 * ```
 * pending ──► rejected          (terminal)
 *        └──► accepted ──► applied
 *                    └──► rejected   (withdrawn: it had never started)
 * ```
 *
 * The state machine lives here and is not scattered between whoever decides
 * and whoever executes, because this is the only point where the property
 * that matters can be guaranteed: NOTHING becomes `applied` without having
 * gone through `accepted`, that is, without you having accepted it. A second
 * path, even just for the convenience of a special case, would turn the
 * guarantee into a hope.
 *
 * A refusal is always a STRING and never a boolean: a proposal that cannot be
 * executed must say why -- it names a project that does not exist, it carries
 * no task, executive mode is off -- or it looks broken instead of stopped for
 * a reason.
 */

const VERSION = 1;

/**
 * How many are kept.
 *
 * Two hundred and not "all": the registry is the memory of decisions, not an
 * archive. The oldest already decided go first, and a `pending` one never
 * goes -- it is the only one still waiting for something from you.
 */
const MAX_KEPT = 200;

export interface Proposal {
  id: string;
  at: number;
  provider: ProviderId;
  kind: string;
  summary: string;
  /** The project to work on, already resolved to an id. `null` if it concerns none. */
  projectId: string | null;
  /** What it is called on screen: used to say it, not to find it. */
  projectName: string | null;
  /** The full task. Only its start reaches the browser. */
  task: string | null;
  status: ProposalStatus;
  decidedAt: number | null;
  /** The session executing it, once one has started. */
  sessionId: string | null;
}

export type NewProposal = Omit<Proposal, 'status' | 'decidedAt' | 'sessionId'>;

export interface Decision {
  ok: boolean;
  proposal: Proposal | null;
  /** Why not. Empty when `ok`. */
  reason: string;
}

export interface ProposalStore {
  add(p: NewProposal): Proposal;
  get(id: string): Proposal | undefined;
  list(): Proposal[];
  /** `pending` -> `accepted` | `rejected`. Everything else is refused. */
  decide(id: string, accept: boolean, now: number): Decision;
  /** `accepted` -> `applied`. Only with a session behind it. */
  markApplied(id: string, sessionId: string, now: number): Decision;
  /**
   * `accepted` -> `rejected`: you take back a yes that never started anything.
   *
   * An accepted proposal at rest is one whose launch was refused -- a launch
   * that works makes it `applied` in the same step. Before this there was no
   * way out: the decsim2 review accepted on 16 September was refused, stayed
   * `accepted` with nothing behind it, and nothing could close it. It is its
   * own call and not a second `decide`, because deciding twice must still
   * fail; and it only ever leads to `rejected`, so it is not a path to
   * `applied`.
   */
  withdraw(id: string, now: number): Decision;
  /**
   * Board started over: every proposal goes, `pending` ones too.
   *
   * Not a transition, so it opens no road to `applied`: a proposal that is
   * gone cannot be decided at all. They are written to `archive/` first, as
   * a plan is on `plan.reset` -- the registry is the memory of decisions, and
   * a clean table must not cost it for good. Returns how many went.
   */
  clear(now: number): number;
  save(): void;
}

interface ProposalsFile {
  version: number;
  proposals: Proposal[];
}

const STATUSES = new Set<ProposalStatus>(['pending', 'accepted', 'rejected', 'applied']);

function isProposal(v: unknown): v is Proposal {
  const p = v as Proposal | null;
  return !!p && typeof p.id === 'string' && typeof p.summary === 'string'
    && STATUSES.has(p.status);
}

/**
 * What a start over takes away, kept in `<ceo>/archive/`.
 *
 * Shared with the job ledger, which starts over the same way. A courtesy, like
 * the plans archive: a disk that refuses it must not stop the clean table you
 * asked for.
 */
export function archive(dir: string, name: string, payload: unknown): void {
  try {
    const into = path.join(dir, 'archive');
    fs.mkdirSync(into, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(into, name), JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // Losing the archive loses a copy, not the registry's state.
  }
}

export function createProposalStore(stateDir: string): ProposalStore {
  const dir = path.join(stateDir, 'ceo');
  const file = path.join(dir, 'proposals.json');
  const byId = new Map<string, Proposal>();
  let dirty = false;

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as ProposalsFile;
    if (raw && raw.version === VERSION) {
      for (const p of raw.proposals ?? []) if (isProposal(p)) byId.set(p.id, p);
    }
  } catch {
    // No registry: start from scratch, which is the case every first time.
  }

  /** The oldest already decided go; a `pending` one stays regardless. */
  function prune(): void {
    if (byId.size <= MAX_KEPT) return;
    const decided = [...byId.values()]
      .filter((p) => p.status !== 'pending')
      .sort((a, b) => a.at - b.at);
    for (const p of decided) {
      if (byId.size <= MAX_KEPT) break;
      byId.delete(p.id);
    }
    dirty = true;
  }

  const no = (reason: string, proposal: Proposal | null = null): Decision =>
    ({ ok: false, proposal, reason });

  return {
    add(p) {
      const full: Proposal = { ...p, status: 'pending', decidedAt: null, sessionId: null };
      byId.set(full.id, full);
      dirty = true;
      prune();
      return full;
    },

    get: (id) => byId.get(id),

    list: () => [...byId.values()].sort((a, b) => a.at - b.at),

    decide(id, accept, now) {
      const p = byId.get(id);
      if (!p) return no('unknown proposal');
      // Deciding twice is not an error to report as broken, but it must not
      // bring something already closed back into play either.
      if (p.status !== 'pending') return no(`already ${p.status}`, p);
      const next: Proposal = {
        ...p,
        status: accept ? 'accepted' : 'rejected',
        decidedAt: now,
      };
      byId.set(id, next);
      dirty = true;
      return { ok: true, proposal: next, reason: '' };
    },

    markApplied(id, sessionId, now) {
      const p = byId.get(id);
      if (!p) return no('unknown proposal');
      // THE property to defend: no shortcut from `pending` to `applied`. If it
      // were ever needed, it is changed here and it shows in the diff.
      if (p.status !== 'accepted') return no(`cannot apply a ${p.status} proposal`, p);
      const next: Proposal = { ...p, status: 'applied', decidedAt: now, sessionId };
      byId.set(id, next);
      dirty = true;
      return { ok: true, proposal: next, reason: '' };
    },

    withdraw(id, now) {
      const p = byId.get(id);
      if (!p) return no('unknown proposal');
      if (p.status !== 'accepted') return no(`only an accepted proposal can be withdrawn, this one is ${p.status}`, p);
      const next: Proposal = { ...p, status: 'rejected', decidedAt: now };
      byId.set(id, next);
      dirty = true;
      return { ok: true, proposal: next, reason: '' };
    },

    clear(now) {
      const gone = [...byId.values()];
      if (gone.length === 0) return 0;
      archive(dir, `proposals-${now}.json`, { version: VERSION, proposals: gone });
      byId.clear();
      dirty = true;
      return gone.length;
    },

    save() {
      if (!dirty) return;
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const payload: ProposalsFile = { version: VERSION, proposals: [...byId.values()] };
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(tmp, file);
        dirty = false;
      } catch {
        // Being unable to save does not stop the tool: what is lost is the
        // memory of decisions between one restart and the next, not the state
        // machine.
      }
    },
  };
}
