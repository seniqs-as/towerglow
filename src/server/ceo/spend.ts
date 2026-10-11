import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProviderId, ProviderLimits } from '../../shared/protocol.ts';
import { windowNow } from '../../shared/limits.ts';
import type { CeoCaps } from '../ceoPort.ts';

/**
 * How much a CEO may spend, and why it cannot right now.
 *
 * Three caps, and only one is in currency:
 *
 *  - the QUOTA is the real limit on a subscription plan, where you do not pay
 *    per token but burn through the 5h and 7d windows. It is also the only
 *    MEASURED figure: it comes from the statusline bridge, not from a price
 *    list to be guessed.
 *  - the DOLLAR cap is for whoever uses an API key, and it is a sliding
 *    24-hour window. Not "per request", which would not stop fifty requests;
 *    not "since start", which with a detached server would reset at every
 *    restart.
 *  - the PER-CALL cap covers a different risk from the other two: not the
 *    day's spend but the call that runs away.
 *
 * Honesty to hold on to: these are this process's own accounting, not caps
 * imposed by the vendor. They hold as long as the runner is the only place a
 * process starts from.
 */

/**
 * The relative weight of the four kinds of token.
 *
 * PRICES change from one model to another and over time; these RATIOS do not
 * -- output five times input, cache write 1.25, cache read 0.1 -- and they
 * hold for the whole family. It is why the brake works on a "weighted token"
 * instead of a price list: a hard-wired price list ages silently, a ratio
 * does not.
 *
 * Verified on the two real calls in the ledger: 3.27 and 3.18 microdollars
 * per weighted token, i.e. a 3% gap between a cold call and a warm one. If the
 * ratios were wrong those two figures would not look alike.
 *
 * Thinking tokens do not appear: the API already counts them inside `out`,
 * and adding them would pay for them twice.
 */
export interface CallUsage {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

export function weigh(u: CallUsage): number {
  return u.in + u.out * 5 + u.cacheWrite * 1.25 + u.cacheRead * 0.1;
}

/**
 * What a weighted token is worth until it has been learned.
 *
 * Ten microdollars is the input of the most expensive model in the family. It
 * is deliberately the maximum: a brake that knows nothing yet must stop too
 * early, not too late. From the first finished call onwards the rate derived
 * from YOUR calls is used, and that one cannot age.
 */
const UNLEARNED_RATE = 10e-6;

/** A call already paid for. */
interface Call {
  at: number;
  usd: number;
  provider: ProviderId;
  /** The call's weighted tokens. Zero in ledgers written before the brake. */
  w: number;
}

interface LedgerFile {
  version: number;
  calls: Call[];
}

const VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The caps live in the contract, not here: whoever lacks this folder names them too. */
export type SpendCaps = CeoCaps;

export interface SpendLedger {
  /**
   * The reason the CEO cannot start right now, or `null` if it can.
   * A string and not a boolean: the WHY must show on screen, or the CEO looks
   * broken instead of stopped out of caution.
   */
  blockedReason(provider: ProviderId, limits: readonly ProviderLimits[], now: number): string | null;
  /** Records a paid call. `usd` may be 0 if the cost is not known. */
  record(provider: ProviderId, usd: number, now: number, weighted?: number): void;
  /**
   * The reason the call IN PROGRESS must be stopped now, or `null`.
   *
   * The other caps look at the past and decide whether to start; this one
   * watches the call while it runs. Without it, `--ceo-max-call` does not
   * limit a call: it only checks that the 24-hour budget still has room for
   * one, and once started the only brake is the timeout -- which, on a
   * structural analysis that can read files for three minutes, arrives long
   * after the fifty cents.
   */
  runawayReason(provider: ProviderId, weighted: number): string | null;
  /** The estimated cost of a call in progress, from its weighted tokens. */
  estimate(provider: ProviderId, weighted: number): number;
  spentLast24h(now: number): number;
  save(): void;
}

/**
 * The window closest to running out, among all the declared ones.
 *
 * The TIGHTEST is what counts, not the average: if the 5h is at 90% it does
 * not matter that the weekly one is at 20%, because it is the first to stop
 * you.
 */
export function tightestWindow(
  provider: ProviderId,
  limits: readonly ProviderLimits[],
  now: number,
): { label: string; usedPercent: number } | null {
  const mine = limits.find((l) => l.provider === provider);
  if (!mine) return null;
  let worst: { label: string; usedPercent: number } | null = null;
  // A window past its reset no longer stops anyone: gating on its old
  // percentage kept the Codex CEO off all morning after an 89% evening.
  for (const w of mine.windows.map((x) => windowNow(x, now))) {
    if (!Number.isFinite(w.usedPercent)) continue;
    if (!worst || w.usedPercent > worst.usedPercent) {
      worst = { label: w.label, usedPercent: w.usedPercent };
    }
  }
  return worst;
}

export function createSpendLedger(stateDir: string, caps: SpendCaps): SpendLedger {
  const dir = path.join(stateDir, 'ceo');
  const file = path.join(dir, 'spend.json');
  let calls: Call[] = [];
  let dirty = false;

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as LedgerFile;
    if (raw && raw.version === VERSION && Array.isArray(raw.calls)) {
      calls = raw.calls.filter(
        (c) => c && Number.isFinite(c.at) && Number.isFinite(c.usd),
      );
    }
  } catch {
    // no ledger: start from zero, which is the case of every first time
  }

  /** Throws away what is outside the window: the file must not grow forever. */
  function prune(now: number): void {
    const before = calls.length;
    calls = calls.filter((c) => now - c.at < DAY_MS);
    if (calls.length !== before) dirty = true;
  }

  /**
   * What a weighted token costs, learned from the calls already finished.
   *
   * It averages over those of THIS provider that have both a declared cost
   * and a count: it is the real rate of the model you are using, not that of a
   * price list someone will have to remember to update. With a model changed
   * halfway through the day the average catches up, and it is still closer to
   * the truth than any constant.
   */
  function rateFor(provider: ProviderId): number {
    let usd = 0;
    let weighted = 0;
    for (const c of calls) {
      if (c.provider !== provider || !c.w || c.usd <= 0) continue;
      usd += c.usd;
      weighted += c.w;
    }
    return weighted > 0 ? usd / weighted : UNLEARNED_RATE;
  }

  function spent(now: number): number {
    prune(now);
    let total = 0;
    for (const c of calls) total += c.usd;
    return total;
  }

  return {
    blockedReason(provider, limits, now) {
      const window = tightestWindow(provider, limits, now);
      if (window && window.usedPercent >= caps.quotaMaxPercent) {
        return `${window.label} quota at ${Math.round(window.usedPercent)}%, over the ${caps.quotaMaxPercent}% cap`;
      }

      // A quota reading means a subscription: the quota is the cap, and the
      // dollars in the ledger are a list-price equivalent, not money spent.
      // The dollar cap is for API keys, which report no windows. Measured on
      // 2026-09-19: three planned workers, $107 of list price for 5h at
      // 80%, locked the planner, the meeting and the CEOs for a whole day
      // behind a $10 cap, with the quota back at 10%.
      if (window) return null;

      const used = spent(now);
      if (used >= caps.budgetUsd) {
        return `spent ${used.toFixed(2)} USD in the last 24h, cap ${caps.budgetUsd.toFixed(2)}`;
      }

      // Do not even start if there is no room left for a whole call: better to
      // stop before than to cut it off halfway after already paying for it.
      if (caps.budgetUsd - used < caps.maxCallUsd) {
        return `${(caps.budgetUsd - used).toFixed(2)} USD left, less than the per-call cap (${caps.maxCallUsd.toFixed(2)})`;
      }

      return null;
    },

    record(provider, usd, now, weighted) {
      calls.push({
        at: now,
        usd: Number.isFinite(usd) && usd > 0 ? usd : 0,
        provider,
        w: Number.isFinite(weighted) && (weighted ?? 0) > 0 ? (weighted as number) : 0,
      });
      dirty = true;
      prune(now);
    },

    estimate: (provider, weighted) => Math.max(0, weighted) * rateFor(provider),

    runawayReason(provider, weighted) {
      const spent = Math.max(0, weighted) * rateFor(provider);
      if (spent <= caps.maxCallUsd) return null;
      return `this call passed ${spent.toFixed(2)} USD, over the ${caps.maxCallUsd.toFixed(2)} per-call cap`;
    },

    spentLast24h: (now) => spent(now),

    save() {
      if (!dirty) return;
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const payload: LedgerFile = { version: VERSION, calls };
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(tmp, file);
        dirty = false;
      } catch {
        // Being unable to save must not stop the tool: the memory of the spend
        // is lost between one restart and the next, and the quota cap holds
        // anyway.
      }
    },
  };
}
