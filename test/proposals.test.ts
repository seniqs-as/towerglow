import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProposalStore } from '../src/server/ceo/proposals.ts';
import type { NewProposal, Proposal } from '../src/server/ceo/proposals.ts';
import { createFleet } from '../src/server/ceo/fleet.ts';
import type { SpendLedger } from '../src/server/ceo/spend.ts';
import type { ProviderLimits, Snapshot } from '../src/shared/protocol.ts';

const T0 = 1_760_000_000_000;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-prop-'));
}

function fresh(id = 'p1', over: Partial<NewProposal> = {}): NewProposal {
  return {
    id,
    at: T0,
    provider: 'claude',
    kind: 'tokens',
    summary: 'Pin the CEO flags so the prompt cache survives between calls.',
    projectId: 'proj1',
    projectName: 'MY_DASHBOARD',
    task: 'Stop changing the system prompt between calls.',
    ...over,
  };
}

/* ───────────────────────── the state machine ───────────────────────── */

test('a proposal is born pending: it does not decide itself', () => {
  const store = createProposalStore(tmp());
  assert.equal(store.add(fresh()).status, 'pending');
});

test('nothing becomes applied without having gone through accepted', () => {
  // This is THE property to defend: without it, "nothing runs without your
  // yes" would depend on the caller instead of on this place.
  const store = createProposalStore(tmp());
  store.add(fresh());
  const out = store.markApplied('p1', 'ceo-p1', T0);
  assert.equal(out.ok, false);
  assert.match(out.reason, /cannot apply a pending proposal/);
  assert.equal(store.get('p1')?.status, 'pending');
});

test('a rejected proposal stays rejected, and cannot be run', () => {
  const store = createProposalStore(tmp());
  store.add(fresh());
  store.decide('p1', false, T0);
  assert.equal(store.get('p1')?.status, 'rejected');
  assert.equal(store.markApplied('p1', 'ceo-p1', T0).ok, false);
});

test('deciding twice does not reopen something already closed', () => {
  const store = createProposalStore(tmp());
  store.add(fresh());
  assert.equal(store.decide('p1', true, T0).ok, true);
  const again = store.decide('p1', false, T0 + 1);
  assert.equal(again.ok, false);
  assert.match(again.reason, /already accepted/);
  assert.equal(store.get('p1')?.status, 'accepted');
});

test('a yes that never started is withdrawn, and becomes a no', () => {
  // The real case: the decsim2 review accepted on 16 September never
  // started, and stayed `accepted` with nothing behind it and no way out.
  const store = createProposalStore(tmp());
  store.add(fresh());
  store.decide('p1', true, T0);
  const out = store.withdraw('p1', T0 + 10);
  assert.equal(out.ok, true);
  assert.equal(store.get('p1')?.status, 'rejected');
  assert.equal(store.get('p1')?.decidedAt, T0 + 10);
  assert.equal(store.markApplied('p1', 'ceo-p1', T0 + 11).ok, false, 'a withdrawn one started again');
});

test('only a stalled yes is withdrawn: not a pending one, not one already started', () => {
  const store = createProposalStore(tmp());
  store.add(fresh('p1'));
  assert.match(store.withdraw('p1', T0).reason, /this one is pending/);
  store.add(fresh('p2'));
  store.decide('p2', true, T0);
  store.markApplied('p2', 'p2', T0 + 1);
  assert.match(store.withdraw('p2', T0 + 2).reason, /this one is applied/);
  assert.equal(store.get('p2')?.status, 'applied');
});

test('the whole path is walked only once', () => {
  const store = createProposalStore(tmp());
  store.add(fresh());
  store.decide('p1', true, T0);
  const applied = store.markApplied('p1', 'p1', T0 + 5);
  assert.equal(applied.ok, true);
  assert.equal(store.get('p1')?.status, 'applied');
  assert.equal(store.get('p1')?.sessionId, 'p1');
  // And it is not applied again: the job has already started once.
  assert.equal(store.markApplied('p1', 'p1-bis', T0 + 6).ok, false);
});

test('an unknown proposal cannot be decided, and says so', () => {
  const store = createProposalStore(tmp());
  const out = store.decide('never-seen', true, T0);
  assert.equal(out.ok, false);
  assert.match(out.reason, /unknown proposal/);
});

test('decisions survive a restart: a pending one must find you again', () => {
  const dir = tmp();
  const a = createProposalStore(dir);
  a.add(fresh('p1'));
  a.add(fresh('p2'));
  a.decide('p2', true, T0);
  a.save();

  const b = createProposalStore(dir);
  assert.equal(b.get('p1')?.status, 'pending');
  assert.equal(b.get('p2')?.status, 'accepted');
});

test('the registry is pruned, but a pending one never leaves', () => {
  // It is the only one still waiting for something from you: throwing it away
  // would make the decision impossible instead of postponed.
  const store = createProposalStore(tmp());
  store.add(fresh('alive'));
  for (let i = 0; i < 260; i++) {
    store.add(fresh(`d${i}`, { at: T0 - 100000 + i }));
    store.decide(`d${i}`, false, T0);
  }
  assert.ok(store.get('alive'), 'the waiting proposal was pruned');
  assert.ok(store.list().length <= 200);
});

/* ───────────────────────── the fleet gates ───────────────────────── */

function ledger(blocked: string | null = null): SpendLedger {
  return {
    blockedReason: () => blocked,
    record: () => {},
    spentLast24h: () => 0,
    save: () => {},
  };
}

function snapshot(limits: ProviderLimits[] = []): Snapshot {
  return { at: T0, limits, projects: [], sessions: [], agents: [], files: [], recent: [] };
}

function accepted(over: Partial<Proposal> = {}): Proposal {
  return { ...fresh(), status: 'accepted', decidedAt: T0, sessionId: null, ...over };
}

function fleetWith(over: Partial<Parameters<typeof createFleet>[0]> = {}): ReturnType<typeof createFleet> {
  return createFleet({
    model: 'sonnet',
    ledger: ledger(),
    execute: true,
    snapshot: () => snapshot(),
    cwdOf: () => '/Users/tester/proj',
    onStart: () => {},
    onProgress: () => {},
    onAdopt: () => {},
    onEnd: () => {},
    ...over,
  });
}

test('with --no-execute nothing starts, and the refusal belongs to the server', () => {
  // Not an instruction inside a prompt: a model can ignore a sentence, not a
  // process that is never started.
  const out = fleetWith({ execute: false }).start(accepted());
  assert.equal(out.ok, false);
  assert.equal(out.jobId, null);
  assert.match(out.reason, /executive mode is off/);
});

test('no dedicated session starts without an accepted proposal', () => {
  const fleet = fleetWith();
  for (const status of ['pending', 'rejected', 'applied'] as const) {
    const out = fleet.start(accepted({ status }));
    assert.equal(out.ok, false, `${status} should not have been able to start`);
    assert.match(out.reason, new RegExp(status));
  }
});

test('a proposal without a task is not run: there would be nothing to do', () => {
  const out = fleetWith().start(accepted({ task: null }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /no task/);
});

test('a proposal without a project is not run: there would be nowhere to run it', () => {
  const out = fleetWith().start(accepted({ projectId: null }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /no project/);
});

test('a project no longer on disk stops the launch', () => {
  const out = fleetWith({ cwdOf: () => undefined }).start(accepted());
  assert.equal(out.ok, false);
  assert.match(out.reason, /not on disk/);
});

test('the quota stops the fleet too, not just the analyst', () => {
  // It would be absurd for the tool built to watch over the quota to burn it
  // through the back door.
  const out = fleetWith({ ledger: ledger('5h quota at 92%, over the 85% cap') }).start(accepted());
  assert.equal(out.ok, false);
  assert.match(out.reason, /92%/);
});

test('the gates close in order: executive mode before everything else', () => {
  // With executive mode off it must not even be possible to find out that the
  // project does not exist: it never gets as far as looking.
  const out = createFleet({
    model: 'sonnet',
    ledger: ledger('quota used up'),
    execute: false,
    snapshot: () => snapshot(),
    cwdOf: () => undefined,
    onStart: () => {},
    onProgress: () => {},
    onAdopt: () => {},
    onEnd: () => {},
  }).start(accepted({ task: null, projectId: null }));
  assert.match(out.reason, /executive mode is off/);
});

test('no process starts, so no job appears', () => {
  const seen: unknown[] = [];
  fleetWith({ execute: false, onStart: (p) => seen.push(p) }).start(accepted());
  assert.deepEqual(seen, []);
});
