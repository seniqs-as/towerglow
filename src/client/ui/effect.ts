import {
  EFFECT_DIRECTION, EFFECT_LABELS, EFFECT_METRICS, EFFECT_MIN_COHORT, EFFECT_NOISE_PERCENT,
} from '../../shared/protocol.ts';
import type { EffectItem, EffectMetricId, EffectPair, ProviderId } from '../../shared/protocol.ts';
import { PROVIDER_COLOR } from '../world/palette.ts';
import { renderMarkdown } from './markdown.ts';
import { twoClicks } from './twoClicks.ts';

/**
 * How it went AFTERWARDS.
 *
 * Board is where you decide, Reports is where you read how the job went in the
 * five minutes after, and this is the third moment: how the PROJECT went in
 * the weeks after. They are three different times of the same day, and the
 * code already says so for the first two -- "next to board, not inside it" --
 * for the same reason this one sits next to Reports: that one answers in five
 * minutes, this one in five sessions, and in the same frame one would keep
 * the other waiting.
 *
 * Nothing is computed here. The medians, the gate and the threshold live on
 * the server, where the history is; this panel only decides how what arrives
 * is read -- and the most important part of that job is STAYING SILENT where
 * the server gave no number, instead of drawing a dash that would look like a
 * zero.
 */

export interface EffectActions {
  /** Give me the board again: it is also the gesture that recomputes the measures. */
  onRead: () => void;
  /** Ask the CEO to try to prove itself wrong. It costs a preamble, and says so. */
  onJudge: (id: string) => void;
  /** Erase the outcome of one job. The server answers with the board again. */
  onDelete: (id: string) => void;
  /** Erase every outcome. The server answers with the board again. */
  onReset: () => void;
}

/* ─────────────────── the decisions, pure and testable ─────────────────── */

export type Tone = 'better' | 'worse' | 'flat' | 'unknown';

/**
 * How much a figure moved, and whether it is worth calling it a movement.
 *
 * The number always comes back; it is the TONE that stays `flat` under the
 * threshold, and it is the same threshold the brief uses to decide what is
 * worth saying. A figure without a direction has no tone even when it moves a
 * lot: `output` and `calls` are read, not judged.
 */
export function changeOf(
  before: number, after: number, dir: 'lower' | 'higher' | 'none',
): { percent: number; tone: Tone } {
  if (before === 0) return { percent: 0, tone: 'unknown' };
  const percent = Math.round(((after - before) / before) * 100);
  if (dir === 'none') return { percent, tone: 'flat' };
  if (Math.abs(percent) < EFFECT_NOISE_PERCENT) return { percent, tone: 'flat' };
  const down = percent < 0;
  return { percent, tone: (dir === 'lower') === down ? 'better' : 'worse' };
}

/** The units differ for each figure, and writing them wrong is worse than leaving them out. */
export function formatValue(id: EffectMetricId, v: number | null): string {
  if (v === null) return '--';
  if (id === 'cache' || id === 'output') return `${Math.round(v)}%`;
  if (id === 'calls') return v.toFixed(1);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

/**
 * One figure row, already decided.
 *
 * `shortfall` is the only thing that replaces a number, and it is not a dash:
 * "2 more after" says the measure is on its way, a dash says there is none
 * and reads as a zero.
 *
 * THE TWO SIDES ARE NOT WAITING FOR THE SAME THING. The "after" grows with
 * every session, so "2 more after" is a promise that comes true; the "before"
 * is a snapshot taken when the job finished and frozen forever
 * (`ceo/effect.ts`), so one more session will NEVER arrive. Saying "1 more
 * before" was a wait that never ends: on a real job that row kept asking for
 * a session nobody could give it.
 */
export function metricRow(id: EffectMetricId, pair: EffectPair): {
  label: string; before: string; after: string;
  change: string | null; tone: Tone; shortfall: string | null;
} {
  const label = EFFECT_LABELS[id];
  const missing = pair.before === null || pair.after === null;
  if (missing) {
    // The before is checked first: if that is missing the figure is lost
    // anyway, and announcing the sessions the after still needs would say
    // it is on its way.
    return {
      label,
      before: formatValue(id, pair.before),
      after: formatValue(id, pair.after),
      change: null,
      tone: 'unknown',
      shortfall: pair.before === null
        ? closedBefore(pair.beforeN)
        : `${Math.max(0, EFFECT_MIN_COHORT - pair.afterN)} more after`,
    };
  }
  // The `missing` above has already ruled out the nulls: TypeScript does not
  // know it because the guard is on two different fields, and rewriting it
  // here is less bad than a non-null assertion on a value that decides a color.
  const c = changeOf(pair.before ?? 0, pair.after ?? 0, EFFECT_DIRECTION[id]);
  return {
    label,
    before: formatValue(id, pair.before),
    after: formatValue(id, pair.after),
    change: `${c.percent > 0 ? '+' : ''}${c.percent}%`,
    tone: c.tone,
    shortfall: null,
  };
}

/**
 * The before was not enough, and never will be: that is how it is said, in
 * the past tense.
 *
 * The number stays because it is information -- two sessions out of three is
 * a different thing from zero -- but the sentence promises nothing, because
 * there is nothing to promise.
 */
function closedBefore(n: number): string {
  return n === 0 ? 'no sessions before' : `only ${n} before`;
}

/** The line above the title, like `metaOf` in Reports. */
export function headlineOf(item: EffectItem): string {
  const bits = [item.kind];
  if (item.projectName) bits.push(item.projectName);
  bits.push(item.provider);
  bits.push(new Date(item.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
  if (item.reviewHolds === false) bits.push('was objected to');
  if (item.workFounded === false) bits.push('request did not hold up');
  return bits.join(' · ');
}

/** The two quota columns, or nothing: never two different windows side by side. */
export function quotaLine(item: EffectItem): string | null {
  if (item.quotaBefore === null || item.quotaAfter === null || item.quotaWindow === null) {
    return null;
  }
  const n = (x: number): string => (x < 1 ? x.toFixed(2) : x.toFixed(1));
  return `<=${n(item.quotaBefore)}% -> <=${n(item.quotaAfter)}% of ${item.quotaWindow}`;
}

/**
 * When it makes sense to spend a call on the judgment.
 *
 * Only on readable numbers: asking a CEO to explain a movement that is not
 * there yet means paying a preamble to be told about the wait.
 */
export function canJudge(item: EffectItem): boolean {
  return item.state === 'read';
}

/**
 * What the button says.
 *
 * "break this attribution" told the prompt's TRADE -- break the link -- to
 * whoever had not read `judge.ts`, i.e. to anyone. The button must say what
 * you get by pressing it: another explanation for these numbers, which is
 * exactly what the CEO is asked to look for.
 *
 * The price is on the button and not in a note beside it: pressing it pays a
 * whole preamble, and a cost discovered afterwards is not a declared cost.
 */
export function askLabel(item: EffectItem, asking: boolean): string {
  if (asking) return 'asking the CEO...';
  return item.judged
    ? 'ask again for another explanation (costs a call)'
    : 'ask the CEO what else could explain this (costs a call)';
}

/** How long until the window closes, or why it closed. */
export function describeWindow(item: EffectItem, now: number): string {
  if (item.closedBy === 'job') return 'window closed by a later job on this project';
  if (item.closedBy === 'time') return 'window closed';
  if (item.closedBy === 'enough') return 'window closed: enough sessions';
  // The deadline comes from the server: it starts from the END of the job, not
  // from when you accepted, and recomputing it here would mean copying in both
  // the duration and the anchor.
  if (item.closesAt === null) return 'window open';
  const days = Math.max(0, Math.ceil((item.closesAt - now) / (24 * 60 * 60 * 1000)));
  return `window closes in ${days} day${days === 1 ? '' : 's'}`;
}

/* ─────────────────────────── the panel ─────────────────────────── */

export class Effect {
  #root: HTMLElement;
  #body: HTMLElement;
  #open = false;
  #act: EffectActions;
  #items: EffectItem[] = [];
  /**
   * The job a judgment is being awaited for, and the prose as it arrives.
   *
   * It lives here and not in the world model because it is not a fact of the
   * world: it is an answer in transit, like a CEO's in the Board panel. The
   * verdict -- the only part that stays -- is written by the server into the
   * job, and comes back from there with the `board` requested as soon as it
   * is done.
   */
  #asking: string | null = null;
  #answerFor: string | null = null;
  #answer = '';

  constructor(host: HTMLElement, button: HTMLElement, act: EffectActions) {
    this.#act = act;

    this.#root = document.createElement('div');
    this.#root.className = 'effect';
    this.#root.hidden = true;

    const panel = document.createElement('div');
    panel.className = 'effect__panel';

    const head = document.createElement('div');
    head.className = 'effect__head';
    const title = document.createElement('h2');
    title.textContent = 'Outcomes';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'effect__close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.close());
    head.append(title, close);

    this.#body = document.createElement('div');
    this.#body.className = 'effect__body';

    panel.append(head, this.#body);
    this.#root.appendChild(panel);

    // The veil closes, the panel does not: clicking inside to read must not
    // make it disappear.
    this.#root.addEventListener('click', (e) => {
      if (e.target === this.#root) this.close();
    });
    panel.addEventListener('click', (e) => e.stopPropagation());
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
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
    else this.open();
  }

  open(): void {
    this.#open = true;
    this.#root.hidden = false;
    // It is requested on opening, and that is also the gesture that recomputes:
    // without it the measure would never move on its own, and that is intended.
    this.#act.onRead();
    this.#render();
  }

  close(): void {
    this.#open = false;
    this.#root.hidden = true;
    this.#body.replaceChildren();
    // The prose goes away with the panel; the verdict does not, it is on disk.
    this.#answerFor = null;
    this.#answer = '';
  }

  /**
   * A piece of the answer to the judgment, if this panel is the one that
   * asked for it. Returns `false` when it is waiting for nothing, and then the
   * stream belongs to the Board panel.
   *
   * It is needed because `ceo.stream` does not say which question it answers:
   * there is only one channel per tool. Without this capture the explanation
   * of these numbers came out in the other panel -- which may be closed -- and
   * here the click produced NOTHING for the whole length of the preamble.
   */
  stream(provider: ProviderId, delta: string, done: boolean): boolean {
    if (this.#asking === null) return false;
    // There is one channel per TOOL: while waiting for one CEO's judgment, a
    // question to the other may be running in the Board panel, and that answer
    // is not this one. The provider is derived from the job, so there is no
    // second field that could fall behind.
    const mine = this.#items.find((i) => i.jobId === this.#asking);
    if (mine !== undefined && mine.provider !== provider) return false;
    this.#answer += delta;
    if (done) {
      this.#asking = null;
      if (!this.#answer) this.#answer = 'No answer.';
      // The verdict has been written into the job: request the board again,
      // the same road as always instead of a second copy in here.
      this.#act.onRead();
    }
    this.#render();
    return true;
  }

  /** The board has arrived. */
  setBoard(items: EffectItem[]): void {
    this.#items = items;
    this.#render();
  }

  #render(): void {
    if (!this.#open) return;
    const now = Date.now();
    this.#body.replaceChildren();

    if (this.#items.length === 0) {
      const empty = div('effect__empty');
      empty.textContent = 'Nothing measured yet. Accept a proposal and this fills in '
        + 'as sessions close in that project.';
      this.#body.appendChild(empty);
      return;
    }

    for (const item of this.#items) this.#body.appendChild(this.#card(item, now));

    // Under the cards, the same quiet button as Reports'.
    const foot = div('effect__foot');
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'effect__restart';
    reset.title = 'Erase every outcome. The jobs stay in Reports.';
    twoClicks(reset, 'delete all', 'erase everything? click again', () => this.#act.onReset());
    foot.appendChild(reset);
    this.#body.appendChild(foot);
  }

  #card(item: EffectItem, now: number): HTMLElement {
    const card = div('effect__card');
    card.dataset['state'] = item.state;

    const head = div('effect__card-head');
    const dot = div('effect__dot');
    dot.style.background = hex(PROVIDER_COLOR[item.provider]);
    head.append(dot, span('effect__meta', headlineOf(item)));
    card.appendChild(head);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'effect__del';
    del.title = 'Erase this outcome. The job stays in Reports.';
    twoClicks(del, 'delete', 'erase it? click again', () => this.#act.onDelete(item.jobId));
    head.appendChild(del);

    card.appendChild(span('effect__summary', item.summary));
    if (item.workDid) card.appendChild(span('effect__did', `→ ${item.workDid}`));

    if (item.state === 'void') {
      card.appendChild(note(item.reason));
      return card;
    }

    const table = div('effect__metrics');
    for (const id of EFFECT_METRICS) {
      const r = metricRow(id, item.metrics[id]);
      const line = div('effect__metric');
      line.dataset['tone'] = r.tone;
      // Both values are ALWAYS shown, even when one is missing: the side that
      // is there is a measured number, and hiding it because of the other
      // would mean throwing away what is known because the rest is not.
      line.append(
        span('effect__metric-label', r.label),
        span('effect__metric-from', r.before),
        span('effect__metric-arrow', '→'),
        span('effect__metric-to', r.after),
        r.shortfall
          ? span('effect__metric-wait', r.shortfall)
          : span('effect__metric-change', r.change ?? ''),
      );
      table.appendChild(line);
    }
    card.appendChild(table);

    const quota = quotaLine(item);
    if (quota) card.appendChild(note(quota));

    card.appendChild(note(
      `${item.beforeSessions} sessions before, ${item.afterSessions} after`
      + ` · ${item.provider} only · ${describeWindow(item, now)}`,
    ));
    card.appendChild(note(item.reason));

    if (item.judged) {
      const j = div('effect__verdict');
      j.dataset['attributed'] = String(item.judged.attributed);
      j.append(
        span('effect__verdict-head', item.judged.attributed
          ? `the ${item.provider} CEO could not explain it away:`
          : `the ${item.provider} CEO could not claim it:`),
        span('effect__verdict-why', item.judged.why),
      );
      card.appendChild(j);
    }

    if (canJudge(item)) {
      const waiting = this.#asking === item.jobId;
      const ask = document.createElement('button');
      ask.type = 'button';
      ask.className = 'effect__ask';
      ask.disabled = waiting;
      ask.textContent = askLabel(item, waiting);
      ask.addEventListener('click', () => {
        // The state changes BEFORE the answer: between the click and the first
        // word there is a whole preamble, and a button that does not move for
        // twenty seconds reads as a broken button.
        this.#asking = item.jobId;
        this.#answerFor = item.jobId;
        this.#answer = '';
        this.#render();
        this.#act.onJudge(item.jobId);
      });
      card.appendChild(ask);

      if (this.#answerFor === item.jobId) {
        const prose = div('effect__answer');
        renderMarkdown(prose, this.#answer || 'The CEO is reading the numbers...');
        if (waiting) prose.classList.add('is-waiting');
        card.appendChild(prose);
      }
    }

    return card;
  }
}

/* ─────────────────────────── building blocks ─────────────────────────── */

function div(cls: string): HTMLElement {
  const el = document.createElement('div');
  el.className = cls;
  return el;
}

function span(cls: string, text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

function note(text: string): HTMLElement {
  return span('effect__note', text);
}

function hex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}
