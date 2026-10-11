import * as path from 'node:path';
import { EFFECT_NOISE_PERCENT } from '../../shared/protocol.ts';
import { hasReset, windowNow } from '../../shared/limits.ts';
import type { ProviderId, Snapshot, SessionInfo, ProjectInfo } from '../../shared/protocol.ts';
import type { HistoryDigest, PeriodTotals, ProjectHistory } from '../state/history.ts';
import { weigh } from './spend.ts';

/**
 * The world, written for a CEO.
 *
 * The ONLY place that decides what the CEO can see. It is not the channel to
 * the browser -- that one has its own, stricter rules, enforced by
 * `redact.ts` -- but it stays a boundary declared in one file instead of
 * scattered around.
 *
 * Two filters in series, and that is what keeps the cost under control:
 *  1. DISABLED projects never get in. You already said they are out of play:
 *     paying for them in every question would be absurd.
 *  2. everything is cut at `MAX_*`, because a brief is for ONE question, not
 *     an archive.
 *
 * The text is compact on purpose: every line in here is input paid for on
 * every single question, and the CLI preamble already costs four cents before
 * it even gets here (measured).
 *
 * Four rules keep it from growing with use, which is the failure mode that
 * matters: a brief that costs more every week eventually costs more than the
 * answer is worth.
 *
 *  a. SECTIONS, WITH A DECLARED BUDGET. Every section carries a rank, and over
 *     `MAX_BRIEF_CHARS` the lowest-ranked ones are dropped, loudest first. A
 *     ceiling that is enforced beats a ceiling that is hoped for.
 *  b. TWO PERIODS, NEVER A SERIES. History arrives already folded: this week
 *     against the one before. Thirty rows say "it got worse" no better than two
 *     numbers and an arrow.
 *  c. ONLY WHAT MOVED. A metric that did not change is not printed twice.
 *  d. THE OTHER FLEET ONLY WHERE IT MEETS YOURS. With no project in common
 *     there is nothing to collide over, and describing it is a bill for
 *     something the answer cannot use.
 *  e. MEMORY AS HEADLINES, NEVER AS TRANSCRIPTS. What the CEO already knows --
 *     what you turned down, what was already done, what the session that works
 *     there objected to -- arrives as one line each, capped in number and in
 *     length. The record itself lives in Reports, where a person reads it.
 */

const MAX_PROJECTS = 24;
const MAX_SESSIONS = 20;
const MAX_FILES = 24;

/**
 * The brief's cap, in characters.
 *
 * Six thousand is about fifteen hundred tokens: next to the twenty-eight
 * thousand of the CLI preamble that is noise, and it does not grow with use.
 * The number matters less than the fact that it exists and is enforced:
 * without it, the brief grows with the city and one day the cheapest question
 * costs as much as the most expensive one.
 */
export const MAX_BRIEF_CHARS = 6000;

/** How far back the historical comparisons look. */
export const HISTORY_DAYS = 7;

/** From milliseconds to a readable duration. */
function human(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${Math.round(h / 24)}d`;
}

function ago(at: number, now: number): string {
  return at > 0 ? human(now - at) : '-';
}

function k(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  if (Math.abs(n) < 1000) return String(Math.round(n));
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** The share of cache that was read, or `null` when there is no cache to speak of. */
export function cacheHitOf(t: { cacheRead: number; cacheWrite: number }): number | null {
  const total = t.cacheRead + t.cacheWrite;
  return total > 0 ? Math.round((t.cacheRead / total) * 100) : null;
}

/**
 * How much it changed, or `null` if it is not worth saying.
 *
 * Under 15% is noise: two weeks of work are never identical, and printing
 * "+3%" for every metric would fill the brief with changes that do not change
 * any decision.
 */
export function moved(now: number, before: number): string | null {
  if (before <= 0) return now > 0 ? 'new' : null;
  const change = Math.round(((now - before) / before) * 100);
  if (Math.abs(change) < EFFECT_NOISE_PERCENT) return null;
  return change > 0 ? `+${change}%` : `${change}%`;
}

function projectLine(p: ProjectInfo, now: number): string {
  const bits = [
    p.name,
    `${p.size} files`,
    `active ${ago(p.lastActiveAt, now)} ago`,
  ];
  if (p.branch) bits.push(`branch ${p.branch}`);
  /*
   * The `+` is not an affectation: that number is a FLOOR, and it used to say
   * "N commits seen" -- a caution too faint for a model to respect.
   *
   * The commits do not come from `git log`: `gitSource.ts` reads the tail of
   * the reflog through a 4096-byte window and discards the first line, which
   * starts truncated. Measured on decsim2 on 14 September 2026: a reflog of
   * 7,524 bytes over 39 lines, i.e. 192 bytes per line; the last 4 KB hold 21
   * of them, and minus the partial one that makes TWENTY -- against 72 real
   * commits. The number measured the read window, not the project, and the
   * CEO passed it on to the worker as "review 20 commits": the first thing the
   * worker did was contradict it by rebuilding everything from `git log`.
   *
   * Same medicine as `quota.ts`, which writes `<=` because its denominator is
   * a floor: a declared bound is worth more than a precise, false number. The
   * why is said once at the head of the section, not on every line: the brief
   * has a cap, and twenty-four projects would pay twenty-four times for the
   * same explanation.
   */
  if (p.commits > 0) bits.push(`${p.commits}+ commits`);
  if (!p.exists) bits.push('GONE FROM DISK');
  return `- ${bits.join(' · ')}`;
}

function sessionLine(s: SessionInfo, nameOf: (id: string) => string, now: number): string {
  const t = s.tokens;
  // The ratio of cache read to cache written is the most actionable signal
  // there is: if the cache does not hold, every turn pays for the whole prompt
  // again.
  const cacheHit = cacheHitOf(t);

  const bits = [
    `${s.provider}/${s.model ?? 'unknown model'}`,
    nameOf(s.projectId),
    s.status,
    `${s.turns} turns`,
    `${s.toolCalls} tool calls`,
    `in ${k(t.in)} out ${k(t.out)}`,
  ];
  if (cacheHit !== null) bits.push(`cache read ${cacheHit}%`);
  if (t.thinking > 0) bits.push(`thinking ${k(t.thinking)}`);
  if (s.contextPct !== null) bits.push(`context ${Math.round(s.contextPct)}%`);
  if (s.reasoningMs !== null && s.reasoningMs > 0) bits.push(`reasoning ${human(s.reasoningMs)}`);
  if (s.lastTurnMs !== null && s.lastTurnMs > 0) bits.push(`last turn ${human(s.lastTurnMs)}`);
  if (s.agentsActive > 0) bits.push(`${s.agentsActive} agents`);
  if (s.status === 'waiting' && s.waitingFor) bits.push(`waiting on: ${s.waitingFor}`);
  if (s.spawnedByCeo) bits.push(`opened by the ${s.spawnedByCeo} CEO`);
  return `- ${bits.join(' · ')} · idle for ${ago(s.lastActivityAt, now)}`;
}

/**
 * A project over the period, and what changed compared with the previous one.
 *
 * The current period is described in full; of the previous one, ONLY what
 * moved is named. It is the difference between a line and a table, and the
 * answer loses nothing by it: the real question is always "is it getting
 * worse".
 */
function historyLine(h: ProjectHistory, name: string, days: number, share: string | null): string {
  const n: PeriodTotals = h.now;
  const bits = [`${n.sessions} sessions`];
  // Turns and calls only count for sessions we watched at work: the closing
  // tally does not carry them, and a session recovered from disk has them at
  // zero. Printing them as a total would make it look like the work collapsed
  // precisely in the period where the most history was recovered.
  if (n.watched > 0) {
    const from = n.watched < n.sessions ? ` (of ${n.watched}/${n.sessions} watched)` : '';
    bits.push(`${n.turns} turns${from}`, `${n.toolCalls} calls`);
  }
  if (n.tokens.in + n.tokens.out > 0) bits.push(`in ${k(n.tokens.in)} out ${k(n.tokens.out)}`);
  const cacheNow = cacheHitOf(n.tokens);
  if (cacheNow !== null) bits.push(`cache read ${cacheNow}%`);
  if (n.tokens.thinking > 0) bits.push(`thinking ${k(n.tokens.thinking)}`);
  // Quota before dollars, and that is the right order: on a subscription you
  // do not pay per token, you use up the windows. The dollar stays as a second
  // point of comparison, never the first.
  if (share) bits.push(share);
  if (n.costUsd > 0) bits.push(`list $${n.costUsd.toFixed(2)}`);
  if (n.linesAdded + n.linesRemoved > 0) bits.push(`+${n.linesAdded}/-${n.linesRemoved} lines`);
  // How many of these rows are numbers DECLARED by the tool and how many we
  // counted ourselves: a partial total passed off as complete is a lie.
  if (n.reported < n.sessions) bits.push(`${n.reported}/${n.sessions} declared, the rest observed`);

  const shifts: string[] = [];
  // Without a previous period there is no comparison to make. Saying so metric
  // by metric -- "cost new, thinking new, calls new" -- fills every line with a
  // single repeated word, which is noise paid for on every question.
  const comparable = h.before.sessions > 0;
  // Only what is complete in BOTH periods is compared. Tokens, cost and cache
  // always are -- the tool declares them -- calls are not, and comparing an
  // observed period with a recovered one would give a change that speaks of
  // our memory, not of your work.
  const bothWatched = n.watched === n.sessions && h.before.watched === h.before.sessions;
  const calls = comparable && bothWatched ? moved(n.toolCalls, h.before.toolCalls) : null;
  if (calls) shifts.push(`calls ${calls}`);
  const cost = comparable ? moved(n.costUsd, h.before.costUsd) : null;
  if (cost) shifts.push(`cost ${cost}`);
  const think = comparable ? moved(n.tokens.thinking, h.before.tokens.thinking) : null;
  if (think) shifts.push(`thinking ${think}`);
  const cacheBefore = comparable ? cacheHitOf(h.before.tokens) : null;
  if (cacheNow !== null && cacheBefore !== null && Math.abs(cacheNow - cacheBefore) >= 5) {
    shifts.push(`cache read was ${cacheBefore}%`);
  }

  const tail = shifts.length > 0 ? ` · vs previous ${days}d: ${shifts.join(', ')}` : '';
  return `- ${name} · ${bits.join(' · ')}${tail}`;
}

/**
 * A repository the CEO is allowed to open, and what to call it.
 *
 * The absolute path is here and nowhere near the browser channel: `redact.ts`
 * hashes paths on the way to the scene, and this is the other consumer of the
 * same model, with its own -- wider -- rules.
 */
export interface ProjectRoot {
  name: string;
  root: string;
}

/**
 * The repositories the CEO may read with its own tools.
 *
 * Same two filters as the brief and for the same reason: a project you disabled
 * is out of play, and being readable is a form of being in play. `exists` is
 * the second one -- a path that is no longer on disk would only buy a failed
 * read and a confused model.
 *
 * `--redact-paths` deliberately does NOT empty this list. That flag governs
 * what leaves the server for the browser; the CEO reading your code is governed
 * by `--ceo`, and silently handing it an empty perimeter would leave the
 * structural analysis answering from nothing while appearing to work.
 */
export function perimeterOf(
  snapshot: Snapshot,
  cwdOf: (projectId: string) => string | undefined,
  off: { home: string; state: string } | null = null,
): ProjectRoot[] {
  const out: ProjectRoot[] = [];
  for (const p of snapshot.projects) {
    if (p.disabled || !p.exists) continue;
    const root = cwdOf(p.id);
    if (!root) continue;
    if (off && !readableRoot(root, off)) continue;
    out.push({ name: p.name, root });
    if (out.length >= MAX_PROJECTS) break;
  }
  return out;
}

/**
 * Whether a project folder may be handed to the CEO as code to read.
 *
 * Not the home folder, nor anything that contains it: running `claude` once
 * in `~` makes `~` a project like any other, and the CEO would have been
 * given every file under it -- keys, tokens, mail -- as "code you may read".
 * Not the disk's root, and not our own state folder either.
 */
export function readableRoot(root: string, off: { home: string; state: string }): boolean {
  const r = path.resolve(root);
  const home = path.resolve(off.home);
  const state = path.resolve(off.state);
  if (r === path.parse(r).root) return false;
  if (home === r || home.startsWith(r + path.sep)) return false;
  if (r === state || r.startsWith(state + path.sep)) return false;
  return true;
}

/**
 * Whose project this is.
 *
 * A project with no declared tool belongs to EVERYONE, not to no one: on first
 * start the history is empty and no session has appeared yet, and the
 * opposite rule would leave every CEO in front of a deserted city.
 */
function belongsTo(p: ProjectInfo, provider: ProviderId): boolean {
  return p.providers.length === 0 || p.providers.includes(provider);
}

export interface BriefOptions {
  /** Who is answering: their fleet is described first. */
  provider: ProviderId;
  now: number;
  /**
   * The repositories to declare as readable.
   *
   * Empty for four of the five analyses: only the structural one is worth the
   * lines, and listing roots to a question that cannot use them is an invitation
   * to go read them anyway -- which is both slow and paid for.
   */
  perimeter?: readonly ProjectRoot[];
  /** Two periods compared. Absent when there is no history yet. */
  history?: HistoryDigest;
  /**
   * The cap in characters, from the chosen depth step.
   *
   * That is how a fast answer really costs less: the model is not asked to be
   * brief -- it is asked that too, but that is a prayer -- it is given less
   * to read. Over the cap the low-ranked sections drop out, and it is the same
   * mechanism as always with a different number.
   */
  budget?: number;
  /** How many live sessions to list. This too comes from the depth step. */
  maxSessions?: number;
  /**
   * What this CEO already knows: one line per known thing, never a text.
   *
   * It is the fifth rule, and it follows from the second. A consultant who
   * does not remember what it proposed can only start over, but remembering
   * BY PASTING -- the outcome of a measured audit weighed about five thousand
   * characters against a cap of six thousand -- would make the cost of every
   * question grow with use, which is exactly the failure this file exists to
   * prevent. A note is the headline of a known thing; the minutes live in
   * Reports.
   */
  memory?: readonly BriefNote[];
}

/** Something the CEO already knows, reduced to what goes into the brief. */
export interface BriefNote {
  kind: 'done' | 'rejected' | 'objection' | 'effect';
  project: string | null;
  text: string;
}

/** A part of the brief, with its place in the line of who drops out first. */
interface Section {
  /** The higher, the sooner it is sacrificed. Zero is never touched. */
  drop: number;
  lines: string[];
}

/**
 * The text that precedes the question.
 *
 * It holds no instructions on HOW to answer: those live in the runner's system
 * prompt, which stays byte-for-byte identical on every call because that is
 * how the prompt cache holds. Here there is only the state of the world.
 */
export function buildBrief(snapshot: Snapshot, opts: BriefOptions): string {
  const { now, provider } = opts;
  const sections: Section[] = [];
  const push = (drop: number, lines: string[]): void => {
    if (lines.length > 0) sections.push({ drop, lines: [...lines, ''] });
  };

  const projects = snapshot.projects
    .filter((p) => !p.disabled)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  const live = new Set(projects.map((p) => p.id));
  const nameOf = (id: string): string =>
    snapshot.projects.find((p) => p.id === id)?.name ?? 'unknown project';

  /**
   * The projects BOTH tools work on.
   *
   * It is the only reason the other fleet appears in the brief. Where there is
   * no overlap there is no possible collision, and describing the other tool's
   * work is a bill paid for something the answer cannot use.
   */
  const shared = projects.filter((p) => p.providers.length > 1);
  const sharedIds = new Set(shared.map((p) => p.id));
  const mineProjects = projects.filter((p) => belongsTo(p, provider));

  /* ── header and quota: never dropped ─────────────────────────────────── */
  const head = ['# World state', `Snapshot taken at ${new Date(now).toISOString()}.`, '', '## Quota'];
  if (snapshot.limits.length === 0) {
    head.push('No quota data: the status line bridge is not installed.');
  }
  for (const l of snapshot.limits) {
    // A reset window is said as such: "5h at 0%" alone would read as a
    // measurement, and the model would plan on a number nobody took.
    const windows = l.windows
      .map((w) => {
        const pct = `${w.label} at ${Math.round(windowNow(w, now).usedPercent)}%`;
        const notes = [w.model, hasReset(w, now) ? 'reset since the last reading' : null].filter(Boolean);
        return notes.length > 0 ? `${pct} (${notes.join(', ')})` : pct;
      })
      .join(', ');
    head.push(`- ${l.provider}${l.plan ? ` [${l.plan}]` : ''}: ${windows || 'no window declared'}`);
  }
  push(0, head);

  /* ── your fleet, right now ───────────────────────────────────────────── */
  const sessions = snapshot.sessions
    .filter((s) => live.has(s.projectId))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, opts.maxSessions ?? MAX_SESSIONS);
  const mine = sessions.filter((s) => s.provider === provider);
  const allMine = snapshot.sessions.filter(
    (s) => s.provider === provider && live.has(s.projectId),
  ).length;

  const fleet = [`## Your fleet (${provider}), right now`];
  if (mine.length === 0) fleet.push('No live session.');
  for (const s of mine) fleet.push(sessionLine(s, nameOf, now));
  // How many are not listed must be said: a silently truncated list reads as a
  // complete list, and the model would reason on it as such.
  if (allMine > mine.length) fleet.push(`- (${allMine - mine.length} more not listed)`);
  push(0, fleet);

  /* ── the readable code ───────────────────────────────────────────────── */
  const perimeter = opts.perimeter ?? [];
  if (perimeter.length > 0) {
    const code = [
      '## Code you may read',
      'These roots are open to your own read tools. Nothing outside them is.',
      ...perimeter.map((r) => `- ${r.name} -> ${r.root}`),
      'Read only what the question needs: every file you open is paid for.',
    ];
    push(1, code);
  }

  /* ── what you already know ───────────────────────────────────────────── */
  const notes = opts.memory ?? [];
  if (notes.length > 0) {
    const line = (n: BriefNote): string => `- ${n.project ? `[${n.project}] ` : ''}${n.text}`;
    const decided = notes.filter((n) => n.kind !== 'effect');
    const measured = notes.filter((n) => n.kind === 'effect');
    const known = ['## What you already know'];
    if (decided.length > 0) {
      known.push(
        'Decisions and outcomes from before. Do not propose again what is here:',
        'an objection from the session that works there is worth more than your',
        'own second look, because it has the context you only see as numbers.',
        ...decided.map(line),
      );
    }
    /*
     * The effect lines apart, with the one rule that matters for them.
     *
     * Mixed in with the rest, "after that work: cost per session +382%" read
     * like a fact about the project, and the CEO proposed a diagnosis of it: a
     * job to explain the aftermath of its own audit, on a number the judgement
     * had already disowned. They are about a job, and only about that job.
     */
    if (measured.length > 0) {
      known.push(
        'How projects went after jobs you proposed. Each line is about that job',
        'and nothing else, not a trend of the project: never make its numbers the',
        'premise of a new proposal. "Not mine" means the movement is explained.',
        ...measured.map(line),
      );
    }
    // Rank 1 like the perimeter: high, because it is the section that prevents
    // paying twice for the same question. It fits under the tightest cap
    // anyway -- that is why a note is a single line.
    push(1, known);
  }

  /* ── the history, already folded ─────────────────────────────────────── */
  const digest = opts.history;
  if (digest && digest.byProject.length > 0) {
    const rows = digest.byProject.filter((h) => {
      const p = snapshot.projects.find((x) => x.id === h.projectId);
      return !!p && !p.disabled && belongsTo(p, provider);
    });
    if (rows.length > 0) {
      /*
       * Each project's quota share, derived and not estimated.
       *
       * The project is worth its slice of the fleet's tokens, and the fleet is
       * worth the MEASURED percentage of the window: multiplying gives how
       * much that project weighs on the subscription rate. No price list, no
       * published token allowance -- only your own ratio between the two.
       *
       * It is a ceiling, not a measurement: the denominator only counts the
       * sessions this tool watched close, so the percentage comes out higher
       * than the truth. It has to be said in the brief, or the model would use
       * it as if it were exact.
       */
      const measured = snapshot.limits
        .find((l) => l.provider === provider)
        ?.windows.find((w) => Math.abs(w.windowMinutes - digest.days * 1440) < 60);
      const window = measured ? windowNow(measured, now) : undefined;
      const fleet = rows.reduce((sum, h) => sum + weigh(h.now.tokens), 0);
      const usable = !!window && window.usedPercent >= 2 && fleet >= 50_000;
      const shareOf = (h: ProjectHistory): string | null =>
        usable && window
          ? `<=${((weigh(h.now.tokens) / fleet) * window.usedPercent).toFixed(1)}% of ${window.label}`
          : null;

      const hist = [
        `## Last ${digest.days} days, closed sessions`,
        'Two periods compared, not a series: older work is folded into monthly totals',
        'and is not shown here. Only what moved by more than 15% is named.',
      ];
      if (usable && window) {
        hist.push(
          `Quota share is what actually costs you: your ${window.label} window reads`,
          `${Math.round(window.usedPercent)}% and these projects are what burned it. Written "<=" because`,
          'the denominator only counts sessions this tool watched close, so each share',
          'is a ceiling, not a measurement.',
        );
      }
      // The dollar figure comes from `totalCostUSD`, which Claude Code computes
      // from the API price list. On a subscription you do not pay per token:
      // it is an EQUIVALENT, not an amount charged.
      hist.push(
        'Dollar figures are list-price equivalents declared by the tool, useful only',
        'to compare weight between projects.',
        ...rows.map((h) => historyLine(h, nameOf(h.projectId), digest.days, shareOf(h))),
      );
      push(2, hist);
    }
  }

  /* ── your projects ───────────────────────────────────────────────────── */
  const shown = mineProjects.slice(0, MAX_PROJECTS);
  const list = [`## Your projects (${mineProjects.length})`];
  // The note that makes the `+` readable, as for the dollars in the history
  // section: it is said once, and holds for every line below.
  if (shown.some((p) => p.commits > 0)) {
    list.push(
      'Commit counts are floors: only the tail of each reflog is read, so "20+" can',
      'be seventy. Never hand a commit count to a worker as if it were the total.',
    );
  }
  for (const p of shown) list.push(projectLine(p, now));
  if (mineProjects.length > shown.length) {
    list.push(`- (${mineProjects.length - shown.length} more not listed)`);
  }
  const disabled = snapshot.projects.length - projects.length;
  if (disabled > 0) {
    list.push(`${disabled} projects are DISABLED and deliberately left out of this snapshot:`);
    list.push('the user has ruled them out of play. Propose nothing that touches them.');
  }
  push(3, list);

  /* ── the other fleet, only where it meets yours ──────────────────────── */
  const others = sessions.filter((s) => s.provider !== provider && sharedIds.has(s.projectId));
  if (shared.length === 0) {
    push(4, [
      '## The other fleet',
      'No project here is worked on by both tools, so there is nothing shared to',
      'reason about. Answer for your own fleet only.',
    ]);
  } else {
    const both = [
      `## Shared with the other fleet (${shared.length} projects)`,
      ...shared.map((p) => `- ${p.name} · worked on by ${p.providers.join(' and ')}`),
    ];
    if (others.length > 0) {
      both.push('Live sessions of the other tool on those projects:');
      for (const s of others) both.push(sessionLine(s, nameOf, now));
    }
    both.push('(You can see them, but you may not act on another tool sessions.)');
    push(4, both);
  }

  /* ── files under stress ──────────────────────────────────────────────── */
  const files = snapshot.files
    .filter((f) => live.has(f.projectId))
    .sort((a, b) => b.churn - a.churn)
    .slice(0, MAX_FILES)
    .filter((f) => f.churn > 1);
  if (files.length > 0) {
    push(5, [
      '## Most touched files',
      ...files.map((f) => `- ${nameOf(f.projectId)}/${f.path} · ${f.reads} reads, ${f.writes} writes`),
    ]);
  }

  /* ── agents ──────────────────────────────────────────────────────────── */
  const agents = snapshot.agents.filter((a) => live.has(a.projectId));
  if (agents.length > 0) {
    const skills = agents.filter((a) => a.kind === 'skill').length;
    push(6, [`## Agents at work: ${agents.length} (${skills} skills, ${agents.length - skills} subagents)`]);
  }

  return assemble(sections, opts.budget ?? MAX_BRIEF_CHARS);
}

/**
 * From the sections to the text, within the budget.
 *
 * Sections are sacrificed by rank, never truncated halfway: a brief cut at
 * the last available character ends with half a line of data, which is worse
 * than a missing section -- the model has no way of knowing that the number
 * it reads is maimed. What dropped out is said, or the absence is mistaken for
 * a zero.
 */
function assemble(sections: Section[], budget: number): string {
  const size = (list: Section[]): number =>
    list.reduce((n, s) => n + s.lines.join('\n').length + 1, 0);

  const kept = [...sections];
  const dropped: number[] = [];
  while (size(kept) > budget) {
    let worst = -1;
    for (let i = 0; i < kept.length; i++) {
      if (kept[i]!.drop === 0) continue;
      if (worst < 0 || kept[i]!.drop > kept[worst]!.drop) worst = i;
    }
    if (worst < 0) break; // only untouchable sections are left: go over and say so
    dropped.push(kept[worst]!.drop);
    kept.splice(worst, 1);
  }

  const out = kept.flatMap((s) => s.lines);
  if (dropped.length > 0) {
    out.push(`(${dropped.length} sections left out to stay inside the brief budget.)`);
  }
  return out.join('\n');
}
