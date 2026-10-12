import type {
  CeoDepth, DeltaEvent, Effort, PlanDoc, PlanPatch, PlanProject, PlanStall, PlanTask, ProviderId,
  TaskStatus,
} from '../../shared/protocol.ts';
import {
  ANSWERS_MINUTE_PREFIX, CLAUDE_MODELS, HUMAN_GRACE_MS, MAX_ANSWER_CHARS, MAX_ATTACHMENT_CHARS, MAX_ATTACHMENTS, MAX_ATTACHMENTS_TOTAL_CHARS,
  MAX_COMMAND_CHARS, MAX_PROJECT_COMMANDS, MAX_SAY_CHARS, MAX_TODO_CHARS,
} from '../../shared/protocol.ts';
import { PROVIDER_COLOR } from '../world/palette.ts';
import { CLOSE_ICON, iconButton } from './icons.ts';
import { renderMarkdown } from './markdown.ts';
import { twoClicks } from './twoClicks.ts';

/**
 * Planning: the meeting with the chair, and the plan that comes out of it.
 *
 * Two views on one document. In Meeting you talk: to-dos, attachments, the
 * chair's questions and your answers. In Plan you decide: order, fleet and
 * model per task, what a worker may run, the reserve, and the yes. The
 * document is pulled from the server (`plan.read`) and never edited here:
 * every control sends one change, and what comes back is the plan as the
 * server now holds it, with the reason when a change was not legal.
 */

const LABEL: Record<ProviderId, string> = { claude: 'CLAUDE CEO', codex: 'CODEX CEO' };

const STATUS_TEXT: Record<PlanDoc['status'], string> = {
  drafting: 'drafting',
  proposed: 'proposed',
  approved: 'approved',
  paused: 'paused',
  done: 'done',
};

const TASK_TEXT: Record<TaskStatus, string> = {
  queued: 'queued',
  running: 'running',
  question: 'asks you',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
};

const DEPTHS: readonly { kind: CeoDepth; label: string; hint: string }[] = [
  { kind: 'fast', label: 'fast', hint: 'haiku, or low effort' },
  { kind: 'standard', label: 'standard', hint: 'your default model, medium effort' },
  { kind: 'deep', label: 'deep', hint: 'opus, or high effort' },
];

const SIZES: readonly PlanTask['size'][] = ['small', 'medium', 'large'];
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];

type PlanEvent = Extract<DeltaEvent, { t: 'plan' }>;

export interface PlanningActions {
  onSay: (text: string) => void;
  onAttach: (name: string, text: string) => void;
  onDetach: (id: string) => void;
  onSet: (patch: PlanPatch) => void;
  onApprove: () => void;
  onPause: () => void;
  onResume: () => void;
  onLaunch: () => void;
  onAnswer: (taskId: string, text: string) => void;
  /** Allow the commands a worker stopped for, and resume it. */
  onAllow: (taskId: string) => void;
  onRetry: (taskId: string) => void;
  onSkip: (taskId: string) => void;
  onRead: () => void;
  onReset: () => void;
  /** Read how an attempt went, in Reports. */
  onOpenJob: (jobId: string) => void;
  /** Open a window with everything the attempt's session did. The answer comes through `reportJob`. */
  onWatchJob: (jobId: string) => void;
}

/* ───────────────────────── pure helpers, tested without a DOM ───────────────────────── */

/**
 * Whether a file can be attached, before reading it.
 *
 * The same caps the server applies, checked first: a refusal on the wire
 * would come back with nothing to show for a file already read. `chars` is
 * the file size in bytes, which is never below its character count.
 */
export function attachmentBudget(
  existing: readonly { name: string; chars: number }[],
  name: string,
  chars: number,
): { ok: boolean; reason: string | null } {
  if (chars > MAX_ATTACHMENT_CHARS) {
    return { ok: false, reason: `${name} is too big: ${chars} chars, the cap is ${MAX_ATTACHMENT_CHARS}` };
  }
  // The same name replaces the old file: it does not count twice.
  const others = existing.filter((a) => a.name !== name);
  if (others.length >= MAX_ATTACHMENTS) {
    return { ok: false, reason: `${MAX_ATTACHMENTS} attachments already: remove one first` };
  }
  const total = others.reduce((sum, a) => sum + a.chars, 0) + chars;
  if (total > MAX_ATTACHMENTS_TOTAL_CHARS) {
    return { ok: false, reason: `attachments would total ${total} chars, the cap is ${MAX_ATTACHMENTS_TOTAL_CHARS}` };
  }
  return { ok: true, reason: null };
}

/**
 * The count under the text box, and whether the message may be sent.
 *
 * The server refuses a turn over its cap, and every turn is also appended to
 * the to-dos, which have a cap of their own: the room is the smaller of the
 * two. Counted here first, the way out -- attach it as a file -- is on screen
 * before you press send, and the text is still in the box.
 */
export function sayMeter(text: string, todo: string): { label: string; over: boolean; near: boolean } {
  const room = Math.max(0, Math.min(MAX_SAY_CHARS, MAX_TODO_CHARS - (todo ? todo.length + 2 : 0)));
  const n = text.trim().length;
  const over = n > room;
  const label = `${n.toLocaleString('en-US')} / ${room.toLocaleString('en-US')}`;
  return {
    label: over ? `${label} · too long for one message: attach it as a file` : label,
    over,
    near: !over && n > room * 0.9,
  };
}

/**
 * The git checkboxes of a project, as the panel shows them. `null` when the
 * project is not under git: no commit and no push, and the panel says so.
 * The push names the branch it goes to -- "push to main" -- because a push
 * goes to the branch the repository is on, and a label that said main over
 * another branch would promise the wrong thing. There is no "tests" box: the
 * tests always run (decision of the user, 2026-09-19).
 */
export function gitBoxes(branch: string | null): { key: 'commit' | 'push'; label: string }[] | null {
  if (branch === null) return null;
  return [
    { key: 'commit', label: 'commit' },
    { key: 'push', label: `push to ${branch}` },
  ];
}

/**
 * The HUD's warning for a stalled plan: what it says and how loud it is.
 * `null` hides it. The text is the server's (`stallOf`): one rule, read here.
 */
export function stallWarning(stall: PlanStall | null): { level: 'you' | 'wait'; text: string; hint: string } | null {
  if (!stall) return null;
  return stall.needsYou
    ? { level: 'you', text: stall.text, hint: 'The plan is blocked until you act: open Planning.' }
    : { level: 'wait', text: stall.text, hint: 'The plan is waiting and nothing runs: open Planning to see why.' };
}

/** Who sits in the chair: the plan's choice, or Claude before the plan arrives. */
export function seatedChair(chair: ProviderId | null, providers: readonly ProviderId[]): ProviderId | null {
  if (chair && providers.includes(chair)) return chair;
  if (providers.includes('claude')) return 'claude';
  return providers[0] ?? null;
}

/**
 * The send button: what it says, whether it can be pressed, and the hint
 * under an empty box. An empty box with answers the chair has not read sends
 * them; an empty box with nothing to send is disabled, not a button that
 * does nothing.
 */
export function sendState(
  text: string, unread: number, busy: boolean, over: boolean,
): { label: string; enabled: boolean; hint: string } {
  // No ellipsis in the label: the stylesheet writes the dots, one at a time.
  if (busy) return { label: 'thinking', enabled: false, hint: 'the chair is answering' };
  const empty = text.trim() === '';
  if (empty && unread > 0) {
    return { label: 'send answers', enabled: true, hint: `${unread} answer${unread === 1 ? '' : 's'} ready: send them, or add a message` };
  }
  return { label: 'send', enabled: !empty && !over, hint: 'ctrl/cmd + enter sends' };
}

/** The count under an answer: the server refuses one over the cap, it does not cut it. */
export function answerMeter(text: string): { label: string; over: boolean } {
  const n = text.trim().length;
  const over = n > MAX_ANSWER_CHARS;
  const label = `${n.toLocaleString('en-US')} / ${MAX_ANSWER_CHARS.toLocaleString('en-US')}`;
  return { label: over ? `${label} · too long: say the rest in a message` : label, over };
}

/**
 * The text a box shows after a redraw: what you were writing, if you were.
 *
 * Every change to the plan redraws the panel, and saving one answer is a
 * change: a second answer being written in the next box vanished with it.
 * The draft goes once the plan holds exactly those words.
 */
export function draftShown(draft: string | undefined, saved: string | null): { text: string; keep: boolean } {
  if (draft === undefined) return { text: saved ?? '', keep: false };
  if (draft.trim() === (saved ?? '')) return { text: saved ?? '', keep: false };
  return { text: draft, keep: true };
}

/**
 * The plan tab's name: what you go there to do. "approve plan" while the
 * plan waits for your yes (or, paused, for it again); "plan" once it runs.
 */
export function planTabLabel(status: PlanDoc['status']): string {
  return status === 'approved' || status === 'done' ? 'plan' : 'approve plan';
}

/**
 * The line at the end of the meeting that says what happens next, or null.
 *
 * After you answered, the chair's block retired the questions and the tab
 * showed your first message and an empty box: nothing said the answers had
 * arrived, or where to go now. Shown only when the plan waits for you and
 * nothing in the meeting does -- no open question, no answer unsent.
 */
export function meetingNext(
  doc: Pick<PlanDoc, 'status' | 'questions' | 'projects' | 'minutes'>, busy: boolean,
): string | null {
  if (busy || doc.status !== 'proposed') return null;
  if (doc.questions.some((q) => q.answer === null) || unreadAnswers(doc) > 0) return null;
  if (!doc.projects.some((p) => p.tasks.some((t) => t.status === 'queued'))) return null;
  // The turn the chair last answered: your lines between its previous answer and that one.
  let i = doc.minutes.length - 1;
  while (i >= 0 && doc.minutes[i]!.role !== 'ceo') i -= 1;
  let sent = false;
  for (let j = i - 1; j >= 0 && doc.minutes[j]!.role !== 'ceo'; j -= 1) {
    const m = doc.minutes[j]!;
    if (m.role === 'user' && m.text.startsWith(ANSWERS_MINUTE_PREFIX)) sent = true;
  }
  return sent
    ? 'Your answers were sent to the chair, and it has updated the plan.'
    : 'The chair has laid the plan on the table.';
}

/**
 * The warning before you approve: projects of the plan where a session of
 * yours is active, by the scheduler's own rule. A worker does not start
 * there until it has been quiet for five minutes; stopping those sessions
 * first is what lets the plan start where you expect it to.
 */
export function activeWarning(
  doc: Pick<PlanDoc, 'status' | 'projects' | 'active'>,
): string | null {
  if (doc.status !== 'proposed' && doc.status !== 'paused') return null;
  const held = doc.projects
    .filter((p) => (doc.active[p.projectId] ?? 0) > 0 && p.tasks.some((t) => t.status === 'queued'))
    .map((p) => `${p.name} (${doc.active[p.projectId]})`);
  if (held.length === 0) return null;
  const minutes = Math.round(HUMAN_GRACE_MS / 60_000);
  return `Sessions of yours are active in ${held.join(', ')}. Stop them before you approve: `
    + `no worker starts in a project where a session of yours is working, waiting, or moved in the last ${minutes} minutes.`;
}

/** What happened to an attachment, beside its name. */
export function attachmentLine(a: { name: string; chars: number; sent: boolean }): string {
  const where = a.sent ? 'sent to the chair' : 'goes with your next message';
  return `${a.name} · ${a.chars.toLocaleString('en-US')} chars · ${where}`;
}

/** Fleet, model and size of a task in one breath: "claude · opus · large". */
export function taskLabel(t: Pick<PlanTask, 'provider' | 'model' | 'effort' | 'size'>): string {
  const bits: string[] = [t.provider];
  if (t.provider === 'codex') bits.push(t.model ?? 'default model', `${t.effort ?? 'medium'} effort`);
  else bits.push(t.model ?? 'default model');
  bits.push(t.size);
  return bits.join(' · ');
}

/** The model choices for a fleet, as the select shows them. */
export function modelOptions(provider: ProviderId): { value: string | null; label: string }[] {
  if (provider === 'codex') return [{ value: null, label: 'default model' }];
  return [{ value: null, label: 'default model' }, ...CLAUDE_MODELS.map((m) => ({ value: m, label: m }))];
}

/** Answers the chair has not read: they are in no briefing yet. The server counts them the same way. */
export function unreadAnswers(doc: Pick<PlanDoc, 'questions'>): number {
  return doc.questions.filter((q) => q.answer !== null && !q.seen).length;
}

/** Why approving (or resuming) is locked, or null when it is not. */
export function unreadReason(doc: Pick<PlanDoc, 'questions'>): string | null {
  const n = unreadAnswers(doc);
  if (n === 0) return null;
  return `${n} answer${n === 1 ? '' : 's'} the chair has not read yet: send it a message first`;
}

/**
 * Can this plan be approved, and what the button should say.
 *
 * Advisory: the chair's `ready` is its opinion, and an open question is a
 * fact. Both are shown; neither locks the button, because the decision is
 * yours and a chair that could veto it would be a chair you cannot overrule.
 *
 * One thing locks it (`blocked`), by decision of the user: an answer the
 * chair has not read. It reaches the workers only through the briefings the
 * chair rewrites, so approving over it launches briefings written without it
 * -- that is not overruling the chair, it is losing your own answer.
 */
export function readinessOf(
  doc: Pick<PlanDoc, 'status' | 'ready' | 'questions' | 'projects'>,
): { ready: boolean; blocked: boolean; why: string } {
  const open = doc.questions.filter((q) => q.answer === null).length;
  const queued = doc.projects.reduce((n, p) => n + p.tasks.filter((t) => t.status === 'queued').length, 0);
  if (doc.status !== 'proposed') return { ready: false, blocked: false, why: `the plan is ${doc.status}` };
  if (queued === 0) return { ready: false, blocked: false, why: 'no task is waiting' };
  const unread = unreadReason(doc);
  if (unread) return { ready: false, blocked: true, why: unread };
  if (open > 0) return { ready: false, blocked: false, why: `${open} question${open === 1 ? '' : 's'} still open` };
  if (!doc.ready) return { ready: false, blocked: false, why: 'the chair does not call it ready yet' };
  return { ready: true, blocked: false, why: 'the chair calls it ready' };
}

/** "3 queued · 1 running · 2 done": only the counts that are not zero. */
export function countsLine(counts: Record<TaskStatus, number>): string {
  const order: TaskStatus[] = ['running', 'question', 'queued', 'done', 'failed', 'skipped'];
  const bits = order.filter((k) => counts[k] > 0).map((k) => `${counts[k]} ${TASK_TEXT[k]}`);
  return bits.length > 0 ? bits.join(' · ') : 'no task yet';
}

/** Move one id a step up or down, keeping everyone else where they were. */
export function orderAfterMove(order: readonly string[], id: string, dir: -1 | 1): string[] {
  const i = order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return [...order];
  const out = [...order];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/**
 * Whether a plan still has work in it, for the mark beside the Planning glyph.
 *
 * `running` while a task runs; `pending` while tasks wait -- queued, failed,
 * asking you -- even paused, because a paused plan is not a finished one;
 * `null` when there is nothing left: done, or no task yet. The label is the
 * glyph's tooltip, so it says the numbers the mark stands for.
 */
export function workLeft(ev: Pick<PlanEvent, 'status' | 'counts'>): { state: 'running' | 'pending'; label: string } | null {
  if (ev.status === 'done') return null;
  const c = ev.counts;
  const waiting = c.queued + c.failed + c.question;
  if (c.running + waiting === 0) return null;
  const bits: string[] = [];
  if (c.running > 0) bits.push(`${c.running} running`);
  if (waiting > 0) bits.push(`${waiting} to do`);
  if (ev.status === 'paused') bits.push('paused');
  return { state: c.running > 0 ? 'running' : 'pending', label: `Planning \u2014 ${bits.join(', ')}` };
}

/** Why nothing is launching, in the words the panel shows under the actions. */
export function nextReason(ev: Pick<PlanEvent, 'status' | 'next' | 'counts'>): string {
  if (ev.next) return ev.next;
  if (ev.status === 'approved') return ev.counts.running > 0 ? 'working' : 'waiting for the next tick';
  if (ev.status === 'paused') return 'paused: running tasks were stopped and nothing launches until you resume';
  if (ev.status === 'done') return 'every task is done or skipped';
  return 'approve the plan to start';
}

/* ───────────────────────── the panel ───────────────────────── */

export class Planning {
  #root: HTMLElement;
  #act: PlanningActions;
  #open = false;
  #enabled = false;
  #providers: readonly ProviderId[] = [];
  #doc: PlanDoc | null = null;
  #rev = -1;
  #last: PlanEvent | null = null;

  #tabs: Record<'meeting' | 'plan', HTMLButtonElement>;
  #views: Record<'meeting' | 'plan', HTMLElement>;
  #chip: HTMLElement;
  #count: HTMLElement;
  /** The mark beside the glyph: a plan still running, or with tasks left to do. */
  #todo: HTMLElement;
  #button: HTMLElement;
  /** The HUD's warning: the plan stopped and says why. Absent in a page without it. */
  #alert: HTMLElement | null;

  #seat: HTMLElement;
  #depths: HTMLElement;
  #minutes: HTMLElement;
  #answer: HTMLElement;
  #questions: HTMLElement;
  #nextStep: HTMLElement;
  #files: HTMLElement;
  #input: HTMLTextAreaElement;
  #send: HTMLButtonElement;
  #attach: HTMLButtonElement;
  #picker: HTMLInputElement;
  #meter: HTMLElement;
  /** Answers being written, by box: they outlive the redraw a change causes. */
  #drafts = new Map<string, string>();
  /** The log button of each attempt, by job id: where `reportJob` writes the answer. Remade at every render. */
  #logButtons = new Map<string, HTMLButtonElement>();
  #note: HTMLElement;
  #buffer = '';
  /** The chair is answering. Not `#send.disabled`: a message over the cap disables it too. */
  #busy = false;

  #settings: HTMLElement;
  #projects: HTMLElement;
  #actions: HTMLElement;
  #next: HTMLElement;

  constructor(host: HTMLElement, button: HTMLElement, act: PlanningActions, alert: HTMLElement | null = null) {
    this.#act = act;
    this.#alert = alert;
    // A click on the warning lands where it can be acted on: the plan.
    alert?.addEventListener('click', () => this.openTask());

    this.#root = document.createElement('aside');
    this.#root.className = 'planning';
    this.#root.hidden = true;
    this.#root.setAttribute('aria-label', 'Planning');

    this.#button = button;
    // The mark beside the glyph: work still in the plan, running or waiting.
    // Before the counter, which is about you: the mark is about the plan.
    this.#todo = document.createElement('span');
    this.#todo.className = 'planning__todo';
    this.#todo.hidden = true;
    button.appendChild(this.#todo);

    // The counter beside the glyph: questions waiting for you, meeting or task.
    this.#count = document.createElement('span');
    this.#count.className = 'planning__count';
    this.#count.hidden = true;
    button.appendChild(this.#count);

    const top = document.createElement('header');
    top.className = 'planning__top';
    const title = document.createElement('span');
    title.className = 'planning__title';
    title.textContent = 'PLANNING';
    const tabs = document.createElement('nav');
    tabs.className = 'planning__tabs';
    const tab = (name: 'meeting' | 'plan'): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'planning__tab';
      b.textContent = name;
      b.addEventListener('click', () => this.#show(name));
      tabs.appendChild(b);
      return b;
    };
    this.#tabs = { meeting: tab('meeting'), plan: tab('plan') };
    this.#tabs.plan.textContent = planTabLabel('drafting');
    this.#chip = document.createElement('span');
    this.#chip.className = 'planning__chip';
    top.append(title, tabs, this.#chip);

    /* ── meeting ── */
    const meeting = document.createElement('section');
    meeting.className = 'planning__meeting';

    this.#seat = document.createElement('div');
    this.#seat.className = 'planning__seat';
    this.#depths = document.createElement('div');
    this.#depths.className = 'planning__depths';
    for (const d of DEPTHS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'planning__depth';
      b.textContent = d.label;
      b.title = d.hint;
      b.dataset['kind'] = d.kind;
      b.addEventListener('click', () => this.#act.onSet({ kind: 'depth', depth: d.kind }));
      this.#depths.appendChild(b);
    }

    this.#minutes = document.createElement('div');
    this.#minutes.className = 'planning__minutes';
    this.#answer = document.createElement('div');
    this.#answer.className = 'planning__answer';
    this.#questions = document.createElement('div');
    this.#questions.className = 'planning__questions';
    this.#files = document.createElement('div');
    this.#files.className = 'planning__files';
    this.#nextStep = document.createElement('div');
    this.#nextStep.className = 'planning__nextstep';
    this.#nextStep.hidden = true;

    this.#input = document.createElement('textarea');
    this.#input.className = 'planning__input';
    this.#input.id = 'planning-input';
    this.#input.rows = 8;
    this.#input.spellcheck = false;
    this.#input.placeholder = 'to-dos per project, which project comes first, what must stay free';
    this.#meter = document.createElement('span');
    this.#meter.className = 'planning__meter';
    this.#input.addEventListener('input', () => this.#fit());

    this.#attach = document.createElement('button');
    this.#attach.type = 'button';
    this.#attach.className = 'planning__btn';
    this.#attach.textContent = 'attach';
    this.#picker = document.createElement('input');
    this.#picker.type = 'file';
    this.#picker.multiple = true;
    this.#picker.accept = '.md,.txt,.json,.yaml,.yml,.csv,text/*';
    this.#picker.hidden = true;
    this.#attach.addEventListener('click', () => this.#picker.click());
    this.#picker.addEventListener('change', () => {
      for (const f of [...(this.#picker.files ?? [])]) this.#readFile(f);
      this.#picker.value = '';
    });

    this.#send = document.createElement('button');
    this.#send.type = 'button';
    this.#send.className = 'planning__btn planning__btn--main';
    this.#send.textContent = 'send';
    const submit = (): void => {
      const text = this.#input.value.trim();
      // `sendState` decided it: an empty box sends the answers the chair has
      // not read, and with nothing to send the button is off. Before, an
      // empty box after answering made send do nothing, and say nothing.
      if (this.#send.disabled) return;
      this.#input.value = '';
      this.#fit();
      this.#buffer = '';
      this.#answer.textContent = '';
      this.#answer.classList.add('is-waiting');
      this.#setBusy(true);
      this.#act.onSay(text);
    };
    this.#send.addEventListener('click', submit);
    this.#input.addEventListener('keydown', (e) => {
      // Ctrl/Cmd+Enter sends: a turn of a meeting is paragraphs, not a line.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    });

    // The box takes the whole width and the buttons go under it: beside
    // them it was a slot of six short lines for a to-do list of pages.
    const row = document.createElement('div');
    row.className = 'planning__compose';
    const bar = document.createElement('div');
    bar.className = 'planning__bar';
    bar.append(this.#meter, this.#attach, this.#send);
    row.append(this.#input, bar);

    const foot = document.createElement('div');
    foot.className = 'planning__foot';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'planning__btn planning__btn--quiet planning__restart';
    reset.title = 'Erase the whole meeting and start from zero: minutes, to-dos, attachments, '
      + 'questions and the plan. Works while the chair is answering: it stops it. '
      + 'The old plan is archived on disk.';
    twoClicks(reset, 'start over', 'erase everything? click again', () => this.#act.onReset());
    this.#note = document.createElement('span');
    this.#note.className = 'planning__note';
    foot.append(this.#note, reset);

    meeting.append(
      this.#seat, this.#depths, this.#minutes, this.#answer, this.#questions, this.#nextStep,
      this.#files, row, this.#picker, foot,
    );

    /* ── plan ── */
    const plan = document.createElement('section');
    plan.className = 'planning__planview';
    plan.hidden = true;
    this.#settings = document.createElement('div');
    this.#settings.className = 'planning__settings';
    this.#projects = document.createElement('div');
    this.#projects.className = 'planning__projects';
    this.#actions = document.createElement('div');
    this.#actions.className = 'planning__actions';
    this.#next = document.createElement('p');
    this.#next.className = 'planning__next';
    plan.append(this.#settings, this.#projects, this.#actions, this.#next);

    this.#views = { meeting, plan };
    this.#root.append(top, meeting, plan);

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
    this.#root.addEventListener('click', (e) => e.stopPropagation());
    window.addEventListener('pointerdown', (e) => {
      if (!this.#open) return;
      const t = e.target;
      if (t instanceof Node && (this.#root.contains(t) || button.contains(t))) return;
      this.close();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.#open) this.close();
    });

    host.appendChild(this.#root);
    this.#show('meeting');
    this.#fit();
  }

  /** Who can chair, from the caps: the seats exist before any event arrives. */
  setProviders(providers: readonly ProviderId[]): void {
    this.#providers = providers;
    this.#enabled = providers.length > 0;
    this.#renderSeat();
    if (!this.#enabled) this.close();
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  toggle(): void {
    if (this.#open) this.close();
    else this.open();
  }

  /**
   * `focus` false leaves the cursor where it is: the desk inside the ship
   * opens this panel as you walk up to it, holding a key, and the box you
   * write to the chair in would take that key's repeats as typing.
   */
  open(focus = true): void {
    if (!this.#enabled) return;
    const wasOpen = this.#open;
    this.#open = true;
    this.#root.hidden = false;
    // The document is pulled on opening: it is the only moment a stale copy
    // could show, and a pull costs nothing.
    this.#act.onRead();
    if (!wasOpen) {
      this.#fit();
      if (focus) this.#input.focus();
    }
  }

  close(): void {
    this.#open = false;
    this.#root.hidden = true;
  }

  /** Open on the plan view, at a task: the badge of a job that asks something lands here. */
  openTask(): void {
    this.open();
    this.#show('plan');
  }

  /**
   * The plan changed somewhere. Counts and status arrive with the event; the
   * text is pulled only when the revision moved and the panel is open.
   */
  setPlan(ev: PlanEvent): void {
    this.#last = ev;
    this.#chip.textContent = STATUS_TEXT[ev.status];
    this.#chip.dataset['status'] = ev.status;
    const attention = ev.questions + ev.asks;
    this.#count.textContent = String(attention);
    this.#count.hidden = attention === 0;
    const left = workLeft(ev);
    this.#todo.hidden = left === null;
    if (left) this.#todo.dataset['state'] = left.state;
    // The glyph's tooltip is its aria-label: the numbers go where the eye is.
    this.#button.setAttribute('aria-label', left?.label ?? 'Planning');
    this.#next.textContent = nextReason(ev);
    const warn = stallWarning(ev.stall);
    this.#next.dataset['stall'] = warn?.level ?? '';
    if (this.#alert) {
      this.#alert.hidden = warn === null;
      if (warn) {
        this.#alert.dataset['level'] = warn.level;
        this.#alert.textContent = warn.text;
        this.#alert.title = warn.hint;
      }
    }
    this.#tabs.plan.textContent = planTabLabel(ev.status);
    this.#setBusy(ev.meeting === 'thinking');
    if (ev.rev !== this.#rev && this.#open) this.#act.onRead();
  }

  /** The document, as the server holds it now. */
  /**
   * What came of a click on an attempt's log button: the button says it, for
   * a moment. The window opening is the real answer; this is for when it did
   * not, and the reason goes on the button you pressed.
   */
  reportJob(jobId: string, ok: boolean, reason: string | null): void {
    const b = this.#logButtons.get(jobId);
    if (!b) return;
    b.dataset['state'] = ok ? 'ok' : 'fail';
    const title = b.dataset['title'] ?? '';
    b.title = !ok && reason ? reason : title;
    setTimeout(() => {
      delete b.dataset['state'];
      b.title = title;
    }, 1800);
  }

  setDoc(doc: PlanDoc, refused: string | null): void {
    // A new plan is a new meeting: the answer of the old one goes with it.
    if (this.#doc && this.#doc.id !== doc.id) {
      this.#buffer = '';
      this.#answer.textContent = '';
      this.#answer.classList.remove('is-waiting');
    }
    this.#doc = doc;
    this.#rev = doc.rev;
    // Once the chair's answer is in the minutes it is read there: the
    // streamed copy above them would show the same text twice.
    if (!this.#busy && doc.minutes.at(-1)?.role === 'ceo') {
      this.#buffer = '';
      this.#answer.textContent = '';
    }
    this.#note.textContent = refused ?? '';
    this.#note.hidden = !refused;
    this.#chip.textContent = STATUS_TEXT[doc.status];
    this.#chip.dataset['status'] = doc.status;
    this.#tabs.plan.textContent = planTabLabel(doc.status);
    this.#renderSeat();
    // The redraw replaces every box: whoever was typing keeps the caret.
    const active = document.activeElement;
    const field = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? active : null;
    const key = field?.dataset['draft'];
    const caret = key && field ? [field.selectionStart ?? 0, field.selectionEnd ?? 0] as const : null;
    this.#renderMeeting(doc);
    this.#renderNextStep(doc);
    this.#renderPlan(doc);
    if (key && caret) {
      const again = this.#root.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[data-draft="${CSS.escape(key)}"]`);
      if (again) {
        again.focus();
        again.setSelectionRange(caret[0], caret[1]);
      }
    }
    this.#fit();
    this.#growAnswers();
  }

  /** A piece of the chair's answer. */
  stream(delta: string, done: boolean): void {
    if (delta) {
      this.#buffer += delta;
      renderMarkdown(this.#answer, this.#buffer);
      this.#answer.classList.remove('is-waiting');
      this.#answer.scrollTop = this.#answer.scrollHeight;
    }
    if (done) {
      this.#answer.classList.remove('is-waiting');
      if (!this.#buffer) this.#answer.textContent = 'No answer.';
      this.#setBusy(false);
    }
  }

  #show(name: 'meeting' | 'plan'): void {
    for (const k of ['meeting', 'plan'] as const) {
      this.#tabs[k].dataset['on'] = String(k === name);
      this.#views[k].hidden = k !== name;
    }
    this.#growAnswers();
    // The minutes scroll to the end only while they are on screen: drawn on
    // the other tab they stayed at the top, and the meeting showed your
    // first message as if nothing had come after it.
    if (name === 'meeting') this.#minutes.scrollTop = this.#minutes.scrollHeight;
    // Sessions come and go without the plan changing: the warning before the
    // yes is read fresh when you go there.
    if (name === 'plan' && this.#open) this.#act.onRead();
  }

  /** The line that says what happens next in the meeting, with the way to the plan. */
  #renderNextStep(doc: PlanDoc): void {
    const text = meetingNext(doc, this.#busy);
    this.#nextStep.replaceChildren();
    this.#nextStep.hidden = text === null;
    if (text === null) return;
    const p = document.createElement('span');
    p.textContent = text;
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'planning__link';
    go.textContent = `${planTabLabel(doc.status)} →`;
    go.addEventListener('click', () => this.#show('plan'));
    this.#nextStep.append(p, go);
  }

  /** An answer box as tall as its text, up to 40% of the window; a hidden one is left alone. */
  #grow(box: HTMLTextAreaElement): void {
    if (box.offsetParent === null) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight + 2, Math.round(window.innerHeight * 0.4))}px`;
  }

  #growAnswers(): void {
    for (const box of this.#root.querySelectorAll<HTMLTextAreaElement>('textarea[data-draft]')) this.#grow(box);
  }

  /**
   * An answer: a box as wide as the panel that grows with the text, the
   * count, and the button. Ctrl/Cmd+Enter saves, Enter is a new line: an
   * answer to a question about a design is paragraphs, not a field.
   */
  #answerField(
    key: string, saved: string | null, placeholder: string, label: string,
    save: (text: string) => void, main = false,
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'planning__answerfield';
    const area = document.createElement('textarea');
    area.className = 'planning__qinput';
    area.rows = 3;
    area.spellcheck = false;
    area.placeholder = placeholder;
    area.dataset['draft'] = key;
    const shown = draftShown(this.#drafts.get(key), saved);
    if (!shown.keep) this.#drafts.delete(key);
    area.value = shown.text;
    const bar = document.createElement('div');
    bar.className = 'planning__qbar';
    const meter = document.createElement('span');
    meter.className = 'planning__meter';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = main ? 'planning__btn planning__btn--main' : 'planning__btn';
    b.textContent = label;
    const sync = (): void => {
      const m = answerMeter(area.value);
      meter.textContent = area.value.trim() ? m.label : 'ctrl/cmd + enter saves';
      meter.dataset['state'] = m.over ? 'over' : '';
      b.disabled = m.over || (main && !area.value.trim());
    };
    const go = (): void => {
      if (!b.disabled) save(area.value);
    };
    area.addEventListener('input', () => {
      this.#drafts.set(key, area.value);
      this.#grow(area);
      sync();
    });
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        go();
      }
    });
    b.addEventListener('click', go);
    sync();
    bar.append(meter, b);
    wrap.append(area, bar);
    return wrap;
  }

  #setBusy(busy: boolean): void {
    this.#busy = busy;
    this.#fit();
    if (this.#doc) this.#renderNextStep(this.#doc);
  }

  /**
   * The box grows with the text up to half the window, then scrolls; the
   * meter follows the text, and send waits for a message that fits.
   */
  #fit(): void {
    const box = this.#input;
    if (!this.#root.hidden) {
      box.style.height = 'auto';
      box.style.height = `${Math.min(box.scrollHeight + 2, Math.round(window.innerHeight * 0.5))}px`;
    }
    const m = sayMeter(box.value, this.#doc?.todo ?? '');
    const s = sendState(box.value, this.#doc ? unreadAnswers(this.#doc) : 0, this.#busy, m.over);
    // While the chair answers, that is the one thing the line says.
    this.#meter.textContent = this.#busy || !box.value.trim() ? s.hint : m.label;
    this.#meter.dataset['state'] = this.#busy ? 'busy' : m.over ? 'over' : m.near ? 'near' : '';
    this.#send.textContent = s.label;
    this.#send.disabled = !s.enabled;
    this.#send.dataset['busy'] = String(this.#busy);
  }

  #readFile(f: File): void {
    const budget = attachmentBudget(this.#doc?.attachments ?? [], f.name, f.size);
    if (!budget.ok) {
      this.#note.textContent = budget.reason ?? '';
      this.#note.hidden = false;
      return;
    }
    const reader = new FileReader();
    reader.onload = () => this.#act.onAttach(f.name, String(reader.result ?? ''));
    reader.onerror = () => {
      this.#note.textContent = `${f.name} could not be read`;
      this.#note.hidden = false;
    };
    reader.readAsText(f);
  }

  #renderSeat(): void {
    const doc = this.#doc;
    // One chair, chosen before the first word: after that the seat is taken.
    const taken = doc !== null && doc.minutes.length > 0;
    this.#seat.replaceChildren();
    const lab = document.createElement('span');
    lab.className = 'planning__seat-label';
    lab.textContent = 'chair';
    // Two segments and not two radios: a native radio took the fleet's
    // colour, and Codex's is near white -- checked and unchecked looked the
    // same on the dark panel, so a choice made could not be seen.
    const group = document.createElement('div');
    group.className = 'planning__chairs';
    const seated = seatedChair(doc?.chair ?? null, this.#providers);
    for (const p of this.#providers) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'planning__chair';
      b.style.setProperty('--c', `#${PROVIDER_COLOR[p].toString(16).padStart(6, '0')}`);
      b.textContent = LABEL[p];
      const on = seated === p;
      b.dataset['on'] = String(on);
      b.setAttribute('aria-pressed', String(on));
      b.disabled = taken;
      b.title = taken
        ? 'The chair is chosen before the first message: start over to change it.'
        : `${LABEL[p]} chairs the meeting`;
      b.addEventListener('click', () => {
        if (!on) this.#act.onSet({ kind: 'chair', chair: p });
      });
      group.appendChild(b);
    }
    this.#seat.append(lab, group);
    for (const b of this.#depths.querySelectorAll<HTMLButtonElement>('button')) {
      b.dataset['on'] = String(b.dataset['kind'] === (doc?.depth ?? 'standard'));
    }
  }

  #renderMeeting(doc: PlanDoc): void {
    this.#minutes.replaceChildren();
    for (const m of doc.minutes) {
      const row = document.createElement('div');
      row.className = 'planning__minute';
      row.dataset['role'] = m.role;
      const who = document.createElement('span');
      who.className = 'planning__who';
      who.textContent = m.role === 'user' ? 'you' : m.role === 'ceo' ? LABEL[doc.chair] : 'note';
      // The chair writes Markdown; what you typed and the notes stay as they
      // were written.
      const text = document.createElement(m.role === 'ceo' ? 'div' : 'p');
      if (m.role === 'ceo') renderMarkdown(text, m.text);
      else text.textContent = m.text;
      row.append(who, text);
      this.#minutes.appendChild(row);
    }
    this.#minutes.scrollTop = this.#minutes.scrollHeight;

    this.#questions.replaceChildren();
    for (const q of doc.questions) {
      const box = document.createElement('div');
      box.className = 'planning__q';
      box.dataset['answered'] = String(q.answer !== null);
      const text = document.createElement('div');
      renderMarkdown(text, q.text);
      const field = this.#answerField(
        `q:${q.id}`, q.answer, 'your answer', q.answer === null ? 'answer' : 'change',
        (value) => this.#act.onSet({ kind: 'question', id: q.id, text: value }),
      );
      box.append(text, field);
      // Answered is not read: the chair gets it with your next message, and
      // until then the plan cannot be approved.
      box.dataset['seen'] = String(q.answer === null || q.seen);
      if (q.answer !== null && !q.seen) {
        const hint = document.createElement('span');
        hint.className = 'planning__qhint';
        hint.textContent = 'the chair reads it with your next message';
        box.appendChild(hint);
      }
      this.#questions.appendChild(box);
    }

    this.#files.replaceChildren();
    for (const a of doc.attachments) {
      const row = document.createElement('div');
      row.className = 'planning__file';
      const name = document.createElement('span');
      name.textContent = attachmentLine(a);
      name.dataset['sent'] = String(a.sent);
      const x = iconButton('planning__x', 'remove', CLOSE_ICON);
      x.addEventListener('click', () => this.#act.onDetach(a.id));
      row.append(name, x);
      this.#files.appendChild(row);
    }
  }

  #renderPlan(doc: PlanDoc): void {
    // The rows are remade below, and with them their log buttons.
    this.#logButtons.clear();
    /* settings */
    this.#settings.replaceChildren();
    const editable = doc.status !== 'done';
    for (const p of this.#providers) {
      const row = document.createElement('div');
      row.className = 'planning__reserve';
      row.style.setProperty('--c', `#${PROVIDER_COLOR[p].toString(16).padStart(6, '0')}`);
      const name = document.createElement('span');
      name.className = 'planning__rname';
      name.textContent = `${p} reserve`;
      row.appendChild(name);
      for (const w of ['5h', '7d'] as const) {
        const l = document.createElement('label');
        l.className = 'planning__slider';
        const cap = document.createElement('span');
        cap.textContent = w;
        const s = document.createElement('input');
        s.type = 'range';
        s.min = '0';
        s.max = '90';
        s.step = '5';
        s.value = String(doc.reserve[p]?.[w] ?? 0);
        s.disabled = !editable;
        const val = document.createElement('b');
        val.textContent = `${s.value}%`;
        s.addEventListener('input', () => { val.textContent = `${s.value}%`; });
        s.addEventListener('change', () => this.#act.onSet({ kind: 'reserve', provider: p, window: w, percent: Number(s.value) }));
        l.append(cap, s, val);
        row.appendChild(l);
      }
      this.#settings.appendChild(row);
    }
    const misc = document.createElement('div');
    misc.className = 'planning__misc';
    const par = document.createElement('label');
    par.className = 'planning__field';
    const parText = document.createElement('span');
    parText.textContent = 'parallel';
    const parIn = document.createElement('input');
    parIn.type = 'number';
    parIn.min = '1';
    parIn.max = '4';
    parIn.value = String(doc.parallel);
    parIn.disabled = !editable;
    parIn.addEventListener('change', () => this.#act.onSet({ kind: 'parallel', parallel: Number(parIn.value) }));
    par.append(parText, parIn);
    const rev = document.createElement('label');
    rev.className = 'planning__field';
    const revIn = document.createElement('input');
    revIn.type = 'checkbox';
    revIn.checked = doc.review;
    revIn.disabled = !editable;
    revIn.addEventListener('change', () => this.#act.onSet({ kind: 'review', review: revIn.checked }));
    const revText = document.createElement('span');
    revText.textContent = 'second opinion on every task';
    rev.title = 'A review fork after each task, as for a proposal. Doubles the cost.';
    rev.append(revIn, revText);
    misc.append(par, rev);
    this.#settings.appendChild(misc);

    /* projects */
    this.#projects.replaceChildren();
    const order = doc.projects.map((p) => p.projectId);
    if (doc.projects.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'planning__empty';
      empty.textContent = 'Nothing yet. Hold the meeting: the chair lays the tasks here.';
      this.#projects.appendChild(empty);
    }
    doc.projects.forEach((project, i) => {
      this.#projects.appendChild(this.#projectCard(doc, project, i, order));
    });

    /* actions */
    this.#actions.replaceChildren();
    const warning = activeWarning(doc);
    if (warning) {
      const w = document.createElement('p');
      w.className = 'planning__active';
      w.textContent = warning;
      this.#actions.appendChild(w);
    }
    const ready = readinessOf(doc);
    const unread = unreadReason(doc);
    const mk = (label: string, on: () => void, show: boolean, title = '', locked = false): void => {
      if (!show) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'planning__btn planning__btn--main';
      b.textContent = label;
      b.title = title;
      b.disabled = locked;
      b.addEventListener('click', on);
      this.#actions.appendChild(b);
    };
    mk('approve', () => this.#act.onApprove(), doc.status === 'proposed', ready.why, ready.blocked);
    mk('pause', () => this.#act.onPause(), doc.status === 'approved', 'Stops the running workers too: their tasks go back in the queue and resume picks them up where they were.');
    mk('resume', () => this.#act.onResume(), doc.status === 'paused', unread ?? 'Tasks stopped by the pause resume their own sessions.', unread !== null);
    mk('launch next', () => this.#act.onLaunch(), doc.status === 'approved', 'Without waiting for the tick.');
    const reason = doc.status === 'proposed' ? ready.why : doc.status === 'paused' ? unread : null;
    if (reason) {
      const why = document.createElement('span');
      why.className = 'planning__why';
      why.dataset['ready'] = String(doc.status === 'proposed' && ready.ready);
      why.dataset['blocked'] = String(doc.status === 'proposed' ? ready.blocked : unread !== null);
      why.textContent = reason;
      this.#actions.appendChild(why);
    }
    if (this.#last) this.#next.textContent = nextReason(this.#last);
  }

  #projectCard(doc: PlanDoc, project: PlanProject, index: number, order: string[]): HTMLElement {
    const card = document.createElement('article');
    card.className = 'planning__project';
    const head = document.createElement('header');
    head.className = 'planning__phead';
    const rank = document.createElement('span');
    rank.className = 'planning__rank';
    rank.textContent = String(project.priority);
    const name = document.createElement('span');
    name.className = 'planning__pname';
    name.textContent = project.name;
    const moves = document.createElement('span');
    moves.className = 'planning__moves';
    const movable = doc.status !== 'done';
    for (const [glyph, dir] of [['↑', -1], ['↓', 1]] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'planning__move';
      b.textContent = glyph;
      b.disabled = !movable || (dir === -1 ? index === 0 : index === order.length - 1);
      b.addEventListener('click', () => this.#act.onSet({ kind: 'order', order: orderAfterMove(order, project.projectId, dir) }));
      moves.appendChild(b);
    }
    const git = document.createElement('span');
    git.className = 'planning__git';
    const busy = project.tasks.some((t) => t.status === 'running');
    const branch = doc.branches[project.projectId] ?? null;
    const box = (key: 'commit' | 'push', label: string): void => {
      const l = document.createElement('label');
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = project.git[key];
      c.disabled = busy || doc.status === 'done';
      c.addEventListener('change', () => {
        this.#act.onSet({ kind: 'git', projectId: project.projectId, rules: { ...project.git, [key]: c.checked } });
      });
      const s = document.createElement('span');
      s.textContent = label;
      l.append(c, s);
      git.appendChild(l);
    };
    const boxes = gitBoxes(branch);
    if (boxes) {
      for (const b of boxes) box(b.key, b.label);
    } else {
      const none = document.createElement('span');
      none.className = 'planning__nogit';
      none.textContent = 'no git versioning for this project';
      git.appendChild(none);
    }
    git.title = busy ? 'A task is running: the rules change when it ends.' : 'What a worker may run here.';
    const held = doc.active[project.projectId] ?? 0;
    if (held > 0) {
      const badge = document.createElement('span');
      badge.className = 'planning__pactive';
      badge.textContent = `${held} active session${held === 1 ? '' : 's'} of yours`;
      badge.title = 'No worker starts here while it is active.';
      head.append(rank, name, badge, moves, git);
    } else {
      head.append(rank, name, moves, git);
    }
    card.appendChild(head);
    card.appendChild(this.#commandsRow(doc, project));

    const list = document.createElement('ul');
    list.className = 'planning__tasks';
    for (const t of project.tasks) list.appendChild(this.#taskRow(t));
    card.appendChild(list);
    return card;
  }

  /**
   * What a worker may run here to test it, besides the common runners: a
   * chip per command, a cross to take one back, a field to add one before
   * any worker asks. The server checks each command and says why it refused
   * one; the list is the project's and stays for the next plans.
   */
  #commandsRow(doc: PlanDoc, project: PlanProject): HTMLElement {
    const row = document.createElement('div');
    row.className = 'planning__cmds';
    const list = doc.commands[project.projectId] ?? [];
    const set = (commands: string[]): void => this.#act.onSet({ kind: 'commands', projectId: project.projectId, commands });
    const label = document.createElement('span');
    label.className = 'planning__cmdslabel';
    label.textContent = 'tests run';
    label.title = 'The tests always run. A worker may use the common runners (npm test, npx, node --test, pytest, '
      + 'cargo test, go test, php -l, node --check, make test) and the commands listed here, which stay for the next plans.';
    row.appendChild(label);
    const locked = doc.status === 'done';
    for (const c of list) {
      const chip = document.createElement('span');
      chip.className = 'planning__cmd';
      const code = document.createElement('code');
      code.textContent = c;
      chip.appendChild(code);
      if (!locked) {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'planning__cmdx';
        x.textContent = '\u00d7';
        x.setAttribute('aria-label', `stop allowing ${c}`);
        x.addEventListener('click', () => set(list.filter((y) => y !== c)));
        chip.appendChild(x);
      }
      row.appendChild(chip);
    }
    if (list.length === 0) {
      const none = document.createElement('span');
      none.className = 'planning__cmdnone';
      none.textContent = 'the common runners';
      row.appendChild(none);
    }
    if (!locked && list.length < MAX_PROJECT_COMMANDS) {
      const key = `cmd:${project.projectId}`;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'planning__cmdadd';
      input.placeholder = '+ command, e.g. php tests/*';
      input.maxLength = MAX_COMMAND_CHARS;
      input.spellcheck = false;
      input.dataset['draft'] = key;
      // A running plan redraws at every task that moves: a half-typed command survives it.
      input.value = this.#drafts.get(key) ?? '';
      input.addEventListener('input', () => this.#drafts.set(key, input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const value = input.value.trim();
        if (!value) return;
        e.preventDefault();
        this.#drafts.delete(key);
        input.value = '';
        set([...list, value]);
      });
      row.appendChild(input);
    }
    return row;
  }

  #taskRow(t: PlanTask): HTMLElement {
    const li = document.createElement('li');
    li.className = 'planning__task';
    li.dataset['status'] = t.status;
    // A task still to start shows its briefing in full, below: it is what the
    // worker will be told, written by a chair that read the repositories.
    if (t.status !== 'queued') li.title = t.briefing;

    const state = document.createElement('span');
    state.className = 'planning__tstate';
    state.textContent = TASK_TEXT[t.status];
    const title = document.createElement('span');
    title.className = 'planning__ttitle';
    title.textContent = t.title;
    li.append(state, title);

    const picks = document.createElement('span');
    picks.className = 'planning__picks';
    const editable = t.status === 'queued';
    if (editable) {
      const prov = document.createElement('select');
      prov.className = 'planning__select';
      for (const p of this.#providers) {
        const o = document.createElement('option');
        o.value = p;
        o.textContent = p;
        o.selected = p === t.provider;
        prov.appendChild(o);
      }
      prov.addEventListener('change', () => this.#act.onSet({ kind: 'task', taskId: t.id, provider: prov.value as ProviderId, model: null }));
      picks.appendChild(prov);
      const model = document.createElement('select');
      model.className = 'planning__select';
      for (const opt of modelOptions(t.provider)) {
        const o = document.createElement('option');
        o.value = opt.value ?? '';
        o.textContent = opt.label;
        o.selected = opt.value === t.model;
        model.appendChild(o);
      }
      model.addEventListener('change', () => this.#act.onSet({ kind: 'task', taskId: t.id, model: model.value || null }));
      picks.appendChild(model);
      if (t.provider === 'codex') {
        const eff = document.createElement('select');
        eff.className = 'planning__select';
        for (const e of EFFORTS) {
          const o = document.createElement('option');
          o.value = e;
          o.textContent = `${e} effort`;
          o.selected = e === (t.effort ?? 'medium');
          eff.appendChild(o);
        }
        eff.addEventListener('change', () => this.#act.onSet({ kind: 'task', taskId: t.id, effort: eff.value as Effort }));
        picks.appendChild(eff);
      }
      const size = document.createElement('span');
      size.className = 'planning__size';
      size.textContent = SIZES.includes(t.size) ? t.size : 'medium';
      picks.appendChild(size);
    } else {
      const label = document.createElement('span');
      label.className = 'planning__tlabel';
      label.textContent = taskLabel(t);
      picks.appendChild(label);
    }
    li.appendChild(picks);

    if (t.status === 'queued' && t.briefing) {
      const brief = document.createElement('p');
      brief.className = 'planning__tbrief';
      brief.textContent = t.briefing;
      li.appendChild(brief);
    }
    if (t.did) {
      const did = document.createElement('p');
      did.className = 'planning__tdid';
      did.textContent = `→ ${t.did}`;
      li.appendChild(did);
    }
    if (t.reason) {
      const reason = document.createElement('p');
      reason.className = 'planning__treason';
      reason.textContent = t.reason;
      li.appendChild(reason);
    }
    if (t.status === 'question' && t.question) {
      const box = document.createElement('div');
      box.className = 'planning__tq';
      const q = document.createElement('div');
      renderMarkdown(q, t.question);
      box.appendChild(q);
      // A refused command is granted by a flag, not by words: the button adds
      // them to the project and resumes the same session with them.
      if (t.needs.length > 0) {
        const needs = document.createElement('div');
        needs.className = 'planning__tneeds';
        for (const c of t.needs) {
          const code = document.createElement('code');
          code.textContent = c;
          needs.appendChild(code);
        }
        const allow = document.createElement('button');
        allow.type = 'button';
        allow.className = 'planning__btn';
        allow.textContent = 'allow and resume';
        allow.title = 'Adds these commands to the project, for this plan and the next ones, and resumes the same session.';
        allow.addEventListener('click', () => this.#act.onAllow(t.id));
        needs.appendChild(allow);
        box.appendChild(needs);
      }
      // Kept as a draft like the meeting's: a running plan redraws the panel
      // at every task that moves, and would wipe an answer half written.
      const field = this.#answerField(
        `t:${t.id}`, null, 'your answer: the session resumes with it', 'answer',
        (value) => this.#act.onAnswer(t.id, value.trim()), true,
      );
      box.appendChild(field);
      li.appendChild(box);
    }

    const acts = document.createElement('span');
    acts.className = 'planning__tacts';
    const mk = (label: string, on: () => void): void => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'planning__btn planning__btn--quiet';
      b.textContent = label;
      b.addEventListener('click', on);
      acts.appendChild(b);
    };
    if (t.status === 'failed') mk('retry', () => this.#act.onRetry(t.id));
    if (t.status === 'queued' || t.status === 'failed' || t.status === 'question') mk('skip', () => this.#act.onSkip(t.id));
    if (t.jobId && (t.status === 'done' || t.status === 'failed' || t.status === 'question')) {
      const id = t.jobId;
      mk('read', () => this.#act.onOpenJob(id));
    }
    // The whole log of the attempt, in a window: what the astronaut's click
    // gave while it ran, still there after it is over. It needs a session --
    // the transcript is the session's -- and the job to name it by.
    if (t.jobId && t.sessionId) {
      const id = t.jobId;
      const log = document.createElement('button');
      log.type = 'button';
      log.className = 'planning__btn planning__btn--quiet';
      log.textContent = 'log';
      log.title = t.status === 'running'
        ? 'Opens a Terminal window that follows the session, read-only.'
        : 'Opens a Terminal window with everything the session did, read-only.';
      log.dataset['title'] = log.title;
      log.addEventListener('click', () => this.#act.onWatchJob(id));
      acts.appendChild(log);
      this.#logButtons.set(id, log);
    }
    if (acts.childElementCount > 0) li.appendChild(acts);
    return li;
  }
}
