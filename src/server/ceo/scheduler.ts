import type {
  PlanProject, PlanTask, ProviderId, ProviderLimits, SessionStatus, TaskSize,
} from '../../shared/protocol.ts';
import { HUMAN_GRACE_MS, MAX_FIELD_CHARS } from '../../shared/protocol.ts';
import { windowNow } from '../../shared/limits.ts';
import type { Plan } from './plan.ts';

/**
 * Which task starts next, if any. A pure rule: no clock of its own, no
 * process, no model.
 *
 * It moves on its own -- the desk asks it every tick -- and that is the one
 * departure this feature makes from "nothing happens without a gesture". It
 * is kept honest by what it is NOT allowed to do: it never calls a CEO, it
 * only launches tasks of a plan you approved, and every refusal is a string
 * the panel shows, so a scheduler at rest is never a silence.
 *
 * The rules, in order:
 *  1. only an approved plan launches;
 *  2. at most `parallel` tasks run at once;
 *  3. projects in priority order, and a project is skipped when it already
 *     has a task running (one session per repository), a task asking you,
 *     a task that failed (retry or skip it), or a session of your own that is
 *     active there;
 *  4. the outer quota gate (`blockedReason`) refuses a fleet altogether, and
 *     the search moves to the next project -- maybe on the other fleet;
 *  5. headroom: on every window of the fleet, used + in flight + expected
 *     must leave the reserve free. An unknown expected cost counts ten points
 *     and runs alone, so one finished task teaches the next one's price.
 *
 * The reserve is also held while tasks run, not only when they start:
 * `reserveBreach` is what the desk stops the fleet with. The stopped tasks go
 * back in the queue, and rule 5 is what holds them there and what lets them
 * start again once the window has room.
 */

/**
 * How long a session of yours keeps a project for itself after its last move.
 *
 * Five minutes, by decision of the user (it was thirty, which held a planned
 * project for half an hour after a session had gone quiet). A terminal left
 * open since yesterday must not stop the queue, and a session you typed in a
 * moment ago must. `idle` status alone does not decide it -- a session goes
 * idle between two prompts. The panel warns, before you approve, about the
 * sessions this rule would wait for.
 */
export { HUMAN_GRACE_MS };

/** What a task is assumed to cost, in points of a window, until one has been measured. */
export const UNKNOWN_EXPECTED_PERCENT = 10;

export interface LiveSessionRef {
  projectId: string;
  provider: ProviderId;
  spawnedByCeo: ProviderId | null;
  status: SessionStatus;
  lastActivityAt: number;
}

export interface SchedulerInput {
  plan: Plan;
  now: number;
  limits: readonly ProviderLimits[];
  live: readonly LiveSessionRef[];
  /** The ledger's gate for this fleet, bound to limits and now. */
  blockedReason: (provider: ProviderId) => string | null;
  /** Expected cost of a task, in percent per window label. `null` when nothing has been measured. */
  expected: (provider: ProviderId, size: TaskSize) => Readonly<Record<string, number>> | null;
}

export type Next =
  | { launch: PlanTask; project: PlanProject; expectedKnown: boolean }
  | { wait: string };

function clip(text: string): string {
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS - 1)}…` : text;
}

/** A session of yours is active here: working, waiting on you, or moved recently. */
export function humanActive(live: readonly LiveSessionRef[], projectId: string, now: number): boolean {
  return humanSessions(live, projectId, now) > 0;
}

/**
 * How many sessions of yours hold a project, by the rule above. The panel
 * counts with this and nothing else: a warning that disagreed with the
 * scheduler would promise a launch that then waits.
 */
export function humanSessions(live: readonly LiveSessionRef[], projectId: string, now: number): number {
  return live.filter((s) => s.projectId === projectId && s.spawnedByCeo === null
    && (s.status !== 'idle' || now - s.lastActivityAt < HUMAN_GRACE_MS)).length;
}

/** How much of a window the plan keeps for you, in points. */
function keepOf(plan: Plan, provider: ProviderId, label: string): number {
  const reserve = plan.reserve[provider] ?? { '5h': 0, '7d': 0 };
  return reserve[label as '5h' | '7d'] ?? Math.max(reserve['5h'], reserve['7d']);
}

/**
 * The headroom check for one fleet: the reason it fails, or null.
 *
 * Every window is checked, not the tightest: the 7d can be the one that
 * blocks while the 5h has just reset.
 *
 * `inFlight` is the expected cost of every task of this fleet already
 * running, counted whole until it ends. Without it a tick that launches
 * three tasks weighed each of them against the same reading, as if the
 * other two cost nothing: measured on the field (2026-09-18), three workers
 * passed a 20% reserve against a 5h window at 5% and emptied it in
 * seventeen minutes. The part a running task has already spent is in the
 * reading too, so it is counted twice -- on the reserve's side.
 */
export function headroomReason(
  plan: Plan,
  provider: ProviderId,
  limits: readonly ProviderLimits[],
  expected: Readonly<Record<string, number>> | null,
  now: number,
  inFlight: readonly (Readonly<Record<string, number>> | null)[] = [],
): string | null {
  const mine = limits.find((l) => l.provider === provider);
  if (!mine) return null; // no reading: the outer gate has the same blindness, and says so elsewhere
  for (const raw of mine.windows) {
    const w = windowNow(raw, now);
    const keep = keepOf(plan, provider, w.label);
    const cost = expected?.[w.label] ?? UNKNOWN_EXPECTED_PERCENT;
    let flying = 0;
    for (const e of inFlight) flying += e?.[w.label] ?? UNKNOWN_EXPECTED_PERCENT;
    if (w.usedPercent + flying + cost > 100 - keep) {
      const running = flying > 0 ? ` + ~${Math.round(flying)}% running` : '';
      return `${w.label} at ${Math.round(w.usedPercent)}%${running} + ~${Math.round(cost)}% would breach the ${keep}% reserve`;
    }
  }
  return null;
}

/**
 * The reserve, read while tasks run: the reason to stop a fleet, or null.
 *
 * The headroom rule decides what starts, on an estimate; this one decides
 * what must stop, on a reading. A task can cost many times its estimate --
 * the translation that emptied the 5h window made 1939 tool calls through
 * fifteen subagents -- and a reserve checked only at the start is a wish.
 * Reaching the line is enough: the reserve is what you keep, so the work
 * stops on it, not after it.
 */
export function reserveBreach(
  plan: Plan,
  provider: ProviderId,
  limits: readonly ProviderLimits[],
  now: number,
): string | null {
  const mine = limits.find((l) => l.provider === provider);
  if (!mine) return null;
  for (const raw of mine.windows) {
    const w = windowNow(raw, now);
    const keep = keepOf(plan, provider, w.label);
    if (w.usedPercent >= 100 - keep) {
      return clip(`${w.label} at ${Math.round(w.usedPercent)}% reached the ${keep}% reserve`);
    }
  }
  return null;
}

export function nextLaunch(input: SchedulerInput): Next {
  const { plan, now } = input;
  if (plan.status !== 'approved') return { wait: `plan is ${plan.status}` };

  let running = 0;
  const unknownInFlight = new Map<ProviderId, number>();
  const inFlight = new Map<ProviderId, (Readonly<Record<string, number>> | null)[]>();
  for (const p of plan.projects) {
    for (const t of p.tasks) {
      if (t.status !== 'running') continue;
      running += 1;
      const e = input.expected(t.provider, t.size);
      inFlight.set(t.provider, [...(inFlight.get(t.provider) ?? []), e]);
      if (e === null) {
        unknownInFlight.set(t.provider, (unknownInFlight.get(t.provider) ?? 0) + 1);
      }
    }
  }
  if (running >= plan.parallel) return { wait: `parallel cap (${plan.parallel}) reached` };

  const reasons: WaitReason[] = [];
  const ordered = [...plan.projects].sort((a, b) => a.priority - b.priority);
  for (const project of ordered) {
    const note = (text: string): void => { reasons.push({ project: project.name, text }); };
    if (project.tasks.some((t) => t.status === 'running')) continue;
    if (project.tasks.some((t) => t.status === 'question')) { note('waiting for your answer'); continue; }
    if (project.tasks.some((t) => t.status === 'failed')) { note('a task failed, retry or skip it'); continue; }
    const candidate = project.tasks.find((t) => t.status === 'queued');
    if (!candidate) continue;
    if (humanActive(input.live, project.projectId, now)) { note('you have a session open there'); continue; }

    const blocked = input.blockedReason(candidate.provider);
    if (blocked) { note(blocked); continue; }

    const expected = input.expected(candidate.provider, candidate.size);
    if (expected === null && (unknownInFlight.get(candidate.provider) ?? 0) > 0) {
      note(`a ${candidate.provider} task of unknown cost is already running`);
      continue;
    }
    const headroom = headroomReason(
      plan, candidate.provider, input.limits, expected, now, inFlight.get(candidate.provider) ?? [],
    );
    if (headroom) { note(headroom); continue; }

    return { launch: candidate, project, expectedKnown: expected !== null };
  }
  return { wait: clip(reasons.length > 0 ? waitText(reasons) : 'nothing queued') };
}

interface WaitReason {
  project: string;
  text: string;
}

/**
 * Why nothing starts, for every project that was held, not the first one.
 *
 * Only the first reason used to reach the panel. On 2026-09-19 it was "you
 * have a session open there" on the project you were typing in -- true, and
 * the one you could already see -- while the dollar cap held the other two
 * and never showed. Projects held for the same reason share a line, and the
 * reason that holds the most goes first: a gate on a whole fleet reads
 * before a single project's.
 */
function waitText(reasons: readonly WaitReason[]): string {
  const groups = new Map<string, string[]>();
  for (const r of reasons) groups.set(r.text, [...(groups.get(r.text) ?? []), r.project]);
  return [...groups]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([text, projects]) => `${projects.join(', ')}: ${text}`)
    .join('; ');
}
