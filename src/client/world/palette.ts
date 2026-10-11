/**
 * Holographic neon palette. The one place where the colours live.
 * Near-black background, volumes defined by glowing edges.
 */
import type { ToolCategory, ProviderId } from '../../shared/protocol.ts';
import { categoryOf } from '../../shared/toolCategories.ts';
import type { Light } from '../state/lights.ts';

export const BG = 0x05070c;
export const FOG = 0x05070c;

export const GRID_MAJOR = 0x3f8fc4;
export const GRID_MINOR = 0x1d4463;
export const STREET = 0x2a5f85;

export const EDGE = 0x39d0ff;        // building edges
export const EDGE_DIM = 0x2f6f96;    // building switched off
export const RUIN = 0x6b3f5c;        // project no longer on disk

/**
 * The colour of the tool at work. It is the piece of information that tells
 * who occupies a building, so it holds everywhere: nameplate, leader line,
 * avatar halo, tower edges and windows lit by the session.
 */
export const PROVIDER_COLOR: Record<ProviderId, number> = {
  claude: 0xffb254,
  // White and not cyan: cyan is already the colour of project names, and two
  // meanings on the same colour make the scene ambiguous.
  codex: 0xeef4ff,
};

/** When both work on the same project: neither of the two wins. */
export const PROVIDER_BOTH = 0xffd9a8;

/**
 * A window lit by a skill in use.
 *
 * Pink, not the purple of subagents: a skill is not someone working in
 * parallel but instructions that guide the session, and mixing them up would
 * say there are more people inside the building than there are. Light and
 * low in saturation against the full fuchsia of `net`, its closest neighbour
 * on the wheel: two near-identical pinks on adjacent facades would not be
 * told apart.
 */
export const SKILL_COLOR = 0xffa3cf;

export const HQ = 0xc77dff;          // CEO HQ: magenta, stands out

/**
 * The colour of a tool category: it says WHAT is being done.
 *
 * It holds in three places at once -- the window lit by the call, the pulse
 * leaving the building, the tool-mix donut -- so a call to `Bash` is the same
 * red wherever you look at it.
 *
 * The hues are chosen to stand ALL TOGETHER on one facade: each is at least
 * 15 ΔE2000 away from every other and from the colours sharing the scene
 * (Claude's orange, Codex's white, the skills' pink). When touching one, the
 * check is to look at all of them: two categories that look alike take away
 * the one thing the window says.
 */
export const TOOL_COLOR: Record<ToolCategory, number> = {
  read:   0x4fb4ff,  // light blue
  edit:   0xb4ee4a,  // lime green
  exec:   0xff5a4d,  // coral red
  search: 0x3fe0a0,  // mint green
  net:    0xff4fb0,  // fuchsia
  agent:  0xcc5cff,  // purple
  plan:   0x6d8cff,  // blue
  msg:    0xffe066,  // yellow
  mcp:    0x19d6d6,  // turquoise
  other:  0x6b7a86,  // grey: a tool we cannot read must not shout
};

/**
 * The tower rings above the roof, one for every HEAD movement read from the
 * reflog. A branch switch produces none: it is not new history.
 *
 * Here and not inside the tower because the legend shows them too, and two
 * copies of the same colour drift apart at the first touch-up.
 */
export const RING_COLOR = {
  commit: 0x8ef6c4,
  merge: 0xc77dff,
  rebase: 0xa8b4ff,
  reset: 0xff8c42,
  checkout: 0x7de3ff,
  other: 0x8899aa,
} as const;

/**
 * The accents a zone can wear: its kerb, its lamps, the trim band of its
 * habitat. Bot Crossing's twelve, chosen to read apart on a deck under the
 * same sun. A project picks one by hash and keeps it: like its slot, the
 * colour is part of the map you learn.
 */
export const ZONE_PALETTE: readonly number[] = [
  0xc96442, 0x4f9a63, 0x4f7ec9, 0xb8942a, 0x8b5cc9, 0xc94f8b,
  0x3fa8a0, 0xc97f4f, 0x6f8f4f, 0x5c7fc9, 0xc95c5c, 0x7f6fc9,
];

/**
 * What colour the light is: it says WHAT WORK it is.
 *
 * The turn takes the tool's colour, the same as the building: it is the
 * session itself at its desk, and it remains the only window that says
 * whether Claude Code or Codex is inside. Each call instead takes the colour
 * of its category -- red a shell, light blue a read, green a write -- the
 * same as the pulse leaving at the same instant. Subagents and skills have
 * their own, because they are something else entering the building.
 *
 * Calls used to take the tool's colour too: a whole facade of orange windows
 * said only "Claude Code is working", which the building already said. Now
 * the facade says what it is doing.
 */
export function lightColor(light: Light): number {
  switch (light.kind) {
    case 'subagent':
      return TOOL_COLOR.agent;
    case 'skill':
      return SKILL_COLOR;
    case 'tool':
      // Without a name it stays `other`: a grey window is still a call in
      // progress, and switching it off would hide real work.
      return TOOL_COLOR[categoryOf(light.name ?? '')];
    case 'turn':
      return PROVIDER_COLOR[light.provider ?? 'claude'];
  }
}
