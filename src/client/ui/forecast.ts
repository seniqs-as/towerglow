import type { ProviderId, ProviderLimits, RateWindow } from '../../shared/protocol.ts';
import { windowNow } from '../../shared/limits.ts';
import { formatElapsed } from './format.ts';

/**
 * The usage forecast: at this pace, does the quota last until it renews?
 *
 * The bars at the top right say how much you have burned. They do not say
 * the thing you actually want to know when you look at them -- can I keep
 * working like this, or do I stop Monday afternoon instead of Wednesday
 * evening -- and that is a division: what you have used divided by the time
 * gone by, carried all the way to the end of the window.
 *
 * The pace is the AVERAGE since the window opened, not the rhythm of the
 * last few minutes. It is the only measure that can be derived from what the
 * tool publishes -- a percentage and a reset instant -- without keeping a
 * history of samples that would be gone as soon as the page reloads.
 *
 * Nothing is drawn here: numbers and sentences, so they can be tested.
 */

/**
 * How much of the window must have passed before venturing a forecast.
 *
 * Ten minutes into a seven-day window is 0.1%: a single heavy turn in there
 * projects the end of everything for tonight. Below the threshold the
 * forecast is not cautious, it is noise -- and that has to be said, instead
 * of showing a made-up number wearing the face of a measurement.
 */
export const MIN_ELAPSED_FRACTION = 0.02;

/** ok: the quota lasts until it renews. early: it runs out before. unknown: can't tell. */
export type ForecastVerdict = 'ok' | 'early' | 'unknown';

/** Why nothing can be said, when nothing can. */
export type ForecastGap =
  /** The tool does not say when the quota restarts: without that there is no finish line. */
  | 'no-reset'
  /** The reset has already passed: the reading we have belongs to another window. */
  | 'stale'
  /** The window has been open too briefly for the pace to mean anything. */
  | 'too-early';

export interface WindowForecast {
  label: string;
  model: string | null;
  usedPercent: number;
  verdict: ForecastVerdict;
  windowMs: number;
  /** How long the window had been open when the quota was measured. */
  elapsedMs: number | null;
  /** The pace, in quotas per window: 1 is exactly what the window allows. */
  pace: number | null;
  /** How much would be used at the instant of renewal, keeping the pace. */
  projectedPercent: number | null;
  /** When it would run out. `null` if it does not run out before renewal. */
  runsOutAt: number | null;
  resetsAt: number | null;
  /** How long before renewal it would run out. */
  earlyBy: number | null;
  gap: ForecastGap | null;
}

export interface ProviderForecast {
  provider: ProviderId;
  plan: string | null;
  /** When the tool published this quota. */
  measuredAt: number;
  windows: WindowForecast[];
  /**
   * The window that runs out FIRST, if any runs out.
   *
   * That is the one that stops you: with two windows, the real limit is
   * always the nearer one, and a forecast showing the average of the two
   * would say all is well just as the rope tightens.
   */
  worst: WindowForecast | null;
}

/* ─────────────────────────── the arithmetic ─────────────────────────── */

function unknown(w: RateWindow, windowMs: number, gap: ForecastGap): WindowForecast {
  return {
    label: w.label,
    model: w.model,
    usedPercent: w.usedPercent,
    verdict: 'unknown',
    windowMs,
    elapsedMs: null,
    pace: null,
    projectedPercent: null,
    runsOutAt: null,
    resetsAt: w.resetsAt,
    earlyBy: null,
    gap,
  };
}

/**
 * The forecast for one window.
 *
 * `measuredAt` and not `now`: the percentage holds for the instant the tool
 * wrote it, and dividing it by the time elapsed since then would lower the
 * pace merely because the bridge has not updated us for a while.
 */
export function forecastWindow(w: RateWindow, measuredAt: number, now: number): WindowForecast {
  const windowMs = w.windowMinutes * 60_000;
  if (w.resetsAt === null || windowMs <= 0) return unknown(w, windowMs, 'no-reset');
  // A reset already in the past is not a window almost over: it is an old
  // reading of a window that restarted without anyone telling us.
  // Its percentage is not shown either: the bars read 0 there, and a panel
  // opened from them must not bring the old number back.
  if (w.resetsAt <= now) return unknown(windowNow(w, now), windowMs, 'stale');

  const start = w.resetsAt - windowMs;
  const elapsed = Math.min(measuredAt - start, windowMs);

  // Untouched quota: there is no pace to project, and no need to wait for the
  // threshold to say the one thing we know -- from here it will not run out.
  if (w.usedPercent <= 0) {
    return {
      label: w.label, model: w.model, usedPercent: w.usedPercent, verdict: 'ok',
      windowMs, elapsedMs: Math.max(0, elapsed), pace: 0, projectedPercent: 0,
      runsOutAt: null, resetsAt: w.resetsAt, earlyBy: null, gap: null,
    };
  }
  if (elapsed < windowMs * MIN_ELAPSED_FRACTION) {
    return { ...unknown(w, windowMs, 'too-early'), elapsedMs: Math.max(0, elapsed) };
  }

  const pace = (w.usedPercent / elapsed) * (windowMs / 100);
  const projectedPercent = pace * 100;
  // The pace the window allows is exactly 1: below it, the quota lasts until
  // renewal; above it, it runs out sooner, and how much sooner is the same
  // division turned the other way round.
  if (pace <= 1) {
    return {
      label: w.label, model: w.model, usedPercent: w.usedPercent, verdict: 'ok',
      windowMs, elapsedMs: elapsed, pace, projectedPercent,
      runsOutAt: null, resetsAt: w.resetsAt, earlyBy: null, gap: null,
    };
  }
  const runsOutAt = start + windowMs / pace;
  return {
    label: w.label, model: w.model, usedPercent: w.usedPercent, verdict: 'early',
    windowMs, elapsedMs: elapsed, pace, projectedPercent,
    runsOutAt, resetsAt: w.resetsAt, earlyBy: w.resetsAt - runsOutAt, gap: null,
  };
}

export function forecastProvider(limits: ProviderLimits, now: number): ProviderForecast {
  const windows = limits.windows.map((w) => forecastWindow(w, limits.at, now));
  let worst: WindowForecast | null = null;
  for (const f of windows) {
    if (f.verdict !== 'early' || f.runsOutAt === null) continue;
    if (!worst || f.runsOutAt < worst.runsOutAt!) worst = f;
  }
  return { provider: limits.provider, plan: limits.plan, measuredAt: limits.at, windows, worst };
}

/* ─────────────────────────── the sentences ─────────────────────────── */

export type DayPart = 'morning' | 'afternoon' | 'evening' | 'night';

export function dayPart(at: number): DayPart {
  const h = new Date(at).getHours();
  if (h < 5) return 'night';
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  if (h < 22) return 'evening';
  return 'night';
}

function midnightOf(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * When, the way a person would say it: "Monday afternoon", not a timestamp.
 *
 * The part of the day comes before the exact time because the question is
 * "when do I stop", and the useful answer is the stretch of the day it falls
 * in. The time sits in parentheses for whoever also has to decide whether
 * there is time to finish something: it is a detail of the day, not the
 * answer.
 *
 * The weekday only when needed: "this evening" and "tomorrow morning" are
 * clear without it, and reading "Mon afternoon" on a Monday forces a look at
 * the calendar to tell whether it means today or seven days from now.
 */
export function describeWhen(at: number, now: number): string {
  const part = dayPart(at);
  const days = Math.round((midnightOf(at) - midnightOf(now)) / 86_400_000);
  // The time follows the browser's language -- it is a format, not a word --
  // but the day does not: it sits inside an English sentence, and "runs out
  // lun morning" is a half-translated sentence that reads worse than either
  // language in full.
  const clock = new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const day = days <= 0
    ? (part === 'night' ? 'tonight' : `this ${part}`)
    : days === 1
      ? `tomorrow ${part}`
      : days < 7
        ? `${new Date(at).toLocaleDateString('en', { weekday: 'short' })} ${part}`
        : `${new Date(at).toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short' })} ${part}`;
  return `${day} (${clock})`;
}

/** The pace, said in one go: 1.5x means a window and a half. */
export function describePace(pace: number): string {
  return `${pace < 10 ? pace.toFixed(1) : Math.round(pace)}× the pace the window allows`;
}

/** What happens to THIS window: the line read first. */
export function describeWindow(f: WindowForecast, now: number): string {
  if (f.verdict === 'early' && f.runsOutAt !== null) {
    // A projection that falls before now is not a forecast: it is a quota
    // that by this point ran out while nobody was watching.
    return f.runsOutAt <= now ? 'out of quota any moment now' : `runs out ${describeWhen(f.runsOutAt, now)}`;
  }
  if (f.verdict === 'ok') return 'ok';
  switch (f.gap) {
    case 'no-reset': return 'no reset time reported';
    case 'stale': return 'window has since reset';
    default: return 'too early to tell';
  }
}

/** The why of the line above: the number it comes from, and how solid it is. */
export function detailWindow(f: WindowForecast, now: number): string {
  if (f.verdict === 'early' && f.earlyBy !== null && f.resetsAt !== null && f.pace !== null) {
    const early = `${formatElapsed(f.earlyBy)} before it resets ${describeWhen(f.resetsAt, now)}`;
    return `${early} · ${describePace(f.pace)}`;
  }
  if (f.verdict === 'ok') {
    if (f.usedPercent <= 0) return 'nothing used in this window yet';
    const when = f.resetsAt !== null ? ` when it resets ${describeWhen(f.resetsAt, now)}` : '';
    return `on this pace about ${Math.round(f.projectedPercent ?? 0)}% used${when}`;
  }
  switch (f.gap) {
    case 'no-reset':
      return 'without the instant the quota restarts there is nothing to project against';
    case 'stale':
      return 'waiting for a fresh reading from the tool';
    default:
      return `only ${formatElapsed(f.elapsedMs ?? 0)} into the ${f.label} window — too little to tell a pace from a burst`;
  }
}

/**
 * A tool's verdict in one sentence.
 *
 * If the quota is enough, it only says it is enough: a forecast that dwells
 * on nothing gets read every time only to find out every time that there is
 * nothing to know.
 */
export function describeProvider(f: ProviderForecast, now: number): string {
  if (f.worst?.runsOutAt != null && f.worst.resetsAt !== null) {
    const which = f.worst.model ? `${f.worst.label} ${f.worst.model}` : f.worst.label;
    const out = f.worst.runsOutAt <= now ? 'is out of quota' : `runs out ${describeWhen(f.worst.runsOutAt, now)}`;
    return `at this pace it ${out}, instead of lasting to ${describeWhen(f.worst.resetsAt, now)} — the ${which} window is the one that stops you`;
  }
  if (f.windows.some((w) => w.verdict === 'ok')) return 'ok — at this pace the quota lasts to the reset';
  return 'not enough to go on yet';
}

/** The attention level of a line: the same code as the bars. */
export function levelOf(f: WindowForecast): 'ok' | 'warn' | 'high' {
  if (f.verdict !== 'early' || f.pace === null) return 'ok';
  // Overshooting a window slightly means an afternoon wrapped up early;
  // overshooting it twofold means running dry halfway through the period.
  return f.pace >= 1.5 ? 'high' : 'warn';
}
