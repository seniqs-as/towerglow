import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AttachmentMeta, CeoDepth, Effort, GitRules, MeetingQuestion, Minute, PlanDoc, PlanPatch,
  PlanProject, PlanStatus, PlanTask, ProviderId, Reserve, TaskSize, TaskStatus,
} from '../../shared/protocol.ts';
import {
  ANSWERS_MINUTE_PREFIX, CLAUDE_MODELS, effortsFor, MAX_ANSWER_CHARS, MAX_ATTACHMENT_CHARS, MAX_ATTACHMENT_NAME_CHARS,
  MAX_ATTACHMENTS, MAX_ATTACHMENTS_TOTAL_CHARS, MAX_BRIEFING_CHARS, MAX_FIELD_CHARS,
  MAX_MINUTE_CHARS, MAX_PLAN_TASKS, MAX_PROJECT_COMMANDS, MAX_QUESTION_CHARS, MAX_SAY_CHARS,
  MAX_SUMMARY_CHARS, MAX_TODO_CHARS,
} from '../../shared/protocol.ts';
import { commandPattern, commandProblem, commandsOf, mergeCommands } from './allow.ts';

/**
 * The plan: what you and the chair agreed on, and where every task stands.
 *
 * ```
 * drafting ──(a block with a project)──► proposed ──(approve)──► approved ──(pause)──► paused
 *                                                                   ▲                    │
 *                                                                   └─────(resume)───────┘
 * approved ──(every task done or skipped)──► done
 * any ──(reset, nothing running)──► drafting, new id, old plan archived
 *
 * task: queued ──► running ──► done | failed | question
 *       question ──(answer | allow)──► queued        failed ──(retry)──► queued
 *       queued | failed | question ──(skip)──► skipped
 * ```
 *
 * This file is the record. The meeting is a resumed CEO session for the
 * model's sake -- it keeps what it read -- but the minutes are extracted
 * every turn and stored here, so the plan stands on its own if that session
 * is gone. A plan that lived only inside a transcript would be a plan you
 * could not read, edit or restart without paying for a model to tell it back.
 *
 * Every mutation is a pure function on the plan, and every refusal is a
 * STRING: a change that is not legal now must say why on screen, or the
 * button just looks broken. The store wraps them, bumps `rev` and persists.
 */

const VERSION = 1;

/**
 * What must stay free, per window, until you say otherwise.
 *
 * Starting points, not measures. An hour of urgent interactive work on the
 * default model can eat a fifth to a third of the 5h window, so 30 keeps one
 * urgent hour available at any moment; a lost working day is a fifth of a
 * week, so 20 keeps one in the weekly window even after the scheduler has run
 * all week. Both are sliders in the panel.
 */
export const DEFAULT_RESERVE: Reserve = { '5h': 30, '7d': 20 };
/**
 * Two workers at once: one per fleet.
 *
 * With one session per project and two independent quotas, that is the
 * natural maximum; a third would compete with the first two for the same
 * windows and for the seven mast pads, where a finished mast lingers five
 * minutes.
 */
export const DEFAULT_PARALLEL = 2;
export const MAX_PARALLEL = 4;
/** Above this the scheduler could never launch anything: a reserve, not a lock. */
export const MAX_RESERVE_PERCENT = 90;
/**
 * How many attempts in a row the reserve may stop before a task waits for you.
 *
 * A task stopped at the reserve goes back in the queue and starts again on
 * its own when the window has room: that is what lets a plan run through
 * the night. The first stop can be anyone's doing -- your own terminals, the
 * task running beside it -- but a second one in a row says this task does
 * not fit in a window as it was planned. The translation that emptied the 5h
 * (1939 tool calls through fifteen subagents) would otherwise come back at
 * every reset and burn up to the line each time, with nobody looking.
 */
export const MAX_RESERVE_STOPS = 2;
export const MAX_MINUTES = 60;
export const MAX_MEETING_QUESTIONS = 12;
export const MAX_TASKS_PER_PROJECT = 20;
export const MAX_PROJECTS = 24;
/**
 * A safety net, not the length the chair is asked for (500, in the
 * contract). At 500 a real question of 638 chars lost its last two asks
 * mid-word, and was answered cut: the chair does not always keep to the
 * number it is given, and a question is read whole or read wrong.
 */
const MAX_MEETING_QUESTION_CHARS = MAX_QUESTION_CHARS;

/** The reason a server restart leaves on a task that was running. */
export const STOPPED_BY_RESTART = 'the server stopped while it was working';

export interface Attachment extends AttachmentMeta {
  text: string;
}

/** `branches` is not stored: it is read from the world each time the document is sent. */
export interface Plan extends Omit<PlanDoc, 'attachments' | 'branches' | 'active'> {
  attachments: Attachment[];
  /** The chair's session or thread, resumed every turn. Server-side only. */
  session: string | null;
  /**
   * Names of files the chair has and you removed since its last turn. It
   * keeps what it read, so a removal must be said, or it plans from a file
   * the panel no longer shows. Server-side only.
   */
  withdrawn: string[];
  /**
   * Attempts in a row the reserve stopped, by task id: see
   * `MAX_RESERVE_STOPS`. Server-side only, and saved: a restart must not
   * hand a task two more tries.
   */
  reserveStops: Record<string, number>;
}

/** The outcome of a change: the plan as it is now, and why it did not change. */
export interface PlanResult {
  ok: boolean;
  plan: Plan;
  /** Empty when `ok`. */
  reason: string;
}

/** What a worker's block, or its death, says about a task. */
export interface TaskReport {
  /** `queued`: stopped by us -- a pause, the reserve -- and back in the queue with its session. */
  status: 'done' | 'failed' | 'question' | 'queued';
  did: string | null;
  question: string | null;
  reason: string;
  /** Weighted tokens the attempt burned, when the tool declared them. */
  learned: number | null;
  /** With `question`: the commands it was refused and needs. Absent is none. */
  needs?: readonly string[];
  /** With `queued`: it was the reserve that stopped it, not a pause. */
  byReserve?: boolean;
}

/** What the chair's block carries once parsed. Resolution to ids happens here. */
export interface ParsedTask {
  id: string | null;
  title: string;
  briefing: string;
  provider: ProviderId;
  model: string | null;
  effort: Effort | null;
  size: TaskSize;
}
export interface ParsedProject {
  name: string;
  priority: number;
  /** The commands that run its tests, as the chair read them in the repository. */
  tests: string[];
  tasks: ParsedTask[];
}
export interface ParsedPlan {
  ready: boolean;
  questions: { id: string; text: string }[];
  projects: ParsedProject[];
}

export interface PlanStoreOptions {
  /** The CEOs that exist: a task cannot be handed to a fleet that is not there. */
  providers: readonly ProviderId[];
  /** Your Codex model, when declared: the only Codex name the plan accepts besides "its own". */
  codexModel: string | null;
}

export interface PlanStore {
  get(): Plan;
  /** Your turn of the meeting: to-dos and priorities, in your words. */
  say(text: string, now: number): PlanResult;
  /** The chair's prose, one line of minutes. */
  noteCeo(text: string, now: number): void;
  /** Something the store did on its own that you should know about. */
  noteSystem(text: string, now: number): void;
  setSession(id: string | null): void;
  attach(name: string, text: string, now: number): PlanResult;
  detach(id: string, now: number): PlanResult;
  /** A turn carrying these files, and these removals, reached the chair. */
  delivered(ids: readonly string[], withdrawn: readonly string[], now: number): void;
  /** A turn carrying these answers reached the chair: they are read, as they were written. */
  readAnswers(read: readonly ReadAnswer[], now: number): void;
  set(patch: PlanPatch, now: number): PlanResult;
  /** The chair's block, merged into the plan. Names resolve to projects here. */
  applyOutcome(
    parsed: ParsedPlan,
    resolve: (name: string) => { projectId: string; name: string } | null,
    now: number,
  ): PlanResult;
  approve(now: number): PlanResult;
  pause(now: number): PlanResult;
  resume(now: number): PlanResult;
  reset(now: number): PlanResult;
  answer(taskId: string, text: string, now: number): PlanResult;
  /** A worker's `needs`, allowed in its project for this plan and the next: it resumes with them. */
  allow(taskId: string, now: number): PlanResult;
  retry(taskId: string, now: number): PlanResult;
  skip(taskId: string, now: number): PlanResult;
  /** The scheduler started it: `queued` -> `running`, one more attempt. */
  launched(taskId: string, jobId: string, now: number): PlanResult;
  attachSession(taskId: string, sessionId: string, now: number): void;
  /** The worker is gone: `running` -> what its block or its death says. */
  finished(taskId: string, report: TaskReport, now: number): PlanResult;
  save(): void;
}

interface PlanFile {
  version: number;
  plan: Plan;
}

/** An answer as a prompt carried it: the question it answered, and its words. */
export interface ReadAnswer {
  id: string;
  text: string;
  answer: string;
}

/**
 * Answers the chair has not read yet. Approving over one is refused, here and
 * in the panel: the answer would reach no worker, because the briefings are
 * the chair's, written before it.
 */
export function unreadAnswersOf(plan: Pick<Plan, 'questions'>): number {
  return plan.questions.filter((q) => q.answer !== null && !q.seen).length;
}

/**
 * The answers this turn sends, as one line of yours in the minutes.
 *
 * The chair's next block retires the questions it no longer needs, and the
 * answers went with them: the meeting tab was left with your first message
 * and an empty box, and nothing said the answers had gone anywhere. Kept in
 * the minutes, they are on screen, in a restart, and in the lines a worker
 * gets about its project. The question is shortened, the answer is not.
 */
function answersMinute(plan: Plan): string | null {
  const unread = plan.questions.filter((q) => q.answer !== null && !q.seen);
  if (unread.length === 0) return null;
  const lines = [ANSWERS_MINUTE_PREFIX];
  for (const q of unread) lines.push('', `Q: ${cut(q.text, 200)}`, `A: ${q.answer}`);
  return cut(lines.join('\n'), MAX_MINUTE_CHARS);
}

function unreadReason(n: number): string {
  return `${n} answer${n === 1 ? '' : 's'} the chair has not read yet: send it a message first, `
    + `so the briefings carry ${n === 1 ? 'it' : 'them'}`;
}

let seq = 0;
/** Short and unique: a task id is a prefix of a job id, which must fit `MAX_FIELD_CHARS`. */
function newId(prefix: string, now: number): string {
  seq += 1;
  return `${prefix}-${now.toString(36)}-${seq.toString(36)}`;
}

/** Which depth names exist, for whoever validates a patch. */
export const DEPTH_NAMES: readonly CeoDepth[] = ['fast', 'standard', 'deep'];

const STATUSES = new Set<PlanStatus>(['drafting', 'proposed', 'approved', 'paused', 'done']);
const TASK_STATUSES = new Set<TaskStatus>(['queued', 'running', 'question', 'done', 'failed', 'skipped']);
const SIZES = new Set<TaskSize>(['small', 'medium', 'large']);

export function emptyPlan(now: number, chair: ProviderId): Plan {
  return {
    id: newId('plan', now),
    rev: 0,
    status: 'drafting',
    chair,
    createdAt: now,
    updatedAt: now,
    depth: 'standard',
    todo: '',
    attachments: [],
    minutes: [],
    questions: [],
    ready: false,
    reserve: { claude: { ...DEFAULT_RESERVE }, codex: { ...DEFAULT_RESERVE } },
    parallel: DEFAULT_PARALLEL,
    review: false,
    projects: [],
    commands: {},
    session: null,
    withdrawn: [],
    reserveStops: {},
  };
}

/**
 * The rules a project gets when it enters the plan: commit and push on, by
 * decision of the user -- "push to main" is ticked until you untick it. The
 * rules are yours: the chair's blocks do not touch them. The tests are not a
 * rule: they always run.
 */
export function defaultGit(): GitRules {
  return { commit: true, push: true };
}

/**
 * `push` without `commit` is not a thing: a push ships commits. `web` is kept
 * only when it is on, so a plan that never ticked it is written as before.
 * Anything else in the object goes.
 */
export function normalizeGit(rules: Partial<GitRules> | null | undefined): GitRules {
  const push = rules?.push === true;
  return { commit: push || rules?.commit === true, push, ...(rules?.web === true ? { web: true } : {}) };
}

/** The commands by project, from a file or a patch: valid ones only, and no empty list. */
export function commandsMapOf(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, list] of Object.entries(raw as Record<string, unknown>)) {
    const clean = commandsOf(list);
    if (clean.length > 0) out[id] = clean;
  }
  return out;
}

function withCommands(map: Readonly<Record<string, string[]>>, projectId: string, list: string[]): Record<string, string[]> {
  const out = { ...map };
  if (list.length > 0) out[projectId] = list;
  else delete out[projectId];
  return out;
}

/** What the world says about the plan's projects, read at every send and never stored. */
export interface WorldView {
  branches: Record<string, string | null>;
  active: Record<string, number>;
}

/** The plan as the panel reads it: no session id, no attachment text; branches and sessions from the world. */
export function docOf(plan: Plan, world: WorldView = { branches: {}, active: {} }): PlanDoc {
  const { session: _session, withdrawn: _withdrawn, reserveStops: _stops, attachments, ...rest } = plan;
  void _session;
  void _withdrawn;
  void _stops;
  return {
    ...rest,
    branches: world.branches,
    active: world.active,
    attachments: attachments.map(({ id, name, chars, addedAt, sent }) => ({ id, name, chars, addedAt, sent })),
  };
}

export function countsOf(plan: Plan): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    queued: 0, running: 0, question: 0, done: 0, failed: 0, skipped: 0,
  };
  for (const p of plan.projects) for (const t of p.tasks) counts[t.status] += 1;
  return counts;
}

/** Meeting questions still waiting for you. */
export function openQuestionsOf(plan: Plan): number {
  return plan.questions.filter((q) => q.answer === null).length;
}

export function findTask(plan: Plan, taskId: string): { project: PlanProject; task: PlanTask } | null {
  for (const project of plan.projects) {
    const task = project.tasks.find((t) => t.id === taskId);
    if (task) return { project, task };
  }
  return null;
}

/** Every task has reached an end: the plan is over. */
function allSettled(plan: Plan): boolean {
  let any = false;
  for (const p of plan.projects) {
    for (const t of p.tasks) {
      any = true;
      if (t.status !== 'done' && t.status !== 'skipped') return false;
    }
  }
  return any;
}

function clip(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap) : text;
}

/** An answer over its cap is refused with the number, never cut: its tail is part of the answer. */
function tooLong(chars: number): string {
  return `your answer is ${chars} chars, the cap is ${MAX_ANSWER_CHARS}: say the rest in a message`;
}

/** For text the chair wrote for you to read: a cut that shows it is one. */
function cut(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}

/**
 * A task's effort on its own fleet's scale. A level the fleet does not have
 * -- `max` on a task moved to Codex -- is the default again, never a guess at
 * the nearest one.
 */
function effortOf(provider: ProviderId, effort: Effort | null | undefined): Effort | null {
  if (!effort) return null;
  return effortsFor(provider).includes(effort) ? effort : null;
}

/**
 * The chair's word on effort, which counts for Codex only.
 *
 * For Claude the chair's lever stays the model: an effort on a Claude task
 * is yours to raise, from the panel. A chair free to write `max` on every
 * task would spend the window on a plan you approved at the price of the
 * default.
 */
function chairEffort(provider: ProviderId, effort: Effort | null | undefined): Effort | null {
  return provider === 'codex' ? effortOf(provider, effort) : null;
}

/** A file name as a label: one line, no control characters, never empty. */
function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = name.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  return clip(flat, MAX_ATTACHMENT_NAME_CHARS) || 'attachment';
}

/** Oldest first out: the minutes are a record of the meeting, not of the room. */
function pushMinute(plan: Plan, minute: Minute): Minute[] {
  const next = [...plan.minutes, { ...minute, text: clip(minute.text, MAX_MINUTE_CHARS) }];
  return next.length > MAX_MINUTES ? next.slice(next.length - MAX_MINUTES) : next;
}

function isTask(v: unknown): v is PlanTask {
  const t = v as PlanTask | null;
  return !!t && typeof t.id === 'string' && typeof t.title === 'string'
    && typeof t.briefing === 'string' && TASK_STATUSES.has(t.status)
    && (t.provider === 'claude' || t.provider === 'codex');
}

function isProject(v: unknown): v is PlanProject {
  const p = v as PlanProject | null;
  return !!p && typeof p.projectId === 'string' && typeof p.name === 'string'
    && Array.isArray(p.tasks) && p.tasks.every(isTask);
}

/** The reserve's count as read from disk: positive whole numbers by task id, nothing else. */
function stopsOf(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, n] of Object.entries(raw)) {
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) out[id] = n;
  }
  return out;
}

function isPlan(v: unknown): v is Plan {
  const p = v as Plan | null;
  return !!p && typeof p.id === 'string' && STATUSES.has(p.status)
    && Array.isArray(p.projects) && p.projects.every(isProject)
    && Array.isArray(p.attachments) && Array.isArray(p.minutes);
}

/**
 * The meeting can be held while nothing is approved or while it is paused.
 *
 * In `approved` the meeting is closed: the scheduler is launching what you
 * agreed on, and a chair rewriting tasks under it would make "approved" mean
 * nothing. Pause first; the plan keeps everything.
 */
function meetingOpen(plan: Plan): string | null {
  if (plan.status === 'approved') return 'the plan is approved: pause it to reopen the meeting';
  if (plan.status === 'done') return 'the plan is done: start over to begin a new one';
  return null;
}

/** The store, with the file behind it. */
export function createPlanStore(stateDir: string, opts: PlanStoreOptions): PlanStore {
  const dir = path.join(stateDir, 'ceo');
  const file = path.join(dir, 'plan.json');
  const providers = opts.providers.length > 0 ? opts.providers : (['claude'] as const);
  /** Claude chairs a new meeting when it is here, whatever order `--providers` gave. */
  const firstChair: ProviderId = providers.includes('claude') ? 'claude' : providers[0]!;
  let plan: Plan = emptyPlan(Date.now(), firstChair);
  let dirty = false;

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as PlanFile;
    if (raw && raw.version === VERSION && isPlan(raw.plan)) {
      // A plan written before `sent` existed: none of its files is known to
      // have reached the chair, so the next turn carries them all.
      plan = {
        ...raw.plan,
        attachments: raw.plan.attachments.map((a) => ({ ...a, sent: a.sent === true })),
        questions: raw.plan.questions.map((q) => ({ ...q, seen: q.seen === true })),
        withdrawn: Array.isArray(raw.plan.withdrawn) ? raw.plan.withdrawn : [],
        // A plan written before the count existed: nothing was stopped yet.
        reserveStops: stopsOf(raw.plan.reserveStops),
        // A plan written when the tests were a checkbox: the box goes, the
        // commands start empty, and no task is waiting on a command.
        commands: commandsMapOf(raw.plan.commands),
        projects: raw.plan.projects.map((p) => ({
          ...p,
          git: normalizeGit(p.git),
          tasks: p.tasks.map((t) => ({ ...t, needs: commandsOf(t.needs) })),
        })),
      };
      /*
       * A task found `running` at startup is not running: its process died
       * with the previous server, and its pipes cannot be reattached. It
       * becomes `failed` and not `queued` on purpose -- the orphan may still
       * be alive on that repository, and a relaunch would put two workers on
       * it. The session id is kept: a retry resumes it, so nothing is lost.
       */
      for (const p of plan.projects) {
        p.tasks = p.tasks.map((t) => (t.status !== 'running' ? t : {
          ...t, status: 'failed', reason: STOPPED_BY_RESTART,
        }));
      }
      dirty = true;
    }
  } catch {
    // No plan yet, or an unreadable one: a fresh sheet is the right start.
  }

  const ok = (next: Plan, now: number): PlanResult => {
    plan = { ...next, rev: plan.rev + 1, updatedAt: now };
    dirty = true;
    return { ok: true, plan, reason: '' };
  };
  const no = (reason: string): PlanResult => ({ ok: false, plan, reason });

  /** A change that goes through, plus a line in the minutes about it. */
  const noted = (next: Plan, text: string, now: number): Plan => ({
    ...next, minutes: pushMinute(next, { at: now, role: 'system', text }),
  });

  function patchTask(
    base: Plan, taskId: string, over: Partial<PlanTask>,
  ): Plan {
    return {
      ...base,
      projects: base.projects.map((p) => ({
        ...p,
        tasks: p.tasks.map((t) => (t.id === taskId ? { ...t, ...over } : t)),
      })),
    };
  }

  /** `approved` and nothing left to do is `done`; anything else stays. */
  function settle(base: Plan): Plan {
    if (base.status !== 'approved' || !allSettled(base)) return base;
    return { ...base, status: 'done' };
  }

  function validModel(provider: ProviderId, model: string | null): string | null {
    if (model === null || model === '') return null;
    if (provider === 'claude') {
      return (CLAUDE_MODELS as readonly string[]).includes(model) ? model : null;
    }
    // Codex: your declared model or its own. A guessed name fails the spawn.
    return model === opts.codexModel ? model : null;
  }

  function archive(old: Plan): void {
    const empty = old.projects.length === 0 && old.minutes.length === 0 && old.attachments.length === 0;
    if (empty) return;
    try {
      const plans = path.join(dir, 'plans');
      fs.mkdirSync(plans, { recursive: true, mode: 0o700 });
      const payload: PlanFile = { version: VERSION, plan: old };
      fs.writeFileSync(path.join(plans, `${old.id}.json`), JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    } catch {
      // The archive is a courtesy: losing it must not stop a reset.
    }
  }

  return {
    get: () => plan,

    say(text, now) {
      const closed = meetingOpen(plan);
      if (closed) return no(closed);
      // Refused and not cut: the tail of a to-do list is a to-do too, and a
      // cut nobody sees is a plan made without it.
      const said = text.trim();
      const answers = answersMinute(plan);
      if (!said) {
        // An empty turn is how answers are sent: the panel's "send answers".
        // Without this, answering and pressing send did nothing at all.
        if (!answers) return no('nothing to say');
        return ok({ ...plan, minutes: pushMinute(plan, { at: now, role: 'user', text: answers }) }, now);
      }
      if (said.length > MAX_SAY_CHARS) {
        return no(`your message is ${said.length} chars, the cap for one turn is ${MAX_SAY_CHARS}: attach it as a file`);
      }
      const todo = plan.todo ? `${plan.todo}\n\n${said}` : said;
      if (todo.length > MAX_TODO_CHARS) {
        return no(`the to-do list is full: ${todo.length} chars, the cap is ${MAX_TODO_CHARS}`);
      }
      // Answers first, then what you said: the order you wrote them in.
      const withAnswers = answers
        ? { ...plan, minutes: pushMinute(plan, { at: now, role: 'user', text: answers }) }
        : plan;
      return ok({
        ...withAnswers, todo, minutes: pushMinute(withAnswers, { at: now, role: 'user', text: said }),
      }, now);
    },

    noteCeo(text, now) {
      const said = text.trim();
      if (!said) return;
      ok({ ...plan, minutes: pushMinute(plan, { at: now, role: 'ceo', text: said }) }, now);
    },

    noteSystem(text, now) {
      ok(noted(plan, text, now), now);
    },

    setSession(id) {
      if (plan.session === id) return;
      // A session that is gone took the files with it: the next one gets
      // them all again, and a removal it never saw is not news to it.
      plan = id !== null ? { ...plan, session: id } : {
        ...plan,
        session: null,
        attachments: plan.attachments.map((a) => ({ ...a, sent: false })),
        withdrawn: [],
      };
      dirty = true;
    },

    attach(name, text, now) {
      const closed = meetingOpen(plan);
      if (closed) return no(closed);
      const label = cleanName(name);
      if (text.length > MAX_ATTACHMENT_CHARS) {
        return no(`${label} is too big: ${text.length} chars, the cap is ${MAX_ATTACHMENT_CHARS}`);
      }
      if (text.trim().length === 0) return no(`${label} is empty`);
      // The same name again is the same file, updated: it takes the old one's place.
      const others = plan.attachments.filter((a) => a.name !== label);
      if (others.length >= MAX_ATTACHMENTS) {
        return no(`${MAX_ATTACHMENTS} attachments already: remove one first`);
      }
      const total = others.reduce((sum, a) => sum + a.chars, 0) + text.length;
      if (total > MAX_ATTACHMENTS_TOTAL_CHARS) {
        return no(`attachments would total ${total} chars, the cap is ${MAX_ATTACHMENTS_TOTAL_CHARS}`);
      }
      const added: Attachment = {
        id: newId('a', now), name: label, text, chars: text.length, addedAt: now, sent: false,
      };
      return ok({ ...plan, attachments: [...others, added] }, now);
    },

    detach(id, now) {
      const closed = meetingOpen(plan);
      if (closed) return no(closed);
      const gone = plan.attachments.find((a) => a.id === id);
      if (!gone) return no('no such attachment');
      const attachments = plan.attachments.filter((a) => a.id !== id);
      // Only a file the chair has is news when it goes; one still waiting
      // for your next message simply never leaves.
      const withdrawn = gone.sent && !plan.withdrawn.includes(gone.name)
        ? [...plan.withdrawn, gone.name]
        : plan.withdrawn;
      return ok({ ...plan, attachments, withdrawn }, now);
    },

    readAnswers(read, now) {
      // Matched on question AND words: an answer changed while the chair was
      // answering is not the one it read.
      const hit = (q: MeetingQuestion): boolean => q.answer !== null && !q.seen
        && read.some((r) => r.id === q.id && r.text === q.text && r.answer === q.answer);
      if (!plan.questions.some(hit)) return;
      ok({ ...plan, questions: plan.questions.map((q) => (hit(q) ? { ...q, seen: true } : q)) }, now);
    },

    delivered(ids, withdrawn, now) {
      // By id and by name, as they were when the prompt was written: a file
      // attached while the chair was answering has not reached it yet.
      if (ids.length === 0 && withdrawn.length === 0) return;
      ok({
        ...plan,
        attachments: plan.attachments.map((a) => (ids.includes(a.id) ? { ...a, sent: true } : a)),
        withdrawn: plan.withdrawn.filter((n) => !withdrawn.includes(n)),
      }, now);
    },

    set(patch, now) {
      if (plan.status === 'done' && patch.kind !== 'chair' && patch.kind !== 'depth') {
        return no('the plan is done: start over to begin a new one');
      }
      switch (patch.kind) {
        case 'order': {
          const wanted = patch.order.filter((id, i, arr) => arr.indexOf(id) === i);
          const byId = new Map(plan.projects.map((p) => [p.projectId, p]));
          const first = wanted.map((id) => byId.get(id)).filter((p): p is PlanProject => !!p);
          const rest = plan.projects.filter((p) => !wanted.includes(p.projectId));
          const projects = [...first, ...rest].map((p, i) => ({ ...p, priority: i + 1 }));
          return ok({ ...plan, projects }, now);
        }
        case 'reserve': {
          const percent = Math.round(patch.percent);
          if (!Number.isFinite(percent) || percent < 0 || percent > MAX_RESERVE_PERCENT) {
            return no(`a reserve is between 0 and ${MAX_RESERVE_PERCENT} percent`);
          }
          const mine = plan.reserve[patch.provider] ?? { ...DEFAULT_RESERVE };
          return ok({
            ...plan,
            reserve: { ...plan.reserve, [patch.provider]: { ...mine, [patch.window]: percent } },
          }, now);
        }
        case 'parallel': {
          const n = Math.trunc(patch.parallel);
          if (!Number.isFinite(n) || n < 1 || n > MAX_PARALLEL) {
            return no(`parallel is between 1 and ${MAX_PARALLEL}`);
          }
          return ok({ ...plan, parallel: n }, now);
        }
        case 'review':
          return ok({ ...plan, review: patch.review === true }, now);
        case 'git': {
          const project = plan.projects.find((p) => p.projectId === patch.projectId);
          if (!project) return no('no such project in the plan');
          if (project.tasks.some((t) => t.status === 'running')) {
            return no(`${project.name}: a task is running, its rules change when it ends`);
          }
          const rules = normalizeGit(patch.rules);
          return ok({
            ...plan,
            projects: plan.projects.map((p) => (p === project ? { ...p, git: rules } : p)),
          }, now);
        }
        case 'commands': {
          const project = plan.projects.find((p) => p.projectId === patch.projectId);
          if (!project) return no('no such project in the plan');
          const wanted: unknown[] = Array.isArray(patch.commands) ? patch.commands : [];
          // Refused whole, with the reason: a command you typed that silently
          // vanished would look allowed until a worker was refused it.
          for (const raw of wanted) {
            const why = typeof raw === 'string' ? commandProblem(raw) : 'not a command';
            if (why) return no(`${clip(String(raw).trim(), 60)}: ${why}`);
          }
          const list = [...new Set(wanted.map(commandPattern).filter((c): c is string => c !== null))];
          if (list.length > MAX_PROJECT_COMMANDS) return no(`at most ${MAX_PROJECT_COMMANDS} commands per project`);
          return ok({ ...plan, commands: withCommands(plan.commands, project.projectId, list) }, now);
        }
        case 'task': {
          const found = findTask(plan, patch.taskId);
          if (!found) return no('no such task');
          if (found.task.status !== 'queued') {
            return no(`${found.task.title}: only a queued task can change fleet, model or effort`);
          }
          const provider = patch.provider ?? found.task.provider;
          if (!providers.includes(provider)) return no(`there is no ${provider} CEO here`);
          const model = patch.model === undefined
            ? (provider === found.task.provider ? found.task.model : null)
            : validModel(provider, patch.model);
          const effort = patch.effort === undefined
            ? effortOf(provider, found.task.effort)
            : effortOf(provider, patch.effort);
          return ok(patchTask(plan, patch.taskId, { provider, model, effort, pinned: true }), now);
        }
        case 'question': {
          const closed = meetingOpen(plan);
          if (closed) return no(closed);
          const q = plan.questions.find((x) => x.id === patch.id);
          if (!q) return no('no such question');
          const text = patch.text.trim();
          if (text.length > MAX_ANSWER_CHARS) return no(tooLong(text.length));
          const answer = text || null;
          // The same words again are still read; new words are news to the chair.
          const seen = answer !== null && answer === q.answer && q.seen;
          return ok({
            ...plan,
            questions: plan.questions.map((x) => (x === q ? { ...x, answer, seen } : x)),
          }, now);
        }
        case 'depth':
          if (!DEPTH_NAMES.includes(patch.depth)) return no('no such depth');
          return ok({ ...plan, depth: patch.depth }, now);
        case 'chair':
          if (!providers.includes(patch.chair)) return no(`there is no ${patch.chair} CEO here`);
          // One chair per meeting: once it has spoken, the seat is taken.
          if (plan.session !== null || plan.minutes.length > 0) {
            return no('the meeting has started: start over to change the chair');
          }
          return ok({ ...plan, chair: patch.chair }, now);
        default:
          return no('unknown change');
      }
    },

    applyOutcome(parsed, resolve, now) {
      const closed = meetingOpen(plan);
      if (closed) return no(closed);
      let next: Plan = { ...plan, ready: parsed.ready === true };
      const notes: string[] = [];

      // Questions: the chair's list replaces the old one. An answer survives
      // only with its exact question -- ids like "q1" get reused for new ones.
      const oldQ = new Map(plan.questions.map((q) => [`${q.id}\x00${q.text}`, q]));
      const questions: MeetingQuestion[] = [];
      for (const q of parsed.questions.slice(0, MAX_MEETING_QUESTIONS)) {
        const text = cut(q.text.trim(), MAX_MEETING_QUESTION_CHARS);
        if (!text) continue;
        const id = clip(q.id.trim(), 24) || `q${questions.length + 1}`;
        const old = oldQ.get(`${id}\x00${text}`);
        questions.push({ id, text, answer: old?.answer ?? null, seen: old?.seen ?? false });
      }

      // Projects: resolved by NAME, the only handle the chair has seen. A name
      // that matches nothing is dropped and said, never guessed.
      const byId = new Map(plan.projects.map((p) => [p.projectId, p]));
      // The chair's test commands are added, never removed: what you allowed
      // or typed stays yours, and a command it read once is still true.
      let commands = plan.commands;
      const listed = new Set<string>();
      const built: PlanProject[] = [];
      let total = 0;
      const ordered = [...parsed.projects].sort((a, b) => a.priority - b.priority);
      for (const pp of ordered) {
        if (built.length >= MAX_PROJECTS) { notes.push(`the chair listed more than ${MAX_PROJECTS} projects: the rest were dropped`); break; }
        const hit = resolve(pp.name);
        if (!hit) { notes.push(`the chair named a project that is not here, or that two projects share (rename one in the city): ${clip(pp.name, 40)}`); continue; }
        if (listed.has(hit.projectId)) continue;
        listed.add(hit.projectId);
        const old = byId.get(hit.projectId);
        const oldTasks = new Map((old?.tasks ?? []).map((t) => [t.id, t]));
        // Tasks that already moved keep their place; the chair only writes
        // the ones still waiting.
        const kept = (old?.tasks ?? []).filter((t) => t.status !== 'queued');
        const fresh: PlanTask[] = [];
        for (const pt of pp.tasks) {
          if (kept.length + fresh.length >= MAX_TASKS_PER_PROJECT) { notes.push(`${hit.name}: more than ${MAX_TASKS_PER_PROJECT} tasks, the rest were dropped`); break; }
          if (total >= MAX_PLAN_TASKS) { notes.push(`the plan holds at most ${MAX_PLAN_TASKS} tasks: the rest were dropped`); break; }
          const title = cut(pt.title.trim(), MAX_SUMMARY_CHARS);
          if (!title) continue;
          const briefing = cut(pt.briefing.trim(), MAX_BRIEFING_CHARS);
          let provider = pt.provider;
          if (!providers.includes(provider)) { notes.push(`${title}: no ${provider} CEO here, handed to the chair`); provider = plan.chair; }
          const existing = pt.id ? oldTasks.get(pt.id) : undefined;
          if (existing && existing.status !== 'queued') continue; // already kept above
          const size: TaskSize = SIZES.has(pt.size) ? pt.size : 'medium';
          // A choice you made by hand outlives the chair's next opinion.
          const task: PlanTask = existing
            ? {
                ...existing, title, briefing, size,
                provider: existing.pinned ? existing.provider : provider,
                model: existing.pinned ? existing.model : validModel(provider, pt.model),
                effort: existing.pinned ? existing.effort : chairEffort(provider, pt.effort),
              }
            : {
                id: newId('t', now), title, briefing, provider, size,
                model: validModel(provider, pt.model),
                effort: chairEffort(provider, pt.effort),
                pinned: false, status: 'queued', question: null, answer: null, needs: [], attempts: 0,
                jobId: null, sessionId: null, did: null, learned: null, reason: null,
              };
          fresh.push(task);
          total += 1;
        }
        // The rules you set stay yours: the chair's block rewrote them every
        // turn, and an unticked push came back ticked -- or the other way --
        // without anyone touching the checkbox.
        built.push({
          projectId: hit.projectId, name: hit.name, priority: built.length + 1,
          git: old ? old.git : defaultGit(), tasks: [...kept, ...fresh],
        });
        const merged = mergeCommands(commands[hit.projectId] ?? [], commandsOf(pp.tests));
        if (merged.length > (commands[hit.projectId]?.length ?? 0)) commands = withCommands(commands, hit.projectId, merged);
      }
      // A project the chair left out keeps what already moved and loses what
      // was only waiting; empty, it goes.
      for (const old of plan.projects) {
        if (listed.has(old.projectId)) continue;
        const kept = old.tasks.filter((t) => t.status !== 'queued');
        if (kept.length === 0) continue;
        built.push({ ...old, priority: built.length + 1, tasks: kept });
      }

      next = { ...next, questions, projects: built, commands };
      for (const text of notes) next = noted(next, text, now);
      if (next.status === 'drafting' && built.some((p) => p.tasks.length > 0)) {
        next = { ...next, status: 'proposed' };
      }
      return ok(next, now);
    },

    approve(now) {
      if (plan.status !== 'proposed') return no(`the plan is ${plan.status}: only a proposed plan is approved`);
      if (countsOf(plan).queued === 0) return no('nothing to approve: the plan has no task waiting');
      const unread = unreadAnswersOf(plan);
      if (unread > 0) return no(unreadReason(unread));
      return ok({ ...plan, status: 'approved' }, now);
    },

    pause(now) {
      if (plan.status !== 'approved') return no(`the plan is ${plan.status}: only an approved plan pauses`);
      return ok({ ...plan, status: 'paused' }, now);
    },

    resume(now) {
      if (plan.status !== 'paused') return no(`the plan is ${plan.status}: only a paused plan resumes`);
      // Resuming is approving again: a pause reopens the meeting, and an
      // answer given in it must reach the briefings before anything launches.
      const unread = unreadAnswersOf(plan);
      if (unread > 0) return no(unreadReason(unread));
      return ok(settle({ ...plan, status: 'approved' }), now);
    },

    reset(now) {
      if (countsOf(plan).running > 0) return no('a task is running: wait for it to end');
      archive(plan);
      // A new meeting starts with Claude in the chair, as the first one did:
      // the seat is a choice for each meeting, not a setting that sticks.
      const fresh = emptyPlan(now, firstChair);
      // The commands go with the settings: a permission given once is not
      // asked for again by the next plan.
      return ok({
        ...fresh, depth: plan.depth, reserve: plan.reserve, parallel: plan.parallel, review: plan.review,
        commands: plan.commands,
      }, now);
    },

    answer(taskId, text, now) {
      const found = findTask(plan, taskId);
      if (!found) return no('no such task');
      if (found.task.status !== 'question') return no(`${found.task.title} is not waiting for an answer`);
      const said = text.trim();
      if (!said) return no('the answer is empty');
      if (said.length > MAX_ANSWER_CHARS) return no(tooLong(said.length));
      return ok(patchTask(plan, taskId, { answer: said, status: 'queued', reason: null, needs: [] }), now);
    },

    allow(taskId, now) {
      const found = findTask(plan, taskId);
      if (!found) return no('no such task');
      const { project, task } = found;
      if (task.status !== 'question') return no(`${task.title} is not waiting for an answer`);
      if (task.needs.length === 0) return no(`${task.title} asked for no command`);
      const have = plan.commands[project.projectId] ?? [];
      const merged = mergeCommands(have, task.needs);
      if (task.needs.some((c) => !merged.includes(c))) {
        return no(`${project.name} has ${MAX_PROJECT_COMMANDS} commands already: remove one first`);
      }
      // The answer the resumed session reads: it is told the refusal is over,
      // or it would ask the same question again, as decsim2's worker did.
      const list = task.needs.map((c) => `\`${c}\``).join(', ');
      const answer = cut(`I allowed these commands in this project: ${list}. This session has them now: run them and finish the task.`, MAX_ANSWER_CHARS);
      const next = { ...plan, commands: withCommands(plan.commands, project.projectId, merged) };
      return ok(patchTask(next, taskId, { answer, status: 'queued', reason: null, needs: [] }), now);
    },

    retry(taskId, now) {
      const found = findTask(plan, taskId);
      if (!found) return no('no such task');
      if (found.task.status !== 'failed') return no(`${found.task.title} has not failed`);
      return ok(patchTask(plan, taskId, { status: 'queued', reason: null }), now);
    },

    skip(taskId, now) {
      const found = findTask(plan, taskId);
      if (!found) return no('no such task');
      const s = found.task.status;
      if (s !== 'queued' && s !== 'failed' && s !== 'question') {
        return no(`${found.task.title} is ${s}: it cannot be skipped`);
      }
      return ok(settle(patchTask(plan, taskId, { status: 'skipped', reason: 'skipped by you' })), now);
    },

    launched(taskId, jobId, now) {
      if (plan.status !== 'approved') return no(`the plan is ${plan.status}`);
      const found = findTask(plan, taskId);
      if (!found) return no('no such task');
      if (found.task.status !== 'queued') return no(`${found.task.title} is ${found.task.status}`);
      return ok(patchTask(plan, taskId, {
        status: 'running', attempts: found.task.attempts + 1, jobId, reason: null,
      }), now);
    },

    attachSession(taskId, sessionId, now) {
      const found = findTask(plan, taskId);
      if (!found || found.task.sessionId === sessionId) return;
      ok(patchTask(plan, taskId, { sessionId }), now);
    },

    finished(taskId, report, now) {
      const found = findTask(plan, taskId);
      if (!found) return no('no such task');
      if (found.task.status !== 'running') return no(`${found.task.title} was not running`);
      const question = report.status === 'question' ? cut((report.question ?? '').trim(), MAX_QUESTION_CHARS) : null;
      // The reserve stopped it: once it waits and starts again on its own,
      // `MAX_RESERVE_STOPS` times in a row it is handed to you through the
      // door a failure uses -- its queue stops, retry resumes its session.
      // A pause is not counted either way, and any other ending clears it.
      const byReserve = report.status === 'queued' && report.byReserve === true;
      const stops = byReserve ? (plan.reserveStops[taskId] ?? 0) + 1 : 0;
      const held = stops >= MAX_RESERVE_STOPS;
      const reserveStops = { ...plan.reserveStops };
      if (byReserve && !held) reserveStops[taskId] = stops;
      else if (held || report.status !== 'queued') delete reserveStops[taskId];
      // A question with nothing asked is a worker that stopped without saying
      // why: that is a failure, and calling it a question would wait forever.
      const status: TaskStatus = held || (report.status === 'question' && !question) ? 'failed' : report.status;
      const why = held ? `${report.reason}, ${stops} times in a row: retry resumes it` : report.reason;
      return ok(settle(patchTask({ ...plan, reserveStops }, taskId, {
        status,
        question,
        // An answered question is spent once the attempt that got it ends
        // with something else: a later retry must not replay it.
        answer: status === 'question' ? found.task.answer : null,
        needs: status === 'question' ? commandsOf(report.needs ?? []) : [],
        did: report.did ? cut(report.did.trim(), MAX_SUMMARY_CHARS) : found.task.did,
        learned: report.learned !== null && Number.isFinite(report.learned) && report.learned > 0
          ? report.learned : found.task.learned,
        reason: status === 'failed'
          ? clip(why || (report.status === 'question' ? 'it stopped without asking anything' : 'it failed'), MAX_FIELD_CHARS)
          // Why it is waiting again: the panel says it, and the next attempt's
          // prompt tells the worker it was stopped, not that it failed.
          : status === 'queued' ? clip(report.reason, MAX_FIELD_CHARS) || null
          : null,
      })), now);
    },

    save() {
      if (!dirty) return;
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const payload: PlanFile = { version: VERSION, plan };
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(tmp, file);
        dirty = false;
      } catch {
        // Not being able to save must not stop the tool: the plan lives on in
        // memory until the next attempt.
      }
    },
  };
}
