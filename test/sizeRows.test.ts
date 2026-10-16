import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sizeRows, SIZE_NOTE } from '../src/client/ui/format.ts';
import { MAX_SCANNED_FILES } from '../src/shared/protocol.ts';

/**
 * What a tower stands for, on its card (the user's request, 2026-10-16).
 *
 * Asked why CMM grew faster than every other tower, the answer took a scan
 * by hand: a Laravel scaffold had given it 206 files in one commit, and
 * compiled views a hundred more, on a scale where every doubling is the same
 * three and a half floors. The card now says the height and what it is
 * counted from, for any project.
 */

test('the city tells floors, the colony decks: the same count on two scales', () => {
  const cmm = { size: 305, dirs: 41 };
  assert.deepEqual(sizeRows(cmm, 'city'), [
    ['floors', '21'],
    ['files', '≈ 305'],
    ['folders', '≈ 41'],
  ]);
  assert.deepEqual(sizeRows(cmm, 'colony')[0], ['decks', '4']);
});

test('a scan cut at its cap says "at least", not a number it never finished', () => {
  const rows = sizeRows({ size: MAX_SCANNED_FILES, dirs: 1234 }, 'city');
  assert.deepEqual(rows.slice(1), [['files', '20,000+'], ['folders', '1,234+']]);
});

test('a project from a server that does not count folders shows a dash, not zero folders', () => {
  const old = { size: 12 } as unknown as { size: number; dirs: number };
  assert.deepEqual(sizeRows(old, 'city')[2], ['folders', '—']);
});

test('the note names the limits the counts come from', () => {
  assert.match(SIZE_NOTE, /20,000 files/);
  assert.match(SIZE_NOTE, /10 levels/);
});
