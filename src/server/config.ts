import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type { AnalysisOffer, Caps, ProviderId } from '../shared/protocol.ts';

export const DEFAULT_PORT = 7317;

/** The state directory under home. */
export const STATE_DIR_NAME = '.towerglow';

/** One of our environment variables: `TOWERGLOW_<name>`. */
export function envOf(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`TOWERGLOW_${name}`];
}

export interface Config {
  readonly port: number;
  readonly claudeDir: string;
  readonly codexDir: string;
  readonly homeDir: string;
  readonly stateDir: string;
  readonly token: string;
  readonly warmupBytes: number;
  readonly dev: boolean;
  readonly quiet: boolean;
  // privacy
  readonly redactPaths: boolean;
  readonly commitText: boolean;
  readonly titles: boolean;
  /** The summary the session writes about itself. Off with --no-recap and with --redact-paths. */
  readonly recap: boolean;
  readonly cmdNames: boolean;
  /** Bringing a session's terminal to the front: only doable on macOS. */
  readonly focus: boolean;
  /** A desktop notice when the plan stops: macOS only, off with --no-notify. */
  readonly notify: boolean;
  readonly exclude: readonly string[];
  // organization
  readonly ceo: boolean;
  readonly ceoModel: string;
  /** Codex's model. `null` = the one Codex uses on its own. */
  readonly ceoCodexModel: string | null;
  readonly ceoBudgetUsd: number;
  /** Quota percentage above which the CEO does not start. The real cap on a subscription. */
  readonly ceoQuotaMaxPercent: number;
  /** Cap on a single call: it covers the call that runs away, not the day's spending. */
  readonly ceoMaxCallUsd: number;
  readonly ceoEveryMs: number | null;
  readonly execute: boolean;
  /** Which tools to watch. One that is not installed is skipped silently. */
  readonly providers: readonly ProviderId[];
}

export interface RawOptions {
  port?: string | undefined;
  'state-dir'?: string | undefined;
  'claude-dir'?: string | undefined;
  'codex-dir'?: string | undefined;
  providers?: string | undefined;
  'warmup-bytes'?: string | undefined;
  dev?: boolean | undefined;
  quiet?: boolean | undefined;
  'redact-paths'?: boolean | undefined;
  'no-commit-text'?: boolean | undefined;
  'no-titles'?: boolean | undefined;
  'no-recap'?: boolean | undefined;
  'no-cmd-names'?: boolean | undefined;
  'no-focus'?: boolean | undefined;
  'no-notify'?: boolean | undefined;
  exclude?: string[] | undefined;
  ceo?: boolean | undefined;
  'no-ceo'?: boolean | undefined;
  'ceo-model'?: string | undefined;
  'ceo-codex-model'?: string | undefined;
  'ceo-budget'?: string | undefined;
  'ceo-quota-max'?: string | undefined;
  'ceo-max-call'?: string | undefined;
  'ceo-every'?: string | undefined;
  'no-execute'?: boolean | undefined;
}

export class ConfigError extends Error {}

function intOpt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name} must be an integer >= 0, got "${value}"`);
  return n;
}

/** Accepts 30s, 15m, 2h. Returns milliseconds. */
export function parseDuration(value: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(value.trim());
  if (!m) throw new ConfigError(`invalid duration: "${value}" (use 30s, 15m, 2h)`);
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
  return n * mult;
}

/** Whether a directory belongs to our own state, the CEOs' working folders included. */
export function isOwnState(cwd: string, cfg: Pick<Config, 'stateDir'>): boolean {
  const abs = path.resolve(cwd);
  const home = path.resolve(cfg.stateDir);
  return abs === home || abs.startsWith(home + path.sep);
}

/** The token lives in ~/.towerglow, NEVER in ~/.claude, which stays read-only. */
function loadOrCreateToken(stateDir: string): string {
  const file = path.join(stateDir, 'token');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  keepPrivate(stateDir);
  try {
    const st = fs.lstatSync(file);
    if (st.isFile() && ownedPrivately(st)) {
      const existing = fs.readFileSync(file, 'utf8').trim();
      if (existing.length >= 24) return existing;
    }
  } catch {
    // does not exist yet: we create it below
  }
  /*
   * A token is kept only if nobody else could have read or written it: a
   * regular file, ours, with no group or other bits. Under a --state-dir in a
   * shared place another user could have planted one they know, or a link.
   * The old one goes -- a link is removed, never followed -- and the new one
   * is created exclusively, so it cannot land on a file someone else made.
   */
  try {
    fs.unlinkSync(file);
  } catch {
    // nothing there
  }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(file, token + '\n', { mode: 0o600, flag: 'wx' });
  return token;
}

/** Ours, and readable by nobody else. Where there are no uids (Windows) only the bits count. */
function ownedPrivately(st: fs.Stats): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return (uid === null || st.uid === uid) && (st.mode & 0o077) === 0;
}

/**
 * The state folder, private to you. `mkdir` sets the mode only when it creates
 * the folder: one that already existed open to others is closed here, and one
 * that belongs to someone else is refused -- its owner could read the token.
 */
function keepPrivate(stateDir: string): void {
  const st = fs.statSync(stateDir);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && st.uid !== uid) {
    throw new ConfigError(`${stateDir} belongs to another user: choose a state folder of your own (--state-dir)`);
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(stateDir, 0o700);
}

export function buildConfig(raw: RawOptions): Config {
  const homeDir = os.homedir();
  /*
   * The state sits NEXT TO home, but it is not home.
   *
   * They must be separate because several copies are derived from a single
   * tree -- a passive one, one with the CEOs, one where something is being
   * tried -- and two copies sharing `~/.towerglow` trample each other's
   * `layout.json`: the geography is frozen by slot, and whoever rewrites the
   * file moves the city for the other one too. Same story for the job ledger
   * and for spending, which would end up summed across two different projects.
   *
   * Moving HOME would not have helped: ~/.claude and ~/.codex are also derived
   * from homeDir, that is, the sessions to WATCH. A copy with HOME moved would
   * have its own state and no city to show.
   */
  const stateOpt = raw['state-dir'] ?? envOf('STATE_DIR');
  const stateDir = stateOpt ? path.resolve(stateOpt) : path.join(homeDir, STATE_DIR_NAME);

  const port = intOpt(raw.port ?? envOf('PORT'), '--port', DEFAULT_PORT);
  if (port !== 0 && (port < 1 || port > 65535)) throw new ConfigError(`port out of range: ${port}`);

  const ceoEveryMs = raw['ceo-every'] ? parseDuration(raw['ceo-every']) : null;
  // The scheduler's beat. Under ten seconds it would read the registry more
  // often than the registry is read, for no launch it could not make later.
  if (ceoEveryMs !== null && ceoEveryMs < 10_000) {
    throw new ConfigError(`--ceo-every must be at least 10s, got "${raw['ceo-every']}"`);
  }
  /*
   * The secondary brake, in currency, for those who pay per token: on a
   * subscription the real cap is the quota below.
   *
   * Ten and not two, and the number comes from a measured day: on September
   * 14, 2026 four analyses consumed $1.60 and at that point NOTHING started
   * any more -- not even a seven-cent analysis -- because with the budget at
   * two there was no room left to reserve a whole call. A cap that closes
   * after four questions does not brake usage: it prevents it, and whoever
   * hits it raises it without looking, which is how you lose a brake.
   *
   * Ten dollars are, at the measured rates, about a hundred and forty analyses
   * or two reviews on large sessions: a full day of real work before having
   * to decide anything.
   */
  const ceoBudgetUsd = raw['ceo-budget'] ? Number(raw['ceo-budget']) : 10;
  if (!Number.isFinite(ceoBudgetUsd) || ceoBudgetUsd <= 0) {
    throw new ConfigError(`--ceo-budget must be a positive number, got "${raw['ceo-budget']}"`);
  }

  /*
   * The cap that really matters on a subscription plan, where you don't pay
   * per token but burn through the 5h and 7d windows.
   *
   * Eighty-five and not sixty, and the number comes from a measurement: a real
   * user's weekly window stood at 64% under entirely normal use. With a cap
   * at 60% the CEO would have refused to start for most of the week, and a
   * gate that always trips does not protect: people just raise it. The job
   * is to stop it when you are close to the wall, not to keep it off.
   */
  const ceoQuotaMaxPercent = raw['ceo-quota-max'] ? Number(raw['ceo-quota-max']) : 85;
  if (!Number.isFinite(ceoQuotaMaxPercent) || ceoQuotaMaxPercent <= 0 || ceoQuotaMaxPercent > 100) {
    throw new ConfigError(`--ceo-quota-max must be between 1 and 100, got "${raw['ceo-quota-max']}"`);
  }

  /*
   * The cap on a single call: the one that runs away, not the day's spending.
   *
   * Measured: a trivial question to `claude -p` already costs four to five
   * cents of preamble alone, a real analysis seven, and the most expensive
   * answer seen in a day of work eighty-five cents. Two dollars is headroom
   * for the longest of those and still tight enough to stop mid-flight a call
   * that never ends -- which is this number's job, not preventing the
   * expected spending.
   *
   * It was one dollar. The planning meeting went over it twice in a row
   * (1.13 and 1.07) with 2890 characters of to-dos across all projects: the
   * chair reads each one's code before asking questions, and that work is the
   * meeting, not a runaway call. It was worth <=1.2% of the 5h.
   *
   * The second opinion can cost more: a fork starts at one dollar and climbs
   * with the megabytes of the resumed transcript. This number is not raised to
   * cover it -- that would switch off the brake on normal calls, which are
   * ninety-nine percent -- and it does not apply to it anyway: the review runs
   * in the fleet, held by the reserve. It never starts by surprise: only when
   * you accept a proposal, and in a fresh session when there is none to resume.
   *
   * The default is LOWERED to the budget when the budget is smaller. Without
   * that, `--ceo-budget 0.40` produced a CEO blocked forever: the ledger
   * refused to start because there was no room left for a whole call, and the
   * reason was correct but the situation absurd. A default that contradicts a
   * value you wrote yourself is not a default, it is a bug.
   */
  const maxCallGiven = raw['ceo-max-call'] !== undefined;
  const ceoMaxCallUsd = maxCallGiven ? Number(raw['ceo-max-call']) : Math.min(2, ceoBudgetUsd);
  if (!Number.isFinite(ceoMaxCallUsd) || ceoMaxCallUsd <= 0) {
    throw new ConfigError(`--ceo-max-call must be a positive number, got "${raw['ceo-max-call']}"`);
  }
  // If you wrote both yourself and they don't add up, better to say so than
  // to quietly fix it.
  if (maxCallGiven && ceoMaxCallUsd > ceoBudgetUsd) {
    throw new ConfigError(
      `--ceo-max-call (${ceoMaxCallUsd}) cannot exceed --ceo-budget (${ceoBudgetUsd}): the CEO would never start`,
    );
  }

  return {
    port,
    claudeDir: raw['claude-dir'] ? path.resolve(raw['claude-dir']) : path.join(homeDir, '.claude'),
    codexDir: raw['codex-dir'] ? path.resolve(raw['codex-dir']) : path.join(homeDir, '.codex'),
    homeDir,
    stateDir,
    token: loadOrCreateToken(stateDir),
    warmupBytes: intOpt(raw['warmup-bytes'], '--warmup-bytes', 8 * 1024 * 1024),
    dev: raw.dev === true,
    quiet: raw.quiet === true,
    redactPaths: raw['redact-paths'] === true,
    commitText: raw['no-commit-text'] !== true,
    titles: raw['no-titles'] !== true,
    // Whoever asked to hide paths must not find them again inside a
    // paragraph: the recap names them in full, and it is not hashable like a
    // path. Under --redact-paths it turns itself off, without requiring two
    // flags for a single intention.
    recap: raw['no-recap'] !== true && raw['redact-paths'] !== true,
    cmdNames: raw['no-cmd-names'] !== true,
    // Outside macOS there is nothing to switch on: the capability stays off
    // instead of being promised and then failing at every click.
    focus: raw['no-focus'] !== true && process.platform === 'darwin',
    notify: raw['no-notify'] !== true && process.platform === 'darwin',
    exclude: raw.exclude ?? [],
    // Off by default (the user's call, 2026-10-08, reversing the one of
    // 2026-09-24): a plain `start` is the observatory alone, fully offline,
    // and the CEOs come only when asked for with --ceo. `--no-ceo` stays
    // accepted and wins over --ceo, so an old command line keeps meaning what
    // it meant. Without the module on disk the desk fails to load and the
    // world runs without it.
    ceo: raw.ceo === true && raw['no-ceo'] !== true,
    ceoModel: raw['ceo-model'] ?? 'sonnet',
    ceoCodexModel: raw['ceo-codex-model'] ?? null,
    ceoBudgetUsd,
    ceoQuotaMaxPercent,
    ceoMaxCallUsd,
    ceoEveryMs,
    // On by default: whoever starts with the CEOs has already chosen the CEOs,
    // and a proposal you accept that then doesn't start is a trap, not a
    // precaution. The gate does not disappear -- it stays in ceo/fleet.ts, and
    // it stays the server's -- but it stops being a second choice to remember.
    // Whoever wants only advice switches it off with --no-execute.
    execute: raw['no-execute'] !== true,
    providers: parseProviders(raw.providers),
  };
}

const ALL_PROVIDERS: readonly ProviderId[] = ['claude', 'codex'];

function parseProviders(value: string | undefined): readonly ProviderId[] {
  if (!value) return ALL_PROVIDERS;
  const wanted = value.split(',').map((v) => v.trim()).filter((v) => v.length > 0);
  for (const w of wanted) {
    if (!ALL_PROVIDERS.includes(w as ProviderId)) {
      throw new ConfigError(`--providers accepts ${ALL_PROVIDERS.join(', ')}; got "${w}"`);
    }
  }
  return wanted as ProviderId[];
}

export function capsOf(
  cfg: Config,
  statuslineInstalled: boolean,
  ceoProviders: readonly ProviderId[] = [],
  analyses: readonly AnalysisOffer[] = [],
  plan = false,
): Caps {
  return {
    statusline: statuslineInstalled,
    ceo: cfg.ceo,
    ceoProviders,
    analyses,
    // Only with the desk loaded: the panel that would use it does not exist
    // otherwise, and the passive build must answer false without knowing why.
    plan,
    execute: cfg.execute,
    redactPaths: cfg.redactPaths,
    commitText: cfg.commitText,
    titles: cfg.titles,
    recap: cfg.recap,
    cmdNames: cfg.cmdNames,
    focus: cfg.focus,
  };
}
