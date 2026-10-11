import type { DeltaEvent, JobState, ProviderId } from '../../shared/protocol.ts';
import { renderMarkdown } from './markdown.ts';
import { twoClicks } from './twoClicks.ts';

/**
 * Reports: how it went.
 *
 * It is the archive of JOBS -- the ones you started by accepting a piece of
 * advice -- and not of analysis reports, which stay in board where you asked
 * for them. The split is not for convenience: in board you decide, here you
 * read what happened after deciding, and they are two different moments of
 * the same day.
 *
 * Before this panel the outcome existed nowhere: the fleet read the worker's
 * stdout to count its calls and threw the answer away. You accepted a piece
 * of advice, the turret went dark, and of how it had gone no trace was left.
 *
 * The text does NOT arrive with the job: it is thousands of characters, and
 * the delta channel carries metadata. It is requested by opening the row
 * (`job.read`) and comes back to whoever asked, like a CEO's answer.
 */

export interface ReportsActions {
  /** Ask for this job's outcome. It comes back through `setOutcome`. */
  onRead: (jobId: string) => void;
  /** Open a window with everything the job's session did. The answer comes through `reportResult`. */
  onWatch: (jobId: string) => void;
  /** Open the `index`-th document the worker wrote. The answer comes through `reportResult`. */
  onOpen: (jobId: string, index: number) => void;
  /** Start Reports over. The server clears it and tells everyone: see `clear`. */
  onReset: () => void;
}

export type JobEvent = Extract<DeltaEvent, { t: 'job' }>;

/**
 * The two things a row can open besides its texts: the session's log, and
 * the documents the worker wrote.
 *
 * The log needs a session -- a job whose worker never surfaced has no
 * transcript to show -- and it does not wait for the end: a running job's
 * window follows it, as a click on its astronaut would. Both need the
 * server's `focus` capability, because both open a window on this machine:
 * with `--no-focus` the buttons are not offered rather than refused.
 */
export function actionsOf(
  job: Pick<JobEvent, 'sessionId' | 'workWrote'>, focus: boolean,
): { log: boolean; docs: string[] } {
  if (!focus) return { log: false, docs: [] };
  return { log: job.sessionId !== null, docs: [...job.workWrote] };
}

/**
 * The text we are holding is stale: it must be requested again.
 *
 * The review always arrives AFTER the outcome -- the review finishes last,
 * because it judges something that must exist first -- and whoever had opened
 * the row in the meantime had taken home an answer without a second opinion.
 * The text is requested only once, so that review NEVER arrived afterwards
 * without reloading the page: the verdict appeared in the row ("the session
 * OBJECTED") and the text below stayed what it had been. Seen in the field.
 *
 * Only the two states are compared, not the whole event: a job that is growing
 * sends an event on every tool call, and dropping the cache there would mean
 * requesting ten thousand characters every few seconds, while you are reading
 * them.
 */
export function textIsStale(before: JobEvent, after: JobEvent): boolean {
  return before.state !== after.state || before.reviewState !== after.reviewState;
}

interface Row {
  root: HTMLElement;
  head: HTMLElement;
  title: HTMLElement;
  /** What was done, under what had been asked. */
  did: HTMLElement;
  meta: HTMLElement;
  /**
   * The two controls, always in plain sight under the title.
   *
   * Before, the whole row was the target and the only hint was a little
   * triangle in front of the meta: you had to know that clicking "the session
   * OBJECTED" opened something, and the review button lived INSIDE the open
   * row, so it was invisible until that click. Two hidden hints in a row make
   * something nobody finds. Now the two texts announce themselves in words --
   * read the outcome, agent's feedback -- and each opens its own.
   */
  tabs: HTMLElement;
  outcomeTab: HTMLElement;
  /**
   * The session's log and the documents it wrote, as buttons.
   *
   * Rebuilt at every render: the list of documents arrives once, at the end,
   * and a button per document is cheaper to remake than to reconcile.
   */
  acts: HTMLElement;
  /** What came out of it. */
  body: HTMLElement;
  /**
   * What whoever works there thinks of it. Behind a control of its own, and
   * closed by default: the outcome answers the question you asked, the review
   * answers a different one -- does it hold up? -- and whoever opens the row
   * is looking for the first.
   */
  verdictTab: HTMLElement;
  verdict: HTMLElement;
  open: boolean;
  /** The review is open. Independent of `open`: they are two separate choices. */
  verdictOpen: boolean;
}

/**
 * What is shown of the review: the control, and the text below it.
 *
 * The control exists only if a review really exists -- no review, no control,
 * because something that opens onto nothing would say the answer is missing
 * rather than never asked for. The text follows the control and not the row:
 * it opens when you open it.
 *
 * It looks at the review's STATE and not at the text: the text arrives only
 * after you have opened the row, and a control appearing at that point would
 * again be a hint that shows up too late to help. `failed` counts as done:
 * there is a why to read, and it is what you want to know.
 */
export function verdictVisibility(
  reviewState: JobEvent['reviewState'], open: boolean,
): { button: boolean; text: boolean } {
  const has = reviewState === 'done' || reviewState === 'failed';
  return { button: has, text: has && open };
}

/**
 * The outcome can be read once WHOEVER DID THE WORK has finished.
 *
 * Not when the whole job ends: that runs while either of its two parts runs,
 * so while the second opinion ran the job read "running" and the outcome --
 * which existed, was written, and was the thing you wanted to read -- stayed
 * hidden until the opinion was done.
 */
export function outcomeReadable(workState: JobState): boolean {
  return workState !== 'running';
}

/** A job's two texts, as they arrive from the server. */
interface Outcome {
  text: string;
  review: string | null;
}

const STATE_TEXT: Record<JobEvent['state'], string> = {
  running: 'working',
  done: 'done',
  failed: 'failed',
};

export class Reports {
  #root: HTMLElement;
  #button: HTMLElement;
  #list: HTMLElement;
  #empty: HTMLElement;
  #foot: HTMLElement;
  #act: ReportsActions;
  #open = false;
  #jobs = new Map<string, JobEvent>();
  #rows = new Map<string, Row>();
  /** The outcomes already received: asking twice would be a wasted round trip. */
  #texts = new Map<string, Outcome>();
  /** The server can open windows here. Assumed until the caps say otherwise. */
  #focus = true;
  /**
   * The row `open` was asked for, while its outcome is still on the way.
   *
   * The text comes back after the panel opens, and a row brought into view
   * while it was a title and two buttons grew past the panel's bottom when
   * it landed. Measured: `read` on a task in Planning opened Reports with the
   * outcome's first line on the lower border and the rest below it.
   */
  #reading: string | null = null;

  constructor(host: HTMLElement, button: HTMLElement, act: ReportsActions) {
    this.#act = act;
    this.#button = button;

    this.#root = document.createElement('aside');
    this.#root.className = 'reports';
    this.#root.hidden = true;
    this.#root.setAttribute('aria-label', 'Reports');

    this.#empty = document.createElement('p');
    this.#empty.className = 'reports__empty';
    this.#empty.textContent = 'Nothing yet. Accept a proposal in board and it shows up here.';

    this.#list = document.createElement('div');
    this.#list.className = 'reports__list';

    // Start over, under the list: the same two clicks as Planning's. Hidden
    // with nothing to erase, where the empty line already says so.
    this.#foot = document.createElement('footer');
    this.#foot.className = 'reports__foot';
    this.#foot.hidden = true;
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'reports__restart';
    reset.title = 'Erase every job in Reports. Jobs still running stay: a process is working for them. '
      + 'What the CEOs remember of past work stays, and the old jobs are archived on disk.';
    twoClicks(reset, 'start over', 'erase everything? click again', () => this.#act.onReset());
    this.#foot.appendChild(reset);

    this.#root.append(this.#empty, this.#list, this.#foot);

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
  }

  get isOpen(): boolean {
    return this.#open;
  }

  toggle(): void {
    if (this.#open) this.close();
    else this.show();
  }

  show(): void {
    this.#open = true;
    this.#root.hidden = false;
    this.#button.dataset['on'] = 'yes';
  }

  close(): void {
    this.#open = false;
    this.#reading = null;
    this.#root.hidden = true;
    delete this.#button.dataset['on'];
  }

  /**
   * A job has changed.
   *
   * Finished ones stay too, however old: this panel is the one place a job
   * never leaves.
   */
  setJob(job: JobEvent): void {
    const before = this.#jobs.get(job.id);
    this.#jobs.set(job.id, job);
    if (before && textIsStale(before, job)) this.#forget(job.id);
    this.#render();
  }

  /**
   * Reports was started over, from this window or another one: every job
   * not in `keep` goes, with its cached text. `keep` is what the server kept
   * -- the running ones -- so nothing here decides what survives.
   */
  clear(keep: readonly string[]): void {
    const stays = new Set(keep);
    for (const id of [...this.#jobs.keys()]) {
      if (stays.has(id)) continue;
      this.#jobs.delete(id);
      this.#texts.delete(id);
      if (this.#reading === id) this.#reading = null;
    }
    this.#render();
  }

  /**
   * The cached text is no longer valid: drop it, and if the row is open before
   * the reader's eyes request it right away instead of waiting for them to
   * close it again.
   */
  #forget(id: string): void {
    if (!this.#texts.delete(id)) return;
    const row = this.#rows.get(id);
    // ONE of the two boxes being open is enough: whoever is reading the review
    // must not notice that the outcome was closed.
    if (!row || (!row.open && !row.verdictOpen)) return;
    this.#ask(id, row);
  }

  /**
   * The outcomes, arrived: the job's and that of whoever judged it.
   *
   * Together and not in two places: they are the same answer to the same
   * question, and separating them would mean not reading the second.
   */
  setOutcome(
    id: string, text: string, truncated: boolean,
    review: string | null, reviewTruncated: boolean,
  ): void {
    this.#texts.set(id, {
      text: cut(text, truncated),
      review: review === null ? null : cut(review, reviewTruncated),
    });
    this.#paint(id);
  }

  /**
   * Open the panel on one job: where Planning sends you to read a task's outcome.
   *
   * The row goes to the top and not just into view, so the outcome has the
   * panel under it; if the text is still to come, it goes there again when
   * it lands (`#paint`).
   */
  open(id: string): void {
    this.show();
    const row = this.#rows.get(id);
    if (!row) return;
    if (!row.open) this.#toggleRow(id);
    this.#reading = this.#texts.has(id) ? null : id;
    row.root.scrollIntoView({ block: 'start' });
  }

  /** Whether the server can open windows here (`caps.focus`). Off, the log and open buttons are not offered. */
  setFocus(focus: boolean): void {
    if (this.#focus === focus) return;
    this.#focus = focus;
    this.#render();
  }

  /**
   * What came of a click on log or open: the button says it, for a moment.
   *
   * The window opening is the real answer; this is for when it did not, and
   * the reason goes where you are looking -- on the button -- as the
   * terminal button of a badge does.
   */
  reportResult(id: string, action: 'watch' | 'open', ok: boolean, reason: string | null): void {
    const row = this.#rows.get(id);
    if (!row) return;
    for (const b of row.acts.querySelectorAll<HTMLElement>(`[data-action="${action}"]`)) {
      b.dataset['state'] = ok ? 'ok' : 'fail';
      const title = b.dataset['title'] ?? '';
      b.title = !ok && reason ? reason : title;
      setTimeout(() => {
        delete b.dataset['state'];
        b.title = title;
      }, 1800);
    }
  }

  #render(): void {
    // Most recent on top: it is the one you are wondering how it went.
    const jobs = [...this.#jobs.values()].sort((a, b) => b.at - a.at);
    this.#empty.hidden = jobs.length > 0;
    this.#foot.hidden = jobs.length === 0;

    for (const [id, row] of this.#rows) {
      if (this.#jobs.has(id)) continue;
      row.root.remove();
      this.#rows.delete(id);
    }

    for (const job of jobs) {
      const row = this.#rows.get(job.id) ?? this.#addRow(job.id);
      row.title.textContent = job.summary;
      // The worker's line, when it left one. The prefix is a sign of
      // consequence: the one above is what you asked, this one what came of
      // it.
      row.did.textContent = job.workDid ? `\u2192 ${job.workDid}` : '';
      row.did.hidden = !job.workDid;
      row.meta.textContent = metaOf(job);
      row.root.dataset['state'] = job.state;
      row.root.dataset['objected'] = job.reviewHolds === false ? 'yes' : 'no';
      row.root.dataset['unfounded'] = job.workFounded === false ? 'yes' : 'no';
      row.head.style.setProperty('--c', colorOf(job.provider));
      /*
       * `workState` and not `state`: the job runs on while only the second
       * opinion does, and by then its outcome EXISTS. With `state` it stayed
       * hidden until the opinion ended -- exactly when you most wanted to read
       * it, because it is what the opinion is judging.
       */
      const readable = outcomeReadable(job.workState);
      row.head.toggleAttribute('disabled', !readable);
      row.tabs.hidden = !readable;
      // The review control is decided from the STATE, not the text: the text
      // arrives only after opening, and a hint that shows up later is no use.
      row.verdictTab.hidden = !verdictVisibility(job.reviewState, row.verdictOpen).button;
      // Two names for two things: the review of whoever worked there, or the
      // check by a session opened just now.
      row.verdictTab.textContent = job.reviewFresh === true
        ? 'premise check'
        : "agent's feedback";

      // The log and the documents: buttons remade each time, from the event.
      const acts = actionsOf(job, this.#focus);
      row.acts.replaceChildren();
      if (acts.log) {
        row.acts.appendChild(this.#actButton(
          'session log', 'watch',
          job.workState === 'running'
            ? 'Opens a Terminal window that follows the session, read-only.'
            : 'Opens a Terminal window with everything the session did, read-only.',
          () => this.#act.onWatch(job.id),
        ));
      }
      acts.docs.forEach((file, index) => {
        row.acts.appendChild(this.#actButton(
          `open ${file}`, 'open', 'Opens the document the worker wrote, in the project.',
          () => this.#act.onOpen(job.id, index),
        ));
      });
      row.acts.hidden = row.acts.childElementCount === 0;

      // The order changes when a new one arrives, and the DOM must follow it.
      this.#list.appendChild(row.root);
    }
  }

  #addRow(id: string): Row {
    const root = document.createElement('div');
    root.className = 'reports__row';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'reports__head';

    const meta = document.createElement('span');
    meta.className = 'reports__meta';
    const title = document.createElement('span');
    title.className = 'reports__title';
    /*
     * What was done, under what had been asked.
     *
     * Two lines and not one: the title is the PROPOSAL's summary, i.e. the
     * CEO's sentence, and it stayed the only readable thing even when the
     * worker had opened its answer by contradicting it -- "review 20 commits"
     * on a project that had 72. The difference between the two lines is the
     * only information you previously had to go looking for by opening the
     * outcome.
     */
    const did = document.createElement('span');
    did.className = 'reports__did';
    did.hidden = true;
    head.append(meta, title, did);

    const body = document.createElement('div');
    body.className = 'reports__body';
    body.hidden = true;

    // The controls sit OUTSIDE the head and not inside it: a button cannot
    // contain a button, and the head is a button because the whole row stays
    // a target for whoever has already figured out how it works.
    const tabs = document.createElement('div');
    tabs.className = 'reports__tabs';
    tabs.hidden = true;

    const outcomeTab = document.createElement('button');
    outcomeTab.type = 'button';
    outcomeTab.className = 'reports__tab';
    outcomeTab.textContent = 'read the outcome';
    outcomeTab.dataset['open'] = 'no';
    outcomeTab.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#toggleRow(id);
    });

    const verdictTab = document.createElement('button');
    verdictTab.type = 'button';
    verdictTab.className = 'reports__tab reports__tab--verdict';
    // The label is decided in `#render`, where it is known who the review comes from.
    verdictTab.textContent = "agent's feedback";
    verdictTab.hidden = true;
    verdictTab.dataset['open'] = 'no';
    verdictTab.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#toggleVerdict(id);
    });

    tabs.append(outcomeTab, verdictTab);

    // Under the two texts' controls and apart from them: these open windows,
    // not boxes in the row, and they are there for a running job too.
    const acts = document.createElement('div');
    acts.className = 'reports__acts';
    acts.hidden = true;

    const verdict = document.createElement('div');
    verdict.className = 'reports__body reports__verdict';
    verdict.hidden = true;

    head.addEventListener('click', () => this.#toggleRow(id));
    root.append(head, tabs, acts, body, verdict);
    this.#list.appendChild(root);

    const row: Row = {
      root, head, title, did, meta, tabs, outcomeTab, acts,
      body, verdictTab, verdict, open: false, verdictOpen: false,
    };
    this.#rows.set(id, row);
    return row;
  }

  /** One of the buttons that open a window. `data-title` keeps the tooltip `reportResult` puts back. */
  #actButton(label: string, action: 'watch' | 'open', title: string, on: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'reports__tab reports__tab--act';
    b.textContent = label;
    b.title = title;
    b.dataset['action'] = action;
    b.dataset['title'] = title;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      on();
    });
    return b;
  }

  /** The outcome opens and closes without touching the review: they are two choices. */
  #toggleRow(id: string): void {
    const row = this.#rows.get(id);
    if (!row) return;
    row.open = !row.open;
    row.body.hidden = !row.open;
    row.root.dataset['open'] = row.open ? 'yes' : 'no';
    mark(row.outcomeTab, row.open);
    if (!row.open) return;
    if (this.#texts.has(id)) {
      this.#paint(id);
      return;
    }
    this.#ask(id, row);
  }

  /**
   * The review opens and closes on its own, without touching the outcome.
   *
   * They are two answers to two different questions: how it went, and does
   * it hold up. Closing the second to read the first must not cost the first
   * -- and it is also why you can open ONLY the review: whoever read "the
   * session OBJECTED" wants to know what it objected to, not to reread the
   * job.
   */
  #toggleVerdict(id: string): void {
    const row = this.#rows.get(id);
    const job = this.#jobs.get(id);
    if (!row || !job) return;
    row.verdictOpen = !row.verdictOpen;
    mark(row.verdictTab, row.verdictOpen);
    row.verdict.hidden = !verdictVisibility(job.reviewState, row.verdictOpen).text;
    // The text may never have been requested: you can get here without having
    // opened the outcome, and then the request goes out from this click.
    if (row.verdictOpen && !this.#texts.has(id)) this.#ask(id, row);
  }

  /**
   * Request the text, and say so while waiting: a box that opens and stays
   * empty reads as an answer that does not exist.
   *
   * BOTH boxes say it, because there is no knowing which of the two you are
   * looking at: the request is a single one and serves both.
   */
  #ask(id: string, row: Row): void {
    row.body.textContent = 'reading…';
    row.verdict.textContent = 'reading…';
    this.#act.onRead(id);
  }

  /** The two texts inside the row, when they are there. */
  #paint(id: string): void {
    const row = this.#rows.get(id);
    const got = this.#texts.get(id);
    const job = this.#jobs.get(id);
    if (!row || !got || !job) return;
    renderMarkdown(row.body, got.text || 'it produced no answer.');
    const show = verdictVisibility(job.reviewState, row.verdictOpen);
    row.verdictTab.hidden = !show.button;
    row.verdict.hidden = !show.text;
    // The text is written anyway: if the control is closed you find it
    // already here when you open it, without a second request to the server.
    // A review that ended badly may have produced nothing, and then that is
    // said instead of opening an empty box.
    if (show.button) renderMarkdown(row.verdict, got.review || 'it produced no answer.');
    if (this.#reading === id) {
      this.#reading = null;
      row.root.scrollIntoView({ block: 'start' });
    }
  }
}

/**
 * A control that says whether it is open, to those who look and those who
 * listen.
 *
 * `data-open` moves the little triangle in the CSS, `aria-expanded` says the
 * same thing to a screen reader: two ways of reading the same state, and
 * writing only one would mean that for someone the panel has no hints.
 */
function mark(tab: HTMLElement, open: boolean): void {
  tab.dataset['open'] = open ? 'yes' : 'no';
  tab.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/** A cut text says so: stopping halfway in silence looks like a fault. */
function cut(text: string, truncated: boolean): string {
  return truncated ? `${text}\n\n[...] the rest was cut: the answer went past the cap.` : text;
}

function colorOf(provider: ProviderId): string {
  return provider === 'codex' ? '#7ee787' : '#ff9d5c';
}

/** The line above the title: who, where, how long it took, what it cost. */
export function metaOf(job: JobEvent): string {
  const bits: string[] = [job.kind];
  if (job.projectName) bits.push(job.projectName);
  bits.push(STATE_TEXT[job.state]);
  if (job.endedAt !== null) bits.push(minutes(job.endedAt - job.at));
  if (job.toolCalls > 0) bits.push(`${job.toolCalls} tool calls`);
  // Zero also means "not said": `codex exec` prints no price, and a zero on
  // screen would read as "free".
  if (job.costUsd > 0) bits.push(`$${job.costUsd.toFixed(2)}`);
  // The verdict in one word. An objection is the only thing the CEO could not
  // have known, and it must be seen without opening the row.
  /*
   * What whoever DID the job says, before what whoever judges it says: it
   * always arrives first, costs nothing -- it comes from a process that was
   * working anyway -- and in the two measured cases it was right two times out
   * of two. Before, it lived only inside the CEO's memory.
   */
  if (job.workFounded === false) bits.push('the request did not hold up');
  /*
   * Who gave the review changes how much it weighs, so it changes the words.
   *
   * "the session" is whoever worked there, resumed with a fork: it knows why
   * the work was done that way. "a fresh check" is a session opened for the
   * occasion, which does not know that and verified the premises against the
   * repository. Writing the second like the first would grant it an authority
   * it does not have.
   */
  const who = job.reviewFresh === true ? 'a fresh check' : 'the session';
  if (job.reviewHolds === false) bits.push(`${who} OBJECTED`);
  else if (job.reviewHolds === true) bits.push(`${who} agrees`);
  else if (job.reviewState === 'running') {
    bits.push(job.reviewFresh === true ? 'checking the premises' : 'asking the session');
  }
  // Nobody asked it, and that shows before opening anything: it is the
  // difference between "the session did not object" and "there was no session
  // to ask", which read as the same thing unless it is said.
  else if (job.reviewState === null && job.workState !== 'running') {
    bits.push('no second opinion yet');
  }
  // A planned attempt that stopped on a question: the answer is typed in
  // Planning, and this row must send you there, not to the outcome.
  if (job.asks) bits.push('asked you: answer it in Planning');
  if (job.state === 'failed' && job.reason) bits.push(job.reason);
  return bits.join(' · ');
}

function minutes(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
