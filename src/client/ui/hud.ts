import type { ProviderId, ProviderLimits, RateWindow, TokenTotals } from '../../shared/protocol.ts';
import { hasReset, windowNow } from '../../shared/limits.ts';
import { formatElapsed } from './format.ts';
import { HIDDEN_ICON } from './icons.ts';
import { WindowTip } from './windowTip.ts';

/** How much a tool has used, as it is shown on screen. */
export interface SpendRow {
  provider: ProviderId;
  tokens: TokenTotals;
  limits: ProviderLimits | undefined;
}

export type LinkState = 'on' | 'connecting' | 'off';

/** A project out of view, as the restore list names it. */
export interface DisabledProject {
  id: string;
  name: string;
}

export interface RestoreActions {
  /** Brings back one project, leaving the others where they are. */
  onRestore: (projectId: string) => void;
  onRestoreAll: () => void;
}

/** HUD: global counters, connection state and the full-screen message. */
export class Hud {
  #dot: HTMLElement;
  #projects: HTMLElement;
  #sessions: HTMLElement;
  #agents: HTMLElement;
  #files: HTMLElement;
  #fps: HTMLElement;
  #empty: HTMLElement;
  #emptyTitle: HTMLElement;
  #emptyBody: HTMLElement;
  #idleTitle = '';
  #idleBody = '';
  #spend: HTMLElement;
  #spendRows: HTMLElement;
  #restore: HTMLButtonElement;
  #restoreCount: HTMLElement;
  /** The list under the glyph: one row per disabled project, then "show all". */
  #restoreList: HTMLElement;
  #restoreActs: RestoreActions | null = null;
  /** One row per tool, reused: recreating it on every pass would make it flicker. */
  #rows = new Map<ProviderId, SpendRowNodes>();
  /** The quota tooltip: the same one as the windows in the scene, so there are not two ways of saying the same thing. */
  #tip: WindowTip;
  #lastFps = -1;
  #pinned = false;

  constructor() {
    this.#dot = must('link-dot');
    this.#projects = must('stat-projects');
    this.#sessions = must('stat-sessions');
    this.#agents = must('stat-agents');
    this.#files = must('stat-files');
    this.#fps = must('stat-fps');
    this.#empty = must('empty');
    this.#emptyTitle = this.#empty.querySelector('h1')!;
    this.#emptyBody = this.#empty.querySelector('p')!;

    this.#spend = must('spend');
    this.#spendRows = must('spend-rows');
    this.#restore = must('spend-restore') as HTMLButtonElement;
    this.#restore.innerHTML = HIDDEN_ICON;
    this.#restoreCount = document.createElement('span');
    this.#restore.appendChild(this.#restoreCount);
    this.#restore.setAttribute('aria-haspopup', 'true');
    this.#restore.setAttribute('aria-expanded', 'false');
    // A sibling and not a child: a button cannot hold buttons.
    this.#restoreList = document.createElement('div');
    this.#restoreList.className = 'hud__restore-list';
    this.#restoreList.hidden = true;
    this.#restore.after(this.#restoreList);
    this.#restore.addEventListener('click', () => this.#toggleRestore(this.#restoreList.hidden === true));
    window.addEventListener('pointerdown', (e) => {
      if (e.target instanceof Node && (this.#restore.contains(e.target) || this.#restoreList.contains(e.target))) return;
      this.#toggleRestore(false);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.#toggleRestore(false);
    });
    this.#tip = new WindowTip(document.body);
  }

  /**
   * Usage per tool.
   *
   * The total includes the cache, which is where almost all the weight is:
   * showing only `in` would make a session of millions of tokens look free.
   * The output stays beside it because it is the part the model actually
   * generated, and the only one comparable between the two tools.
   */
  setSpend(rows: readonly SpendRow[]): void {
    const wanted = new Set(rows.map((r) => r.provider));
    for (const [provider, nodes] of this.#rows) {
      if (wanted.has(provider)) continue;
      // `pointerleave` never arrives from a node removed from the document:
      // without this, the tooltip of a vanished tool would stay on screen.
      this.#tip.hide();
      nodes.root.remove();
      this.#rows.delete(provider);
    }

    for (const row of rows) {
      let nodes = this.#rows.get(row.provider);
      if (!nodes) {
        nodes = buildSpendRow(row.provider);
        this.#spendRows.appendChild(nodes.root);
        this.#rows.set(row.provider, nodes);
      }
      const t = row.tokens;
      nodes.total.textContent = compact(t.in + t.out + t.cacheRead + t.cacheWrite);
      nodes.plan.textContent = row.limits?.plan ?? '';
      nodes.plan.hidden = !row.limits?.plan;
      paintWindows(nodes, row.limits?.windows ?? [], this.#tip);
    }

    this.#spend.hidden = rows.length === 0;
  }

  /**
   * The projects out of view, and how to bring them back.
   *
   * One at a time: "show all" alone meant re-enabling everything and then
   * disabling again all but the one you wanted back.
   */
  setDisabled(projects: readonly DisabledProject[], actions: RestoreActions): void {
    this.#restoreActs = actions;
    this.#restore.hidden = projects.length === 0;
    if (projects.length === 0) {
      this.#toggleRestore(false);
      return;
    }
    // The number stays beside the glyph: how many are missing is worth a
    // glance, and only the sentence waits for the hover.
    this.#restoreCount.textContent = String(projects.length);
    this.#restore.setAttribute('aria-label', `${projects.length} disabled`);

    const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));
    const key = sorted.map((p) => `${p.id}\u0001${p.name}`).join('\u0002');
    // Rebuilt only when the list changes: this runs on every store pass, and
    // a row replaced under the pointer would swallow the click.
    if (this.#restoreList.dataset['key'] === key) return;
    this.#restoreList.dataset['key'] = key;
    const rows: HTMLElement[] = sorted.map((p) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'hud__restore-row';
      row.textContent = p.name;
      row.title = `Enable ${p.name}`;
      row.addEventListener('click', () => this.#restoreActs?.onRestore(p.id));
      return row;
    });
    if (sorted.length > 1) {
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'hud__restore-row hud__restore-row--all';
      all.textContent = 'show all';
      all.addEventListener('click', () => {
        this.#restoreActs?.onRestoreAll();
        this.#toggleRestore(false);
      });
      rows.push(all);
    }
    this.#restoreList.replaceChildren(...rows);
  }

  #toggleRestore(open: boolean): void {
    if (open && this.#restore.hidden) open = false;
    this.#restoreList.hidden = !open;
    this.#restore.setAttribute('aria-expanded', String(open));
    if (open) this.#restore.dataset['on'] = 'yes';
    else delete this.#restore.dataset['on'];
  }

  setLink(state: LinkState): void {
    this.#dot.dataset['state'] = state;
  }

  setCounts(projects: number, sessions: number, agents: number, files: number): void {
    this.#projects.textContent = String(projects);
    this.#sessions.textContent = String(sessions);
    this.#agents.textContent = String(agents);
    this.#files.textContent = String(files);
    if (!this.#pinned) this.#empty.hidden = sessions > 0;
  }

  setFps(fps: number): void {
    if (fps === this.#lastFps) return;
    this.#lastFps = fps;
    this.#fps.textContent = fps > 0 ? String(fps) : '—';
  }

  /** A message that stays until it is removed: used for blocking states. */
  pinMessage(title: string, bodyHtml: string): void {
    this.#pinned = true;
    this.#emptyTitle.textContent = title;
    this.#emptyBody.innerHTML = bodyHtml;
    this.#empty.hidden = false;
  }

  /**
   * What the message says when nothing is pinned over it: there is no
   * session. It depends on the view on screen -- a tower lights up, an
   * astronaut walks out -- so it is set again on every switch, and a pinned
   * message (a lost connection, a lost 3D view) is never overwritten by it.
   */
  setIdleMessage(title: string, bodyHtml: string): void {
    this.#idleTitle = title;
    this.#idleBody = bodyHtml;
    if (this.#pinned) return;
    this.#emptyTitle.textContent = title;
    this.#emptyBody.innerHTML = bodyHtml;
  }

  unpinMessage(): void {
    this.#pinned = false;
    this.#emptyTitle.textContent = this.#idleTitle;
    this.#emptyBody.innerHTML = this.#idleBody;
  }
}

function must(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`element #${id} missing from the DOM`);
  return el;
}

interface WindowNodes {
  root: HTMLElement;
  fill: HTMLElement;
  pct: HTMLElement;
  win: HTMLElement;
  /** The model's name, when the limit is its own and not the whole tool's. */
  model: HTMLElement;
  /**
   * The last reading painted, re-read when you hover and not when it is
   * painted: the time left until the reset shrinks even while the bar stands
   * still, and a quota can stay the same for hours.
   */
  data: RateWindow | null;
}

interface SpendRowNodes {
  root: HTMLElement;
  total: HTMLElement;
  plan: HTMLElement;
  windowsBox: HTMLElement;
  /** One per window, reused: recreating them on every pass would make them flicker. */
  windows: WindowNodes[];
}

/**
 * As many windows as the tool declares.
 *
 * Both have two today; but if a third one arrived -- the case of a limit
 * tied to a model -- it would show up here without anyone having to notice
 * and add it by hand.
 */
function paintWindows(nodes: SpendRowNodes, windows: readonly RateWindow[], tip: WindowTip): void {
  while (nodes.windows.length < windows.length) {
    const w = buildWindow(tip);
    nodes.windowsBox.appendChild(w.root);
    nodes.windows.push(w);
  }
  nodes.windows.forEach((w, i) => paintWindow(w, windows[i] ?? null));
}

function buildSpendRow(provider: ProviderId): SpendRowNodes {
  const root = document.createElement('div');
  root.className = 'spend__row';
  root.dataset['provider'] = provider;

  const tool = document.createElement('span');
  tool.className = 'spend__tool';
  tool.textContent = provider === 'claude' ? 'CLAUDE' : 'CODEX';

  const plan = document.createElement('span');
  plan.className = 'spend__plan';
  plan.hidden = true;

  const windowsBox = document.createElement('span');
  windowsBox.className = 'spend__windows';

  const total = document.createElement('span');
  total.className = 'spend__total';

  // Name and plan stay together: they are two sides of the same thing --
  // which tool this is -- and separating them made them read as two columns.
  const id = document.createElement('span');
  id.className = 'spend__id';
  id.append(tool, plan);

  root.append(id, windowsBox, total);
  return { root, total, plan, windowsBox, windows: [] };
}

function buildWindow(tip: WindowTip): WindowNodes {
  const root = document.createElement('span');
  root.className = 'spend__win';

  const bar = document.createElement('span');
  bar.className = 'spend__bar';
  const fill = document.createElement('span');
  fill.className = 'spend__fill';
  bar.appendChild(fill);

  const pct = document.createElement('span');
  pct.className = 'spend__pct';

  const win = document.createElement('span');
  win.className = 'spend__winlabel';

  const model = document.createElement('span');
  model.className = 'spend__winmodel';
  model.hidden = true;

  // The percentage first, then which window: the number is the data, the
  // window's name is the number's context.
  root.append(pct, bar, win, model);

  const nodes: WindowNodes = { root, fill, pct, win, model, data: null };

  // When the quota restarts is not written anywhere: the bar says how much is
  // left, not for how much longer. It is the very thing you need at the
  // moment you look at a full bar, so you ask for it by pointing at it --
  // the way you do with the windows in the scene.
  const follow = (e: PointerEvent): void => {
    if (!nodes.data) return;
    tip.show(describeWindow(nodes.data), getComputedStyle(root).color, e.clientX, e.clientY);
  };
  root.addEventListener('pointerenter', follow);
  root.addEventListener('pointermove', follow);
  root.addEventListener('pointerleave', () => tip.hide());
  return nodes;
}

/**
 * What the tooltip of a quota window says.
 *
 * The time left comes before the exact time: the question is "how long do I
 * have to wait", and the time of day only serves to tell whether it falls
 * today or tomorrow.
 */
function describeWindow(w: RateWindow): string {
  const now = Date.now();
  const who = w.model ? `${w.label} ${w.model}` : w.label;
  const head = `${who} window · ${Math.round(windowNow(w, now).usedPercent)}% used`;
  if (w.resetsAt === null) return head;
  const left = w.resetsAt - now;
  // A reset already in the past is not "resets in 0s": it means this reading
  // is old, and the window restarted without anyone telling us.
  if (hasReset(w, now)) return `${head} · window has since reset`;
  const when = new Date(w.resetsAt).toLocaleString(undefined, {
    weekday: 'short', hour: '2-digit', minute: '2-digit',
  });
  return `${head} · resets in ${formatElapsed(left)}, ${when}`;
}

/**
 * Paints a window, or hides it if nothing is known about that quota.
 *
 * A bar at zero would say "you have used nothing", which is a different lie
 * from "I don't know": missing data must disappear, not drop to zero.
 */
function paintWindow(nodes: WindowNodes, w: RateWindow | null): void {
  if (!w) {
    nodes.root.hidden = true;
    nodes.data = null;
    return;
  }
  nodes.root.hidden = false;
  // The tooltip keeps the reading as it arrived and decides at hover time,
  // like the countdown: a window can reset while the bar sits still.
  nodes.data = w;
  const used = windowNow(w, Date.now()).usedPercent;
  nodes.fill.style.width = `${Math.round(used)}%`;
  // Below the threshold no attention is needed; above it, the colour asks for it.
  nodes.root.dataset['level'] = used >= 90 ? 'high' : used >= 70 ? 'warn' : 'ok';
  nodes.pct.textContent = `${Math.round(used)}%`;
  nodes.win.textContent = w.label;
  // Two windows of the same span are told apart only by this: without it,
  // they would be two `7d` bars with different percentages and no explanation.
  nodes.model.textContent = w.model ?? '';
  nodes.model.hidden = !w.model;
}

/** Big numbers in few digits: on screen, the order of magnitude is what counts. */
function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}
