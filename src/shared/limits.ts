import type { ProviderLimits, RateWindow } from './protocol.ts';

/**
 * What a quota window reads NOW, not when the tool last wrote it.
 *
 * Both tools publish the quota only inside a turn: Codex in the `token_count`
 * of its rollout, Claude Code through the status line. Stop working and the
 * last reading stays on disk as it was. Measured on the field: a 5h Codex
 * window at 89% at 20:00, reset at 00:34, still drawn at 89% at 09:00 -- and
 * over the 85% cap, so the Codex CEO refused to start on a window that no
 * longer existed.
 *
 * Past `resetsAt` the percentage belongs to a window that is gone, and the one
 * that replaced it has nothing from this machine: any turn here would have
 * written a fresher reading, which replaces this one. So it reads 0. `resetsAt`
 * stays in the past on purpose: it is how every surface can still say "reset
 * since, no new reading" instead of passing a guess off as a measurement.
 *
 * One function for the bars, the forecast and the CEO gate: if they decided
 * this each on their own, sooner or later they would disagree.
 */
export function windowNow(w: RateWindow, now: number): RateWindow {
  if (w.resetsAt === null || w.resetsAt > now) return w;
  return w.usedPercent === 0 ? w : { ...w, usedPercent: 0 };
}

/** True when the reading is older than the reset: the percentage is not measured. */
export function hasReset(w: RateWindow, now: number): boolean {
  return w.resetsAt !== null && w.resetsAt <= now;
}

/**
 * A fresher reading laid over the windows already known.
 *
 * Claude Code's status line publishes the quota of the LAST response of the
 * session that drew it, and a session that has not called the API since the
 * short window opened carries only `seven_day`. Measured on 2026-09-20: the
 * 5h bar disappeared from the HUD as soon as any idle session redrew its
 * status line, came back while something was working, and went again the
 * moment that turn ended -- and with it went the 5h reserve the scheduler
 * holds, which reads the same state.
 *
 * A reading that does not NAME a window says nothing about it, which is not
 * the same as measuring zero: the known one stays, and `windowNow` is what
 * turns it to 0 once its reset has passed. The order is the one every source
 * writes: shortest span first, and at equal span the general limit before a
 * model's.
 */
export function mergeWindows(known: readonly RateWindow[], fresh: readonly RateWindow[]): RateWindow[] {
  const same = (a: RateWindow, b: RateWindow): boolean => a.label === b.label && a.model === b.model;
  const kept = known.filter((w) => !fresh.some((n) => same(n, w)));
  return [...fresh, ...kept].sort((a, b) => a.windowMinutes - b.windowMinutes
    || Number(a.model !== null) - Number(b.model !== null));
}

/** Every window of a tool, as it reads now. */
export function limitsNow(l: ProviderLimits, now: number): ProviderLimits {
  const windows = l.windows.map((w) => windowNow(w, now));
  return windows.every((w, i) => w === l.windows[i]) ? l : { ...l, windows };
}
