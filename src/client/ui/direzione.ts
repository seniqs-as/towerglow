import type {
  AnalysisKind, AnalysisOffer, CeoDepth, CeoState, DeltaEvent, ProposalStatus, ProviderId,
} from '../../shared/protocol.ts';
import { PROVIDER_COLOR } from '../world/palette.ts';
import { renderMarkdown } from './markdown.ts';
import { twoClicks } from './twoClicks.ts';

/**
 * The Board panel: this is where you talk to the two CEOs, and the only place.
 *
 * You can walk into the HQ now, up to the CEOs' desk -- and what opens there
 * is THIS panel, the same object the HUD button opens, handed to the room
 * (`world/interior.ts`). The first interior had walls that decided things,
 * a second surface holding a second copy of the state, and it was removed
 * for that; this one holds nothing. So the panel is still not one of two
 * views of the same state: it is the only one, wherever you open it from.
 *
 * Nothing is decided in here anyway: it sends `ceo.say` and shows what comes
 * back. The real state stays with the server.
 */

const LABEL: Record<ProviderId, string> = { claude: 'CLAUDE CEO', codex: 'CODEX CEO' };

/** What it is doing, said in one word. */
const STATE_TEXT: Record<CeoState, string> = {
  off: 'stopped',
  starting: 'starting',
  idle: 'ready',
  thinking: 'answering',
  asking: 'asking you',
  waiting: 'waiting',
  error: 'error',
};

const STATUS_TEXT: Record<ProposalStatus, string> = {
  pending: 'pending',
  accepted: 'accepted',
  rejected: 'rejected',
  applied: 'applied',
};

/**
 * The five analyses, on five buttons.
 *
 * The same closed set the server holds: a button still sends the KIND, not the
 * sentence, so the question that is actually paid for is written in one place
 * and this list can never drift into asking for something that does not exist.
 *
 * Pressing a button now ARMS the analysis and writes its question into the
 * text box, instead of sending it right away: the sentence that goes out is
 * read before it is paid for, and can be corrected. The sentence is not here
 * -- it comes from the `caps`, i.e. from the same text the server sends to the
 * model. Two copies of the same question diverge at the first edit, and what
 * would diverge is exactly what the panel promises to show.
 */
const PICKS: readonly { kind: AnalysisKind; label: string }[] = [
  { kind: 'sessions', label: 'sessions' },
  { kind: 'development', label: 'development' },
  { kind: 'tokens', label: 'tokens' },
  { kind: 'structure', label: 'structure' },
  { kind: 'quota', label: 'quota' },
];

/** An analysis's question as the server declared it, or '' if there is none. */
export function questionOf(
  analyses: readonly AnalysisOffer[], kind: AnalysisKind,
): string {
  return analyses.find((a) => a.kind === kind)?.question ?? '';
}

/**
 * What travels from the text box, once you press.
 *
 * The untouched sentence does NOT travel: the server already knows it -- it
 * wrote it -- and sending it back would paste it a second time into the same
 * prompt, which is paid per token. What travels is what you added or changed,
 * which is the only part the server does not have.
 */
export function textToSend(typed: string, question: string | null): string {
  return question !== null && typed === question.trim() ? '' : typed;
}

/**
 * The three tiers, with what they actually change.
 *
 * The caption under the name is not decoration: the depth picks the MODEL,
 * and that is the biggest lever on the cost of a question. Hiding it behind
 * three adjectives would mean choosing blind.
 */
/**
 * Start from `fast`.
 *
 * Depth costs: `deep` runs on opus and opens files, and every file read comes
 * back into the context on every turn. Starting from the most expensive tier
 * would make someone who only wanted a number pay for the deep dive -- and
 * whoever wants to go deep knows it, and asks for it.
 */
const DEFAULT_DEPTH: CeoDepth = 'fast';

const DEPTHS: readonly { kind: CeoDepth; label: string; hint: string }[] = [
  { kind: 'fast', label: 'fast', hint: 'haiku, or low effort · short brief · 5 lines' },
  { kind: 'standard', label: 'standard', hint: 'your default model, medium effort · full brief' },
  { kind: 'deep', label: 'deep', hint: 'opus, or high effort · full brief · reads the code' },
];

export interface BoardroomActions {
  onAsk: (
    provider: ProviderId, text: string, analysis: AnalysisKind | null, depth: CeoDepth,
  ) => void;
  /** The same question to every CEO at once. */
  onMeeting: (topic: string, analysis: AnalysisKind | null, depth: CeoDepth) => void;
  /** You accept or reject. The server decides the transition, not this panel. */
  onDecide: (id: string, accept: boolean) => void;
  /** Ask for a proposal's full task: the answer comes back to `setProposalTask`. */
  onReadTask: (id: string) => void;
  /** Start the board over. The server clears it and tells everyone: see `clear`. */
  onReset: () => void;
}

/** A proposal, as it arrives from the channel. */
type ProposalEvent = Extract<DeltaEvent, { t: 'proposal' }>;
/** A report, as it arrives from the channel. */
type ReportEvent = Extract<DeltaEvent, { t: 'report' }>;

interface Desk {
  provider: ProviderId;
  root: HTMLElement;
  state: HTMLElement;
  report: HTMLElement;
  answer: HTMLElement;
  proposals: HTMLElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  /** The accumulated text of the answer in progress. */
  buffer: string;
  /** The proposals already on screen, by id: a resync rewrites them, never duplicates them. */
  cards: Map<string, Card>;
  /** How deep, for the next question. It stays as you left it. */
  depth: CeoDepth;
  /** The analysis chosen and not yet sent: it goes out with the next send. */
  armed: AnalysisKind | null;
  /** The five buttons, to light up just one when arming. */
  picks: Map<AnalysisKind, HTMLButtonElement>;
}

/** The parts of a proposal card, held by name instead of by index. */
interface Card {
  root: HTMLElement;
  kind: HTMLElement;
  text: HTMLElement;
  status: HTMLElement;
  /** Why it did not start. Empty almost always, and then it is not shown. */
  reason: HTMLElement;
  /** Where its worker would run. */
  project: HTMLElement;
  /** What its worker will be told, in full, once the server has sent it. */
  task: HTMLElement;
  /** The task is on screen: only then can it be accepted. */
  read: boolean;
  actions: HTMLElement;
}

export class Boardroom {
  #root: HTMLElement;
  #analyses: readonly AnalysisOffer[] = [];
  #open = false;
  #desks = new Map<ProviderId, Desk>();
  #act: BoardroomActions;
  #enabled = false;
  #both: HTMLInputElement;
  #bothRow: HTMLElement;
  #seats = 0;
  #shared = false;
  #foot: HTMLElement;

  constructor(host: HTMLElement, button: HTMLElement, act: BoardroomActions) {
    this.#act = act;

    this.#root = document.createElement('aside');
    this.#root.className = 'boardroom';
    this.#root.hidden = true;
    this.#root.setAttribute('aria-label', 'Board');

    /*
     * One switch for the whole panel, and not one per desk.
     *
     * A meeting is a cross-fleet act: putting its control inside a single CEO's
     * desk would suggest that CEO is the one convening it. Here it reads as
     * what it is -- how the next question goes out, whoever you type it to.
     */
    this.#bothRow = document.createElement('header');
    this.#bothRow.className = 'boardroom__top';
    const both = document.createElement('label');
    both.className = 'boardroom__both';
    this.#both = document.createElement('input');
    this.#both.type = 'checkbox';
    this.#both.id = 'boardroom-both';
    const bothText = document.createElement('span');
    bothText.textContent = 'ask both fleets (shared projects)';
    both.append(this.#both, bothText);
    this.#bothRow.append(both);
    this.#root.appendChild(this.#bothRow);

    /*
     * Start over, under the desks: the same two clicks as Planning's.
     *
     * It exists before any desk: the caps name them later, and `#desk`
     * inserts each one above it.
     */
    this.#foot = document.createElement('footer');
    this.#foot.className = 'boardroom__foot';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'boardroom__restart';
    reset.title = 'Erase the whole board: answers, reports and proposals, pending ones too. '
      + 'Works while a CEO is answering here: it stops it. What the CEOs remember stays, '
      + 'and the old proposals are archived on disk.';
    twoClicks(reset, 'start over', 'erase everything? click again', () => this.#act.onReset());
    this.#foot.appendChild(reset);
    this.#root.appendChild(this.#foot);

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
    // It closes on a click outside or with Esc, like the other panels. But NOT
    // on a click inside: that is where you type.
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
  }

  /**
   * Who sits on the Board panel, from the caps.
   *
   * The desks are created HERE and not at the first news of a state: a client
   * that connects to an already running world does not receive the events
   * broadcast at startup, and found the panel empty without knowing why. The
   * caps, instead, arrive on every connection.
   */
  setProviders(providers: readonly ProviderId[]): void {
    this.#enabled = providers.length > 0;
    this.#seats = providers.length;
    for (const p of providers) this.#desk(p);
    this.#syncMeeting();
    if (!this.#enabled) this.close();
  }

  /**
   * Whether there is a project that both tools work on.
   *
   * It is the only thing that justifies a meeting. Without overlap, two CEOs
   * answering the same question are two bills for a single answer, and each
   * would give it about its own projects: you ask one at a time.
   */
  setShared(hasShared: boolean): void {
    this.#shared = hasShared;
    this.#syncMeeting();
  }

  #syncMeeting(): void {
    const possible = this.#seats > 1 && this.#shared;
    this.#bothRow.hidden = !possible;
    if (!possible) this.#both.checked = false;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Open right now. For whoever shares a key with this panel. */
  get isOpen(): boolean {
    return this.#open;
  }

  toggle(): void {
    if (this.#open) this.close();
    else this.open();
  }

  /**
   * `focus` false leaves the cursor where it is: the desk inside the ship
   * opens this panel as you walk up to it, holding a key, and a text box that
   * took the focus would take that key's repeats as typing.
   */
  open(focus = true): void {
    if (!this.#enabled) return;
    const wasOpen = this.#open;
    this.#open = true;
    this.#root.hidden = false;
    // The cursor goes where you type: opening a panel and then having to click
    // inside it is one step too many. But only when opening it: if it was
    // already open, this would move the cursor away from where you were typing.
    if (!wasOpen && focus) [...this.#desks.values()][0]?.input.focus();
  }

  close(): void {
    this.#open = false;
    this.#root.hidden = true;
  }

  /** Creates a CEO's desk at the first news that it exists. */
  #desk(provider: ProviderId): Desk {
    const existing = this.#desks.get(provider);
    if (existing) return existing;

    const root = document.createElement('section');
    root.className = 'boardroom__desk';
    root.style.setProperty('--c', `#${PROVIDER_COLOR[provider].toString(16).padStart(6, '0')}`);

    const head = document.createElement('header');
    head.className = 'boardroom__head';
    const name = document.createElement('span');
    name.className = 'boardroom__name';
    name.textContent = LABEL[provider];
    const state = document.createElement('span');
    state.className = 'boardroom__state';
    state.textContent = STATE_TEXT.idle;
    head.append(name, state);

    const report = document.createElement('div');
    report.className = 'boardroom__report';
    report.hidden = true;

    const answer = document.createElement('div');
    answer.className = 'boardroom__answer';

    const proposals = document.createElement('div');
    proposals.className = 'boardroom__proposals';

    const input = document.createElement('textarea');
    input.className = 'boardroom__input';
    input.id = `boardroom-input-${provider}`;
    input.rows = 2;
    input.placeholder = 'where am I wasting tokens?';
    input.spellcheck = false;

    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'boardroom__send';
    send.textContent = 'ask';

    const desk: Desk = {
      provider, root, state, report, answer, proposals, input, send,
      buffer: '', cards: new Map(), depth: DEFAULT_DEPTH,
      armed: null, picks: new Map(),
    };

    /*
     * The three tiers, above everything else.
     *
     * Above and not below because it is the first decision: it changes the
     * model, and so it changes the bill before you even know what you will
     * ask. It stays where you left it between one question and the next --
     * whoever works fast works fast for a while, not for a single question.
     */
    const depths = document.createElement('div');
    depths.className = 'boardroom__depths';
    const buttons: HTMLButtonElement[] = [];
    for (const d of DEPTHS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'boardroom__depth';
      b.textContent = d.label;
      b.title = d.hint;
      b.dataset['on'] = String(d.kind === desk.depth);
      b.addEventListener('click', () => {
        desk.depth = d.kind;
        for (const other of buttons) other.dataset['on'] = String(other === b);
      });
      buttons.push(b);
      depths.appendChild(b);
    }

    /**
     * A question goes out: make room.
     *
     * The previous report and its proposals are cleared here and not when the
     * new ones arrive: between the two there are tens of seconds in which the
     * old cards would sit under a fresh answer, looking like they came from it.
     */
    const ask = (text: string, analysis: AnalysisKind | null): boolean => {
      if (!text && !analysis) return false;
      // One CEO at a time: the runner rejects a second question anyway while
      // it answers the first, and without this Enter sent it all the same
      // -- the buttons were disabled and the keyboard was not, which is worse
      // than either consistent choice.
      if (desk.send.disabled) return false;
      input.value = '';
      desk.buffer = '';
      answer.textContent = '';
      answer.classList.add('is-waiting');
      report.hidden = true;
      proposals.replaceChildren();
      desk.cards.clear();
      if (this.#both.checked && !this.#bothRow.hidden) {
        this.#act.onMeeting(text, analysis, desk.depth);
      } else {
        this.#act.onAsk(provider, text, analysis, desk.depth);
      }
      return true;
    };

    /**
     * Arming an analysis: the button lights up and the question goes into the
     * text box.
     *
     * Nothing goes out from here. A button that sent on the first click made
     * you pay for a call before letting you read what was being asked, and
     * whoever wanted to add a line to the question had to write it BEFORE
     * knowing what the question was. Pressing the same button again disarms,
     * and the sentence goes away only if it is still the one the button wrote:
     * a change of mind does not erase what you wrote yourself.
     */
    const arm = (kind: AnalysisKind | null): void => {
      const before = desk.armed;
      const next = kind !== null && kind === before ? null : kind;
      desk.armed = next;
      for (const [k, b] of desk.picks) b.dataset['on'] = String(k === next);
      const wasQuestion = before !== null
        && input.value.trim() === questionOf(this.#analyses, before);
      if (next !== null) {
        const q = questionOf(this.#analyses, next);
        // Without the sentence from the server -- CEOs off, or an older server
        // -- it stays armed all the same: the `kind` is the only thing needed.
        if (q && (!input.value.trim() || wasQuestion)) input.value = q;
        input.focus();
      } else if (wasQuestion) {
        input.value = '';
      }
    };

    const picks = document.createElement('div');
    picks.className = 'boardroom__picks';
    for (const p of PICKS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'boardroom__pick';
      b.textContent = p.label;
      b.dataset['on'] = 'false';
      b.addEventListener('click', () => arm(p.kind));
      desk.picks.set(p.kind, b);
      picks.appendChild(b);
    }

    /**
     * What was read from the text box, and the analysis that was armed.
     *
     * If the sentence is still the one the button put there, only the `kind`
     * travels: the question is already written on the server, and sending it
     * back next to the brief would mean paying for it twice in the same
     * prompt. If you touched it, yours travels -- the analysis stays armed
     * because it decides which brief to build, and `structure` is the only one
     * that opens files.
     */
    const submit = (): void => {
      const typed = input.value.trim();
      const armed = desk.armed;
      const text = textToSend(typed, armed === null ? null : questionOf(this.#analyses, armed));
      if (!text && !armed) return;
      // Disarm only if it went out: with a busy CEO the click sends nothing,
      // and losing the chosen analysis as well would add insult to injury.
      if (ask(text, armed)) arm(null);
    };

    send.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      // Enter sends, Shift+Enter breaks the line: it is a question, not an essay.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });

    const row = document.createElement('div');
    row.className = 'boardroom__row';
    row.append(input, send);

    root.append(head, depths, picks, report, answer, proposals, row);
    this.#root.insertBefore(root, this.#foot);
    this.#desks.set(provider, desk);
    return desk;
  }

  /**
   * The analyses as the server declares them, with the sentence they send.
   *
   * They come from the `caps` for the same reason as `ceoProviders`: a client
   * that connects to an already running world would never see an event
   * broadcast at startup. Empty until they arrive, and a button without a
   * sentence arms anyway: the `kind` is the only thing without which the
   * question does not go out.
   */
  setAnalyses(analyses: readonly AnalysisOffer[]): void {
    this.#analyses = analyses;
  }

  /**
   * A CEO's state.
   *
   * `reason` is not decoration: a CEO stopped because the quota is almost used
   * up is indistinguishable from a broken CEO, unless it says why.
   */
  setState(provider: ProviderId, state: CeoState, reason: string | null): void {
    const desk = this.#desk(provider);
    desk.state.textContent = reason ? `${STATE_TEXT[state]} — ${reason}` : STATE_TEXT[state];
    desk.state.dataset['state'] = state;
    this.#setBusy(desk, state === 'thinking' || state === 'starting');
  }

  /** Busy or free, in one place only: two paths lead here. */
  #setBusy(desk: Desk, busy: boolean): void {
    desk.send.disabled = busy;
    desk.send.textContent = busy ? 'asking…' : 'ask';
    for (const b of desk.root.querySelectorAll('.boardroom__pick, .boardroom__depth')) {
      (b as HTMLButtonElement).disabled = busy;
    }
  }

  /** A piece of the answer. It arrives in chunks, as the model writes it. */
  stream(provider: ProviderId, delta: string, done: boolean): void {
    const desk = this.#desk(provider);
    if (delta) {
      desk.buffer += delta;
      renderMarkdown(desk.answer, desk.buffer);
      desk.answer.classList.remove('is-waiting');
      // Follow the answer as it arrives, without having to chase it by hand.
      desk.answer.scrollTop = desk.answer.scrollHeight;
    }
    if (done) {
      desk.answer.classList.remove('is-waiting');
      if (!desk.buffer) desk.answer.textContent = 'No answer.';
      // Re-enable HERE and not only on the state event: they are two separate
      // paths, and if the state one is lost to a resync the panel would stay
      // disabled forever with no way of noticing.
      this.#setBusy(desk, false);
    }
  }

  /**
   * An analysis is over: it gets a name and a price.
   *
   * The cost is shown even when it is zero, because zero here means "the tool
   * did not say" -- `codex exec` prints no price -- and hiding it would let a
   * silence read as free.
   */
  setReport(ev: ReportEvent): void {
    const desk = this.#desk(ev.provider);
    const bits = [ev.title];
    // Quota before dollars: on a subscription you do not pay per token, you
    // use up the windows. The `<=` is not modesty -- the denominator counts
    // only the sessions the program saw close, so the percentage is a cap and
    // must be read as one.
    if (ev.quotaPercent !== null && ev.quotaWindow) {
      const n = ev.quotaPercent < 1 ? ev.quotaPercent.toFixed(2) : ev.quotaPercent.toFixed(1);
      bits.push(`≤${n}% of ${ev.quotaWindow}`);
    }
    if (ev.costUsd > 0) bits.push(`list $${ev.costUsd.toFixed(2)}`);
    // Which model answered: it is what explains the price difference between
    // two identical questions, and without the name it would go unexplained.
    if (ev.model) bits.push(`${ev.depth} · ${ev.model}`);
    desk.report.textContent = bits.join(' · ');
    desk.report.title = ev.quotaPercent !== null
      ? 'Share of the rate-limit window, derived from your own usage. A ceiling: '
        + 'the denominator counts only the sessions this tool watched close. '
        + 'The dollar figure is a list-price equivalent, not money charged.'
      : 'List-price equivalent declared by the tool, not money charged on a subscription.';
    desk.report.hidden = false;
  }

  /**
   * The board was started over, from this window or another one.
   *
   * What is on screen goes -- the answer, its report line, the cards -- and
   * what you are typing stays: it is the next question, not the board. A
   * question stopped by the reset frees its desk with the state event the
   * stop sends, not from here.
   */
  clear(): void {
    for (const desk of this.#desks.values()) {
      desk.buffer = '';
      desk.answer.textContent = '';
      desk.answer.classList.remove('is-waiting');
      desk.report.hidden = true;
      desk.report.textContent = '';
      desk.proposals.replaceChildren();
      desk.cards.clear();
    }
  }

  /** A proposal. By id, so a resync rewrites the same card. */
  setProposal(ev: ProposalEvent): void {
    const desk = this.#desk(ev.provider);
    let card = desk.cards.get(ev.id);
    if (!card) {
      const root = document.createElement('article');
      root.className = 'boardroom__prop';
      card = {
        root,
        kind: document.createElement('span'),
        text: document.createElement('p'),
        status: document.createElement('span'),
        reason: document.createElement('p'),
        project: document.createElement('p'),
        task: document.createElement('p'),
        read: false,
        actions: document.createElement('div'),
      };
      card.kind.className = 'boardroom__prop-kind';
      card.project.className = 'boardroom__prop-project';
      card.task.className = 'boardroom__prop-task';
      card.task.textContent = 'loading what the worker will be told…';
      card.text.className = 'boardroom__prop-text';
      card.status.className = 'boardroom__prop-status';
      card.reason.className = 'boardroom__prop-reason';
      card.actions.className = 'boardroom__prop-actions';

      for (const [label, accept] of [['accept', true], ['reject', false]] as const) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'boardroom__decide';
        b.dataset['accept'] = String(accept);
        b.textContent = label;
        b.addEventListener('click', () => this.#act.onDecide(ev.id, accept));
        card.actions.appendChild(b);
      }

      root.append(card.kind, card.status, card.text, card.project, card.task, card.reason, card.actions);
      desk.cards.set(ev.id, card);
      desk.proposals.appendChild(root);
      // The task, in full, before any yes: it was a tooltip of 127 characters
      // of a text of up to a thousand, written by a model that reads
      // repositories anyone may have written into.
      if (ev.command !== null && ev.status === 'pending') this.#act.onReadTask(ev.id);
    }

    card.kind.textContent = ev.kind;
    card.text.textContent = ev.summary;
    card.project.textContent = ev.project ? `runs in ${ev.project}` : 'names no project';
    // Asked for only while it can still be accepted: a decided card on a
    // resync would cost a thousand characters each, for nothing.
    card.task.hidden = ev.command === null || (!card.read && ev.status !== 'pending');
    card.status.textContent = STATUS_TEXT[ev.status];
    card.status.dataset['status'] = ev.status;
    // An accepted proposal that did not start is indistinguishable from an
    // ignored one, unless it says why. Under `--no-execute` this is the NORMAL
    // outcome, and must be read as such rather than as a failure.
    card.reason.textContent = ev.reason ?? '';
    card.reason.hidden = !ev.reason;
    // You decide once only: after that, the buttons have nothing left to do.
    // Except for a yes that never started (an accepted card at rest: a launch
    // that works turns it `applied` at once) -- that one can be taken back.
    const withdrawable = ev.status === 'accepted';
    card.actions.hidden = ev.status !== 'pending' && !withdrawable;
    for (const b of card.actions.querySelectorAll<HTMLButtonElement>('button')) {
      const yes = b.dataset['accept'] === 'true';
      b.hidden = withdrawable && yes;
      if (!yes) b.textContent = withdrawable ? 'withdraw' : 'reject';
      // No yes to a task you have not been shown.
      if (yes) b.disabled = ev.command !== null && !card.read;
    }
  }

  /** A proposal's task, in full: on the card, and only now can it be accepted. */
  setProposalTask(id: string, task: string | null, project: string | null): void {
    for (const desk of this.#desks.values()) {
      const card = desk.cards.get(id);
      if (!card) continue;
      card.task.textContent = task ?? '';
      card.task.hidden = task === null;
      if (project) card.project.textContent = `runs in ${project}`;
      card.read = true;
      for (const b of card.actions.querySelectorAll<HTMLButtonElement>('button[data-accept="true"]')) b.disabled = false;
    }
  }
}
