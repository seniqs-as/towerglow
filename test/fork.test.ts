import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TranscriptSource, inherited } from '../src/server/sources/transcriptSource.ts';
import { createStats, parseLine } from '../src/server/parse/records.ts';
import { slugFor } from '../src/server/paths.ts';
import type { PathPolicy } from '../src/server/paths.ts';
import type { RedactOptions } from '../src/server/parse/redact.ts';
import type { DeltaEvent } from '../src/shared/protocol.ts';

/*
 * The fork that doubled a session.
 *
 * `claude --resume <id> --fork-session` -- the path EVERY CEO second opinion
 * is born from -- does not open an empty file: it copies the mother's
 * transcript and rewrites every record with its own sessionId. The tailer,
 * which attaches with an 8 MiB warmup window, therefore read another
 * session's history as if it were activity that had just happened.
 *
 * Measured on a real fork (14 September 2026): 980 inherited lines out of
 * 1001, and a row in `history.json` declaring 257 tool calls and 222k output
 * tokens for ONE call actually made. The double count ended up in the CEOs'
 * brief and in the denominator of `ceo/quota.ts`, where it loosened the
 * brake instead of tightening it.
 */

const CWD = '/Users/tester/proj';
const SESSION = 'e701ba3c-0c94-44cf-8a4d-d2148ab0b34a';
/** The start of the fork. Before this instant the file talks about another session. */
const STARTED_AT = Date.parse('2026-09-14T08:49:40.882Z');
const MOTHER_AT = Date.parse('2026-09-13T19:38:21.656Z');
const OWN_AT = Date.parse('2026-09-14T08:49:41.416Z');

const OPTS: RedactOptions = {
  projectId: 'proj123',
  cwd: CWD,
  redactPaths: false,
  cmdNames: true,
  titles: true,
  recap: true,
};

function assistantLine(at: number, toolUseId: string): string {
  return JSON.stringify({
    type: 'assistant', sessionId: SESSION, uuid: `u-${toolUseId}`, requestId: `r-${toolUseId}`,
    timestamp: new Date(at).toISOString(),
    message: {
      model: 'claude-opus-5',
      usage: { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5000 },
      content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'ls' } }],
    },
  });
}

test('a record written before the session started is not its own', () => {
  const stats = createStats();
  const inheritedRec = parseLine(assistantLine(MOTHER_AT, 'toolu_old'), stats);
  const ownRec = parseLine(assistantLine(OWN_AT, 'toolu_new'), stats);
  assert.ok(inheritedRec && ownRec);

  assert.equal(inherited(inheritedRec, STARTED_AT), true, 'the mother\'s history must be rejected');
  assert.equal(inherited(ownRec, STARTED_AT), false, 'its own work must be counted');
});

test('the final cost is never discarded: its timestamp is the start, not the moment', () => {
  // `cost-state` declares `startTime`, which by construction is BEFORE
  // `startedAt` or equal to it. Treating it like the other records would mean
  // throwing away the only line that carries a session's complete numbers.
  const stats = createStats();
  const rec = parseLine(JSON.stringify({
    type: 'cost-state', sessionId: SESSION, startTime: MOTHER_AT,
    totalCostUSD: 4.41, totalAPIDuration: 1000, totalToolDuration: 100,
    totalDuration: 5000, totalLinesAdded: 0, totalLinesRemoved: 0,
    modelUsage: {
      'claude-opus-5': {
        inputTokens: 10, outputTokens: 200, cacheReadInputTokens: 5000,
        cacheCreationInputTokens: 0, thinkingTokens: 0,
      },
    },
  }), stats);
  assert.ok(rec && rec.kind === 'cost_state');
  assert.equal(inherited(rec, STARTED_AT), false);
});

test('the title has no timestamp and is not discarded', () => {
  const stats = createStats();
  const rec = parseLine(JSON.stringify({
    type: 'ai-title', sessionId: SESSION, aiTitle: 'My_dashboard audit and quota optimization',
  }), stats);
  assert.ok(rec && rec.kind === 'title');
  assert.equal(inherited(rec, STARTED_AT), false);
});

/** A transcript written the way a fork writes it: the mother, then the new work. */
interface Run {
  stats: ReturnType<typeof createStats>;
  events: DeltaEvent[];
  attached: number;
}

async function tail(startedAt: number): Promise<Run> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fork-'));
  const claudeDir = path.join(home, '.claude');
  const dir = path.join(claudeDir, 'projects', slugFor(CWD));
  fs.mkdirSync(dir, { recursive: true });

  const lines = [
    assistantLine(MOTHER_AT - 2000, 'toolu_mother1'),
    assistantLine(MOTHER_AT - 1000, 'toolu_mother2'),
    assistantLine(MOTHER_AT, 'toolu_mother3'),
    assistantLine(OWN_AT, 'toolu_own'),
  ];
  fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), lines.map((l) => `${l}\n`).join(''));

  const policy: PathPolicy = {
    claudeDir, codexDir: path.join(home, '.codex'), homeDir: home,
  };
  const stats = createStats();
  const events: DeltaEvent[] = [];
  const source = new TranscriptSource({
    claudeDir,
    policy,
    // The real window: 8 MiB on a file of a few lines means reading all of it,
    // which is exactly the condition in which the bug showed.
    warmupBytes: 8 * 1024 * 1024,
    stats,
    devAssert: true,
    emit: (evs) => events.push(...evs),
  });

  source.sync([{ sessionId: SESSION, cwd: CWD, startedAt }], () => OPTS);
  // Attaching is asynchronous: wait until it has happened, not for a fixed delay.
  for (let i = 0; i < 200 && source.attachedCount === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const attached = source.attachedCount;
  source.stop();
  fs.rmSync(home, { recursive: true, force: true });
  return { stats, events, attached };
}

test('the tailer of a fork does not re-emit the mother session\'s history', async () => {
  const run = await tail(STARTED_AT);
  assert.equal(run.attached, 1, 'the transcript must be attached');

  assert.equal(run.stats.inheritedLines, 3, 'the mother\'s three lines must be rejected and counted');
  assert.ok(run.events.length > 0, 'its own work must still come through');
  for (const ev of run.events) {
    const at = (ev as { at?: number }).at;
    if (typeof at !== 'number') continue;
    assert.ok(
      at >= STARTED_AT,
      `no event can precede the start of the session: ${JSON.stringify(ev)}`,
    );
  }
});

test('a session that was not forked loses nothing: the warmup recovers all its history', async () => {
  // The counter-check, and it is not a detail: the warmup window exists because
  // after a restart the city must find again which files had been touched --
  // measured, with 256 KiB ZERO tool_use/tool_result pairs were recovered. A
  // filter that cut here too would buy the accounting at the price of the
  // scene. For a session of its own, `startedAt` precedes ALL its records, and
  // then the boundary cuts nothing.
  const run = await tail(MOTHER_AT - 5000);
  assert.equal(run.attached, 1);
  assert.equal(run.stats.inheritedLines, 0, 'nothing to reject: they are all its own');
  const own = await tail(STARTED_AT);
  assert.ok(
    run.events.length > own.events.length,
    'with an older boundary more events must come through, not the same ones',
  );
});
