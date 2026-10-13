import * as THREE from 'three';
import { Stage } from './world/stage.ts';
import { Settings } from './core/settings.ts';
import { SettingsPanel, PLANET_ORDER, nextTime } from './ui/settingsPanel.ts';
import { Colony } from './world/colony.ts';
import type { ColonySubagent } from './world/colony.ts';
import { Lamps } from './world/lamps.ts';
import { Ship } from './world/ship.ts';
import { Interior, roomReflections } from './world/interior.ts';
import { Boarding } from './world/boarding.ts';
import { Crates } from './world/crates.ts';
import { RingLedger } from '../shared/rings.ts';
import { Landers, summonsLander } from './world/landers.ts';
import { Astronauts } from './agents/astronauts.ts';
import { Navigation } from './agents/navigation.ts';
import { Particles } from './agents/particles.ts';
import { buildFaceAtlas } from './agents/faces.ts';
import { deckSurface, kerbSurface } from './world/surfaces.ts';
import { lightColor, RING_COLOR, TOOL_COLOR } from './world/palette.ts';
import { categoryOf } from '../shared/toolCategories.ts';
import { crewStatus } from './state/status.ts';
import type { CrewStatus } from './state/status.ts';
import { Notices } from './state/notices.ts';
import { PendingFocus } from './state/pendingFocus.ts';
import { Hud } from './ui/hud.ts';
import { Socket, resolveToken } from './net/socket.ts';
import { Store } from './state/store.ts';
import { Lights } from './state/lights.ts';
import type { Light } from './state/lights.ts';
import type {
  ProjectInfo, ProviderId, SessionInfo, TokenTotals,
} from '../shared/protocol.ts';
import { Labels, projectPlateText } from './ui/labels.ts';
import { ProjectMenu } from './ui/projectMenu.ts';
import { Stats } from './ui/stats.ts';
import { Legend } from './ui/legend.ts';
import { foldCorners } from './ui/fold.ts';
import { BOARD_ICON, EFFECT_ICON, FORECAST_ICON, HELP_ICON, LEGEND_ICON, PLAN_ICON, REPORT_ICON, SETTINGS_ICON, STATS_ICON, VIEW_ICON } from './ui/icons.ts';
import { Planning } from './ui/planning.ts';
import { ForecastPanel } from './ui/forecastPanel.ts';
import { Boardroom } from './ui/direzione.ts';
import { Reports } from './ui/reports.ts';
import { WindowTip } from './ui/windowTip.ts';
import { Effect } from './ui/effect.ts';
import type { LabelItem } from './ui/labels.ts';
import { Badges, FOCUS_TITLE, FOLLOW_TITLE, SHELL_TITLE } from './ui/badges.ts';
import type { BadgeItem, BadgeState } from './ui/badges.ts';
import { SessionCard } from './ui/sessionCard.ts';
import { describeActivity, formatElapsed } from './ui/format.ts';
import {
  HQ_PLAZA_RADIUS, HQ_HEIGHT, HEX_SIZE, hqPlacement, placeSlot, LAMP_SEATS,
} from '../shared/layout.ts';
import { City } from './city/city.ts';
import { lightColor as cityLightColor } from './city/windows.ts';

/**
 * What the page says when no session runs, of either tool. It used to name
 * Claude Code alone and promise an astronaut, on the city too, which has
 * none: the words follow the view on screen.
 */
function idleMessage(view: WorldView): { title: string; body: string } {
  const run = 'Open a terminal and run <code>claude</code> or <code>codex</code> in a project';
  return {
    title: 'No sessions running',
    body: view === 'city'
      ? `${run}: its tower lights up as the work starts.`
      : `${run}: its astronaut walks out of the ship.`,
  };
}

const canvas = document.getElementById('stage');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('canvas #stage not found');

const hud = new Hud();

/**
 * Every knob that costs frames, and the world's look. The storage is the
 * browser's own; a private window that refuses it just forgets between
 * sessions, which is not worth a message.
 */
const settings = new Settings({ storage: safeStorage() });

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let stage: Stage;
try {
  stage = new Stage(canvas, settings);
} catch (err) {
  // A black page with no explanation is the worst way to fail. And the
  // advice has to fit the likely cause: after its GPU process dies, Chrome
  // (and Brave with it) turns hardware acceleration off for as long as the
  // browser runs -- seen on 2026-09-19, a GPU process relaunched with
  // `--use-gl=disabled` -- and on macOS closing every window does not quit
  // it. "Close a few tabs and reload" was followed to the letter and could
  // not work.
  hud.pinMessage(
    'WebGL unavailable',
    'The browser refused a 3D context. After a GPU crash, Chrome and Brave keep 3D off until ' +
      'they are quit completely: press <code>⌘Q</code> and reopen, closing the windows is not enough. ' +
      'If the browser was just started, close a few tabs with 3D content and reload.',
  );
  throw err;
}

/**
 * The city: the light view the page opens on. The same store, drawn as one
 * tower per project with its windows lit by the work -- the first drawing. The
 * colony above is built at boot too, but it neither draws nor decodes its
 * five megabytes of models until you switch to it (`setWorldView`).
 */
const cityCanvas = document.getElementById('city');
if (!(cityCanvas instanceof HTMLCanvasElement)) throw new Error('canvas #city not found');
const city = new City(cityCanvas, {
  sizeOf: (projectId) => store.projects.get(projectId)?.size ?? 0,
  sessions: () => store.sessions.values(),
  pitch: settings.get('citySpacing'),
});
/**
 * How far apart the towers stand is a slider in the settings. The names and
 * the badges hang on the towers at points read when they were hung, so they
 * are hung again; and the frame follows the city out, unless you have taken
 * the camera -- then the towers move and your view stays where you put it.
 */
settings.onChange((changed) => {
  if (!changed.has('citySpacing')) return;
  if (!city.setPitch(settings.get('citySpacing'))) return;
  city.frame(visibleProjects(), store.activeProjectIds);
  refreshLabels();
});

/**
 * Which of the two views is on screen. Always the city at load, by the
 * user's call (2026-09-24): the colony draws many more polygons, and it is a
 * choice you make, not the price of opening the page.
 */
type WorldView = 'city' | 'colony';
let worldView: WorldView = 'city';

/**
 * The GPU can take the context away while the page runs: a GPU process that
 * dies, a driver reset. The engine stops drawing; without a word here the
 * last frame just froze, or went white, and nothing said why.
 */
let contextLost = false;
stage.onContextLost = () => {
  contextLost = true;
  hud.pinMessage(
    '3D view lost',
    'The GPU dropped this page\'s 3D context. It usually comes back by itself; if not, reload. ' +
      'If the reload says WebGL is unavailable, quit the browser completely (<code>⌘Q</code>) and reopen it.',
  );
};
stage.onContextRestored = () => {
  // The engine restarts itself on a restored context; the colony may not be
  // the view on screen.
  if (worldView !== 'colony') stage.stop();
  contextLost = false;
  hud.unpinMessage();
  // Unpinning only resets the text; the counts decide whether it shows, and
  // no snapshot is coming to recount them the way a reconnect does.
  refreshCounts();
};
// The city's context goes the same way, with the same words: which view lost
// it matters less than knowing the picture froze.
city.stage.onContextLost = () => stage.onContextLost?.();
city.stage.onContextRestored = () => {
  contextLost = false;
  hud.unpinMessage();
  refreshCounts();
};

/**
 * The colony: zones, habitats, the structures of the live sessions. The deck
 * and kerb textures are drawn once here, on a canvas, and shared by every
 * zone; the scatter is told what ground to leave clear whenever a zone's
 * footprint changes.
 */
const colony = new Colony({
  surfaces: { deck: deckSurface(), kerb: kerbSurface() },
  groundHeight: (x, z) => stage.groundHeight(x, z),
  onFootprint: (clear) => stage.setKeepClear(clear),
});
const lamps = new Lamps();
/** The ground's own colour, for dust thrown up off it. */
const dustTint = new THREE.Color();
/**
 * History on the ground: one crate per commit, beside the habitat. A fresh
 * one drops onto the pile, and where it lands it kicks up dust and flashes
 * the kerb in the colour of the kind of history it is.
 */
const crates = new Crates({
  onLand: (x, y, z, kind) => {
    particles.puff(x, y, z, dustTint.set(stage.planet.ground.high), y);
    colony.flashAt(x, z, RING_COLOR[kind]);
  },
});
/**
 * The git events on the towers and the piles: the last hour's, each once
 * (`shared/rings.ts`). Rebuilt from every snapshot, fed by the live events.
 */
const rings = new RingLedger();
/** Rings and crates redrawn whole from the ledger: nothing falls, it is a recount. */
function showRings(): void {
  const list = rings.all();
  city.setRings(list);
  crates.clear();
  for (const ev of list) crates.add(ev.projectId, ev.kind, false);
}
/** A skill in use: a supply lander hovering over the project's habitat. */
const landers = new Landers({
  onThrust: (x, y, z) => particles.exhaust(x, y, z),
});
/**
 * The ship is the HQ. It stands on the planet's surface, which moves when the
 * planet does.
 */
const ship = new Ship();
const hqAt = hqPlacement();
function settleShip(): void {
  ship.setGroundHeight(stage.groundHeight(hqAt.x, hqAt.z));
}
settleShip();
settings.onChange((changed) => {
  if (changed.has('planet')) settleShip();
});
/** The last notice of every session, held for a while: what makes an astronaut `blocked`. */
const notices = new Notices();
/**
 * The sessions that were already running when this page opened. Their
 * astronauts appear in place; anyone who starts later walks out of the ship.
 * Read off the first snapshot, because that is the one fact that says it.
 */
const knownAtBoot = new Set<string>();
/** The same, for subagents: one already running when the page opened is just there. */
const knownAgentsAtBoot = new Set<string>();
let bootSnapshotSeen = false;

/**
 * The crew: one astronaut per live session, routed round everything solid,
 * throwing sparks and dust. The face atlas is drawn on a canvas here, once,
 * and again when the texture quality changes; the rig lands with the pack.
 */
const nav = new Navigation();
const particles = new Particles(settings);
const astronauts = new Astronauts(settings, faceAtlas());
function faceAtlas(): THREE.Texture | null {
  try {
    return buildFaceAtlas(Math.min(settings.textureSize, 512));
  } catch {
    return null; // no 2d context: helmets without faces, not a broken page
  }
}
settings.onChange((changed) => {
  if (changed.has('textureQuality')) {
    astronauts.faceTexture?.dispose();
    astronauts.setFaceTexture(faceAtlas());
  }
  if (changed.has('planet')) colony.setPlanet(stage.planet);
});
colony.setPlanet(stage.planet);
colony.attachCrew({
  astronauts, nav, particles, ship,
  scatterObstacles: () => stage.scatterObstacles(),
  full: () => settings.get('particles') === 'full',
});
// The crew routes around the scatter, so a new scatter is a new grid.
stage.onScatterRebuilt = () => colony.rebuildNavigation();
/**
 * The lit lights: who is working on the lot, and for how long.
 *
 * Every zone is one hex whatever its size, and the lamps stand on its top
 * deck: the same twelve seats for every project.
 */
const lights = new Lights(() => LAMP_SEATS);
/**
 * Facade to redraw on the next frame.
 *
 * A burst of calls arrives in a single batch: redrawing on every event would
 * redo the facade ten times to show one.
 */
let lightsDirty = false;
let wasLifting = false;
/** How often the windows that have gone dark are removed, in seconds. */
const PRUNE_EVERY_S = 0.25;
let pruneAccum = 0;

/** The name of the work behind a window, only on mouse hover. */
const windowTip = new WindowTip(document.body);
/**
 * Where the pointer is on the scene. `null` when it is outside: over a
 * panel, or outside the browser window.
 */
let pointer: { x: number; y: number } | null = null;
/**
 * While you drag the camera the name stays off: a caption jumping from one
 * window to another while the city turns is just noise.
 */
let dragging = false;
canvas.addEventListener('pointermove', (e) => {
  pointer = { x: e.clientX, y: e.clientY };
  // Inside the ship the colony is not on screen: nothing out there to point at.
  if (stage.view) return;
  // Pointing at an astronaut: a ring under it, and a hand for the cursor.
  // Mid-drag the cursor is the grab hand and nothing else.
  if (stage.rig.interacting) return;
  const [x, y, aspect] = ndcOf(e);
  const hit = colony.pick(x, y, aspect, stage.camera);
  colony.setHover(hit);
  // Over no astronaut, a lot nobody works on is what a click opens.
  const lot = hit ? null : colony.pickProject(x, y, stage.camera);
  canvas.style.cursor = hit || (lot !== null && canOpenShell(lot)) ? 'pointer' : '';
});
canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || stage.view || !stage.rig.wasClick) return;
  const picked = colony.pick(...ndcOf(e), stage.camera);
  // A subagent's astronaut opens the session that launched it: it has no card of its own.
  const hit = picked === null ? null : colony.sessionOf(picked);
  if (!hit) {
    const [x, y] = ndcOf(e);
    const lot = colony.pickProject(x, y, stage.camera);
    if (lot !== null && canOpenShell(lot)) openShell(lot);
    return;
  }
  if (card.openFor === hit) card.close();
  else showCard(hit);
});

/** The pointer in normalised device coordinates, plus the aspect the picker needs. */
function ndcOf(e: PointerEvent): [number, number, number] {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return [(e.clientX / w) * 2 - 1, -(e.clientY / h) * 2 + 1, w / Math.max(1, h)];
}
canvas.addEventListener('pointerleave', () => {
  pointer = null;
});
canvas.addEventListener('pointerdown', () => {
  dragging = true;
});
// The city has no crew to point at: only its windows, whose name the tip
// reads, and the towers of projects nobody works on, which a click opens.
cityCanvas.addEventListener('pointermove', (e) => {
  pointer = { x: e.clientX, y: e.clientY };
  if (e.buttons !== 0) return;
  const id = city.pickProject(e.clientX, e.clientY);
  cityCanvas.style.cursor = id !== null && canOpenShell(id) ? 'pointer' : '';
});
/** Where the button went down: a click is a press that did not become a drag. */
let cityPress: { x: number; y: number } | null = null;
cityCanvas.addEventListener('pointerdown', (e) => {
  cityPress = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
});
cityCanvas.addEventListener('pointerup', (e) => {
  const press = cityPress;
  cityPress = null;
  if (!press || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) return;
  const id = city.pickProject(e.clientX, e.clientY);
  if (id !== null && canOpenShell(id)) openShell(id);
});
cityCanvas.addEventListener('pointerleave', () => {
  pointer = null;
});
cityCanvas.addEventListener('pointerdown', () => {
  dragging = true;
});
window.addEventListener('pointerup', () => {
  dragging = false;
});
/**
 * Rename and hide apply to ANY project, not only to those with a session on
 * them: the same two actions used to live in the badge's speech bubble,
 * which however exists only where someone is working.
 */
const projectMenu = new ProjectMenu(document.getElementById('badges')!, {
  onRename: (projectId, name) => socket?.send({ t: 'project.alias', projectId, name }),
  onHide: (projectId) => socket?.send({ t: 'project.disabled', projectId, disabled: true }),
  onReveal: (projectId) => socket?.send({ t: 'project.reveal', projectId }),
});

/**
 * The numbers, behind a button.
 *
 * The city answers "what is happening right now"; this answers "how much did
 * it cost and where did it go". Keeping both on screen together would mean
 * filling the scene with figures that are almost never looked at.
 */
const stats = new Stats(document.body);

function statsInput(): Parameters<typeof stats.open>[0] {
  return {
    projects: store.projects.values(),
    sessions: store.sessions.values(),
    files: store.files.values(),
    limits: store.limits,
    toolsByCat: store.toolsByCat,
    countingSince: store.countingSince,
  };
}

document.getElementById('stats-open')!.addEventListener('click', () => stats.toggle(statsInput()));

// The HUD's buttons are glyphs; the word each one used to carry is its
// aria-label, which the CSS shows on hover.
for (const [id, icon] of [
  ['stats-open', STATS_ICON],
  ['forecast-open', FORECAST_ICON],
  ['legend-open', LEGEND_ICON],
  ['settings-open', SETTINGS_ICON],
  ['help-open', HELP_ICON],
  ['boardroom-open', BOARD_ICON],
  ['reports-open', REPORT_ICON],
  ['effect-open', EFFECT_ICON],
  ['planning-open', PLAN_ICON],
  ['view-toggle', VIEW_ICON],
] as const) {
  // Prepended, not assigned: the instructions button already holds its tip.
  document.getElementById(id)!.insertAdjacentHTML('afterbegin', icon);
}

// The instructions show on hover; a click pins them, for a touch screen or
// for reading them while trying the keys. Any other press or Esc lets go.
{
  const help = document.getElementById('help-open')!;
  const unpin = (): void => { delete help.dataset['on']; };
  help.addEventListener('click', () => {
    if (help.dataset['on'] === 'yes') unpin();
    else help.dataset['on'] = 'yes';
  });
  window.addEventListener('pointerdown', (e) => {
    if (e.target instanceof Node && help.contains(e.target)) return;
    unpin();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') unpin();
  });
}

// Both top corners fold behind a chevron, remembered in this browser.
foldCorners({
  left: { body: document.getElementById('hud-body')!, button: document.getElementById('hud-fold') as HTMLButtonElement },
  right: { body: document.getElementById('topright-body')!, button: document.getElementById('topright-fold') as HTMLButtonElement },
}, safeStorage());

// The side panels open just under the corner whose buttons open them. How
// tall that corner is depends on folding, on the CEO buttons and on the buttons
// wrapping in a narrow window, so the CSS reads it from here rather than from
// a number that is right for one of those cases only.
{
  const hudEl = document.getElementById('hud')!;
  const place = (): void => {
    document.documentElement.style.setProperty('--hud-bottom', `${Math.ceil(hudEl.getBoundingClientRect().bottom)}px`);
  };
  new ResizeObserver(place).observe(hudEl);
  place();
}

// What every colour and every mark means in the view on screen: the city's
// or the colony's, never the two together (`showWorldView` tells it which).
const legend = new Legend(document.body, document.getElementById('legend-open')!);

// Quality, planet, time of day: opens from the same corner as the legend.
new SettingsPanel(document.body, document.getElementById('settings-open')!, settings);

/**
 * At this pace, does the quota last until it renews?
 *
 * The bars at the top say how much is left, not for how long: it sits next to
 * the legend because it answers the same question -- this thing I see, what
 * does it mean -- aimed at the bars instead of at the city.
 */
const forecast = new ForecastPanel(document.body, document.getElementById('forecast-open')!);

/**
 * The Board panel. This is where you talk to the CEOs.
 *
 * It is the only surface you decide from, and there is no other place that
 * keeps a copy of that state -- not even the room inside the ship: walking
 * up to the desk there opens this same panel.
 */
const boardroomBtn = document.getElementById('boardroom-open')!;
const boardroom = new Boardroom(document.body, boardroomBtn, {
  onAsk: (provider, text, analysis, depth) =>
    socket?.send({ t: 'ceo.say', provider, text, analysis, depth }),
  // `with` names the CEOs that exist, from the caps: the desk ignores anyone it
  // did not build, so an empty list would quietly become "everyone" instead.
  onMeeting: (topic, analysis, depth) =>
    socket?.send({
      t: 'meeting', kind: 'ceo',
      with: [...(store.caps?.ceoProviders ?? [])],
      topic, analysis, depth,
    }),
  // Nothing is decided here: the frame is sent and we wait for the server to
  // say how it went. The state machine lives in one place only.
  onDecide: (id, accept) => socket?.send({ t: 'proposal.decide', id, accept }),
  onReadTask: (id) => socket?.send({ t: 'proposal.read', id }),
  // Nothing is erased here either: the server clears, and its `ceo.cleared`
  // wipes this window and every other one alike.
  onReset: () => socket?.send({ t: 'board.reset' }),
});

/**
 * Planning: the meeting with the chair, and what launches from it.
 *
 * Every control sends one frame; nothing is decided here. The document comes
 * back from the server, with the reason when a change was not legal.
 */
const planningBtn = document.getElementById('planning-open')!;
const planning = new Planning(document.body, planningBtn, {
  onSay: (text) => socket?.send({ t: 'plan.say', text }),
  onAttach: (name, text) => socket?.send({ t: 'plan.attach', name, text }),
  onDetach: (id) => socket?.send({ t: 'plan.detach', id }),
  onSet: (patch) => socket?.send({ t: 'plan.set', patch }),
  onApprove: () => socket?.send({ t: 'plan.approve' }),
  onPause: () => socket?.send({ t: 'plan.pause' }),
  onResume: () => socket?.send({ t: 'plan.resume' }),
  onLaunch: () => socket?.send({ t: 'plan.launch' }),
  onAnswer: (taskId, text) => socket?.send({ t: 'plan.answer', taskId, text }),
  onAllow: (taskId) => socket?.send({ t: 'plan.allow', taskId }),
  onRetry: (taskId) => socket?.send({ t: 'plan.retry', taskId }),
  onSkip: (taskId) => socket?.send({ t: 'plan.skip', taskId }),
  onRead: () => socket?.send({ t: 'plan.read' }),
  onReset: () => socket?.send({ t: 'plan.reset' }),
  // Reports and Planning are the same box in the same corner -- fixed to the
  // same top and left, a panel's width apart in size -- so one opened under
  // the other is a click that does nothing you can see. Measured: `read` on
  // a finished task opened Reports behind the plan. Going to read the
  // outcome means leaving the plan, so the plan closes.
  onOpenJob: (id) => {
    planning.close();
    reports.open(id);
  },
  onWatchJob: (id) => socket?.send({ t: 'job.watch', id }),
}, document.getElementById('planning-alert'));

/**
 * Inside the ship: a room with the CEOs at their desk, and you walking in.
 *
 * The room is handed the Planning panel above -- the object itself, not a
 * copy, not a second one built for the room -- and opens it when you reach
 * the desk. Planning and not Board, by the user's call (2026-09-20): walking
 * up to the two of them is the moment you plan with them, and the brief is a
 * question you ask one of them from the HUD, at the button that is always
 * there. It is drawn by the stage's own renderer as a second view, and you
 * get there the way the crew does: up the ramp, through the hatch. Only with
 * CEOs: without them the desk is empty and there is no reason to go in.
 */
const interior = new Interior({
  settings,
  faceTexture: astronauts.faceTexture,
  panel: planning,
  onLeave: () => leaveShip(),
});
const boarding = new Boarding(settings, astronauts.faceTexture, {
  shipDoor: (out) => ship.shipDoor(out),
  shipWayIn: (out) => ship.wayIn(out),
  groundAt: (x, z) => colony.groundAt(x, z),
  ping: () => ship.ping(),
});
boarding.onAboard = () => enterShip();
/** The room's reflections are prefiltered on the first visit, not at boot: most sessions never go in. */
let interiorLit = false;
/** The crew's rig has landed: before it, you would walk up the ramp as a floating helmet. */
let rigReady = false;
settings.onChange((changed) => {
  // After the colony's own handler, which has just swapped the atlas.
  if (changed.has('textureQuality')) {
    interior.setFaceTexture(astronauts.faceTexture);
    boarding.setFaceTexture(astronauts.faceTexture);
  }
});
/** The hint at the bottom of the screen while you are inside: the keys, and the way out. */
const insideHint = document.getElementById('inside-hint')!;

/**
 * Up the ramp. The camera goes to the ship and you walk in the way the crew
 * goes home; `enterShip` is the moment you are through the hatch.
 */
function boardShip(): void {
  // The room is the colony's: in the city there is no ramp to climb (the
  // user's call, 2026-09-24).
  if (worldView !== 'colony') return;
  if (stage.view || boarding.busy || !rigReady || !boardroom.enabled) return;
  const at = hqPlacement();
  const door = ship.shipDoor(new THREE.Vector3());
  // Between the hull and the foot of the ramp: both in the frame, and you on the ramp between them.
  stage.frameSpot({ x: (at.x + door.x) / 2, y: 0, z: (at.z + door.z) / 2 }, BOARDING_SPAN);
  badges.setZoomed(null);
  card.close();
  colony.setSelected(null);
  boarding.start();
}

/** How much the camera takes in while you climb: the ship, its ramp, and a little plaza. */
const BOARDING_SPAN = 13;

function enterShip(): void {
  // The CEOs went away while you were on the ramp: nobody left to meet.
  if (!boardroom.enabled || worldView !== 'colony') return;
  if (!interiorLit) {
    interior.setEnvironment(roomReflections(stage.renderer));
    interiorLit = true;
  }
  interior.enter();
  stage.setView(interior);
  document.body.classList.add('is-inside');
  insideHint.hidden = false;
  colony.setHover(null);
  windowTip.hide();
  // The engine's handle on the canvas: the guard on `canvas` up top does not
  // narrow inside a function declared this far below it.
  stage.engine.canvas.style.cursor = '';
}

/** Back out onto the ramp, with the ship in the frame. */
function leaveShip(): void {
  if (stage.view !== interior) return;
  interior.leave();
  stage.setView(null);
  document.body.classList.remove('is-inside');
  insideHint.hidden = true;
  const span = (HQ_PLAZA_RADIUS + HQ_HEIGHT * 0.5) * 1.25;
  stage.frameSpot(Ship.focus(), span);
  ship.ping();
}

/*
 * The walking keys, inside only. A key held while the focus jumps into a
 * text box -- the Board panel's, say -- never sends its keyup here, so the
 * keys are let go whenever that happens, and when the window loses focus.
 */
window.addEventListener('keyup', (e) => interior.keys.release(e.code));
window.addEventListener('blur', () => interior.keys.clear());
document.addEventListener('focusin', (e) => {
  if (isTyping(e.target)) interior.keys.clear();
});

/** Somewhere keys are words: a project's name, a question to a CEO. */
function isTyping(el: EventTarget | Element | null): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
    || (el instanceof HTMLElement && el.isContentEditable);
}

/**
 * Reports. How it went.
 *
 * Beside board and not inside it: board is where you decide, here you read
 * what happened after deciding. They are two different moments of the same
 * day, and a single panel would have made them fight over the same space.
 */
const reportsBtn = document.getElementById('reports-open')!;
const reports = new Reports(document.body, reportsBtn, {
  onRead: (id) => socket?.send({ t: 'job.read', id }),
  onWatch: (id) => socket?.send({ t: 'job.watch', id }),
  onOpen: (id, index) => socket?.send({ t: 'job.open', id, index }),
  onReset: () => socket?.send({ t: 'jobs.reset' }),
  onDelete: (id) => socket?.send({ t: 'job.delete', id }),
});

/**
 * The third moment.
 *
 * In board you decide, in Reports you read how the JOB went, here how the
 * PROJECT went in the weeks after. Reports answers in five minutes, this one
 * in five sessions: in the same box one would keep the other waiting.
 */
const effectBtn = document.getElementById('effect-open')!;
const effect = new Effect(document.body, effectBtn, {
  onRead: () => socket?.send({ t: 'effect.read' }),
  onJudge: (id) => socket?.send({ t: 'effect.judge', id }),
  onDelete: (id) => socket?.send({ t: 'effect.delete', id }),
  onReset: () => socket?.send({ t: 'effects.reset' }),
});

/**
 * Is there a project that both tools work on?
 *
 * `ProjectInfo.providers` decides it, and it is sticky: it counts time too,
 * not only who is on right now. Without a project in common the meeting of
 * the two CEOs has no subject, and you ask one at a time about its own
 * projects.
 */
function refreshShared(): void {
  let shared = false;
  for (const p of store.projects.values()) {
    if (!p.disabled && p.providers.length > 1) { shared = true; break; }
  }
  boardroom.setShared(shared);
}

const labels = new Labels(document.getElementById('labels')!, stage.camera, {
  onEnter: (item, node) => {
    if (item.kind !== 'project') return;
    const id = item.id.slice(2); // the nameplate carries the `p:` prefix
    // On a project that is ON the same actions are already in the badge's
    // speech bubble, a few pixels away: opening them here too would mean
    // two identical menus on top of each other. The check is here and not on
    // a flag decided when the nameplate is born, because a project switches
    // on and off while the nameplate stays the same.
    if (store.activeProjectIds.has(id)) return;
    const project = store.projects.get(id);
    node.style.cursor = canOpenShell(id) ? 'pointer' : '';
    projectMenu.open(id, project?.name ?? item.text, node, project?.exists ?? false);
  },
  onLeave: () => projectMenu.scheduleClose(),
  onClick: (item) => {
    if (item.kind !== 'project') return;
    const id = item.id.slice(2);
    if (canOpenShell(id)) openShell(id);
  },
});

/**
 * A project with no session on it -- no badge over its name -- opens a
 * Terminal in its folder on a click, ready for `claude` or `codex`. One with
 * a session has badges, and they are what a click there is for.
 */
function canOpenShell(projectId: string): boolean {
  if (!(store.caps?.focus ?? false)) return false;
  if (store.activeProjectIds.has(projectId)) return false;
  return store.projects.get(projectId)?.exists ?? false;
}

function openShell(projectId: string): void {
  socket?.send({ t: 'project.terminal', projectId });
}
const card = new SessionCard(document.getElementById('card')!, (id) => jumpToTerminal(id));
const badges = new Badges(document.getElementById('badges')!, stage.camera, {
  onSelect: (id) => {
    if (card.openFor === id) card.close();
    else showCard(id);
  },
  onFocus: (id) => jumpToTerminal(id),
  onZoom: (projectId) => zoomToProject(projectId),
  onZoomOut: () => frameColony(),
  onRename: (projectId, name) => socket?.send({ t: 'project.alias', projectId, name }),
  onHide: (projectId) => socket?.send({ t: 'project.disabled', projectId, disabled: true }),
  onReveal: (projectId) => socket?.send({ t: 'project.reveal', projectId }),
});
stage.addLayer(colony);
stage.addLayer(ship);
stage.addLayer(crates);
stage.addLayer(landers);
stage.addLayer(astronauts);
stage.addLayer(boarding);
stage.addLayer(particles);
stage.addLayer(lamps);
stage.addLayer(labels);
stage.addLayer(badges);

/**
 * What runs every frame whichever view is on screen: the fps counter, the
 * menu that rides a nameplate, the lights running out, the tip under the
 * pointer. Both views' lights are pruned, the hidden one's too: a lamp that
 * outlived its time while you looked at the city must not be lit when you
 * switch back to the colony.
 */
function commonFrame(dt: number, fps: number): void {
  hud.setFps(fps);
  // The menu is anchored to a nameplate, and the nameplate moves with the
  // city: without this it would slide away on its own as soon as you touch
  // the camera.
  projectMenu.place();
  // A window goes dark when its time is up, not when an event arrives:
  // with the city still, no event would ever remove it.
  pruneAccum += dt;
  if (pruneAccum >= PRUNE_EVERY_S) {
    pruneAccum = 0;
    const now = Date.now();
    if (lights.prune(now)) lightsDirty = true;
    city.prune(now);
  }
  // Every frame and not only when the mouse moves: the camera keeps
  // gliding after the gesture, and the lights switch on and off by
  // themselves.
  refreshWindowTip();
}

// The city's own service layer. The nameplates and the badges are layers of
// the colony's stage; while the city is on screen that stage does not run,
// so they are stepped from here, through the city's camera.
city.addLayer({
  object3d: new THREE.Group(),
  update: (dt) => {
    commonFrame(dt, city.stage.fps);
    labels.update(dt);
    badges.update();
  },
  dispose: () => {},
});

// Service layer: keeps the fps counter up to date without touching the scene.
stage.addLayer({
  object3d: new THREE.Group(),
  update: (dt) => {
    commonFrame(dt, stage.fps);
    // A stack gaining a deck pushes its top up for a second or two: the lamps
    // and the crates standing on it ride along, one frame past the end too.
    const lifting = colony.lifting;
    if (lightsDirty || lifting || wasLifting) {
      lightsDirty = false;
      refreshLamps();
    }
    if (lifting || wasLifting) crates.place((id) => colony.positionOf(id));
    wasLifting = lifting;
    // How dark it is, read once per frame from the sky and handed to whoever
    // lights up after dark: kerbs, habitat windows, lamp heads, the ship.
    const night = stage.night;
    colony.setNight(night);
    lamps.setNight(night);
    ship.setNight(night);
    // Dust and the like, wherever the camera is looking.
    particles.ambient(dt, stage.camera, stage.planet);
  },
  dispose: () => {},
});

/**
 * Frame the HQ, and come back to the city.
 *
 * It needs an explicit command because the HQ sits at negative z while the
 * camera starts at +Z: at startup it is behind the whole city, and no
 * automatic framing would ever show it. A key and not a button: the HUD is
 * already full, and this gesture is learned only once.
 */
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // Never steal a key from someone typing a project's name.
  if (isTyping(document.activeElement)) return;

  const key = e.key.toLowerCase();
  // Inside the ship the keys walk, and E is the way back out; the colony's
  // keys would move a camera nobody is looking through.
  if (stage.view === interior) {
    if (interior.keys.press(e.code)) e.preventDefault();
    else if (key === 'e' && !e.repeat) leaveShip();
    return;
  }
  if (key === 'v' && !e.repeat) {
    setWorldView(worldView === 'city' ? 'colony' : 'city');
    return;
  }
  // The city has the map key only: it has no HQ to frame or walk into (the
  // user's call, 2026-09-24), and planet, time and orbit are the colony's sky.
  if (worldView === 'city') {
    if (key === 'c') frameColony();
    return;
  }
  if (key === 'e' && !e.repeat) {
    boardShip();
  } else if (key === 'h') {
    // The span holds the plaza and the ship's height: with the plaza alone
    // the ship fell out of the bottom of the frame.
    const span = (HQ_PLAZA_RADIUS + HQ_HEIGHT * 0.5) * 1.25;
    stage.frameSpot(Ship.focus(), span);
    badges.setZoomed(null);
  } else if (key === 'c') {
    frameColony();
  } else if (key === 'p') {
    // The next planet round. A key and not only a chip in the panel: it is
    // the one setting worth flipping while watching the colony.
    const i = PLANET_ORDER.indexOf(settings.get('planet'));
    settings.set('planet', PLANET_ORDER[(i + 1) % PLANET_ORDER.length]!);
  } else if (key === 't') {
    // Step to the next named time after the current one, wrapping at
    // midnight, and stop following the clock: you asked for a light.
    settings.set('autoTime', false);
    settings.set('clockTime', false);
    settings.set('timeOfDay', nextTime(settings.get('timeOfDay')).value);
  } else if (key === 'o') {
    stage.rig.toggleOrbit();
  }
});

/**
 * Closes the gaps left by hidden projects.
 *
 * The slot the server assigns remains the truth: it is what keeps the city
 * still from one restart to the next, and bringing a project back into view
 * returns it exactly to its place in the order. Here only the PRESENTATION is
 * compacted, keeping the relative order -- so hiding the third building
 * shifts the fourth into its place instead of leaving a hole.
 *
 * Buildings move, but only when YOU take something away: it is not a
 * spontaneous movement, it is the visible consequence of a gesture of yours.
 */
function compactSlots(projects: readonly ProjectInfo[]): ProjectInfo[] {
  return [...projects]
    .sort((a, b) => a.slot - b.slot)
    .map((p, i) => (p.slot === i ? p : { ...p, slot: i }));
}

/**
 * How wide to frame at startup.
 *
 * Not the whole city: with fifteen projects, framing them all means seeing
 * them all badly, and the windows -- which are the living part of the
 * facade -- drop below a few pixels and stop being readable. Frame where the
 * work is happening, with a margin so the outline stays visible.
 *
 * The margin is counted in hexes, not in zone pitches: a zone is one hex, and
 * one active project now opens with its deck, its crew and the ring of bare
 * ground around it filling the view -- about 75 units back -- where a margin
 * of pitches put it 160 away, a coin in the middle of a plain.
 */
const FRAME_MARGIN = HEX_SIZE * 1.5;
const FRAME_MIN_RADIUS = HEX_SIZE * 2.5;
/**
 * With nobody at work, the most recent projects: slot 0 and the ring around
 * it. The whole colony is one `C` away, and opening on all of it is what made
 * every deck a few pixels wide.
 */
const RECENT_SLOTS = 5;

/**
 * What to frame: how wide the city is AND where its centre is.
 *
 * The centre has not been the origin since lots started growing away from
 * the HQ: with the city spreading south, aiming at (0,0) leaves it bunched in
 * a corner with half the screen empty on the other side. Look at the centre
 * of the rectangle that actually contains it.
 *
 * `visible` must carry the compacted slots, the ones the colony draws with.
 */
function framingBox(visible: readonly ProjectInfo[], whole = false): { cx: number; cz: number; radius: number } {
  const active = store.activeProjectIds;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let any = false;

  // First try with the live sessions alone: they are the centre of attention.
  const passes: ((p: ProjectInfo) => boolean)[] = whole
    ? [() => true]
    : [(p) => active.has(p.id), (p) => p.slot < RECENT_SLOTS];
  for (const wanted of passes) {
    for (const p of visible) {
      if (!wanted(p)) continue;
      const at = placeSlot(p.slot);
      minX = Math.min(minX, at.x); maxX = Math.max(maxX, at.x);
      minZ = Math.min(minZ, at.z); maxZ = Math.max(maxZ, at.z);
      any = true;
    }
    if (any) break;
  }
  if (!any) return { cx: 0, cz: 0, radius: FRAME_MIN_RADIUS };

  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const half = Math.max(maxX - minX, maxZ - minZ) / 2;
  return { cx, cz, radius: Math.max(half + FRAME_MARGIN, FRAME_MIN_RADIUS) };
}

/** The projects on the map, with the slots the colony actually draws them at. */
function visibleProjects(): ProjectInfo[] {
  return compactSlots([...store.projects.values()].filter((p) => !p.disabled));
}

/**
 * Latest commit per project.
 *
 * It is what the session's nameplate shows instead of the handle: the
 * session's technical name says nothing about what is being done, the subject
 * of the latest commit does.
 */
const latestCommit = new Map<string, string>();

/**
 * How long the caption of a commit just made stays on screen.
 *
 * A commit is an EVENT: the instant it happens it is worth seeing from the
 * whole city. Right after, it is history, and history lives in the tower
 * rings, which do not steal attention from what is happening now.
 */
const COMMIT_FLASH_MS = 12_000;
const COMMIT_FLASH_DISTANCE = 420;

/** How old an event may be and still move the crew: older is replay, not news. */
const LIVE_EVENT_MS = 15_000;

/** When the latest commit of every project was MADE. */
const commitSeenAt = new Map<string, number>();

function refreshLamps(): void {
  lamps.setLights(lights.values(), (projectId) => colony.zoneMetrics(projectId), Date.now());
}

/**
 * What every live session is doing, as the colony reads it: one status per
 * session, decided by `crewStatus` so the scene, the badge and the card
 * never disagree.
 */
function refreshColonySessions(): void {
  const now = Date.now();
  colony.setSessions([...store.sessions.values()].map((s) => ({
    id: s.id,
    projectId: s.projectId,
    provider: s.provider,
    status: crewStatus(s, notices.of(s.id, now), now),
    toolCalls: s.toolCalls,
    known: knownAtBoot.has(s.id),
    activity: s.activityTool ? categoryOf(s.activityTool) : null,
  })));
  refreshSubagents();
}

/**
 * The subagents walk out of their habitat; the skills keep a lander over it.
 * Both read `store.agents`, which is what a lamp reads too, so a figure and
 * its lamp come and go together. The lander's other visits -- a prompt, a
 * call out to the web or MCP -- are moments, and come through `onDelta`.
 */
function refreshSubagents(): void {
  const subagents: ColonySubagent[] = [];
  const skilled = new Set<string>();
  for (const a of store.agents.values()) {
    if (a.kind === 'skill') {
      skilled.add(a.projectId);
      continue;
    }
    subagents.push({ id: a.id, sessionId: a.sessionId, projectId: a.projectId, known: knownAgentsAtBoot.has(a.id) });
  }
  colony.setSubagents(subagents);
  landers.set(skilled, (projectId) => colony.summitAt(projectId));
}

/** Switches the windows of turns and agents on and off according to the state. */
function syncLights(): void {
  const now = Date.now();
  if (lights.sync(store.sessions, store.agents, now)) lightsDirty = true;
  city.sync(store.sessions, store.agents, now);
}

function refreshWindowTip(): void {
  if (stage.view) {
    windowTip.hide();
    return;
  }
  if (worldView === 'city') {
    const lit = pointer && !dragging ? city.pick(pointer.x, pointer.y) : null;
    if (lit && pointer) {
      windowTip.show(describeLight(lit), `#${cityLightColor(lit).toString(16).padStart(6, '0')}`, pointer.x, pointer.y);
    } else {
      windowTip.hide();
    }
    return;
  }
  const light = pointer && !dragging
    ? lamps.pick(pointer.x, pointer.y, stage.camera, window.innerWidth, window.innerHeight)
    : null;
  if (light && pointer) {
    windowTip.show(describeLight(light), `#${lightColor(light).toString(16).padStart(6, '0')}`, pointer.x, pointer.y);
    return;
  }
  // A small astronaut says what it is only when pointed at, like a lamp.
  const id = pointer && !dragging && !stage.rig.interacting ? crewUnder(pointer) : null;
  const sub = id === null ? null : colony.subagentOf(id);
  const helping = id === null ? null : colony.helperOf(id);
  if (!pointer || (!sub && !helping)) {
    windowTip.hide();
    return;
  }
  if (sub) {
    const info = store.agents.get(sub.id);
    // The subagent's own lamp colour: the figure and its lamp are the same work.
    windowTip.show(`Subagent · ${info?.agentType ?? 'agent'}`, `#${TOOL_COLOR.agent.toString(16).padStart(6, '0')}`, pointer.x, pointer.y);
    return;
  }
  // A helper is its session's last call: the name its lamp would give, in that lamp's colour.
  const tool = helping === null ? null : store.sessions.get(helping)?.activityTool ?? null;
  const color = tool ? TOOL_COLOR[categoryOf(tool)] : TOOL_COLOR.other;
  windowTip.show(`Helper · ${toolName(tool)}`, `#${color.toString(16).padStart(6, '0')}`, pointer.x, pointer.y);
}

function crewUnder(at: { x: number; y: number }): string | null {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return colony.pick((at.x / w) * 2 - 1, -(at.y / h) * 2 + 1, w / Math.max(1, h), stage.camera);
}

/**
 * What you read hovering over a window: what work it is, and what it is called.
 *
 * The turn takes the session's title -- it is the task it is working on --
 * read now and not when the light is born, because it changes while it
 * works. `done` says the work is over and the light is only running out its
 * minimum: without it, a lit window would always look like it is at work.
 */
function describeLight(light: Light): string {
  const done = light.endedAt !== null ? ' · done' : '';
  switch (light.kind) {
    case 'turn': {
      const s = store.sessions.get(light.sessionId);
      return `Task · ${s?.title ?? s?.label ?? 'session'}${done}`;
    }
    case 'tool':
      return `Tool · ${toolName(light.name)}${done}`;
    case 'subagent':
      return `Subagent · ${light.name ?? 'agent'}${done}`;
    case 'skill':
      return `Skill · ${light.name ?? '?'}${done}`;
  }
}

/**
 * A tool's name, readable.
 *
 * An MCP tool is called `mcp__<server>__<name>`: spelled out, that is half a
 * line of prefixes before the word that matters.
 */
function toolName(name: string | null): string {
  if (!name) return '?';
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[2]} (${mcp[1]})` : name;
}

const store = new Store({
  onCaps: (caps) => {
    // Without --ceo there is nobody to talk to: the button does not appear.
    // The CEOs come from the caps and not from an event, so even a client
    // that connects to an already running world finds the desks in place.
    // Analyses first and then the CEOs: the desks are built in here, and a
    // desk born without the phrases would have five buttons that arm an
    // analysis without being able to show it.
    boardroom.setAnalyses(caps.analyses ?? []);
    boardroom.setProviders(caps.ceoProviders);
    boardroomBtn.hidden = !caps.ceo || caps.ceoProviders.length === 0;
    // The log and open buttons open windows here: not offered without `focus`.
    reports.setFocus(caps.focus);
    // The same CEOs at the desk inside the ship, and the key that gets you
    // there only where there is someone to meet.
    interior.setCeos(boardroomBtn.hidden ? [] : caps.ceoProviders);
    for (const el of document.querySelectorAll<HTMLElement>('[data-ceo-key]')) el.hidden = boardroomBtn.hidden;
    if (boardroomBtn.hidden) leaveShip();
    reportsBtn.hidden = boardroomBtn.hidden;
    if (reportsBtn.hidden) reports.close();
    effectBtn.hidden = boardroomBtn.hidden;
    if (effectBtn.hidden) effect.close();
    // Its own cap: the desk may be there without the meeting, the day the
    // module is split again.
    planning.setProviders(caps.plan ? caps.ceoProviders : []);
    planningBtn.hidden = !caps.plan || caps.ceoProviders.length === 0;
    if (planningBtn.hidden) planning.close();
    refreshShared();
  },
  onLimits: () => {
    refreshSpend();
  },
  // The server says which panel asked: the reply lands there and nowhere
  // else. Before `surface` the panels guessed by "who is waiting", and a
  // third panel would have made the guess wrong once a day.
  onCeoStream: (provider, delta, done, surface) => {
    if (surface === 'plan') { planning.stream(delta, done); return; }
    if (surface === 'effect' && effect.stream(provider, delta, done)) return;
    boardroom.stream(provider, delta, done);
  },
  onDelta: (event) => {
    if (event.t === 'ceo') {
      boardroom.setState(event.provider, event.state, event.reason);
      // The figure at the desk wears the same state: one word, not a copy of the conversation.
      interior.setCeoState(event.provider, event.state);
      return;
    }
    // An analysis' outcome. It goes to everyone, not only to whoever asked:
    // it is a fact of the world.
    if (event.t === 'report') {
      boardroom.setReport(event);
      return;
    }
    if (event.t === 'proposal') {
      boardroom.setProposal(event);
      return;
    }
    if (event.t === 'plan') {
      planning.setPlan(event);
      return;
    }
    if (event.t === 'job') {
      reports.setJob(event);
      // A worker's hover and card name the task it was given, and the job is
      // where that name lives.
      refreshBadges();
      return;
    }
    if (event.t === 'ceo.cleared') {
      if (event.what === 'board') boardroom.clear();
      else {
        reports.clear(event.keep);
        refreshBadges();
      }
      return;
    }

    // The city draws the same events its own way: a pulse, a ring, a window.
    city.apply(event, store.sessions);

    if (event.t === 'git') {
      // Through the ledger: a reflog line replayed after a server restart,
      // or older than an hour, makes no ring and no crate.
      if (rings.accept(event, Date.now())) {
        // Only a commit that just happened is cheered, and only its crate
        // falls: at startup the whole history on disk arrives at once, and
        // that is history, not news.
        const fresh = Date.now() - event.at < 60_000;
        crates.add(event.projectId, event.kind, fresh);
        if (fresh) colony.commit(event.projectId, event.kind);
        city.setRings(rings.all());
      }
      if (event.subject && event.kind !== 'checkout') {
        latestCommit.set(event.projectId, event.subject);
        // The instant of the commit, not the one it reached us.
        commitSeenAt.set(event.projectId, event.at);
        refreshLabels();
      }
      return;
    }
    // An error notice, or the activity that clears it, changes what an
    // astronaut is doing even though the session's status did not move.
    if (notices.apply(event)) refreshColonySessions();
    // The hands take the shape of the work, sparks fly in its colour (the
    // lamp's), and the project's kerb light speeds up. Only for what is
    // happening now: the server re-reads the tail of every transcript it
    // attaches, and a page opening onto that replay would see every astronaut
    // hop for turns that ended an hour ago.
    if (Date.now() - ('at' in event ? event.at : 0) < LIVE_EVENT_MS) {
      if (event.t === 'tool.start') colony.toolStart(event.sessionId, event.cat, event.at);
      if (event.t === 'file.touch' && event.op !== 'read') colony.fileWritten(event.sessionId);
      if (event.t === 'turn.end') colony.turnEnd(event.sessionId);
      if (event.t === 'prompt') colony.prompt(event.sessionId);
      // A prompt, or a call out of the colony: the supply lander pays a visit.
      if (summonsLander(event)) {
        const projectId = store.sessions.get(event.sessionId)?.projectId;
        if (projectId) landers.visit(projectId);
      }
    }
    // Every tool call, every subagent, every skill: a light.
    if (lights.apply(event, store.sessions)) lightsDirty = true;
  },
  onFiles: () => refreshCounts(),
  onTopology: () => {
    refreshShared();
    syncLights();
    // A hidden project has no building, and without a building everything
    // else -- windows, nameplates, badges -- goes dark by itself, because
    // there is no place to hook onto.
    const projects = visibleProjects();
    // The latest commit already arrives in the snapshot: without this, whoever
    // opens the page would see an empty nameplate until the next commit.
    for (const p of projects) {
      if (p.lastCommit) latestCommit.set(p.id, p.lastCommit);
    }
    colony.setProjects(projects.map((p) => ({ id: p.id, slot: p.slot, size: p.size, exists: p.exists })));
    city.setProjects(projects);
    city.frame(projects, store.activeProjectIds);
    refreshColonySessions();
    crates.place((id) => colony.positionOf(id));
    stage.frameCity(framingBox(projects));
    // The lamps stand on the zones: if a zone was rebuilt, they go back on it.
    refreshLamps();
    refreshLabels();
    refreshCounts();
  },
  onPresence: () => {
    syncLights();
    city.setPresence(visibleProjects());
    refreshColonySessions();
    refreshLabels();
    refreshCounts();
  },
});

/**
 * Fly in close to one project: its deck, its habitat, the structures of its
 * sessions and the crew working on them, all in the frame and nothing else.
 *
 * Measured like the ship's framing: the hex, plus half of what stands on it
 * (the stack and the habitat), with a margin so the ramp and the lamps on the
 * rim stay in.
 */
function zoomToProject(projectId: string): void {
  if (worldView === 'city') {
    if (city.zoomTo(projectId)) badges.setZoomed(projectId);
    return;
  }
  const at = colony.positionOf(projectId);
  if (!at) return;
  const span = (colony.footprintOf(projectId) + (at.y + colony.heightOf(projectId)) * 0.5) * PROJECT_ZOOM;
  stage.frameSpot(at, span);
  badges.setZoomed(projectId);
}

/**
 * How much of the frame one project takes when zoomed in on. At 1.2 the
 * whole zone and its ramp sat in the middle of a wide margin: the lens is for
 * watching the crew work, so the frame is the deck and a sliver around it.
 */
const PROJECT_ZOOM = 0.75;

/**
 * Every project on the map, framed from above: the C key and the way back
 * out of a project. With the slots it is drawn at: the raw ones counted the
 * hidden projects too, and framed ground nobody stands on.
 */
function frameColony(): void {
  if (worldView === 'city') {
    city.frame(visibleProjects(), store.activeProjectIds, true);
    badges.setZoomed(null);
    return;
  }
  const box = framingBox(visibleProjects(), true);
  stage.frameCity({ ...box, radius: box.radius * COLONY_ZOOM }, true);
  badges.setZoomed(null);
}

/**
 * How tight the way back out frames the colony. The box already carries a
 * margin and `frameCity` adds another on top: with both, six projects sat 134
 * units back and took 40% of the screen, a jump from 21 that lost the project
 * you had just left. At 0.65 they fill the view with the ramps still in.
 */
const COLONY_ZOOM = 0.65;

/** How far above the summit a project's name floats: enough to clear the roof seen from above. */
const LABEL_GAP = 0.6;
/** A fresh commit's caption, over the name. The city's towers are metres taller, so its gap is too. */
const COMMIT_RISE = 1.2;
const CITY_COMMIT_RISE = 4.1;

/**
 * Where a project's name hangs in the view on screen, and so its badges and
 * its commit caption: the summit of the habitat in the colony (the zone's
 * root before the kit has built one), over the roof in the city.
 */
function anchorOf(projectId: string): { position: THREE.Vector3; offsetY: number } | null {
  if (worldView === 'city') return city.anchorOf(projectId);
  const position = colony.summitAt(projectId) ?? colony.positionOf(projectId);
  return position ? { position, offsetY: LABEL_GAP } : null;
}

/** One nameplate per building, one per session: that is how you recognise the city. */
function refreshLabels(): void {
  const items: LabelItem[] = [];

  for (const project of store.projects.values()) {
    // On the summit of the habitat, and LIVE: the vector rises with the
    // building. Before the kit lands there is no habitat, only the deck.
    const anchor = anchorOf(project.id);
    if (!anchor) continue;
    // Only the name. This nameplate is the map: it must stay short and always
    // the same, otherwise it stops helping you find your way around.
    items.push({
      id: `p:${project.id}`,
      text: projectPlateText(project.name, project.exists),
      kind: 'project',
      position: anchor.position,
      offsetY: anchor.offsetY,
      // The nameplate takes the mouse: it is the door for renaming a project
      // or getting it out of the way even when nobody is working on it.
      interactive: true,
      priority: 3,
    });
  }

  // The commit shows up ONLY in the instant it happens, then disappears.
  //
  // Showing it afterwards too meant keeping text on screen about an
  // operation already finished, which competes for attention with what is
  // happening now. The history is already told by the rings on the tower, in
  // silence: an event deserves a caption, a state deserves a shape.
  for (const [projectId, subject] of latestCommit) {
    if (Date.now() - (commitSeenAt.get(projectId) ?? 0) >= COMMIT_FLASH_MS) continue;
    const anchor = anchorOf(projectId);
    if (!anchor) continue;
    items.push({
      id: `c:${projectId}`,
      text: subject,
      kind: 'commit',
      position: anchor.position,
      offsetY: anchor.offsetY + (worldView === 'city' ? CITY_COMMIT_RISE : COMMIT_RISE),
      maxDistance: COMMIT_FLASH_DISTANCE,
      priority: 1,
    });
  }

  // No nameplate next to the windows: neither the name of a skill nor the
  // type of a subagent. Who is working is told by the window's COLOUR; the
  // name is read by hovering over it (`describeLight`), it is not in the scene.

  labels.set(items);
  refreshBadges();
}

/** Width of a badge plus the breathing room between two: used to space them. */
const BADGE_PITCH = 38;

/**
 * From the foot of the project's name to the centre of a badge over it, in
 * pixels: the label (11px text at line-height 1.5, 2px padding and 1px border
 * each side: 23), a breath of 3, and the outer radius of the context arc (23),
 * so even a full arc clears the name.
 */
const BADGE_LIFT = 23 + 3 + 23;

/**
 * One badge per session, on its building.
 *
 * There used to be a line of text here for every session. It said the same
 * thing, but it took up the space all the time: with a few live sessions the
 * city became a wall of captions, and the project's name -- which is the
 * map -- got lost in it. The symbol says the state, the rest you ask for.
 */
function refreshBadges(): void {
  const items: BadgeItem[] = [];
  const now = Date.now();

  // Several sessions on the same project sit on the same building: they have
  // to be shifted apart, otherwise they cover each other and only one shows.
  const perProject = new Map<string, number>();
  for (const s of store.sessions.values()) {
    perProject.set(s.projectId, (perProject.get(s.projectId) ?? 0) + 1);
  }
  const placed = new Map<string, number>();

  for (const session of store.sessions.values()) {
    // Over the project's name, never on the astronaut: the glyph says how
    // the project's work is going, and a glyph riding a helmet wandered off
    // with every walk. Halfway up the habitat it covered the building and
    // sat under the name; now it takes the name's own point -- live, rising
    // with the habitat, the zone root before the kit has built one -- and
    // floats a label's height above it.
    const anchor = anchorOf(session.projectId);
    if (!anchor) continue;

    const total = perProject.get(session.projectId) ?? 1;
    const index = placed.get(session.projectId) ?? 0;
    placed.set(session.projectId, index + 1);

    // The stopwatch starts from when the current state began, so for a busy
    // session it measures the run in progress, not the session's age; for a
    // waiting one it says how long it has been waiting for you.
    const timed = session.status !== 'idle';
    const elapsed = timed ? formatElapsed(now - session.statusSince) : '';

    items.push({
      id: session.id,
      position: anchor.position,
      offsetY: anchor.offsetY,
      lift: BADGE_LIFT,
      provider: session.provider,
      state: badgeStateOf(crewStatus(session, notices.of(session.id, now), now)),
      inferred: session.statusConfidence === 'inferred',
      // Side by side across the building, centred on it.
      shift: (index - (total - 1) / 2) * BADGE_PITCH,
      hover: hoverText(session, elapsed),
      // Without a PID there is no terminal to find, but the project is still
      // there: the click opens a shell in it. With neither, the details.
      canFocus: canJump(session),
      focusTitle: jumpTitle(session),
      projectId: session.projectId,
      projectName: store.projects.get(session.projectId)?.name ?? '',
      canReveal: (store.caps?.focus ?? false) && (store.projects.get(session.projectId)?.exists ?? false),
      contextPct: session.contextPct,
    });
  }

  badges.set(items);
  // The open panel must follow the session it describes, not stay stuck on
  // what was true at the moment of the click.
  if (card.openFor) showCard(card.openFor);
}

/**
 * The glyph for what the astronaut is doing. Blocked wears the alert like
 * waiting does: both want you, and the hover says which.
 */
function badgeStateOf(status: CrewStatus): BadgeState {
  if (status === 'working') return 'busy';
  if (status === 'waiting' || status === 'blocked') return 'waiting';
  // idle: the turn is over. It is the same signal that used to switch off the
  // facade's windows, made explicit here with the check mark.
  return 'done';
}

/**
 * What THIS session is doing: first the gesture in progress, then the context.
 *
 * The order is not random. The session title is almost always the same for
 * hours -- for Claude Code it is often identical to the handle -- so on its
 * own it does not tell a session apart from itself half an hour ago. The tool
 * in use does. The commit does not show here: it belongs to the project and
 * sits on its nameplate.
 */
function hoverText(session: SessionInfo, elapsed: string): string {
  const what = whatOf(session);
  // The arc around the circle shows the context at a glance; here is the
  // number, for whoever wants to know how long before the session compacts.
  const ctx = session.contextPct !== null ? `\ncontext ${Math.round(session.contextPct)}%` : '';

  if (session.status === 'waiting') {
    const why = session.waitingFor ?? what;
    return (elapsed ? `Awaiting you · ${elapsed}\n${why}` : `Awaiting you\n${why}`) + ctx;
  }

  if (session.status === 'busy') {
    const doing = describeActivity(session);
    const head = doing ?? what;
    const tail = doing ? `${what} · ${elapsed}` : elapsed;
    return (tail ? `${head}\n${tail}` : head) + ctx;
  }

  // Done: how long the task LASTED, not how long ago it ended. The time
  // elapsed since the end is read in the panel, where there is room to say
  // which of the two numbers it is.
  const took = session.lastTurnMs !== null ? ` in ${formatElapsed(session.lastTurnMs)}` : '';
  return `Done${took}\n${what}${ctx}`;
}

/**
 * What a session is about, in one line.
 *
 * A worker has no title of its own -- its label is a name Claude Code derived
 * from the folder -- but it was given a task, and the task is what you
 * approved: that is how you recognise it on a lot next to your own sessions.
 */
function whatOf(session: SessionInfo): string {
  if (session.spawnedByCeo !== null) {
    const job = store.jobOf(session.id);
    if (job) return `Worker: ${job.summary}`;
  }
  return session.title ?? session.label;
}

/**
 * Asks the server to bring this session's terminal to the front.
 *
 * Only the id travels: the server resolves the PID on its own model, so
 * nothing born in the browser can end up in a command.
 */
const pendingFocus = new PendingFocus();

function jumpToTerminal(sessionId: string): void {
  if (!socket) return;
  const now = Date.now();
  // A second click while the first is on its way would only queue a second
  // AppleScript behind it: the ring already says it is coming.
  if (!pendingFocus.begin(sessionId, now)) return;
  badges.markFocusPending(sessionId);
  card.markFocusPending(sessionId, now);
  socket.send({ t: 'focus', sessionId });
}

/**
 * A click can reach a terminal: the session's own, or -- once its process is
 * gone -- a new one the server opens in the project's folder.
 */
function canJump(session: SessionInfo): boolean {
  if (!(store.caps?.focus ?? false)) return false;
  return session.pid > 1 || (store.projects.get(session.projectId)?.exists ?? false);
}

/** What that click does, in words. The server decides; this only names it. */
function jumpTitle(session: SessionInfo): string {
  if (session.pid <= 1) return SHELL_TITLE;
  return session.spawnedByCeo === null ? FOCUS_TITLE : FOLLOW_TITLE;
}

/** Opens the detail panel, or updates it if it is already the open one. */
function showCard(sessionId: string): void {
  const session = store.sessions.get(sessionId);
  if (!session) {
    card.close();
    colony.setSelected(null);
    return;
  }
  colony.setSelected(sessionId);
  card.show(session, {
    project: store.projects.get(session.projectId),
    sinceMs: Date.now() - session.statusSince,
    canFocus: canJump(session),
    focusTitle: jumpTitle(session),
    what: whatOf(session),
    trail: store.trail.of(sessionId),
  });
}


// A quota window resets on its own clock, and nothing arrives from the server
// when it does: without this the bar kept last night's percentage until the
// next session event, which on an idle morning never comes.
window.setInterval(refreshSpend, 30_000);
// A ring stays an hour: once a minute the ones that grew older go.
window.setInterval(() => {
  if (rings.prune(Date.now())) showRings();
}, 60_000);

// The stopwatch must keep running even when nothing arrives from the server.
window.setInterval(() => {
  for (const s of store.sessions.values()) {
    if (s.status === 'busy' || s.status === 'waiting') {
      refreshLabels();
      return;
    }
  }
}, 1000);

/**
 * The counters describe the city you SEE.
 *
 * A hidden project has no building, and with it go its windows and its
 * session's badge: counting them here would give a number that matches
 * nothing on the screen. How many are missing is already said by the button
 * below, which is also the way to get them back.
 */
function refreshCounts(): void {
  // A disabled project counts nowhere: not itself, nor the sessions, nor the
  // agents or the files that belong to it. You declared it is not in play,
  // and the totals must say the same thing.
  const off = new Set<string>();
  for (const p of store.projects.values()) if (p.disabled) off.add(p.id);

  let sessions = 0;
  for (const s of store.sessions.values()) if (!off.has(s.projectId)) sessions++;
  let agents = 0;
  for (const a of store.agents.values()) if (!off.has(a.projectId)) agents++;
  let files = 0;
  for (const f of store.files.values()) if (!off.has(f.projectId)) files++;

  hud.setCounts(store.projects.size - off.size, sessions, agents, files);
  refreshSpend();
  // When open, it updates before your eyes: a panel of frozen numbers while
  // the city moves would look broken.
  if (stats.isOpen) stats.render(statsInput());
}

/**
 * Usage per tool: the sum of what has already been counted per session.
 *
 * A row shows up only if that tool is actually in the city: two rows, one of
 * them always at zero, would mostly say that you do not use the other one.
 */
function refreshSpend(): void {
  const zero = (): TokenTotals => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 });
  const totals: Record<ProviderId, TokenTotals> = { claude: zero(), codex: zero() };
  const seen: Record<ProviderId, boolean> = { claude: false, codex: false };

  for (const s of store.sessions.values()) {
    seen[s.provider] = true;
    const t = totals[s.provider];
    t.in += s.tokens.in;
    t.out += s.tokens.out;
    t.cacheRead += s.tokens.cacheRead;
    t.cacheWrite += s.tokens.cacheWrite;
    t.thinking += s.tokens.thinking;
  }
  // The quota used outlives the session that reported it: if we know anything
  // about it, that tool stays in the list even with its sessions closed.
  for (const provider of store.limits.keys()) seen[provider] = true;

  hud.setSpend(
    (['claude', 'codex'] as const)
      .filter((p) => seen[p])
      .map((p) => ({ provider: p, tokens: totals[p], limits: store.limits.get(p) })),
  );
  // The forecast comes from the same numbers as the bars: it is refreshed
  // here, otherwise with the panel open it would show the pace of ten minutes
  // ago.
  forecast.update({ limits: store.limits, now: Date.now() });
  const off: { id: string; name: string }[] = [];
  for (const p of store.projects.values()) if (p.disabled) off.push({ id: p.id, name: p.name });
  hud.setDisabled(off, {
    onRestore: (projectId) => socket?.send({ t: 'project.disabled', projectId, disabled: false }),
    onRestoreAll: () => socket?.send({ t: 'project.showAll' }),
  });
}

/**
 * Switch between the city and the colony.
 *
 * Only the view on screen runs its frame loop: the other one keeps receiving
 * the store's changes -- the colony's astronauts are placed, its lamps are
 * lit -- but draws nothing, and the colony decodes its model pack the first
 * time it is shown, not at load. Nameplates and badges are the same ones,
 * re-anchored and projected through the new view's camera. Leaving the colony
 * from inside the ship walks you out first; halfway up the ramp the switch
 * waits, since the walk ends in a door the city does not have.
 */
function setWorldView(next: WorldView): void {
  if (next === worldView) return;
  if (worldView === 'colony') {
    if (boarding.busy) return;
    leaveShip();
    colony.setHover(null);
    stage.stop();
  } else {
    city.stop();
  }
  worldView = next;
  showWorldView();
}

let assetsBooted = false;

function showWorldView(): void {
  const colonyOn = worldView === 'colony';
  // The stages' own handles: the guards on the canvases up top do not narrow
  // inside a function declared this far below them.
  stage.engine.canvas.hidden = !colonyOn;
  city.stage.renderer.domElement.hidden = colonyOn;
  document.body.classList.toggle('view-city', !colonyOn);
  const camera = colonyOn ? stage.camera : city.camera;
  labels.setCamera(camera);
  badges.setCamera(camera);
  badges.setZoomed(null);
  windowTip.hide();
  legend.setView(worldView);
  { const idle = idleMessage(worldView); hud.setIdleMessage(idle.title, idle.body); }
  if (colonyOn) {
    // Hidden, the canvas kept a size nobody measured: measure before drawing.
    stage.resize();
    stage.start();
    if (!assetsBooted) {
      assetsBooted = true;
      bootAssets().catch((err: unknown) => {
        // The colony without its models is decks and lamps on bare ground: still a
        // map, so the page stays up, but it has to say why the buildings are missing.
        console.error('[assets]', err);
        hud.pinMessage('Models unavailable', 'The model pack could not be decoded; the colony shows its ground only.');
      });
    }
  } else {
    city.stage.resize();
    city.start();
  }
  viewToggle.setAttribute('aria-label', colonyOn ? 'City view (lighter)' : 'Colony view (full detail)');
  refreshLabels();
}

const viewToggle = document.getElementById('view-toggle')!;
viewToggle.addEventListener('click', () => setWorldView(worldView === 'city' ? 'colony' : 'city'));
showWorldView();

/**
 * A handle for poking at the running colony from the console, and for the
 * headless checks that read it over the debugging protocol. Data only; no
 * network primitive lives behind it.
 */
(window as unknown as Record<string, unknown>)['__aw'] = {
  stage, settings, store, colony, interior, boarding, boardroom, boardShip, leaveShip,
  city, setWorldView, view: () => worldView, ready: true,
};

/** The channel to the server. Absent until the token has been resolved. */
let socket: Socket | null = null;

const token = resolveToken();
if (!token) {
  hud.pinMessage(
    'Token link required',
    'Open the address printed by the terminal, the one ending in <code>?t=…</code>. ' +
      'The token is deliberately not embedded in the page: if it were, any local process could read it and connect.',
  );
} else {
  socket = new Socket(token, {
    onState: (state) => {
      hud.setLink(state);
      // A reconnect says nothing about the GPU: a lost 3D view keeps its message.
      if (state === 'on' && !contextLost) hud.unpinMessage();
      if (state === 'off') {
        hud.pinMessage('Connection lost', 'Retrying automatically. If the server stopped, restart it from the terminal.');
      }
    },
    onFrame: (frame) => {
      if (frame.t === 'error') {
        hud.pinMessage(
          'The server refused the connection',
          frame.code === 'version_mismatch'
            ? 'Protocol version mismatch: reload the page.'
            : 'Invalid token: reopen the link printed by the terminal.',
        );
        return;
      }
      if (frame.t === 'terminal.result') {
        labels.flash(`p:${frame.projectId}`, frame.ok, frame.reason);
        return;
      }
      if (frame.t === 'reveal.result') {
        projectMenu.reportReveal(frame.projectId, frame.ok, frame.reason);
        badges.reportReveal(frame.projectId, frame.ok, frame.reason);
        return;
      }
      if (frame.t === 'proposal.task') {
        boardroom.setProposalTask(frame.id, frame.task, frame.project);
        return;
      }
      if (frame.t === 'job.outcome') {
        reports.setOutcome(
          frame.id, frame.text, frame.truncated, frame.review, frame.reviewTruncated,
        );
        return;
      }
      if (frame.t === 'job.result') {
        // Both panels have the button: whichever you pressed shows the answer.
        reports.reportResult(frame.id, frame.action, frame.ok, frame.reason);
        if (frame.action === 'watch') planning.reportJob(frame.id, frame.ok, frame.reason);
        return;
      }
      if (frame.t === 'effect.board') {
        effect.setBoard(frame.items);
        return;
      }
      if (frame.t === 'plan.doc') {
        planning.setDoc(frame.plan, frame.refused);
        return;
      }
      if (frame.t === 'focus.result') {
        pendingFocus.end(frame.sessionId);
        badges.reportFocus(frame.sessionId, frame.ok, frame.reason);
        card.reportFocus(frame.sessionId, frame.ok, frame.reason);
        return;
      }
      // Every snapshot, first or after a reconnect, rebuilds the rings and
      // the crates from the server's ledger: the page shows what the server
      // holds, not what this tab happened to receive while it was open.
      if (frame.t === 'snapshot') {
        rings.reset(frame.rings ?? [], Date.now());
        showRings();
      }
      if (frame.t === 'snapshot' && !bootSnapshotSeen) {
        bootSnapshotSeen = true;
        for (const s of frame.sessions) knownAtBoot.add(s.id);
        for (const a of frame.agents) knownAgentsAtBoot.add(a.id);
      }
      if (store.apply(frame)) socket?.send({ t: 'resync' });
    },
  });
  socket.connect();
}

/**
 * The model pack, decoded after the first frame.
 *
 * It is a five-megabyte chunk loaded with a dynamic import, so the sky and
 * the ground are on screen before it arrives; the colony waits for the kit
 * (`onAssetsReady`) and the scatter is rebuilt with real boulders and trees.
 * Nothing here fetches: the bytes are a string in the chunk, the textures
 * come from `createImageBitmap` on those bytes.
 */
async function bootAssets(): Promise<void> {
  const [{ PACK }, { parseGlb, bytesFromDataUri }, { loadKit }] = await Promise.all([
    import('./assets/pack.ts'), import('./assets/glb.ts'), import('./assets/kit.ts'),
  ]);
  const base = parseGlb(bytesFromDataUri(PACK.spacebase));
  const forest = parseGlb(bytesFromDataUri(PACK.forest));
  loadKit('base', base, await textureFrom(base.image));
  loadKit('forest', forest, await textureFrom(forest.image));
  colony.onAssetsReady();
  stage.rebuildWorld();
  refreshLabels();
  // The crew's rig last: a fifth of a second of baking, after the ground
  // and the buildings are already there to stand on.
  const { bakeCrew } = await import('./assets/crew.ts');
  const rig = bakeCrew(parseGlb(bytesFromDataUri(PACK.crew)));
  astronauts.setRig(rig);
  // One bake for everyone: the CEOs at their desk and the crew of one that
  // walks you up the ramp are the same body.
  interior.setRig(rig);
  boarding.setRig(rig);
  // You are not crew, and you are not in a suit: the villager is what the
  // ramp and the room draw where that crew of one walks.
  const { buildVillager } = await import('./assets/villager.ts');
  const villagerDoc = parseGlb(bytesFromDataUri(PACK.villager));
  const villager = buildVillager(villagerDoc, await textureFrom(villagerDoc.image));
  interior.setVillager(villager);
  boarding.setVillager(villager);
  rigReady = true;
}

/** A texture from the bytes of a PNG, with the glTF convention of not flipping. */
async function textureFrom(image: { mimeType: string; bytes: Uint8Array } | null): Promise<THREE.Texture | null> {
  if (!image) return null;
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), {
    imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
  });
  const texture = new THREE.Texture(bitmap);
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

