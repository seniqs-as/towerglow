import * as COLONY from '../world/palette.ts';
import * as CITY from '../city/palette.ts';
import { MIN_LIT_MS } from '../state/lights.ts';
import { SLEEP_AFTER_MS } from '../state/status.ts';
import { MAX_CRATES } from '../world/crates.ts';
import { MAX_CADETS, HELPER_LINGER_MS } from '../world/colony.ts';
import { MIN_HOVER_S } from '../world/landers.ts';
import { GESTURE_HOLD_S } from '../agents/gestures.ts';
import { MAX_RINGS } from '../city/towers.ts';
import type { ToolCategory } from '../../shared/protocol.ts';

/**
 * The legend: what every colour and every sign means in the view on screen.
 *
 * One legend per view, never the two together. The city and the colony draw
 * the same store with different marks -- a window where the other has a lamp,
 * a ring where the other has a crate -- and the single list this used to be
 * explained a ship, a crew and decks to somebody looking at towers, in a view
 * that has none of them. `legendFor` is the content as data, so a test can
 * hold each view to its own words; the class only draws it.
 *
 * It opens beside the scene instead of covering it. A legend is consulted by
 * looking at both things together -- the symbol being explained and the one
 * in the scene -- and a modal that blurs everything would hide the scene
 * exactly when you need to compare them.
 *
 * The colours come from the palette of the view being explained, they are not
 * copied here: a legend that shows an orange different from the one on screen
 * is worse than none.
 */

/** The drawing a legend explains. */
export type LegendView = 'city' | 'colony';

/** A session's state, as the symbol over its project shows it. */
type SignState = 'busy' | 'done' | 'wait' | 'stop';

export type LegendRow =
  | { kind: 'note'; text: string }
  | { kind: 'swatch'; color: number; name: string; meaning: string }
  | { kind: 'symbol'; state: SignState; name: string; meaning: string }
  | { kind: 'context'; name: string; meaning: string };

export interface LegendSection {
  title: string;
  rows: LegendRow[];
}

/**
 * The tool categories, in palette order.
 *
 * The name is the category key, capitalised: it is the same word that
 * appears in the tool mix donut, and reading two different words for the
 * same colour would force you to guess that they are the same thing.
 */
const TOOL_KINDS: [cat: ToolCategory, name: string, meaning: string][] = [
  ['read', 'Read', 'reading a file or a notebook'],
  ['edit', 'Edit', 'writing or changing a file'],
  ['exec', 'Exec', 'a shell command'],
  ['search', 'Search', 'grep, glob, hunting for something'],
  ['net', 'Net', 'fetching or searching the web'],
  ['agent', 'Agent', 'handing work to a subagent, or reading back what it did'],
  ['plan', 'Plan', 'todos, plan mode, loading a skill'],
  ['msg', 'Msg', 'a question to you, or a message to another agent'],
  ['mcp', 'Mcp', 'a tool from an MCP server'],
  ['other', 'Other', 'a tool we cannot place: the list of names ages'],
];

/** What moved HEAD: the tint of a crate in the colony, of a ring in the city. */
const GIT_KINDS: [kind: 'commit' | 'merge' | 'rebase' | 'reset' | 'other', meaning: string][] = [
  ['commit', 'a commit (also a fresh clone)'],
  ['merge', 'a merge, or a pull that merged'],
  ['rebase', 'a rebase step'],
  ['reset', 'a reset that moved the branch'],
  ['other', 'anything else that moved HEAD'],
];

/** What the legend says while `view` is on screen, and nothing about the other one. */
export function legendFor(view: LegendView): LegendSection[] {
  return view === 'city' ? cityLegend() : colonyLegend();
}

export class Legend {
  #root: HTMLElement;
  #open = false;
  #view: LegendView | null = null;

  constructor(host: HTMLElement, button: HTMLElement) {
    this.#root = document.createElement('aside');
    this.#root.className = 'legend';
    this.#root.hidden = true;
    this.#root.setAttribute('aria-label', 'Legend');
    // The page opens on the city; whoever switches the view says so.
    this.setView('city');

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
    // Closes on a click outside or on Esc, but not on a click inside: it is a
    // panel to be read, not dodged.
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
   * The view on screen changed: the legend explains that one from here on.
   * Open or closed it stays as it was, and starts again from the top -- the
   * place you had scrolled to belonged to another list.
   */
  setView(view: LegendView): void {
    if (view === this.#view) return;
    this.#view = view;
    this.#root.dataset['view'] = view;
    this.#root.replaceChildren(...legendFor(view).map(drawSection));
    this.#root.scrollTop = 0;
  }

  toggle(): void {
    if (this.#open) this.close();
    else this.open();
  }

  open(): void {
    this.#open = true;
    this.#root.hidden = false;
  }

  close(): void {
    this.#open = false;
    this.#root.hidden = true;
  }
}

/* ─────────────────────────── the city ─────────────────────────── */

function cityLegend(): LegendSection[] {
  return [
    section('City view', [
      note('The light view the page opens on: one tower per project, and the work going on inside it. V, or the button beside Settings, switches to the colony -- the same projects and sessions, drawn in full detail -- and this legend follows.'),
    ]),
    section('Towers', [
      swatch(CITY.PROVIDER_COLOR.claude, 'Claude Code', 'has a session in this tower'),
      swatch(CITY.PROVIDER_COLOR.codex, 'Codex', 'has a session in this tower'),
      swatch(CITY.PROVIDER_BOTH, 'Both', 'Claude Code and Codex at the same time'),
      swatch(CITY.EDGE_DIM, 'Empty', 'no live session right now'),
      swatch(CITY.RUIN, 'Gone', 'the folder is no longer on disk'),
      note('A bigger project has a taller and wider tower; the lines across its sides are its floors. A tower that pulses has a session waiting for you.'),
      note('Click a tower nobody works in, or its name, to open a Terminal in its folder, ready for claude or codex.'),
    ]),
    section('Sessions', [
      note('With the CEOs, the workers of the jobs you accepted are sessions too, in the tower of the project they work on, and the hover on their symbol names the task. They have no terminal of their own, so a click on their symbol opens a Terminal window that follows what they do. What came out of a job is in Reports.'),
    ]),
    signs('The symbol floats over the tower, above the name of the project', 'like the tower itself'),
    section('Windows', [
      swatch(CITY.PROVIDER_COLOR.claude, 'Claude Code at work', 'the session itself, while a turn runs'),
      swatch(CITY.PROVIDER_COLOR.codex, 'Codex at work', 'the same, for a Codex session'),
      swatch(CITY.TOOL_COLOR.agent, 'Subagent', 'working inside: one window each, until it delivers'),
      swatch(CITY.SKILL_COLOR, 'Skill', 'in use for this turn, until the turn ends'),
      note('Every tool the session calls lights a window of its own, in the colour of the work it does: the list below. There are no dark windows: one exists only while somebody works behind it.'),
      // From the real value: if the minimum changes, the legend cannot fall behind.
      note(`Every window stays lit for at least ${litSeconds()} seconds from when the work started, even if it took a moment, then fades. Work that runs longer keeps its window lit until it ends.`),
      note('Hover a window to read what it is: the task of the session, the tool, the subagent or the skill.'),
      note(HAND_STARTED_SKILLS.replace('%s', 'window')),
    ]),
    section('What a tool call is doing', [
      ...TOOL_KINDS.map(([cat, name, meaning]) => swatch(CITY.TOOL_COLOR[cat], name, meaning)),
      note('One colour, three places: the window on the tower, the spark that leaves it when the call starts, and the slice in the tool mix.'),
      note('Where the spark goes says the kind of work: high above the tower for the web, out to the side for a subagent, across to another tower for a message to the agent working there, and just over the top for everything else. A shell command sends none: its window says it.'),
    ]),
    section('Rings over the tower', [
      ...GIT_KINDS.map(([kind, meaning]) => swatch(CITY.RING_COLOR[kind], kind, meaning)),
      note(`One ring per event of the last hour, piled over the top of the tower, up to ${MAX_RINGS} high; older ones go. Switching branch adds no ring.`),
      note('A new ring swells and glows for a few seconds, then settles.'),
    ]),
    section('Keys', [
      note('C frames the whole map, V switches to the colony. Drag to turn the view, right-drag to slide it, scroll to zoom.'),
    ]),
  ];
}

/* ────────────────────────── the colony ────────────────────────── */

function colonyLegend(): LegendSection[] {
  const minutes = Math.round(SLEEP_AFTER_MS / 60_000);
  return [
    section('Colony view', [
      note('The full drawing: one hex zone per project, one astronaut per session, and the ship they walk out of. V, or the button beside Settings, switches back to the city -- the same projects and sessions, drawn light -- and this legend follows.'),
    ]),
    section('Zones', [
      swatch(COLONY.ZONE_PALETTE[0]!, 'A project', 'one hex zone each, in a colour of its own that never changes'),
      swatch(COLONY.RUIN, 'Gone', 'the folder is no longer on disk'),
      note('A bigger project stacks more decks on its hex, one plate per step in size; everything happens on the top one. The kerb glows in its colour after dark, and pulses when somebody there is waiting for you.'),
      note('Click a zone nobody works on, or its name, to open a Terminal in its folder, ready for claude or codex.'),
    ]),
    section('Buildings', [
      note('The habitat in the middle of a zone is the project itself. Every live session raises a small structure on a spot of its own: it grows with the tool calls the session makes, and sinks back into the deck when the session ends.'),
    ]),
    section('Crew', [
      swatch(COLONY.PROVIDER_COLOR.claude, 'Claude Code', 'the trim of the suit says which tool the session is'),
      swatch(COLONY.PROVIDER_COLOR.codex, 'Codex', 'the same, in white'),
      note('One astronaut per live session. Hammering: a turn is running. Waving: it stopped and is waiting for you. Slumped, with red eyes: it fell over. Sitting: quiet for ' +
        `${minutes} minutes or more. Pottering about: idle. Cheering: a commit just landed.`),
      note('Sessions walk out of the ship when they start and back into it when they end.'),
      note('While a session calls tools, a smaller helper comes out of the habitat and works the same structure with the same hands. It goes back in once the turn is over, ' +
        `or ${Math.round(HELPER_LINGER_MS / 1000)} seconds after the last call if that is later. Hover it for the tool, click it for its session.`),
    ]),
    section('What the hands say', [
      swatch(COLONY.TOOL_COLOR.edit, 'Hammering', 'writing or changing a file'),
      swatch(COLONY.TOOL_COLOR.read, 'Inspecting', 'reading a file or searching the code'),
      swatch(COLONY.TOOL_COLOR.exec, 'At the console', 'a shell command: the structure lets off steam on every blow'),
      swatch(COLONY.TOOL_COLOR.net, 'Uplink', 'the web or an MCP tool: inspecting, with a thread of light rising off the structure'),
      swatch(COLONY.TOOL_COLOR.plan, 'Thinking', 'planning, todos, loading a skill'),
      note(`The gesture follows the last tool the session called and holds for at least ${GESTURE_HOLD_S} seconds, so a burst of calls does not make the astronaut twitch. Sparks fly in that tool's colour.`),
      note('When a turn ends the astronaut hops once. When you send a prompt it stops and turns to look at the ship.'),
    ]),
    section('Signs of work', [
      swatch(COLONY.TOOL_COLOR.agent, 'Subagent', `a smaller astronaut comes out of the habitat, works beside it and goes back in when it delivers; up to ${MAX_CADETS} small astronauts per project, helpers first, the rest are lamps only. Hover it for its type, click it for its session`),
      swatch(COLONY.SKILL_COLOR, 'Supply lander', 'comes down over the habitat when you send a prompt, when the session calls out to the web or an MCP tool, and while a skill is in use. ' +
        `It holds station at least ${MIN_HOVER_S} seconds, then lifts off`),
      swatch(COLONY.ZONE_PALETTE[0]!, 'Running light', 'runs round the kerb in the project\'s own colour while somebody there is working, faster the more tool calls in the last minute'),
      note('Rotors spin fast while their session works, at their usual pace when it is idle, and stop when it is asleep.'),
      note('Writing a file lights the construction band at the foot of that session\'s structure.'),
      note('When a project grows into another deck, the new plate slides in underneath and pushes the whole stack up.'),
    ]),
    signs('The symbol sits on the project\'s habitat', 'like the suit'),
    section('Lamps on the deck', [
      swatch(COLONY.PROVIDER_COLOR.claude, 'Claude Code at work', 'the session itself, while a turn runs'),
      swatch(COLONY.PROVIDER_COLOR.codex, 'Codex at work', 'the same, for a Codex session'),
      swatch(COLONY.TOOL_COLOR.agent, 'Subagent', 'working inside: one lamp each, until it delivers'),
      swatch(COLONY.SKILL_COLOR, 'Skill', 'in use for this turn, until the turn ends'),
      note('Every tool the session calls lights a lamp of its own on the kerb, in the colour of the work it does: the list below.'),
      // From the real value: if the minimum changes, the legend cannot fall behind.
      note(`Every lamp stays lit for at least ${litSeconds()} seconds from when the work started, even if it took a moment, then sinks back into the deck. Work that runs longer keeps its lamp lit until it ends.`),
      note('Hover a lamp to read what it is: the task of the session, the tool, the subagent or the skill.'),
      note(HAND_STARTED_SKILLS.replace('%s', 'lamp')),
    ]),
    section('What a tool call is doing', [
      ...TOOL_KINDS.map(([cat, name, meaning]) => swatch(COLONY.TOOL_COLOR[cat], name, meaning)),
      note('One colour, three places: the lamp on the deck, the sparks at the astronaut\'s hands while the call runs, and the slice in the tool mix.'),
    ]),
    section('Crates by the habitat', [
      ...GIT_KINDS.map(([kind, meaning]) => swatch(COLONY.RING_COLOR[kind], kind, meaning)),
      note(`One crate per event of the last hour, newest on top, up to ${MAX_CRATES}; older ones go. Switching branch adds no crate.`),
      note('A new crate drops onto the pile, kicks up dust, and the kerb flashes once in its colour while the crew there cheers.'),
    ]),
    section('The ship', [
      note('North of the colony, on its own plaza. Every session walks out of it when it starts and back in when it ends.'),
      note('With the CEOs, the workers of the jobs you accepted walk out too, to the lot of the project they work on: they stand there like your own sessions, and their hover names the task. They have no terminal of their own, so a click on their symbol opens a Terminal window that follows what they do. What came out of a job is in Reports.'),
      note('With the CEOs, E takes you up the ramp and inside, where they sit at their desk, bigger than the crew. Walk with WASD or the arrows; at the desk the Board panel opens -- the same one as the button -- and walking away closes it. E again, or the hatch you came in by, takes you out.'),
    ]),
    section('Sky and keys', [
      note('The sky follows your clock unless you pick a time. H frames the ship, C the colony, P cycles the planet, T the time of day, O orbits, V switches to the city. Drag to move, scroll to zoom at the cursor.'),
    ]),
  ];
}

/* ───────────────────── what both views share ───────────────────── */

/** One sentence for both views, with the view's own word for the light. */
const HAND_STARTED_SKILLS =
  'Only skills the agent calls itself light a %s. One you start by hand with /name cannot be told apart from a built-in command like /model.';

function litSeconds(): number {
  return Math.round(MIN_LIT_MS / 1000);
}

/**
 * The symbol over a project: the same badge in both views, re-anchored. What
 * changes is where it hangs and which figure wears the same colour.
 */
function signs(where: string, wornBy: string): LegendSection {
  return section('Session', [
    symbol('busy', 'Working', 'a turn is running'),
    symbol('done', 'Done', 'the last turn finished'),
    symbol('wait', 'Waiting for you', 'it asked a question and is stopped until you answer'),
    symbol('stop', 'Stopped at the limit', 'it ran out of usage and stopped. It does not start again by itself when the limit resets: send it a message. Hover it for when the limit resets'),
    note(`${where}, one per session, side by side. Its colour says the state; the circle around it says the tool, orange for Claude Code, white for Codex, ${wornBy}. A dashed circle means the state is inferred from files rather than reported by the tool. Hover it for the task, click it to jump to its terminal -- or, once the session is over, to open a new one in the project, ready for claude or codex. The i in the bubble opens the details.`),
    {
      kind: 'context',
      name: 'Context used',
      meaning: 'the arc around the circle fills as the session uses up its context window; it pulses past 90%, when the session is about to compact. Once it has, "context compacted" stands over the circle for an hour',
    },
  ]);
}

function section(title: string, rows: LegendRow[]): LegendSection {
  return { title, rows };
}

function note(text: string): LegendRow {
  return { kind: 'note', text };
}

/** A solid colour: towers, suits, windows and lamps. */
function swatch(color: number, name: string, meaning: string): LegendRow {
  return { kind: 'swatch', color, name, meaning };
}

function symbol(state: SignState, name: string, meaning: string): LegendRow {
  return { kind: 'symbol', state, name, meaning };
}

/* ─────────────────────────── bricks ─────────────────────────── */

function drawSection(s: LegendSection): HTMLElement {
  const box = document.createElement('section');
  box.className = 'legend__section';
  const h = document.createElement('h3');
  h.textContent = s.title;
  box.append(h, ...s.rows.map(drawRow));
  return box;
}

function drawRow(r: LegendRow): HTMLElement {
  switch (r.kind) {
    case 'note': {
      const p = document.createElement('p');
      p.className = 'legend__note';
      p.textContent = r.text;
      return p;
    }
    case 'swatch': {
      const m = document.createElement('span');
      m.className = 'legend__swatch';
      m.style.setProperty('--c', hex(r.color));
      return row(m, r.name, r.meaning);
    }
    case 'symbol': {
      // The same symbol that sits over the project, in the same stroke.
      const m = document.createElement('span');
      m.className = `legend__symbol legend__symbol--${r.state}`;
      m.innerHTML = SIGN[r.state];
      return row(m, r.name, r.meaning);
    }
    case 'context': {
      // The context arc, as it is around the badge.
      const m = document.createElement('span');
      m.className = 'legend__ctx';
      m.innerHTML =
        '<svg viewBox="0 0 44 44" aria-hidden="true">' +
        '<circle class="legend__ctx-track" cx="22" cy="22" r="18" pathLength="100"/>' +
        '<circle class="legend__ctx-fill" cx="22" cy="22" r="18" pathLength="100"/></svg>';
      return row(m, r.name, r.meaning);
    }
  }
}

function row(mark: HTMLElement, name: string, meaning: string): HTMLElement {
  const r = document.createElement('div');
  r.className = 'legend__row';
  const text = document.createElement('span');
  text.className = 'legend__text';
  const strong = document.createElement('span');
  strong.className = 'legend__name';
  strong.textContent = name;
  const rest = document.createElement('span');
  rest.className = 'legend__meaning';
  rest.textContent = meaning;
  text.append(strong, rest);
  r.append(mark, text);
  return r;
}

function hex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`;
}

const SIGN: Record<SignState, string> = {
  busy:
    '<svg viewBox="0 0 8 12" aria-hidden="true"><path d="M5.2 0 0 6.9h2.9L2.4 12 8 4.8H4.7z" fill="currentColor"/></svg>',
  done:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.4l3.4 3.4L13.2 5" fill="none" ' +
    'stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  wait:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 15.2 14.2H0.8z" fill="none" ' +
    'stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M8 6.2v3.3" ' +
    'stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>' +
    '<circle cx="8" cy="11.9" r="0.95" fill="currentColor"/></svg>',
  stop:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" ' +
    'stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
};
