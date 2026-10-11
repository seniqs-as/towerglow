import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legendFor } from '../src/client/ui/legend.ts';
import type { LegendRow, LegendSection, LegendView } from '../src/client/ui/legend.ts';
import * as CITY from '../src/client/city/palette.ts';
import * as COLONY from '../src/client/world/palette.ts';
import type { ToolCategory } from '../src/shared/protocol.ts';

/**
 * One legend per view.
 *
 * The legend used to be a single list: a section about the city on top, then
 * the whole colony. Open on the city it explained a ship, a crew and decks
 * that view does not draw -- and said so itself, "there is no ship here" --
 * while the colony's reader had to skip the towers first.
 */

/** Every word a row shows. */
function wordsOf(row: LegendRow): string {
  return row.kind === 'note' ? row.text : `${row.name} ${row.meaning}`;
}

/** The first thing in a legend that names a mark of the other view, if any. */
function strayMark(sections: readonly LegendSection[], marks: RegExp): string | null {
  for (const s of sections) {
    const title = marks.exec(s.title);
    if (title) return `"${title[0]}" in the title "${s.title}"`;
    for (const row of s.rows) {
      const hit = marks.exec(wordsOf(row));
      if (hit) return `"${hit[0]}" under "${s.title}": ${wordsOf(row)}`;
    }
  }
  return null;
}

/** What only the colony draws. */
const COLONY_MARKS = /\b(ship|astronaut|habitat|deck|kerb|lamp|crate|lander|planet|hatch|rotor|suit|zone)s?\b/i;
/** What only the city draws. */
const CITY_MARKS = /\b(tower|capsule|facade|roof|ring)s?\b/i;

const CATEGORIES: ToolCategory[] = ['read', 'edit', 'exec', 'search', 'net', 'agent', 'plan', 'msg', 'mcp', 'other'];

test('the legend open on the city explains no ship, no crew and no deck', () => {
  assert.equal(strayMark(legendFor('city'), COLONY_MARKS), null);
});

test('the legend open on the colony explains no tower, no capsule and no ring', () => {
  assert.equal(strayMark(legendFor('colony'), CITY_MARKS), null);
});

test('the ship is explained in the colony, where it still stands', () => {
  const ship = legendFor('colony').find((s) => s.title === 'The ship');
  assert.ok(ship, 'the colony draws the ship: its legend has to say what it is');
  assert.ok(ship.rows.length > 0);
});

test('each legend explains the marks of its own view', () => {
  const titles = (view: LegendView): string[] => legendFor(view).map((s) => s.title);
  for (const title of ['Towers', 'Windows', 'Rings over the tower']) {
    assert.ok(titles('city').includes(title), `the city legend lost "${title}"`);
  }
  for (const title of ['Zones', 'Crew', 'Lamps on the deck', 'Crates by the habitat']) {
    assert.ok(titles('colony').includes(title), `the colony legend lost "${title}"`);
  }
});

test('both legends name every tool category, in the colour their own view draws it', () => {
  for (const [view, palette] of [['city', CITY], ['colony', COLONY]] as const) {
    const kinds = legendFor(view).find((s) => s.title === 'What a tool call is doing');
    assert.ok(kinds, `the ${view} legend has no list of tool categories`);
    const swatches = kinds.rows.filter((r) => r.kind === 'swatch');
    assert.deepEqual(swatches.map((r) => r.color), CATEGORIES.map((c) => palette.TOOL_COLOR[c]));
  }
});

test('both legends explain the three session symbols and the context arc', () => {
  for (const view of ['city', 'colony'] as const) {
    const rows = legendFor(view).flatMap((s) => s.rows);
    const states = rows.filter((r) => r.kind === 'symbol').map((r) => r.state);
    assert.deepEqual(states, ['busy', 'done', 'wait'], `${view}: the badge is the same in both views`);
    assert.equal(rows.filter((r) => r.kind === 'context').length, 1, `${view}: the context arc`);
  }
});

test('each legend says how to get to the other view', () => {
  for (const view of ['city', 'colony'] as const) {
    const first = legendFor(view)[0]!;
    const other = view === 'city' ? 'colony' : 'city';
    assert.match(first.rows.map(wordsOf).join(' '), new RegExp(`V, .* switches .*${other}`));
  }
});
