import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Tailer } from '../src/server/watch/tailer.ts';

function tmpFile(contents = ''): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-tail-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, contents);
  return file;
}

test('reads whole lines appended after opening', async () => {
  const file = tmpFile();
  const lines: string[] = [];
  const tailer = new Tailer(file, 0, (l) => lines.push(l));
  await tailer.open();

  fs.appendFileSync(file, 'one\ntwo\n');
  await tailer.pump();
  assert.deepEqual(lines, ['one', 'two']);

  fs.appendFileSync(file, 'three\n');
  await tailer.pump();
  assert.deepEqual(lines, ['one', 'two', 'three']);
  await tailer.close();
});

test('holds back a partial line until its newline arrives', async () => {
  const file = tmpFile();
  const lines: string[] = [];
  const tailer = new Tailer(file, 0, (l) => lines.push(l));
  await tailer.open();

  // A write interrupted halfway: the line must NOT be emitted truncated.
  fs.appendFileSync(file, '{"type":"assis');
  await tailer.pump();
  assert.deepEqual(lines, [], 'a partial line must not be emitted');

  fs.appendFileSync(file, 'tant"}\n');
  await tailer.pump();
  assert.deepEqual(lines, ['{"type":"assistant"}']);
  await tailer.close();
});

test('does not corrupt a UTF-8 character split across two reads', async () => {
  const file = tmpFile();
  const lines: string[] = [];
  // A tiny chunk: it is the only way to make the read boundary fall exactly
  // inside a multibyte character.
  const tailer = new Tailer(file, 0, (l) => lines.push(l), 4);
  await tailer.open();

  const payload = 'però—naïve 😀 fine';
  fs.appendFileSync(file, payload + '\n');
  await tailer.pump();

  assert.deepEqual(lines, [payload], 'multibyte characters must survive chunking');
  await tailer.close();
});

test('recovers when the file is truncated', async () => {
  const file = tmpFile('old\n');
  const lines: string[] = [];
  const tailer = new Tailer(file, 0, (l) => lines.push(l));
  await tailer.open();

  fs.appendFileSync(file, 'before\n');
  await tailer.pump();
  assert.deepEqual(lines, ['before']);

  // Truncation: unhandled, the offset would stay past the end of the file and
  // nothing would ever be read again.
  fs.writeFileSync(file, '');
  await tailer.pump();
  fs.appendFileSync(file, 'after\n');
  await tailer.pump();
  assert.deepEqual(lines, ['before', 'after']);
  await tailer.close();
});

test('warm-up starts from the tail and drops the truncated first line', async () => {
  const body = Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n') + '\n';
  const file = tmpFile(body);
  const lines: string[] = [];

  const tailer = new Tailer(file, 30, (l) => lines.push(l));
  await tailer.open();

  assert.ok(lines.length > 0, 'the warm-up should surface recent activity');
  assert.ok(lines.length < 50, 'it must not re-read the whole file');
  // No truncated line: the first one, almost certainly cut, is dropped.
  for (const l of lines) assert.match(l, /^line-\d+$/);
  await tailer.close();
});

test('warmupBytes 0 means only what happens from now on', async () => {
  const file = tmpFile('past\nhistory\n');
  const lines: string[] = [];
  const tailer = new Tailer(file, 0, (l) => lines.push(l));
  await tailer.open();
  assert.deepEqual(lines, []);
  fs.appendFileSync(file, 'now\n');
  await tailer.pump();
  assert.deepEqual(lines, ['now']);
  await tailer.close();
});

test('blank lines are skipped', async () => {
  const file = tmpFile();
  const lines: string[] = [];
  const tailer = new Tailer(file, 0, (l) => lines.push(l));
  await tailer.open();
  fs.appendFileSync(file, 'a\n\n\nb\n');
  await tailer.pump();
  assert.deepEqual(lines, ['a', 'b']);
  await tailer.close();
});

test('closing while a pass waits on the file does not throw: the server went down on it', async () => {
  // Measured on 2026-09-29: `close()` nulled the handle while `pump()` was
  // awaiting `stat`, the pass woke up to read from null, and the unhandled
  // rejection killed the server at startup.
  const file = tmpFile();
  const lines: string[] = [];
  const tailer = new Tailer(file, 0, (l) => lines.push(l));
  await tailer.open();
  fs.appendFileSync(file, '{"a":1}\n');
  const pass = tailer.pump();
  await tailer.close();
  await assert.doesNotReject(pass);
  assert.deepEqual(lines, [], 'a closed tailer must not deliver lines');
});
