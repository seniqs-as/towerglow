import { OPERATOR_CAP_MS, addModelTimes } from '../../shared/protocol.ts';
import type { ModelTime } from '../../shared/protocol.ts';

/**
 * How long the agents worked for a session, and how long you did.
 *
 * Asked for to show funders what a project took (the user's request,
 * 2026-10-24): the tokens, the hours the AI spent, and the hours of the
 * person at the keyboard. Only instants go in, never text.
 *
 * AI TIME is the tool's own measure of each turn: Claude Code's
 * `turn_duration`, Codex's `task_complete.duration_ms`. Measured on
 * 2026-10-24 over the transcripts of three projects: it equals the span from
 * the prompt to the end of the turn to the second, except in turns that
 * waited, where it is shorter. A turn that ends without one -- `claude -p`
 * never writes it, so every worker of a plan, or a turn killed halfway --
 * counts from its start to the last thing the AGENT did in it: a reply, a
 * tool's result, a compaction. Not to the last thing that happened in the
 * session: measured on 2026-10-25 over the 232 sessions of the last 30 days,
 * that made 201.3 hours of AI out of 188.1 -- thirteen of them in one
 * session, where an automatic compaction opened a turn in the evening and a
 * background task delivering the next morning closed it, and nine minutes
 * in a `/clear` (a prompt the model never sees) followed by the deliveries of
 * the conversation it had cleared. Sessions add up: two working for the same
 * hour are two hours of AI.
 *
 * YOUR TIME is an estimate, and a floor: for every message you send, the
 * time since the session last did anything, up to `OPERATOR_CAP_MS` --
 * reading its answer and writing yours. Watching it work is not counted, nor
 * is the first message of a session, which nothing measures. Over the 30 days
 * on disk the cap moved the total from 37 hours (5 minutes) to 69 (15): it is
 * a choice, and the card names it.
 *
 * MODELS (the user's request, 2026-10-25): each turn's time goes to the
 * model and effort of the last reply read in it (Codex writes its
 * `turn_context` just after `task_started`); a turn with no reply goes to
 * what the session last ran on, or, at its start, to the first model it
 * names -- a compaction or a refusal before the first reply. So the split
 * sums to the AI time to the millisecond, and only a file that names no model
 * at all gives its time and no split.
 */

/**
 * How the numbers below are counted. A row on record read under an older
 * count is read again, once: a funder must not get two rules in one total.
 * 1, 2026-10-24: the hours. 2, 2026-10-25: the models, and a turn with no
 * measure of its own ends at the agent's last work.
 */
export const WORK_RULES = 2;

export interface WorkTotals {
  /** The agents' turns, in ms. */
  aiMs: number;
  /**
   * When you were at it, as flat `[start, end, start, end, ...]` in ms.
   *
   * Spans and not a total: you have one pair of hands, and a minute in which
   * two projects were waiting on you is shared between them (`shareOperator`),
   * which only the instants make possible. Measured on the same 30 days:
   * summed per session your time came to 54.7 hours, shared it is 51.1.
   */
  operator: number[];
  /**
   * `aiMs` by model and effort, the largest first. Absent on rows timed
   * before models were read.
   */
  models?: ModelTime[];
  /** `WORK_RULES` when it was read. Absent: the first count. */
  rules?: number;
}

export class WorkMeter {
  #ai = 0;
  #operator: number[] = [];
  #models: ModelTime[] = [];
  /** What the session last ran on: the turn's, once it has replied. */
  #model: { model: string; effort: string | null } | null = null;
  /** Time worked before any model was named: the first one named takes it. */
  #unnamed = 0;
  /** The start of a turn whose end has not been read yet. */
  #open: number | null = null;
  /** The last thing the session did. */
  #last = 0;
  /** The last thing the agent did: where a turn with no measure of its own ends. */
  #worked = 0;

  /**
   * A message arrived: yours (`human`), or a script's -- a worker's
   * briefing, an answer resumed by the plan. `queued` was typed while a turn
   * was running: it joins that turn instead of starting one.
   */
  prompt(at: number, human: boolean, queued = false): void {
    if (human && this.#last > 0 && at > this.#last) {
      const from = Math.max(this.#last, at - OPERATOR_CAP_MS);
      this.#operator.push(from, at);
    }
    // A new turn while one is open: the open one ended without saying so.
    if (this.#open !== null && !queued) this.#closeAtLast();
    if (this.#open === null) this.#open = at;
    this.#touch(at);
  }

  /** The end of a turn, with the tool's own measure of it when there is one. */
  turnEnd(at: number, durationMs: number): void {
    if (durationMs > 0) this.#credit(durationMs);
    else if (this.#open !== null) this.#credit(Math.max(0, at - this.#open));
    this.#open = null;
    this.#touch(at);
  }

  /** A turn stopped by you (Codex's `turn_aborted`): it ran until now. */
  abort(at: number): void {
    if (this.#open !== null) this.#credit(Math.max(0, at - this.#open));
    this.#open = null;
    this.#touch(at);
  }

  /** What the session runs on from here: a reply's model, a Codex turn's settings. */
  model(model: string, effort: string | null): void {
    this.#model = { model, effort };
    if (this.#unnamed > 0) addModelTimes(this.#models, [{ model, effort, aiMs: this.#unnamed }]);
    this.#unnamed = 0;
  }

  /** The agent at work: a reply, a tool's result, a compaction. */
  work(at: number): void {
    if (at > this.#worked) this.#worked = at;
    this.#touch(at);
  }

  /**
   * Something the session did that is not the agent working: a background
   * task's delivery, a reminder of the context left. It is where your time
   * starts counting, and it does not stretch a turn.
   */
  activity(at: number): void {
    this.#touch(at);
  }

  /** So far: a turn still open counts up to the last thing it did. */
  totals(): WorkTotals {
    const open = this.#open !== null ? Math.max(0, this.#worked - this.#open) : 0;
    const models: ModelTime[] = [];
    addModelTimes(models, this.#models);
    if (open > 0 && this.#model) addModelTimes(models, [{ ...this.#model, aiMs: open }]);
    models.sort((a, b) => b.aiMs - a.aiMs);
    return { aiMs: this.#ai + open, operator: [...this.#operator], models, rules: WORK_RULES };
  }

  #closeAtLast(): void {
    if (this.#open !== null) this.#credit(Math.max(0, this.#worked - this.#open));
    this.#open = null;
  }

  #credit(ms: number): void {
    this.#ai += ms;
    if (ms <= 0) return;
    if (this.#model) addModelTimes(this.#models, [{ ...this.#model, aiMs: ms }]);
    else this.#unnamed += ms;
  }

  #touch(at: number): void {
    if (at > this.#last) this.#last = at;
  }
}

/** Whose spans these are: a session, on a project. */
export interface SpanOwner {
  id: string;
  projectId: string;
  spans: readonly number[];
}

/**
 * Each session's share of your time.
 *
 * A stretch in which you were at two projects counts half in each: you
 * cannot be in two places at once, and a funder of one project should not pay
 * for the minutes of another. Two sessions on the SAME project share it
 * between them, and the project gets the stretch once.
 */
export function shareOperator(owners: readonly SpanOwner[]): Map<string, number> {
  const out = new Map<string, number>();
  // [instant, +1 opens / -1 closes, owner]. At the same instant closes come
  // first: two spans that touch do not overlap.
  const events: [number, number, number][] = [];
  owners.forEach((o, i) => {
    out.set(o.id, 0);
    for (let k = 0; k + 1 < o.spans.length; k += 2) {
      const a = o.spans[k]!;
      const b = o.spans[k + 1]!;
      if (b > a) events.push([a, 1, i], [b, -1, i]);
    }
  });
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  const active = new Map<number, number>();
  let prev = 0;
  for (const [at, step, i] of events) {
    if (active.size > 0 && at > prev) {
      const len = at - prev;
      const perProject = new Map<string, number[]>();
      for (const j of active.keys()) {
        const p = owners[j]!.projectId;
        const list = perProject.get(p);
        if (list) list.push(j);
        else perProject.set(p, [j]);
      }
      for (const list of perProject.values()) {
        const each = len / perProject.size / list.length;
        for (const j of list) out.set(owners[j]!.id, (out.get(owners[j]!.id) ?? 0) + each);
      }
    }
    const n = (active.get(i) ?? 0) + step;
    if (n > 0) active.set(i, n);
    else active.delete(i);
    prev = at;
  }
  return out;
}
