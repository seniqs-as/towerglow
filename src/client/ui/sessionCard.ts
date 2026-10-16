import type { ProjectInfo, SessionInfo } from '../../shared/protocol.ts';
import type { Step } from '../state/trail.ts';
import { PENDING_MAX_MS } from '../state/pendingFocus.ts';
import { TOOL_COLOR } from '../world/palette.ts';
import { describeActivity, describeStep, formatElapsed, limitStopText } from './format.ts';

export interface CardContext {
  project: ProjectInfo | undefined;
  /** How long the current state has lasted, in milliseconds. */
  sinceMs: number;
  /** This session's terminal can be brought to the front. */
  canFocus: boolean;
  /** What the terminal button does: bring a terminal forward, or follow a worker. */
  focusTitle: string;
  /** The one line that says what the session is about: a worker's task, or its title. */
  what: string;
  /** The gestures already finished, most recent first. Empty until it has made any. */
  trail: readonly Step[];
}

/**
 * The panel that opens when you click a badge.
 *
 * The badge says the state, hovering says the task, clicking says all the
 * rest. They are three levels of detail on request, not three things shown
 * together: the city stays readable because almost always only one is
 * needed.
 */
export class SessionCard {
  #root: HTMLElement;
  #id: string | null = null;
  #onFocus: (id: string) => void;
  #jump: HTMLButtonElement | null = null;
  #jumpTitle = '';
  #pending: { id: string; until: number } | null = null;

  constructor(root: HTMLElement, onFocus: (id: string) => void) {
    this.#root = root;
    this.#onFocus = onFocus;
    this.#root.hidden = true;
    this.#root.addEventListener('click', (e) => {
      const t = e.target;
      if (t instanceof HTMLElement && t.closest('[data-close]')) this.close();
      e.stopPropagation();
    });
    // Closing must always be one gesture away: Esc, or a click outside.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    window.addEventListener('pointerdown', (e) => {
      // A click on a badge is NOT a click outside: closing here would make
      // the panel close and reopen on every selection.
      const t = e.target;
      if (t instanceof Element && t.closest('.badge, .card')) return;
      this.close();
    });
  }

  get openFor(): string | null {
    return this.#id;
  }

  close(): void {
    if (this.#id === null) return;
    this.#id = null;
    this.#jump = null;
    this.#root.hidden = true;
    this.#root.replaceChildren();
  }

  /**
   * The jump has left and the terminal is not there yet. Kept by session and
   * with a deadline, not only on the button: the card is redrawn on every
   * event, and the button with it.
   */
  markFocusPending(sessionId: string, now: number): void {
    const pending = { id: sessionId, until: now + PENDING_MAX_MS };
    this.#pending = pending;
    if (this.#jump && this.#id === sessionId) this.#jump.dataset['state'] = 'pending';
    // No answer at all: the button stops waiting with the click it answers.
    setTimeout(() => {
      if (this.#pending !== pending) return;
      this.#pending = null;
      if (this.#jump?.dataset['state'] === 'pending') delete this.#jump.dataset['state'];
    }, PENDING_MAX_MS);
  }

  /** Outcome of the jump to the terminal, shown on the button that asked for it. */
  reportFocus(sessionId: string, ok: boolean, reason: string | null): void {
    if (this.#pending?.id === sessionId) this.#pending = null;
    const jump = this.#jump;
    if (!jump || this.#id !== sessionId) return;
    jump.dataset['state'] = ok ? 'ok' : 'fail';
    if (!ok && reason) jump.title = reason;
    setTimeout(() => {
      delete jump.dataset['state'];
      jump.title = this.#jumpTitle;
    }, 1800);
  }

  show(session: SessionInfo, ctx: CardContext): void {
    this.#id = session.id;
    this.#root.hidden = false;
    this.#root.dataset['provider'] = session.provider;

    const what = ctx.what;
    const stop = limitStopText(session, Date.now());
    const rows: [string, string][] = [['status', stop ? 'stopped at the usage limit' : statusText(session)]];

    // The two times are different things and must be stated separately: how
    // long the work lasted, and how long it has been in this state. Merging
    // them into a single row made twenty-five minutes of waiting read as
    // twenty-five minutes of running.
    const doing = describeActivity(session);
    // First: a session refused at the limit can read busy for a shell it
    // left running, and nothing of its turn is running.
    if (stop) {
      rows.push(['stopped for', stop.since]);
    } else if (session.status === 'busy') {
      if (doing) rows.push(['doing', doing]);
      rows.push(['running for', formatElapsed(ctx.sinceMs)]);
    } else if (session.status === 'waiting') {
      rows.push(['waiting for you', formatElapsed(ctx.sinceMs)]);
    } else {
      rows.push(['idle for', formatElapsed(ctx.sinceMs)]);
    }
    if (session.lastTurnMs !== null) {
      rows.push(['last task took', formatElapsed(session.lastTurnMs)]);
    }

    rows.push(
      ['tool', session.provider === 'claude' ? 'Claude Code' : 'Codex CLI'],
      ['model', session.model ?? '—'],
      ['project', ctx.project?.name ?? '—'],
      ['branch', session.gitBranch ?? '—'],
      ['session', session.label],
      ['pid', String(session.pid)],
      // A worker sits on the lot like your own sessions, so the card has to
      // say whose it is: nothing else on screen tells the two apart.
      ...(session.spawnedByCeo !== null ? [['opened by', 'the CEO, for a job you accepted'] as [string, string]] : []),
      ['started', new Date(session.startedAt).toLocaleTimeString()],
      ['tokens', tokensText(session)],
    );
    if (session.contextLeft !== null) {
      // `total_tokens_reminder` counts the tokens left in the session's
      // BUDGET, not the free space in the context window: calling it
      // "context" made fifteen million read as remaining context.
      rows.push(['tokens left', compact(session.contextLeft)]);
    }
    if (session.statusConfidence === 'inferred') {
      // It must be said here and not only with a dashed border: it is the
      // difference between a state the tool declares and one we infer from
      // the files.
      rows.push(['confidence', 'inferred from files']);
    }

    const head = el('div', 'card__head');
    head.appendChild(el('span', 'card__kicker', session.provider === 'claude' ? 'CLAUDE' : 'CODEX'));

    this.#jump = null;
    this.#jumpTitle = ctx.focusTitle;
    if (ctx.canFocus) {
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'card__jump';
      jump.title = ctx.focusTitle;
      jump.setAttribute('aria-label', ctx.focusTitle);
      jump.innerHTML = CODE_ICON;
      jump.addEventListener('click', () => this.#onFocus(session.id));
      if (this.#pending?.id === session.id && Date.now() < this.#pending.until) jump.dataset['state'] = 'pending';
      head.appendChild(jump);
      this.#jump = jump;
    }

    const close = el('button', 'card__close', '×');
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', 'Close');
    close.dataset['close'] = 'yes';
    head.appendChild(close);

    const body = el('div', 'card__body');
    if (what) body.appendChild(el('p', 'card__what', what));
    // The recap sits at the top, before the numbers: it is the only line that
    // says in words WHY the session is doing what it does, and whoever opens
    // the panel is asking exactly that. The numbers answer afterwards.
    if (session.recap) {
      body.appendChild(recapBlock(session.recap, session.recapAt, session.recapInherited));
    }
    if (session.waitingFor) body.appendChild(el('p', 'card__wait', session.waitingFor));
    if (stop) body.appendChild(el('p', 'card__wait', stop.next));

    const dl = el('dl', 'card__rows');
    for (const [k, v] of rows) {
      const row = el('div', '');
      row.appendChild(el('dt', '', k));
      row.appendChild(el('dd', '', v));
      dl.appendChild(row);
    }
    body.appendChild(dl);
    if (ctx.trail.length > 0) body.appendChild(trailBlock(ctx.trail));

    this.#root.replaceChildren(head, body);
  }
}

/**
 * The summary the session wrote of itself.
 *
 * The age comes before the text, not after: the tool rewrites it roughly
 * every fifteen minutes, so what you read may describe work already
 * finished, and knowing that changes how the sentence reads. Without it, a
 * recap from an hour ago reads as if it were from now.
 */
function recapBlock(text: string, at: number | null, inherited: boolean): HTMLElement {
  const box = el('div', 'card__recap');
  // An inherited recap declares itself: it describes this project's previous
  // session, not the one open now. Without the warning it would read as an
  // account from whoever is working right now, which is the opposite.
  const head = inherited ? 'recap · previous session' : 'recap';
  const when = at === null ? head : `${head} · ${formatElapsed(Date.now() - at)} ago`;
  box.append(el('p', 'card__recap-head', when), el('p', 'card__recap-text', text));
  return box;
}

/**
 * How it got here: the finished gestures, most recent first.
 *
 * It sits at the bottom and reads downwards going back in time, so the
 * gesture just finished touches the `doing` row that says what is under way:
 * the two adjacent rows are the two adjacent instants, and reading does not
 * have to jump from one end of the panel to the other to piece the order
 * back together.
 */
function trailBlock(steps: readonly Step[]): HTMLElement {
  const box = el('div', 'card__trail');
  box.appendChild(el('p', 'card__trail-title', 'what it has been doing'));

  const list = el('ol', 'card__steps');
  for (const step of steps) {
    const row = el('li', 'card__step');
    const dot = el('span', 'card__step-dot');
    dot.style.background = hex(TOOL_COLOR[step.cat]);
    row.append(
      dot,
      el('span', 'card__step-time', clock(step.at)),
      // Here the target is the file name alone: the column is a third as
      // wide as the `doing` row, and a full path would fill it with folders
      // and leave out the name itself.
      el('span', 'card__step-what', describeStep(step.tool, step.target, true)),
    );
    const note = stepNote(step);
    if (note) {
      const tag = el('span', 'card__step-note', note);
      if (!step.ok) tag.dataset['state'] = 'fail';
      row.appendChild(tag);
    }
    list.appendChild(row);
  }

  box.appendChild(list);
  return box;
}

/**
 * How it went, in a single word.
 *
 * The order is by importance: if it failed it does not matter how long it
 * took, and if it changed some lines those say more than the time it spent.
 * Under a second nothing is written: a twelve-millisecond read has no
 * duration worth talking about.
 */
function stepNote(step: Step): string {
  if (!step.ok) return 'failed';
  if (step.changed > 0) return `+${step.changed}`;
  if (step.durationMs !== null && step.durationMs >= 1000) return formatElapsed(step.durationMs);
  return '';
}

/** The time of the gesture. Absolute, not "two minutes ago": the panel is
 *  redrawn only while the session works, and once idle a relative time would lie. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function hex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

function statusText(s: SessionInfo): string {
  return s.status === 'busy' ? 'working' : s.status === 'waiting' ? 'awaiting you' : 'done';
}

/** The real weight is in the cache, not in `in`: showing them apart would be a lie. */
function tokensText(s: SessionInfo): string {
  const t = s.tokens;
  const total = t.in + t.out + t.cacheRead + t.cacheWrite;
  if (total === 0) return '—';
  return `${compact(total)} · out ${compact(t.out)}`;
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The same glyph as the tooltip: two angle brackets, inline. */
const CODE_ICON =
  '<svg viewBox="0 0 20 14" aria-hidden="true">' +
  '<path d="M6.6 2.6 2 7l4.6 4.4M13.4 2.6 18 7l-4.6 4.4" fill="none" stroke="currentColor" ' +
  'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
