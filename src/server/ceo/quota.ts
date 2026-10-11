import type { ProviderId, ProviderLimits } from '../../shared/protocol.ts';
import { windowNow } from '../../shared/limits.ts';

/**
 * From tokens to a percentage of your subscription rate, without price lists.
 *
 * On a subscription you do not pay per token: you burn the 5h and 7d windows,
 * and those percentages are the only MEASURED number in all the accounting --
 * they come from the statusline bridge, not from a price someone will have to
 * remember to update. A cost in dollars, here, measures something that does
 * not exist.
 *
 * The conversion is derived from you and from nothing else:
 *
 *     the 7d window is at 67%
 *     in seven days you burned W weighted tokens
 *     => the whole window is worth W / 0.67
 *     => a call of w tokens is worth 67 * w / W  percent
 *
 * Two honesties to hold firm:
 *
 *  - W counts only the sessions this tool has seen close, so it is a floor:
 *    the percentage that comes out is higher than the truth. For a brake it is
 *    the right direction to be wrong in, and it must be said instead of
 *    hidden.
 *  - below a certain amount of history the ratio is noise, and then we do not
 *    answer: `null` is better than a number made up to three decimals.
 *  - the denominator mixes models. A haiku token and an opus token do not
 *    consume the same quota, and here they weigh the same: the conversion
 *    assumes the call costs like the average of your fleet. For a model more
 *    expensive than average the estimate is low, for a cheaper one it is
 *    high -- and since the fast tier is the cheapest, the direction of the
 *    error stays the prudent one here too. Fixing it would mean bringing back
 *    a per-model price list, which is exactly what this file exists to avoid.
 */

/**
 * Below this many weighted tokens in the window, the ratio is not computed.
 *
 * Fifty thousand is about two CEO calls: with fewer than that the denominator
 * is dominated by whatever happened first, and the percentage would say more
 * about how much history we have than about how much it costs.
 */
const MIN_WEIGHTED = 50_000;
/** A practically untouched window cannot bear a division. */
const MIN_PERCENT = 2;

export interface QuotaShare {
  /** How much of that window it is worth, in percentage points. */
  percent: number;
  /** Which window: `5h`, `7d`, whatever the tool declares. */
  label: string;
  /** The denominator is a floor: the estimate is a ceiling, not a measure. */
  atMost: true;
}

/**
 * How much `weighted` weighs on the window that will close first.
 *
 * ALL the declared windows are evaluated and the highest percentage is kept:
 * it is the one that stops you, exactly as `tightestWindow` keeps the most
 * consumed one. A window without enough history is skipped, not guessed.
 */
export function quotaShare(
  weighted: number,
  provider: ProviderId,
  limits: readonly ProviderLimits[],
  weightedSince: (provider: ProviderId, since: number, now: number) => number,
  now: number,
): QuotaShare | null {
  const shares = shareByWindow(weighted, provider, limits, weightedSince, now);
  if (!shares) return null;
  let worst: QuotaShare | null = null;
  for (const [label, percent] of Object.entries(shares)) {
    if (!worst || percent > worst.percent) worst = { percent, label, atMost: true };
  }
  return worst;
}

/**
 * The same arithmetic, one figure per window instead of the worst.
 *
 * The scheduler's headroom rule needs every window: the 7d can be the one
 * that blocks while the 5h has just reset, and the worst of the two says
 * nothing about the other. A window with too little history is left out of
 * the map, not guessed; an empty map is `null`.
 */
export function shareByWindow(
  weighted: number,
  provider: ProviderId,
  limits: readonly ProviderLimits[],
  weightedSince: (provider: ProviderId, since: number, now: number) => number,
  now: number,
): Record<string, number> | null {
  if (!Number.isFinite(weighted) || weighted <= 0) return null;
  const mine = limits.find((l) => l.provider === provider);
  if (!mine) return null;

  const out: Record<string, number> = {};
  let any = false;
  // A window past its reset reads 0 and falls below MIN_PERCENT: its old
  // percentage divided by tokens burned since would be a share of nothing.
  for (const w of mine.windows.map((x) => windowNow(x, now))) {
    if (!Number.isFinite(w.usedPercent) || w.usedPercent < MIN_PERCENT) continue;
    if (!Number.isFinite(w.windowMinutes) || w.windowMinutes <= 0) continue;
    const burned = weightedSince(provider, now - w.windowMinutes * 60_000, now);
    if (burned < MIN_WEIGHTED) continue;
    out[w.label] = (weighted / burned) * w.usedPercent;
    any = true;
  }
  return any ? out : null;
}

/** How it is written on screen. Two decimals below one percent, one above. */
export function formatShare(share: QuotaShare | null): string | null {
  if (!share) return null;
  const n = share.percent < 1 ? share.percent.toFixed(2) : share.percent.toFixed(1);
  return `<=${n}% of ${share.label}`;
}
