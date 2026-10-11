import type { ProviderId, ProviderLimits } from '../../shared/protocol.ts';
import { formatElapsed } from './format.ts';
import {
  describeProvider, describeWindow, detailWindow, forecastProvider, levelOf,
} from './forecast.ts';
import type { WindowForecast } from './forecast.ts';

export interface ForecastInput {
  limits: Map<ProviderId, ProviderLimits>;
  now: number;
}

/**
 * The usage forecasts, beside the legend.
 *
 * It comes from the same question as the legend -- "this thing I am looking
 * at, what does it mean?" -- aimed at the quota bars: 68% of a seven-day
 * window does not tell you whether you make it to Wednesday. That is why it
 * opens from the same corner and with the same frame, and why it is a panel
 * to consult instead of a number always on screen: a forecast is looked at
 * when you have to decide whether to keep going, not every second.
 *
 * It holds no state: it recomputes from `limits` on every draw. The pace is a
 * division between two numbers that arrive together -- the percentage and
 * the reset -- so there is nothing to accumulate, and nothing that can fall
 * behind what the bars show.
 */
export class ForecastPanel {
  #root: HTMLElement;
  #open = false;
  /** The last state seen, so the panel can be opened from a click alone. */
  #last: ForecastInput | null = null;

  constructor(host: HTMLElement, button: HTMLElement) {
    this.#root = document.createElement('aside');
    this.#root.className = 'forecast';
    this.#root.hidden = true;
    this.#root.setAttribute('aria-label', 'Usage forecast');

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle({ limits: this.#last?.limits ?? new Map(), now: Date.now() });
    });
    // Closes on a click outside or on Esc, but not on a click inside: like the
    // legend, it is a panel to be read.
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

  /** Keeps what would be shown up to date, even while the panel is closed. */
  update(input: ForecastInput): void {
    this.#last = input;
    if (this.#open) this.render(input);
  }

  toggle(input: ForecastInput): void {
    if (this.#open) this.close();
    else this.open(input);
  }

  open(input: ForecastInput): void {
    this.#open = true;
    this.#root.hidden = false;
    this.render(input);
  }

  close(): void {
    this.#open = false;
    this.#root.hidden = true;
    this.#root.replaceChildren();
  }

  render(input: ForecastInput): void {
    this.#last = input;
    if (!this.#open) return;
    this.#root.replaceChildren(...content(input));
  }
}

/* ─────────────────────────── bricks ─────────────────────────── */

function content(input: ForecastInput): HTMLElement[] {
  const providers = [...input.limits.values()];
  if (providers.length === 0) {
    return [
      note(
        'No quota reported yet, so there is nothing to project: without a percentage and the ' +
        'instant it restarts, tokens alone do not say how much of the period is left.',
      ),
      note('Claude Code publishes it through the statusline bridge; Codex through its rollout.'),
    ];
  }

  const out: HTMLElement[] = [];
  for (const limits of providers) {
    const f = forecastProvider(limits, input.now);
    const box = document.createElement('section');
    box.className = 'forecast__tool';
    box.dataset['provider'] = f.provider;

    const h = document.createElement('h3');
    h.append(text('forecast__name', f.provider === 'claude' ? 'Claude Code' : 'Codex CLI'));
    if (f.plan) h.append(text('forecast__plan', f.plan.toUpperCase()));
    box.append(h);

    const head = document.createElement('p');
    head.className = 'forecast__head';
    head.dataset['verdict'] = f.worst ? 'early' : f.windows.some((w) => w.verdict === 'ok') ? 'ok' : 'unknown';
    head.textContent = describeProvider(f, input.now);
    box.append(head);

    for (const w of f.windows) box.append(windowRow(w, input.now));

    // An old quota is not a quota: the pace it shows is the one from when it
    // was written, and the reader has to know that before trusting it.
    const age = input.now - f.measuredAt;
    if (age > 120_000) box.append(note(`measured ${formatElapsed(age)} ago`));

    out.push(box);
  }

  out.push(
    note(
      'The pace is the average since the window opened, carried to the end of it: it answers ' +
      '"if I keep going like this", not "if I stop now".',
    ),
  );
  return out;
}

function windowRow(f: WindowForecast, now: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'forecast__win';
  row.dataset['level'] = levelOf(f);

  // The model beside the span: two `7d` windows with different percentages
  // and without the name of whoever uses them would look like a bug.
  row.append(
    text('forecast__label', f.model ? `${f.label} ${f.model}` : f.label),
    text('forecast__pct', `${Math.round(f.usedPercent)}%`),
  );

  const body = document.createElement('span');
  body.className = 'forecast__text';
  body.append(
    text('forecast__line', describeWindow(f, now)),
    text('forecast__detail', detailWindow(f, now)),
  );
  row.append(body);
  return row;
}

function text(className: string, content: string): HTMLElement {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = content;
  return s;
}

function note(content: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'forecast__note';
  p.textContent = content;
  return p;
}
