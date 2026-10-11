import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange, plateRect, projectPlateText, ENTRY_MARGIN } from '../src/client/ui/labels.ts';
import type { Candidate } from '../src/client/ui/labels.ts';

/**
 * The names over the towers flickered while the view turned.
 *
 * Seen on 2026-09-28, after an earlier attempt that decided only every
 * 200 ms: two names close on screen still went on and off. A hidden name was
 * tested every frame and shown on any frame it happened to fit, and it was
 * tested at a guessed width (a hidden node measures 0), so it "fitted", was
 * shown, measured its real width on the next frame and hid again.
 */

const W = 120;
const H = 18;

function at(id: string, x: number, y = 300): Candidate {
  return { id, rect: plateRect(x, y, W, H) };
}

test('between decisions a hidden name stays hidden, even on a frame it would fit', () => {
  const shown = arrange([at('a', 200), at('b', 600)], new Set(['a']), false);
  assert.deepEqual([...shown], ['a']);
});

test('between decisions a shown name stays shown while it has a place on screen', () => {
  const overlapping = [at('a', 200), at('b', 230)];
  assert.deepEqual([...arrange(overlapping, new Set(['a', 'b']), false)].sort(), ['a', 'b']);
  // Off screen (behind the camera, past the edge) it goes at once.
  assert.deepEqual([...arrange([at('a', 200), { id: 'b', rect: null }], new Set(['a', 'b']), false)], ['a']);
});

test('two names sliding past each other do not trade places at every decision', () => {
  // The camera turns: b moves across a, one pixel per step, and a decision
  // falls on every step. Count how often b changes state.
  let visible: ReadonlySet<string> = new Set(['a', 'b']);
  let flips = 0;
  let last = true;
  for (let x = 600; x >= 200; x -= 1) {
    visible = arrange([at('a', 200), at('b', x)], visible, true);
    const now = visible.has('b');
    if (now !== last) flips++;
    last = now;
  }
  for (let x = 200; x <= 600; x += 1) {
    visible = arrange([at('a', 200), at('b', x)], visible, true);
    const now = visible.has('b');
    if (now !== last) flips++;
    last = now;
  }
  assert.equal(flips, 2, 'b hides once when it runs into a, and comes back once when it is clear');
  assert.ok(visible.has('a'), 'the name ahead in rank never gave way');
});

test('a name jittering on the edge of its neighbour does not blink', () => {
  // Hand-held rotation: the gap between two names wobbles by a few pixels
  // around zero. The one already shown leaves on a real overlap; coming back
  // takes more than the wobble.
  const touch = W + 6; // centre distance at which the two boxes just meet
  let visible: ReadonlySet<string> = new Set(['a', 'b']);
  visible = arrange([at('a', 200), at('b', 200 + touch - 2)], visible, true);
  assert.equal(visible.has('b'), false, 'a real overlap hides the lower-ranked name');
  for (const wobble of [1, 3, 5, -1, 4, 2, 6, 0]) {
    visible = arrange([at('a', 200), at('b', 200 + touch + wobble)], visible, true);
    assert.equal(visible.has('b'), false, `back after ${wobble} px of clearance, less than ${ENTRY_MARGIN}`);
  }
  visible = arrange([at('a', 200), at('b', 200 + touch + ENTRY_MARGIN)], visible, true);
  assert.ok(visible.has('b'), 'with the margin clear it comes back');
});

test('at a decision, the ranking decides who keeps the space', () => {
  const shown = arrange([at('near', 200), at('far', 210), at('alone', 700)], new Set(), true);
  assert.deepEqual([...shown].sort(), ['alone', 'near']);
});

/**
 * Asked on 2026-10-09: a project renamed in lower case must still read in
 * capitals on its tower. The capitals were only a CSS rule, so the plate's
 * own text kept whatever case the rename had.
 */
test('a project renamed in lower case reads in capitals on its tower', () => {
  assert.equal(projectPlateText('my_dashboard', true), 'MY_DASHBOARD');
  assert.equal(projectPlateText('Seniqs new website', true), 'SENIQS NEW WEBSITE');
  assert.equal(projectPlateText('decsim2', false), 'DECSIM2 (GONE)');
});
