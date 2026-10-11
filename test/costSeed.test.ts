import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readClosedCosts } from '../src/server/sources/costSeed.ts';
import { slugFor } from '../src/server/paths.ts';
import type { PathPolicy } from '../src/server/paths.ts';

const CWD = '/Users/tester/proj';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const S1 = '8f44d010-1111-4222-8333-444455556666';
const S2 = '3e6afb62-2222-4333-8444-555566667777';

interface Fixture {
  claudeDir: string;
  policy: PathPolicy;
  write(sessionId: string, lines: string[], mtime: number): void;
}

function fixture(): Fixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cost-'));
  const claudeDir = path.join(home, '.claude');
  const dir = path.join(claudeDir, 'projects', slugFor(CWD));
  fs.mkdirSync(dir, { recursive: true });
  return {
    claudeDir,
    policy: { claudeDir, codexDir: path.join(home, '.codex'), homeDir: home },
    write(sessionId, lines, mtime) {
      const file = path.join(dir, `${sessionId}.jsonl`);
      fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
      fs.utimesSync(file, new Date(mtime), new Date(mtime));
    },
  };
}

function costLine(sessionId: string, startTime: number, usd: number): string {
  return JSON.stringify({
    type: 'cost-state', sessionId, startTime,
    totalCostUSD: usd, totalAPIDuration: 1000, totalToolDuration: 100,
    totalDuration: 5000, totalLinesAdded: 7, totalLinesRemoved: 1,
    modelUsage: {
      'claude-opus-5': {
        inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 9000,
        cacheCreationInputTokens: 1000, thinkingTokens: 10,
      },
    },
  });
}

const chatter = (n: number): string[] =>
  Array.from({ length: n }, (_, i) =>
    JSON.stringify({ type: 'user', sessionId: S1, message: { content: `x${i}` } }));

function seed(f: Fixture, maxAgeDays = 30): ReturnType<typeof readClosedCosts> {
  return readClosedCosts([CWD], {
    claudeDir: f.claudeDir, policy: f.policy, maxAgeMs: maxAgeDays * DAY, now: NOW,
  });
}

test('the final cost of a closed session is recovered from the tail of its transcript', () => {
  // Without this read the history would start empty: the tailer follows only
  // the sessions in the registry, and nobody opens a closed transcript.
  const f = fixture();
  f.write(S1, [...chatter(50), costLine(S1, NOW - DAY, 1.25)], NOW - DAY);

  const found = seed(f);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.record.sessionId, S1);
  assert.equal(Math.round((found[0]?.record.costUsd ?? 0) * 100), 125);
  assert.equal(found[0]?.record.tokens.cacheRead, 9000);
  assert.equal(found[0]?.cwd, CWD);
});

test('only the per-row window is scanned: beyond it, the history is already aggregated', () => {
  // A monthly aggregate built from a partial scan would state a wrong number
  // instead of staying silent, which is worse.
  const f = fixture();
  f.write(S1, [costLine(S1, NOW - 90 * DAY, 9)], NOW - 90 * DAY);
  assert.deepEqual(seed(f), []);
});

test('a transcript without a final cost produces nothing, not a zero', () => {
  const f = fixture();
  f.write(S1, chatter(20), NOW - DAY);
  assert.deepEqual(seed(f), []);
});

test('the LAST final cost is taken: a session can write more than one', () => {
  // Measured: four transcripts out of thirty-six had two.
  const f = fixture();
  f.write(S1, [costLine(S1, NOW - DAY, 1), costLine(S1, NOW - DAY, 4)], NOW - DAY);
  const found = seed(f);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.record.costUsd, 4);
});

test('several sessions of the same project all come back', () => {
  const f = fixture();
  f.write(S1, [costLine(S1, NOW - DAY, 1)], NOW - DAY);
  f.write(S2, [costLine(S2, NOW - 2 * DAY, 2)], NOW - 2 * DAY);
  assert.equal(seed(f).length, 2);
});

test('a project without transcripts is not an error', () => {
  const f = fixture();
  const found = readClosedCosts(['/Users/tester/never-seen'], {
    claudeDir: f.claudeDir, policy: f.policy, maxAgeMs: 30 * DAY, now: NOW,
  });
  assert.deepEqual(found, []);
});

test('subagent transcripts are not scanned: they have no final cost of their own', () => {
  const f = fixture();
  const dir = path.join(f.claudeDir, 'projects', slugFor(CWD));
  fs.writeFileSync(path.join(dir, 'agent-abcdef12.jsonl'), `${costLine(S1, NOW - DAY, 5)}\n`);
  assert.deepEqual(seed(f), []);
});

test('reading the tail does not pollute the malformed-line counter', () => {
  // Starting mid-file the first line is truncated: handing it to the parser
  // would make it go off in /healthz, which is a diagnostic counter and must
  // go off only for a real problem.
  const f = fixture();
  const huge = JSON.stringify({ type: 'user', sessionId: S1, message: { content: 'y'.repeat(700_000) } });
  f.write(S1, [huge, costLine(S1, NOW - DAY, 3)], NOW - DAY);

  const found = seed(f);
  assert.equal(found.length, 1, 'the final cost must be found even past a huge line');
  assert.equal(found[0]?.record.costUsd, 3);
});
