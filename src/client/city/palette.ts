/**
 * Neon holographic palette. One single place where colors live.
 * Almost-black background, volumes defined by luminous edges.
 */
import type { ToolCategory, ProviderId } from '../../shared/protocol.ts';

export const BG = 0x05070c;
export const FOG = 0x05070c;

/** The floor grid: the brighter line every few cells, and the fine ones between. */
export const GRID_MAJOR = 0x3f8fc4;
export const GRID_MINOR = 0x1d4463;

export const EDGE = 0x39d0ff;        // building edges
export const EDGE_DIM = 0x2f6f96;    // powered-off building
export const RUIN = 0x6b3f5c;        // project no longer on disk

/**
 * The color of the tool at work. It is the piece of information that
 * distinguishes who occupies a building, so it applies everywhere: nameplate,
 * beacon line, avatar glow, tower edges, and windows lit by the session.
 */
export const PROVIDER_COLOR: Record<ProviderId, number> = {
  claude: 0xffb254,
  // White, not cyan: cyan is already the color of project names, and two
  // meanings on the same color make the scene ambiguous.
  codex: 0xeef4ff,
};

/** When both work on the same project: neither one wins. */
export const PROVIDER_BOTH = 0xffd9a8;

/**
 * A window lit by a skill in use.
 *
 * Pink, not the violet of subagents: a skill is not someone working in
 * parallel but instructions guiding the session, and confusing them would say
 * there is more people inside the building than there actually is. Light and
 * low-saturation against the full fuchsia of `net`, which is its closest
 * neighbor on the wheel: two near-identical pinks on adjacent facades would
 * not be distinguishable.
 */
export const SKILL_COLOR = 0xffa3cf;


/**
 * The color of a tool category: it says WHAT is being done.
 *
 * It applies in three places together -- the window lit by the call, the
 * pulse leaving the building, the tool-mix donut -- so a call to `Bash` is
 * the same red everywhere it is seen.
 *
 * The hues are chosen to all sit TOGETHER on one facade: each is far from
 * every other and from the colors sharing the scene (Claude's orange,
 * Codex's white, the skills' pink) by at least 15 deltaE2000. Touching one,
 * the check is to look at them all: two categories that look alike take away
 * from the window the one thing it says.
 */
export const TOOL_COLOR: Record<ToolCategory, number> = {
  read:   0x4fb4ff,  // light blue
  edit:   0xb4ee4a,  // lime green
  exec:   0xff5a4d,  // coral red
  search: 0x3fe0a0,  // mint green
  net:    0xff4fb0,  // fuchsia
  agent:  0xcc5cff,  // violet
  plan:   0x6d8cff,  // blue
  msg:    0xffe066,  // yellow
  mcp:    0x19d6d6,  // turquoise
  other:  0x6b7a86,  // gray: a tool we cannot read should not shout
};

/**
 * The tower rings above the roof, one for each HEAD movement read from the
 * reflog. Switching branches does not produce one: it is not new history.
 *
 * Here and not inside the tower because the legend shows them too, and two
 * copies of the same color diverge at the first tweak.
 */
export const RING_COLOR = {
  commit: 0x8ef6c4,
  merge: 0xc77dff,
  rebase: 0xa8b4ff,
  reset: 0xff8c42,
  checkout: 0x7de3ff,
  other: 0x8899aa,
} as const;
