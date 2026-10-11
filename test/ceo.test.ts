import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSpendLedger, tightestWindow, weigh } from '../src/server/ceo/spend.ts';
import { quotaShare } from '../src/server/ceo/quota.ts';
import type { SpendCaps } from '../src/server/ceo/spend.ts';
import { buildBrief, MAX_BRIEF_CHARS, perimeterOf, readableRoot } from '../src/server/ceo/brief.ts';
import type { PeriodTotals } from '../src/server/state/history.ts';
import {
  ANALYSES, analysisOf, contractFor, DEPTHS, effortFor, modelFor,
} from '../src/server/ceo/analyses.ts';
import { parseOutcome, visibleProse } from '../src/server/ceo/outcome.ts';
import { assertSafe, clampUnsafe } from '../src/server/parse/redact.ts';
import { MAX_FIELD_CHARS, MAX_SUMMARY_CHARS } from '../src/shared/protocol.ts';
import type { ProjectInfo, ProviderLimits, SessionInfo, Snapshot } from '../src/shared/protocol.ts';

const CAPS: SpendCaps = { quotaMaxPercent: 85, budgetUsd: 2, maxCallUsd: 0.5 };
const T0 = 1_760_000_000_000;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ceo-'));
}

function limits(provider: 'claude' | 'codex', ...pcts: number[]): ProviderLimits[] {
  return [{
    provider, at: T0, plan: null,
    windows: pcts.map((usedPercent, i) => ({
      label: i === 0 ? '5h' : '7d',
      usedPercent, windowMinutes: i === 0 ? 300 : 10080,
      model: null, resetsAt: null,
    })),
  }];
}

/* ───────────────────────── the quota gate ───────────────────────── */

test('the window that counts is the tightest one, not the average', () => {
  // If the 5h is at 90% it does not matter that the weekly one is at 20%: it
  // is the first to stop you, and averaging would say 55%, a convenient lie.
  const w = tightestWindow('claude', limits('claude', 90, 20), T0);
  assert.equal(w?.usedPercent, 90);
  assert.equal(w?.label, '5h');
});

test('above the quota cap the CEO does not start, and says why', () => {
  const led = createSpendLedger(tmp(), CAPS);
  const why = led.blockedReason('claude', limits('claude', 91, 10), T0);
  assert.ok(why, 'it should have blocked');
  assert.match(why, /quota/);
  assert.match(why, /91/, 'the reason must contain the number, or you cannot tell how far off it is');
});

test('a week already half used up is not enough to stop it', () => {
  // The number comes from the field: 30% on the 5h and 64% on the 7d is NORMAL
  // use. A cap that blocks here does not protect, it gets switched off -- and
  // that is exactly what happened the first time this test ran on real data.
  const led = createSpendLedger(tmp(), CAPS);
  assert.equal(led.blockedReason('claude', limits('claude', 30, 64), T0), null);
});

test('a window that has already reset does not stop the CEO: the percentage belonged to the previous window', () => {
  // Seen in the field: at 20:00 Codex writes the 5h at 89%, reset at 00:34. No
  // turn after that, so no new reading on disk, and at 09:00 the Codex CEO was
  // still stuck on "5h quota at 89%, over the 85% cap" for a window that no
  // longer existed.
  const led = createSpendLedger(tmp(), CAPS);
  const [l] = limits('codex', 89, 30);
  const stale: ProviderLimits[] = [{
    ...l!,
    windows: [
      { ...l!.windows[0]!, resetsAt: T0 - 8 * 3_600_000 },
      { ...l!.windows[1]!, resetsAt: T0 + 6 * 86_400_000 },
    ],
  }];
  assert.equal(led.blockedReason('codex', stale, T0), null);
  assert.deepEqual(tightestWindow('codex', stale, T0), { label: '7d', usedPercent: 30 });
  // Before the reset the same reading blocks, as it must.
  assert.match(led.blockedReason('codex', stale, T0 - 9 * 3_600_000) ?? '', /89%/);
});

test('without quota data nothing blocks: absence is not overrun', () => {
  // Someone who has not installed the statusline bridge must not be left with
  // a mute CEO and no idea why.
  const led = createSpendLedger(tmp(), CAPS);
  assert.equal(led.blockedReason('claude', [], T0), null);
});

test('the quota of one provider does not block the other', () => {
  const led = createSpendLedger(tmp(), CAPS);
  assert.ok(led.blockedReason('claude', limits('claude', 95), T0));
  assert.equal(led.blockedReason('codex', limits('claude', 95), T0), null);
});

/* ───────────────────────── the currency cap ───────────────────────── */

// The dollar cap is for API keys, which report no quota windows: these tests
// read no limits, and the next one says why a reading switches it off.

test('the budget is a sliding 24-hour window, not an everlasting total', () => {
  const led = createSpendLedger(tmp(), CAPS);
  led.record('claude', 1.9, T0);
  assert.ok(led.blockedReason('claude', [], T0), 'at 1.90 out of 2 there is no room left');

  // Twenty-six hours later, that spend has left the window.
  const later = T0 + 26 * 3600_000;
  assert.equal(led.spentLast24h(later), 0);
  assert.equal(led.blockedReason('claude', [], later), null);
});

test('nothing starts unless there is room for a whole call', () => {
  // Better to stop beforehand than to cut in half a call already paid for.
  const led = createSpendLedger(tmp(), CAPS);
  led.record('claude', 1.7, T0); // 0.30 left, below maxCall 0.50
  const why = led.blockedReason('claude', [], T0);
  assert.ok(why);
  assert.match(why, /per-call cap/);
});

test('on a subscription the quota is the cap: list-price dollars do not lock the CEO for a day', () => {
  // 2026-09-19: three planned workers wrote $107 of list price into the
  // ledger. With the 5h back at 10% the $10 cap still refused every launch,
  // every turn of the meeting and every question until the next evening.
  const led = createSpendLedger(tmp(), CAPS);
  led.record('claude', 106.82, T0);
  assert.equal(led.blockedReason('claude', limits('claude', 10, 33), T0), null);
  // The quota still gates, and the fleet without a reading keeps the dollars.
  assert.match(led.blockedReason('claude', limits('claude', 90, 33), T0) ?? '', /quota at 90%/);
  assert.match(led.blockedReason('codex', limits('claude', 10, 33), T0) ?? '', /USD/, 'codex has no reading here');
  led.record('codex', 5, T0);
  assert.match(led.blockedReason('codex', limits('claude', 10, 33), T0) ?? '', /spent .* USD in the last 24h/);
});

test('spend survives a restart: a cap that resets is not a cap', () => {
  const dir = tmp();
  const a = createSpendLedger(dir, CAPS);
  a.record('claude', 1.25, T0);
  a.save();

  const b = createSpendLedger(dir, CAPS);
  assert.equal(Math.round(b.spentLast24h(T0) * 100), 125);
});

test('an unknown cost counts as zero and does not blow up the ledger', () => {
  const led = createSpendLedger(tmp(), CAPS);
  led.record('claude', Number.NaN, T0);
  led.record('claude', -3, T0);
  assert.equal(led.spentLast24h(T0), 0);
});

/* ───────────────────────── the brief ───────────────────────── */

function project(
  id: string, name: string, disabled: boolean,
  providers: ('claude' | 'codex')[] = [],
): ProjectInfo {
  return {
    id, name, realName: name, disabled, slot: 0, exists: true,
    firstSeenAt: T0, lastActiveAt: T0, size: 120,
    lastCommit: null, branch: 'main', commits: 3, providers,
  };
}

function session(id: string, projectId: string, provider: 'claude' | 'codex'): SessionInfo {
  return {
    id, projectId, pid: 1, label: id, title: null, status: 'busy', waitingFor: null,
    kind: 'interactive', model: 'sonnet', ccVersion: '1', gitBranch: null,
    permissionMode: null, isCeo: false, spawnedByCeo: null, provider,
    statusConfidence: 'reported', startedAt: T0, lastActivityAt: T0, statusSince: T0,
    tokens: { in: 1000, out: 200, cacheRead: 9000, cacheWrite: 1000, thinking: 0 },
    contextLeft: null, contextPct: 42, turns: 4, toolCalls: 12,
    lastTurnMs: 3000, turnsMs: 12000, reasoningMs: 500,
    recap: null, recapAt: null, recapInherited: false,
    activityTool: null, activityTarget: null, agentsActive: 0, deskIndex: 0,
  };
}

function snapshot(projects: ProjectInfo[], sessions: SessionInfo[]): Snapshot {
  return { at: T0, limits: limits('claude', 30, 64), projects, sessions, agents: [], files: [], recent: [] };
}

test('a disabled project stays out of the brief, and the brief says so', () => {
  // It is the filter that keeps the cost down: paying in every question for
  // projects you have already put out of play would be absurd.
  const snap = snapshot(
    [project('p1', 'LIVE', false), project('p2', 'SECRET', true)],
    [session('s1', 'p1', 'claude'), session('s2', 'p2', 'claude')],
  );
  const text = buildBrief(snap, { provider: 'claude', now: T0 });

  assert.ok(text.includes('LIVE'));
  assert.equal(text.includes('SECRET'), false, 'the disabled project ended up in the brief');
  assert.ok(text.includes('DISABLED'), 'the brief must say that something was left out');
  assert.equal(text.includes('s2'), false, 'the session of a disabled project got through');
});

test('on a shared project each CEO also sees the sessions of the other', () => {
  // It is the only case where it is needed: without overlap there is no
  // collision to notice, and describing the other tool's work is a bill paid
  // for something the answer cannot use.
  const snap = snapshot(
    [project('p1', 'ONE', false, ['claude', 'codex'])],
    [session('s1', 'p1', 'claude'), session('s2', 'p1', 'codex')],
  );
  const claude = buildBrief(snap, { provider: 'claude', now: T0 });
  const codex = buildBrief(snap, { provider: 'codex', now: T0 });

  assert.ok(claude.indexOf('Your fleet (claude)') < claude.indexOf('Shared with the other fleet'));
  assert.ok(codex.includes('Your fleet (codex)'));
  assert.ok(claude.includes('codex/sonnet'), 'on the shared project the other fleet must be visible');
  assert.ok(codex.includes('claude/sonnet'));
});

test('with no project in common the other fleet is not paid for', () => {
  const snap = snapshot(
    [project('p1', 'MINE', false, ['claude']), project('p2', 'THEIRS', false, ['codex'])],
    [session('s1', 'p1', 'claude'), session('s2', 'p2', 'codex')],
  );
  const claude = buildBrief(snap, { provider: 'claude', now: T0 });

  assert.ok(claude.includes('MINE'));
  assert.equal(claude.includes('codex/sonnet'), false, 'the session of the other tool got through anyway');
  assert.equal(claude.includes('THEIRS'), false, 'a project that is not yours does not enter your projects');
  assert.ok(claude.includes('No project here is worked on by both tools'));
});

test('a project nobody has claimed yet belongs to both', () => {
  // At first start the history is empty and no session has appeared yet: the
  // opposite rule would leave every CEO facing a deserted city.
  const snap = snapshot([project('p1', 'NEW', false, [])], []);
  assert.ok(buildBrief(snap, { provider: 'claude', now: T0 }).includes('NEW'));
  assert.ok(buildBrief(snap, { provider: 'codex', now: T0 }).includes('NEW'));
});

test('the brief carries the cache ratio, which is the most actionable signal', () => {
  const snap = snapshot([project('p1', 'ONE', false)], [session('s1', 'p1', 'claude')]);
  const text = buildBrief(snap, { provider: 'claude', now: T0 });
  assert.match(text, /cache read 90%/);
});

test('the brief copes with an empty world without breaking', () => {
  const text = buildBrief(snapshot([], []), { provider: 'claude', now: T0 });
  assert.ok(text.includes('No live session.'));
  assert.ok(text.length > 0);
});

test('the quota ends up in the brief: it is what the model is asked to reason about', () => {
  const text = buildBrief(snapshot([], []), { provider: 'claude', now: T0 });
  assert.match(text, /5h at 30%/);
  assert.match(text, /7d at 64%/);
});

test('in the brief a reset window counts as zero and says it is not a measurement', () => {
  // "5h at 89%" on a finished window makes the model plan on a false number;
  // "5h at 0%" on its own would read as a measurement taken just now.
  const snap = snapshot([], []);
  snap.limits = snap.limits.map((l) => ({
    ...l,
    windows: l.windows.map((w) => (w.label === '5h' ? { ...w, resetsAt: T0 - 60_000 } : w)),
  }));
  const text = buildBrief(snap, { provider: 'claude', now: T0 });
  assert.match(text, /5h at 0% \(reset since the last reading\)/);
  assert.match(text, /7d at 64%/);
  assert.doesNotMatch(text, /5h at 30%/);
});

test('a small budget must not produce a CEO blocked forever', () => {
  // It really happened: with --ceo-budget 0.40 and the per-call cap at its
  // default of 0.50, the ledger refused to start, forever. The reason was
  // correct and the situation absurd.
  const led = createSpendLedger(tmp(), { quotaMaxPercent: 85, budgetUsd: 0.4, maxCallUsd: 0.4 });
  assert.equal(led.blockedReason('claude', [], T0), null);
});

/* ───────────────────────── the readable perimeter ───────────────────────── */

test('the perimeter leaves out what you disabled and what is no longer there', () => {
  // Being readable is a form of being in play, and a project you ruled out of
  // play must not come back through the one door that opens the code itself.
  const gone: ProjectInfo = { ...project('p3', 'GONE', false), exists: false };
  const snap = snapshot(
    [project('p1', 'LIVE', false), project('p2', 'HIDDEN', true), gone],
    [],
  );
  const roots = perimeterOf(snap, (id) => `/code/${id}`);

  assert.deepEqual(roots.map((r) => r.name), ['LIVE']);
  assert.equal(roots[0]?.root, '/code/p1');
});

test('the home folder is never code to read, nor what contains it, nor our own state', () => {
  // Running claude once in ~ makes ~ a project: the CEO was handed every file
  // under it -- keys and tokens included -- as code it may read.
  const off = { home: '/Users/me', state: '/Users/me/.towerglow' };
  assert.equal(readableRoot('/Users/me', off), false);
  assert.equal(readableRoot('/Users', off), false);
  assert.equal(readableRoot('/', off), false);
  assert.equal(readableRoot('/Users/me/.towerglow/ceo/claude', off), false);
  assert.equal(readableRoot('/Users/me/code/my_dashboard', off), true);
  assert.equal(readableRoot('/Users/meadow', off), true, 'a prefix is not the same folder');
  const snap = snapshot([project('p1', 'HOME', false), project('p2', 'LIVE', false)], []);
  const roots = perimeterOf(snap, (id) => (id === 'p1' ? '/Users/me' : '/Users/me/code/live'), off);
  assert.deepEqual(roots.map((r) => r.name), ['LIVE']);
});

test('a project the model cannot place is not a readable root', () => {
  // `cwdOf` answers from the world model. No answer means no path, and inventing
  // one would buy a failed read and a confused analysis.
  const snap = snapshot([project('p1', 'LIVE', false)], []);
  assert.deepEqual(perimeterOf(snap, () => undefined), []);
});

test('the brief lists the code only when it is handed a perimeter', () => {
  const snap = snapshot([project('p1', 'LIVE', false)], []);
  const bare = buildBrief(snap, { provider: 'claude', now: T0 });
  const withCode = buildBrief(snap, {
    provider: 'claude', now: T0, perimeter: [{ name: 'LIVE', root: '/code/p1' }],
  });

  assert.equal(bare.includes('/code/p1'), false, 'a path leaked into a brief that cannot use it');
  assert.ok(withCode.includes('## Code you may read'));
  assert.ok(withCode.includes('/code/p1'));
});

/* ───────────────────────── the five analyses ───────────────────────── */

test('exactly one of the five is worth the project code', () => {
  // The whole cost argument rests on this: if a second one turned `code` on,
  // the expensive brief would become the normal one without anybody deciding it.
  const withCode = ANALYSES.filter((a) => a.code);
  assert.deepEqual(withCode.map((a) => a.kind), ['structure']);
});

test('every analysis carries a question, and a free question carries none', () => {
  for (const a of ANALYSES) {
    assert.ok(a.question.length > 40, `${a.kind} has no question behind its button`);
    assert.equal(analysisOf(a.kind)?.kind, a.kind);
  }
  assert.equal(analysisOf(null), null);
});

/* ───────────────────────── the outcome block ───────────────────────── */

function answer(prose: string, json: string): string {
  return `${prose}\n\n\`\`\`towerglow\n${json}\n\`\`\`\n`;
}

test('the block becomes proposals and never reaches the reader', () => {
  const text = answer(
    'Cache is repaid every turn on VISIBILITYCHECK.',
    '{"title":"cache is not holding","proposals":[{"kind":"tokens","summary":"Stop changing the system prompt between calls.","command":"pin the flags"}]}',
  );

  assert.equal(visibleProse(text).trim(), 'Cache is repaid every turn on VISIBILITYCHECK.');
  const out = parseOutcome(text);
  assert.equal(out?.title, 'cache is not holding');
  assert.equal(out?.proposals.length, 1);
  assert.equal(out?.proposals[0]?.kind, 'tokens');
  assert.equal(out?.proposals[0]?.command, 'pin the flags');
});

test('an answer without a block is still an answer', () => {
  // A report that cannot be parsed is a report worth reading: losing it because
  // its last fifty characters were missing would be the worse failure.
  const text = 'Nothing here looks wasteful.';
  assert.equal(visibleProse(text), text);
  assert.equal(parseOutcome(text), null);
});

test('an empty proposal list is a legitimate outcome, not a parse failure', () => {
  const out = parseOutcome(answer('All quiet.', '{"title":"nothing to change","proposals":[]}'));
  assert.equal(out?.title, 'nothing to change');
  assert.deepEqual(out?.proposals, []);
});

test('a proposal with no summary is dropped instead of shown empty', () => {
  // An empty card can still be accepted in phase 4, and it would start a
  // session to do nothing in particular.
  const out = parseOutcome(answer('x', '{"title":"t","proposals":[{"kind":"a"},{"kind":"b","summary":"Real one."}]}'));
  assert.equal(out?.proposals.length, 1);
  assert.equal(out?.proposals[0]?.summary, 'Real one.');
});

test('a summary is clipped at the source, so the redaction counter stays zero', () => {
  // The clamp counter in /healthz is an invariant: it reads zero in a healthy
  // system, and one that ticks on ordinary traffic stops being a signal.
  const long = 'x'.repeat(MAX_SUMMARY_CHARS + 200);
  const out = parseOutcome(answer('x', JSON.stringify({ title: 't', proposals: [{ kind: 'k', summary: long }] })));
  assert.equal(out?.proposals[0]?.summary.length, MAX_SUMMARY_CHARS);
});

test('no more than four proposals reach the panel', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ kind: 'k', summary: `p${i}` }));
  const out = parseOutcome(answer('x', JSON.stringify({ title: 't', proposals: many })));
  assert.equal(out?.proposals.length, 4);
});

test('a truncated block is read as far as it goes', () => {
  // A call cut by the timeout closes nothing. Throwing the analysis away for a
  // missing fence would waste what was already paid for.
  const out = parseOutcome('prose\n```towerglow\n{"title":"cut","proposals":[]}');
  assert.equal(out?.title, 'cut');
});

test('a json fence is parsed but stays on screen', () => {
  // Recovering the content without pretending the contract was honoured: the
  // block on screen is the only evidence that it was not.
  const text = 'prose\n```json\n{"title":"t","proposals":[{"kind":"k","summary":"s"}]}\n```';
  assert.equal(parseOutcome(text)?.proposals.length, 1);
  assert.ok(visibleProse(text).includes('```json'));
});

test('valid json that is not an outcome does not become a report', () => {
  assert.equal(parseOutcome(answer('x', '{"hello":"world"}')), null);
  assert.equal(parseOutcome(answer('x', 'not json at all')), null);
});

/* ───────────────────────── the guard on the way out ───────────────────────── */

test('a proposal summary is allowed its declared cap and not a character more', () => {
  // The cap is declared by name in LONG_FIELDS. Without the entry the general
  // 128 would apply and every proposal would arrive cut in half.
  const at = T0;
  const ok = {
    t: 'proposal', id: 'p1', at, provider: 'claude', kind: 'tokens',
    summary: 'y'.repeat(MAX_SUMMARY_CHARS), status: 'pending', command: null,
  } as const;
  assert.doesNotThrow(() => assertSafe(ok));

  const tooLong = { ...ok, summary: 'y'.repeat(MAX_SUMMARY_CHARS + 1) };
  assert.throws(() => assertSafe(tooLong), /redaction violation/);
  assert.equal(clampUnsafe({ ...tooLong }), 1);
});

test('a report title gets no such licence: it is a headline, not a paragraph', () => {
  const bad = {
    t: 'report', id: 'r1', at: T0, provider: 'claude', analysis: 'tokens',
    title: 'z'.repeat(MAX_FIELD_CHARS + 1), costUsd: 0.04,
  } as const;
  assert.throws(() => assertSafe(bad), /redaction violation/);
});

/* ───────────────────────── the brief budget ───────────────────────── */

function crowd(n: number): Snapshot {
  const projects = Array.from({ length: n }, (_, i) => project(`p${i}`, `PROJECT-NUMBER-${i}`, false, ['claude']));
  const sessions = Array.from({ length: n }, (_, i) => session(`s${i}`, `p${i}`, 'claude'));
  const files = Array.from({ length: n * 4 }, (_, i) => ({
    id: `f${i}`, projectId: `p${i % n}`,
    path: `src/some/rather/long/path/to/a/file/number/${i}.ts`,
    ext: 'ts', dir: 'src/some/rather/long/path/to/a/file/number',
    floor: 0, col: i, reads: 9, writes: 3, churn: 40,
    firstSeenAt: T0, lastTouchAt: T0,
  }));
  return { at: T0, limits: limits('claude', 30, 64), projects, sessions, agents: [], files, recent: [] };
}

test('the brief does not grow with the city: above the cap it sacrifices, and says so', () => {
  // This is how it breaks over time: not a bug, but the cheapest question
  // costing, six months later, as much as the dearest.
  const text = buildBrief(crowd(40), { provider: 'claude', now: T0 });
  assert.ok(
    text.length <= MAX_BRIEF_CHARS,
    `the brief overflowed: ${text.length} characters out of ${MAX_BRIEF_CHARS}`,
  );
  // An absence kept quiet is mistaken for a zero.
  assert.match(text, /sections left out/);
});

test('quota and your fleet never drop out, however big the city is', () => {
  const text = buildBrief(crowd(40), { provider: 'claude', now: T0 });
  assert.ok(text.includes('## Quota'));
  assert.ok(text.includes('5h at 30%'));
  assert.ok(text.includes('## Your fleet (claude), right now'));
});

test('a small world loses nothing: the cap is not a pruning', () => {
  const text = buildBrief(crowd(2), { provider: 'claude', now: T0 });
  assert.equal(text.includes('sections left out'), false);
  assert.ok(text.includes('## Most touched files'));
});

/* ───────────────────────── the history in the brief ───────────────────────── */

function totals(over: Partial<PeriodTotals> = {}): PeriodTotals {
  return {
    sessions: 0, turns: 0, toolCalls: 0,
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    costUsd: 0, apiMs: 0, toolMs: 0, linesAdded: 0, linesRemoved: 0,
    reported: 0, watched: 0,
    ...over,
  };
}

test('history enters as a comparison and names only what moved', () => {
  const snap = snapshot([project('p1', 'ONE', false, ['claude'])], []);
  const text = buildBrief(snap, {
    provider: 'claude', now: T0,
    history: {
      days: 7,
      byProject: [{
        projectId: 'p1',
        providers: ['claude'],
        now: totals({ sessions: 9, toolCalls: 300, costUsd: 4, reported: 9, watched: 9 }),
        before: totals({ sessions: 8, toolCalls: 100, costUsd: 3.9, reported: 8, watched: 8 }),
      }],
    },
  });

  assert.ok(text.includes('## Last 7 days, closed sessions'));
  assert.match(text, /calls \+200%/, 'a large change must appear');
  assert.equal(text.includes('cost '), false, 'a 2% change is noise and is not printed');
});

test('a partial history says so instead of passing itself off as complete', () => {
  // Codex writes no end-of-session summary: presenting its numbers as
  // equivalent to Claude Code's would be a convenient lie.
  const snap = snapshot([project('p1', 'ONE', false, ['codex'])], []);
  const text = buildBrief(snap, {
    provider: 'codex', now: T0,
    history: {
      days: 7,
      byProject: [{
        projectId: 'p1', providers: ['codex'],
        now: totals({ sessions: 5, toolCalls: 10, reported: 2 }),
        before: totals(),
      }],
    },
  });
  assert.match(text, /2\/5 declared, the rest observed/);
});

test('the history of a project that is not yours does not enter your brief', () => {
  const snap = snapshot([project('p1', 'THEIRS', false, ['codex'])], []);
  const text = buildBrief(snap, {
    provider: 'claude', now: T0,
    history: {
      days: 7,
      byProject: [{
        projectId: 'p1', providers: ['codex'],
        now: totals({ sessions: 3, toolCalls: 99 }), before: totals(),
      }],
    },
  });
  assert.equal(text.includes('Last 7 days'), false);
});

test('without a previous period no comparison with nothing is printed', () => {
  // "cost new, thinking new, calls new" on every line is a single word
  // repeated, and it is noise paid for on every single question.
  const snap = snapshot([project('p1', 'ONE', false, ['claude'])], []);
  const text = buildBrief(snap, {
    provider: 'claude', now: T0,
    history: {
      days: 7,
      byProject: [{
        projectId: 'p1', providers: ['claude'],
        now: totals({ sessions: 4, toolCalls: 90, costUsd: 3, reported: 4, watched: 4 }),
        before: totals(),
      }],
    },
  });
  assert.ok(text.includes('4 sessions'));
  assert.equal(text.includes('vs previous'), false);
});

/* ───────────── the cost as a percentage of the subscription rate ───────────── */

test('token weights are the ratios, not the prices', () => {
  // Prices change from one model to another and over time; these ratios do
  // not. It is the only reason the brake can live without a hard-coded price list.
  const one = { in: 1, out: 0, cacheRead: 0, cacheWrite: 0 };
  assert.equal(weigh(one), 1);
  assert.equal(weigh({ in: 0, out: 1, cacheRead: 0, cacheWrite: 0 }), 5);
  assert.equal(weigh({ in: 0, out: 0, cacheRead: 0, cacheWrite: 1 }), 1.25);
  assert.equal(weigh({ in: 0, out: 0, cacheRead: 1, cacheWrite: 0 }), 0.1);
});

test('the weights reproduce the two real calls to within five percent', () => {
  // Numbers taken from the ledger: one cold and one warm, 3.6 minutes later.
  // If the ratios were wrong the two rates would not resemble each other.
  const cold = weigh({ in: 2, out: 53, cacheRead: 0, cacheWrite: 17752 });
  const warm = weigh({ in: 2, out: 22, cacheRead: 14978, cacheWrite: 2762 });
  const rateCold = 0.0734 / cold;
  const rateWarm = 0.0161 / warm;
  assert.ok(
    Math.abs(rateCold - rateWarm) / rateCold < 0.05,
    `rates too far apart: ${rateCold} vs ${rateWarm}`,
  );
});

test('the rate is learned from your calls, not from a price list', () => {
  const led = createSpendLedger(tmp(), CAPS);
  // Before it knows anything it uses the cap for the model family: it stops
  // too early, never too late.
  const blind = led.estimate('claude', 100_000);
  led.record('claude', 0.32, T0, 100_000);
  const learned = led.estimate('claude', 100_000);

  assert.ok(blind > learned, 'the rate with no data should have been the most expensive');
  assert.equal(Math.round(learned * 100), 32, 'it should have learned 0.32 per 100k weighted');
});

test('the brake stops the call in flight, which the old one did not', () => {
  // `--ceo-max-call` only checked whether the 24-hour budget still had room:
  // once the call started, the only brake was the three-minute timeout.
  const led = createSpendLedger(tmp(), CAPS);
  led.record('claude', 0.32, T0, 100_000); // rate: 3.2 USD per weighted million
  assert.equal(led.runawayReason('claude', 100_000), null, '0.32 is below the 0.50 cap');

  const why = led.runawayReason('claude', 400_000);
  assert.ok(why, 'at 1.28 USD it should have stopped');
  assert.match(why, /per-call cap/);
  assert.match(why, /1\.28/);
});

test('the rate of one provider does not contaminate the other', () => {
  const led = createSpendLedger(tmp(), CAPS);
  led.record('claude', 0.32, T0, 100_000);
  assert.ok(led.estimate('codex', 100_000) > led.estimate('claude', 100_000));
});

test('the quota share is derived from your numbers, not from a published allowance', () => {
  // 200k weighted tokens in seven days are worth 60% of the window, so 10k are
  // worth 3%. No price lists, no declared allowances.
  const share = quotaShare(
    10_000, 'claude',
    [{ provider: 'claude', at: T0, plan: null, windows: [
      { label: '7d', usedPercent: 60, windowMinutes: 10080, model: null, resetsAt: null },
    ] }],
    () => 200_000,
    T0,
  );
  assert.equal(share?.label, '7d');
  assert.equal(Math.round((share?.percent ?? 0) * 10) / 10, 3);
  assert.equal(share?.atMost, true, 'it is a ceiling, and it must declare itself as one');
});

test('without enough history no percentage is invented', () => {
  // A number with three decimals derived from two sessions would say more
  // about how much history we have than about how much it costs.
  const windows = [{ provider: 'claude' as const, at: T0, plan: null, windows: [
    { label: '7d', usedPercent: 60, windowMinutes: 10080, model: null, resetsAt: null },
  ] }];
  assert.equal(quotaShare(10_000, 'claude', windows, () => 1_000, T0), null);
  // Nor on a window that is practically untouched: the division does not hold.
  assert.equal(
    quotaShare(10_000, 'claude',
      [{ ...windows[0]!, windows: [{ ...windows[0]!.windows[0]!, usedPercent: 0.4 }] }],
      () => 500_000, T0),
    null,
  );
});

test('between two windows the one that stops you first wins', () => {
  // Same rule as `tightestWindow`: the nearly full 5h counts for more than the
  // half-empty weekly one.
  const share = quotaShare(
    10_000, 'claude',
    [{ provider: 'claude', at: T0, plan: null, windows: [
      { label: '5h', usedPercent: 40, windowMinutes: 300, model: null, resetsAt: null },
      { label: '7d', usedPercent: 60, windowMinutes: 10080, model: null, resetsAt: null },
    ] }],
    (_p, since) => (T0 - since < 3600_000 * 6 ? 100_000 : 900_000),
    T0,
  );
  // 10k out of 100k at 40% = 4%; 10k out of 900k at 60% = 0.67%. The 5h wins.
  assert.equal(share?.label, '5h');
});

test('without quota data the answer is not a zero', () => {
  assert.equal(quotaShare(10_000, 'claude', [], () => 900_000, T0), null);
  assert.equal(quotaShare(0, 'claude', [], () => 900_000, T0), null);
});

/* ───────────────────────── the three depths ───────────────────────── */

test('depth picks the Claude model, not just the tone', () => {
  // It is the biggest lever on cost: haiku to opus is a factor of five, while
  // the shortest brief to the longest is less than two.
  assert.equal(modelFor('claude', 'fast', 'sonnet', null), 'haiku');
  assert.equal(modelFor('claude', 'standard', 'sonnet', null), 'sonnet');
  assert.equal(modelFor('claude', 'deep', 'sonnet', null), 'opus');
});

test('the middle step is the one you pick', () => {
  assert.equal(modelFor('claude', 'standard', 'opus', null), 'opus');
});

test('Codex is never passed a Claude alias', () => {
  // The bug that was there: `-m sonnet` also went to `codex exec`, where it
  // means nothing and makes the spawn fail.
  for (const depth of ['fast', 'standard', 'deep'] as const) {
    assert.equal(modelFor('codex', depth, 'sonnet', null), null);
    assert.equal(modelFor('codex', depth, 'sonnet', 'gpt-5.5'), 'gpt-5.5');
  }
});

test('for Codex depth is the reasoning effort, not the model', () => {
  // Its scale is `model_reasoning_effort`, which is stable: model names belong
  // to another vendor and change without notice.
  assert.equal(effortFor('codex', 'fast'), 'low');
  assert.equal(effortFor('codex', 'standard'), 'medium');
  assert.equal(effortFor('codex', 'deep'), 'high');
  assert.equal(effortFor('claude', 'deep'), null);
});

test('the fast step really costs less, not just in words', () => {
  // Asking for brevity is a prayer; giving less to read is a measure. The two
  // must go together or there is no saving.
  const snap = crowd(40);
  const fast = buildBrief(snap, {
    provider: 'claude', now: T0,
    budget: DEPTHS.fast.briefChars, maxSessions: DEPTHS.fast.sessions,
  });
  const deep = buildBrief(snap, {
    provider: 'claude', now: T0,
    budget: DEPTHS.deep.briefChars, maxSessions: DEPTHS.deep.sessions,
  });
  assert.ok(fast.length <= DEPTHS.fast.briefChars);
  assert.ok(deep.length > fast.length * 1.5, 'the two steps gave the same brief');
  // And even the tightest keeps what cannot be lost.
  assert.ok(fast.includes('## Quota'));
  assert.ok(fast.includes('## Your fleet (claude), right now'));
});

test('the contract asks for fewer proposals when going fast', () => {
  assert.match(contractFor('fast'), /At most 2 proposals/);
  assert.match(contractFor('standard'), /At most 4 proposals/);
  assert.match(contractFor('fast'), /at most five lines/);
  // Standard is the reference: it carries no additions.
  assert.equal(contractFor('standard').includes('five lines'), false);
});

test('deep declares the code even outside the structure analysis', () => {
  // You asked to go deep, and reading the code is what that means.
  assert.equal(DEPTHS.deep.code, true);
  assert.equal(DEPTHS.fast.code, false);
  assert.equal(DEPTHS.standard.code, false);
});

test('a truncated session list says so', () => {
  // Truncated silently it reads as complete, and the model would reason on it
  // as such.
  const text = buildBrief(crowd(40), {
    provider: 'claude', now: T0,
    budget: DEPTHS.fast.briefChars, maxSessions: DEPTHS.fast.sessions,
  });
  assert.match(text, /more not listed/);
});

test('the commit count enters the brief as a floor, not as a total', () => {
  /*
   * Measured on 14 September 2026: the brief declared "20 commits seen" on a
   * project that had 72. The commits do not come from `git log` but from the
   * tail of the reflog read in 4096 bytes -- at 192 bytes a line that is 21
   * lines, minus the first, which starts truncated. The CEO passed that number
   * on to the worker as "review 20 commits", and the first thing the worker
   * did was contradict it by rebuilding the history from git.
   *
   * A number that is a technical ceiling must be written as one: the same rule
   * by which `quota.ts` writes `<=`.
   */
  const snap = snapshot([project('p1', 'LIVE', false)], [session('s1', 'p1', 'claude')]);
  const text = buildBrief(snap, { provider: 'claude', now: T0 });

  assert.ok(text.includes('3+ commits'), 'the count must declare itself a floor');
  assert.equal(
    text.includes('3 commits seen'), false,
    'the old wording promised a total we never measured',
  );
  assert.ok(
    text.includes('Commit counts are floors'),
    'the reason for the "+" must be given once, at the top of the section',
  );
});
