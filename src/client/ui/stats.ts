import type {
  FileNode, ProjectInfo, ProviderId, ProviderLimits, SessionInfo, TokenTotals,
} from '../../shared/protocol.ts';
import { windowNow } from '../../shared/limits.ts';
import { TOOL_COLOR } from '../world/palette.ts';
import { describeActivity, formatElapsed } from './format.ts';

export interface StatsInput {
  projects: Iterable<ProjectInfo>;
  sessions: Iterable<SessionInfo>;
  files: Iterable<FileNode>;
  limits: Map<ProviderId, ProviderLimits>;
  toolsByCat: Map<string, number>;
  countingSince: number;
}

/**
 * The numbers panel.
 *
 * The city answers "what is happening right now"; this answers "how much did
 * it cost and where did it go". They are two different questions, and mixing
 * them would fill the scene with figures that are almost never looked at --
 * that is why it sits behind a button instead of on screen.
 *
 * It computes nothing new: it aggregates what the model already has. Every
 * row here can be traced back to data that went through the redaction choke
 * point.
 */
export class Stats {
  #root: HTMLElement;
  #body: HTMLElement;
  #open = false;

  constructor(host: HTMLElement) {
    this.#root = document.createElement('div');
    this.#root.className = 'stats';
    this.#root.hidden = true;

    const panel = document.createElement('div');
    panel.className = 'stats__panel';

    const head = document.createElement('div');
    head.className = 'stats__head';
    const title = document.createElement('h2');
    title.textContent = 'Statistics';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'stats__close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.close());
    head.append(title, close);

    this.#body = document.createElement('div');
    this.#body.className = 'stats__body';

    panel.append(head, this.#body);
    this.#root.appendChild(panel);

    // The veil closes, the panel does not: clicking inside to read must not
    // make it disappear.
    this.#root.addEventListener('click', (e) => {
      if (e.target === this.#root) this.close();
    });
    panel.addEventListener('click', (e) => e.stopPropagation());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.#open) this.close();
    });

    host.appendChild(this.#root);
  }

  get isOpen(): boolean {
    return this.#open;
  }

  toggle(input: StatsInput): void {
    if (this.#open) this.close();
    else this.open(input);
  }

  open(input: StatsInput): void {
    this.#open = true;
    this.#root.hidden = false;
    this.render(input);
  }

  close(): void {
    this.#open = false;
    this.#root.hidden = true;
    this.#body.replaceChildren();
  }

  /** Redraws. Called while it is open too: the numbers change underneath. */
  render(input: StatsInput): void {
    if (!this.#open) return;
    const projects = [...input.projects];
    const sessions = [...input.sessions];
    const files = [...input.files];

    const totals = totalsOf(sessions);
    const visible = projects.filter((p) => !p.disabled);

    this.#body.replaceChildren(
      summary(projects, visible, sessions, files, totals),
      quotas(input.limits, sessions),
      perProject(visible, sessions, files),
      toolMix(input.toolsByCat, input.countingSince),
      sessionTable(sessions, projects),
    );
  }
}

/* ─────────────────────────── aggregations ─────────────────────────── */

function zero(): TokenTotals {
  return { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
}

function addTo(a: TokenTotals, b: TokenTotals): void {
  a.in += b.in;
  a.out += b.out;
  a.cacheRead += b.cacheRead;
  a.cacheWrite += b.cacheWrite;
  a.thinking += b.thinking;
}

function totalsOf(sessions: readonly SessionInfo[]): TokenTotals {
  const t = zero();
  for (const s of sessions) addTo(t, s.tokens);
  return t;
}

/** The total that matters: the cache is where almost all the weight is. */
function sum(t: TokenTotals): number {
  return t.in + t.out + t.cacheRead + t.cacheWrite;
}

/* ─────────────────────────── sections ─────────────────────────── */

function summary(
  all: readonly ProjectInfo[],
  visible: readonly ProjectInfo[],
  sessions: readonly SessionInfo[],
  files: readonly FileNode[],
  totals: TokenTotals,
): HTMLElement {
  const disabled = all.length - visible.length;
  const busy = sessions.filter((s) => s.status === 'busy').length;
  const waiting = sessions.filter((s) => s.status === 'waiting').length;
  const writes = files.reduce((n, f) => n + f.writes, 0);
  const reads = files.reduce((n, f) => n + f.reads, 0);
  const churn = files.reduce((n, f) => n + f.churn, 0);
  const commits = all.reduce((n, p) => n + p.commits, 0);
  const workingMs = sessions.reduce((n, s) => n + s.turnsMs, 0);
  const thinking = sessions.reduce((n, s) => n + s.tokens.thinking, 0);
  const timed = sessions.filter((s) => s.reasoningMs !== null && s.reasoningMs > 0);
  const reasoningMs = timed.reduce((n, s) => n + (s.reasoningMs ?? 0), 0);
  // Only Codex times its reasoning: saying so keeps Claude Code's silence
  // from looking like a zero.
  const reasoningNote = reasoningMs > 0 ? `${formatElapsed(reasoningMs)} reasoning` : '';

  const box = section('At a glance');
  const grid = div('stats__figures');
  for (const [label, value, note] of [
    ['projects', String(visible.length), disabled > 0 ? `${disabled} disabled` : ''],
    ['sessions', String(sessions.length), busy > 0 || waiting > 0 ? `${busy} working · ${waiting} waiting` : 'all idle'],
    ['tokens', compact(sum(totals)), `out ${compact(totals.out)}`],
    ['files touched', String(files.length), `${reads} reads · ${writes} writes`],
    ['lines changed', compact(churn), ''],
    ['commits', String(commits), ''],
    ['working time', workingMs > 0 ? formatElapsed(workingMs) : '—', reasoningNote],
    ['thinking', compact(thinking), 'tokens'],
  ] as [string, string, string][]) {
    const cell = div('stats__figure');
    cell.append(span('stats__figure-label', label), span('stats__figure-value', value));
    if (note) cell.appendChild(span('stats__figure-note', note));
    grid.appendChild(cell);
  }
  box.appendChild(grid);
  return box;
}

function quotas(
  limits: Map<ProviderId, ProviderLimits>,
  sessions: readonly SessionInfo[],
): HTMLElement {
  const box = section('Usage limits');
  const byProvider = new Map<ProviderId, TokenTotals>();
  for (const s of sessions) {
    const t = byProvider.get(s.provider) ?? zero();
    addTo(t, s.tokens);
    byProvider.set(s.provider, t);
  }

  const providers = new Set<ProviderId>([...limits.keys(), ...byProvider.keys()]);
  if (providers.size === 0) {
    box.appendChild(note('Nothing observed yet.'));
    return box;
  }

  for (const provider of providers) {
    const row = div('stats__quota');
    const name = span('stats__quota-name', provider === 'claude' ? 'Claude Code' : 'Codex CLI');
    name.dataset['provider'] = provider;
    row.appendChild(name);

    const l = limits.get(provider);
    if (l?.plan) row.appendChild(span('stats__quota-plan', l.plan.toUpperCase()));

    const windows = l?.windows ?? [];
    if (windows.length === 0) {
      row.appendChild(note('no quota reported'));
    } else {
      const now = Date.now();
      for (const measured of windows) {
        const w = windowNow(measured, now);
        const item = div('stats__quota-win');
        item.dataset['level'] = w.usedPercent >= 90 ? 'high' : w.usedPercent >= 70 ? 'warn' : 'ok';
        item.append(
          // The model beside the span: two `7d` windows with different
          // percentages, without the name of whoever uses them, would look
          // like a bug.
          span('stats__quota-label', w.model ? `${w.label} ${w.model}` : w.label),
          bar(w.usedPercent, 100),
          span('stats__quota-pct', `${Math.round(w.usedPercent)}%`),
        );
        const left = w.resetsAt === null ? null : w.resetsAt - now;
        if (left !== null) {
          // A reset instant already in the past is not "resets in 0s": it
          // means this reading is old, and the window restarted without
          // anyone telling us.
          item.appendChild(
            span('stats__quota-reset', left > 0 ? `resets in ${formatElapsed(left)}` : 'window has since reset'),
          );
        }
        row.appendChild(item);
      }
    }

    const t = byProvider.get(provider);
    if (t) row.appendChild(span('stats__quota-tokens', `${compact(sum(t))} tokens`));
    box.appendChild(row);
  }
  return box;
}

interface ProjectRow {
  name: string;
  tokens: number;
  /** Reasoning tokens: the measure both tools provide. */
  thinking: number;
  /** Timed reasoning. `null` if no session measures it. */
  reasoningMs: number | null;
  /** Time of the finished turns: how long it was worked on in total. */
  workingMs: number;
  files: number;
  writes: number;
  churn: number;
  commits: number;
  lastActiveAt: number;
  branch: string | null;
}

function perProject(
  visible: readonly ProjectInfo[],
  sessions: readonly SessionInfo[],
  files: readonly FileNode[],
): HTMLElement {
  const rows = new Map<string, ProjectRow>();
  for (const p of visible) {
    rows.set(p.id, {
      name: p.name,
      tokens: 0,
      thinking: 0,
      reasoningMs: null,
      workingMs: 0,
      files: 0,
      writes: 0,
      churn: 0,
      commits: p.commits,
      lastActiveAt: p.lastActiveAt,
      branch: p.branch,
    });
  }
  for (const s of sessions) {
    const r = rows.get(s.projectId);
    if (!r) continue;
    r.tokens += sum(s.tokens);
    r.thinking += s.tokens.thinking;
    r.workingMs += s.turnsMs;
    // Stays `null` until some session of this project times it: a zero would
    // say "it did not reason", which is a different fact.
    if (s.reasoningMs !== null) r.reasoningMs = (r.reasoningMs ?? 0) + s.reasoningMs;
  }
  for (const f of files) {
    const r = rows.get(f.projectId);
    if (!r) continue;
    r.files++;
    r.writes += f.writes;
    r.churn += f.churn;
  }

  // Only the projects where something happened: fifteen rows of zeros are
  // not data, they are a list.
  const list = [...rows.values()]
    .filter((r) => r.tokens > 0 || r.files > 0 || r.commits > 0 || r.workingMs > 0)
    .sort((a, b) => b.tokens - a.tokens || b.files - a.files);

  const box = section('By project');
  if (list.length === 0) {
    box.appendChild(note('No activity recorded yet.'));
    return box;
  }

  const maxTokens = Math.max(...list.map((r) => r.tokens), 1);
  const table = div('stats__rows');
  for (const r of list) {
    const row = div('stats__row');
    row.append(
      span('stats__row-name', r.name),
      bar(r.tokens, maxTokens),
      span('stats__row-value', r.tokens > 0 ? compact(r.tokens) : '—'),
      span(
        'stats__row-meta',
        [
          r.workingMs > 0 ? `${formatElapsed(r.workingMs)} working` : '',
          // The time where it is measured, the tokens where it is not: they
          // are two answers to the same question, and the one that counts is
          // the one that is not made up.
          r.reasoningMs !== null && r.reasoningMs > 0
            ? `${formatElapsed(r.reasoningMs)} reasoning`
            : r.thinking > 0 ? `${compact(r.thinking)} thinking tokens` : '',
          r.files > 0 ? `${r.files} files` : '',
          r.writes > 0 ? `${r.writes} writes` : '',
          r.churn > 0 ? `${compact(r.churn)} lines` : '',
          r.commits > 0 ? `${r.commits} commits` : '',
          r.branch ? r.branch : '',
        ].filter(Boolean).join(' · '),
      ),
    );
    table.appendChild(row);
  }
  box.appendChild(table);
  return box;
}

/**
 * How the work was split among the tool types.
 *
 * It is a ring and not bars because the question here is "in what
 * proportion", not "how much": reading slices is immediate, comparing six
 * little bars is not.
 */
function toolMix(counts: Map<string, number>, since: number): HTMLElement {
  const box = section('Tool mix');
  const entries = [...counts.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((n, [, v]) => n + v, 0);
  if (total === 0) {
    box.appendChild(note('No tool calls seen yet.'));
    return box;
  }

  const wrap = div('stats__mix');
  const SIZE = 132;
  const R = 52;
  const C = 2 * Math.PI * R;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
  svg.setAttribute('class', 'stats__donut');

  let offset = 0;
  for (const [cat, n] of entries) {
    const arc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    arc.setAttribute('cx', String(SIZE / 2));
    arc.setAttribute('cy', String(SIZE / 2));
    arc.setAttribute('r', String(R));
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', hex(TOOL_COLOR[cat as keyof typeof TOOL_COLOR] ?? 0x8899aa));
    arc.setAttribute('stroke-width', '16');
    const len = (n / total) * C;
    arc.setAttribute('stroke-dasharray', `${len} ${C - len}`);
    // -C/4 moves the start to the top instead of the right.
    arc.setAttribute('stroke-dashoffset', String(-offset - C / 4));
    arc.setAttribute('transform', `scale(1,-1) translate(0,${-SIZE})`);
    svg.appendChild(arc);
    offset += len;
  }

  const legend = div('stats__legend');
  for (const [cat, n] of entries) {
    const item = div('stats__legend-item');
    const dot = span('stats__legend-dot', '');
    dot.style.background = hex(TOOL_COLOR[cat as keyof typeof TOOL_COLOR] ?? 0x8899aa);
    const pct = Math.round((n / total) * 100);
    item.append(dot, span('stats__legend-name', cat), span('stats__legend-n', `${n} · ${pct}%`));
    legend.appendChild(item);
  }

  wrap.append(svg, legend);
  box.append(wrap, note(`${total} tool calls since this page was opened, ${formatElapsed(Date.now() - since)} ago`));
  return box;
}

function sessionTable(
  sessions: readonly SessionInfo[],
  projects: readonly ProjectInfo[],
): HTMLElement {
  const box = section('Sessions');
  if (sessions.length === 0) {
    box.appendChild(note('No session is running.'));
    return box;
  }
  const nameOf = new Map(projects.map((p) => [p.id, p.name]));
  const list = [...sessions].sort((a, b) => sum(b.tokens) - sum(a.tokens));
  const maxTokens = Math.max(...list.map((s) => sum(s.tokens)), 1);

  const table = div('stats__rows');
  for (const s of list) {
    const row = div('stats__row');
    const label = span('stats__row-name', s.title ?? s.label);
    label.dataset['provider'] = s.provider;
    row.append(
      label,
      bar(sum(s.tokens), maxTokens),
      span('stats__row-value', sum(s.tokens) > 0 ? compact(sum(s.tokens)) : '—'),
      span(
        'stats__row-meta',
        [
          nameOf.get(s.projectId) ?? '',
          s.status === 'busy' ? 'working' : s.status === 'waiting' ? 'awaiting you' : 'idle',
          describeActivity(s, true) ?? '',
          s.model ?? '',
          s.turns > 0 ? `${s.turns} turns` : '',
          s.turnsMs > 0 ? `${formatElapsed(s.turnsMs)} working` : '',
          s.reasoningMs !== null && s.reasoningMs > 0
            ? `${formatElapsed(s.reasoningMs)} reasoning`
            : s.tokens.thinking > 0 ? `${compact(s.tokens.thinking)} thinking` : '',
          s.toolCalls > 0 ? `${s.toolCalls} calls` : '',
          s.lastTurnMs !== null ? `last ${formatElapsed(s.lastTurnMs)}` : '',
        ].filter(Boolean).join(' · '),
      ),
    );
    table.appendChild(row);
  }
  box.appendChild(table);
  return box;
}

/* ─────────────────────────── bricks ─────────────────────────── */

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
  return span('stats__note', text);
}

function section(title: string): HTMLElement {
  const box = div('stats__section');
  const h = document.createElement('h3');
  h.textContent = title;
  box.appendChild(h);
  return box;
}

function bar(value: number, max: number): HTMLElement {
  const wrap = div('stats__bar');
  const fill = div('stats__bar-fill');
  fill.style.width = `${Math.max(0, Math.min(100, (value / max) * 100))}%`;
  wrap.appendChild(fill);
  return wrap;
}

function hex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}
