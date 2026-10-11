import * as path from 'node:path';

/**
 * The single gate on EVERY open() of the server.
 *
 * It is an ALLOW-LIST, not a deny-list: a file introduced by a future version
 * of Claude Code is excluded by default instead of included by oversight.
 * Every admitted path is below, with its reason.
 */

const RE_REGISTRY = /^\d+\.json$/;
const RE_TRANSCRIPT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

export class PathDenied extends Error {
  readonly target: string;
  constructor(target: string, reason: string) {
    super(`read denied: ${target} (${reason})`);
    this.name = 'PathDenied';
    this.target = target;
  }
}

export interface PathPolicy {
  claudeDir: string;
  codexDir: string;
  homeDir: string;
}

/** The path's segments, normalized and with no climbing up. */
function segmentsUnder(root: string, abs: string): string[] | null {
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return parts;
}

function isAllowedClaudePath(parts: string[]): boolean {
  const [head, ...rest] = parts;

  // ~/.claude/sessions/<pid>.json  -> registry of the live sessions.
  // The <pid>.<sha>.key files are excluded BY CONSTRUCTION by the regex, not by an endsWith.
  if (head === 'sessions') return rest.length === 1 && RE_REGISTRY.test(rest[0]!);

  // <slug>/<sessionId>.jsonl -> main transcript. Only that: the subagents'
  // transcripts and the tool outputs offloaded beside it were listed here once,
  // and no code ever opened them. A list wider than what is read is a promise
  // nobody keeps.
  if (head === 'projects') return rest.length === 2 && RE_TRANSCRIPT.test(rest[1]!);

  // Everything else in ~/.claude is out: history.jsonl, plans/, memory/,
  // session-env/, shell-snapshots/, debug/, backups/, cache/, file-history/.
  return false;
}

/* ───────────────────────── Codex ───────────────────────── */

const RE_ROLLOUT = /^rollout-[0-9T:-]+-[0-9a-f-]{16,}\.jsonl$/i;
const RE_DATE_PART = /^\d{2,4}$/;

/**
 * Codex's allow-list, with the same criterion used for Claude Code: it lists
 * what can be opened, not what must be avoided.
 *
 * Deliberately left out:
 *  - `auth.json`      credentials
 *  - `history.jsonl`  global user prompts
 *  - `queue_1.sqlite` payloads of queued messages, i.e. the user's text
 *  - `memories_1.sqlite`, `goals_1.sqlite`  persisted content
 *  - `shell_snapshots/`, `log/`, `.tmp/`, `packages/`, `plugins/`
 */
function isAllowedCodexPath(parts: string[]): boolean {
  const [head, ...rest] = parts;
  if (head === undefined) return false;

  // The logs from which the PID for liveness is derived. The thread registry
  // (`state_5.sqlite`) and the decoded items (`thread_history_1.sqlite`) were
  // on this list too, and nothing read them: the rollouts say it all.
  if (rest.length === 0) {
    return (
      head === 'logs_2.sqlite' ||
      head === 'config.toml' ||
      head === 'session_index.jsonl'
    );
  }

  // sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
  if (head === 'sessions') {
    return (
      rest.length === 4 &&
      rest.slice(0, 3).every((seg) => RE_DATE_PART.test(seg)) &&
      RE_ROLLOUT.test(rest[3]!)
    );
  }

  // NOTHING is read from the `app-server` daemon, and that is a measured
  // conclusion, not a precaution: a TUI session started three hours after the
  // daemon did not have a single socket with a name on the filesystem, only
  // anonymous socketpairs, and only the daemon itself turned out to be
  // connected to the control socket. The TUI carries its own app-server
  // inside the process, so the daemon knows nothing about the sessions we
  // want to watch. Granting a path that isn't needed is surface given away.
  // (Incidentally, the path we were looking for didn't even exist: in 0.153.4
  // it is `app-server-control/app-server-control.sock`, not `app-server-daemon/`.)
  return false;
}

/**
 * True only for the two readable git files, under any project directory.
 * Explicitly excluded: .git/config (remote URLs, sometimes credentials),
 * .git/objects/ and .git/COMMIT_EDITMSG (the full message, not just the subject).
 */
function isAllowedGitPath(abs: string): boolean {
  const parts = abs.split(path.sep);
  const i = parts.lastIndexOf('.git');
  if (i < 0) return false;
  const tail = parts.slice(i + 1);
  if (tail.length === 1 && tail[0] === 'HEAD') return true;
  if (tail.length === 2 && tail[0] === 'logs' && tail[1] === 'HEAD') return true;
  return false;
}

/** Returns the normalized path if admitted, otherwise throws PathDenied. */
export function assertReadable(target: string, policy: PathPolicy): string {
  const abs = path.resolve(target);

  const claudeParts = segmentsUnder(policy.claudeDir, abs);
  if (claudeParts) {
    if (isAllowedClaudePath(claudeParts)) return abs;
    throw new PathDenied(abs, 'outside the ~/.claude allow-list');
  }

  const codexParts = segmentsUnder(policy.codexDir, abs);
  if (codexParts) {
    if (isAllowedCodexPath(codexParts)) return abs;
    throw new PathDenied(abs, 'outside the ~/.codex allow-list');
  }

  // ~/.claude.json: the only admitted read, and the dedicated parser extracts
  // ONLY the `projects` keys from it, dropping oauthAccount/userID/machineID.
  if (abs === path.join(policy.homeDir, '.claude.json')) return abs;

  if (isAllowedGitPath(abs)) return abs;

  throw new PathDenied(abs, 'path not covered by the allow-list');
}

/** Non-throwing variant, for the discovery loops. */
export function isReadable(target: string, policy: PathPolicy): boolean {
  try {
    assertReadable(target, policy);
    return true;
  } catch {
    return false;
  }
}

/** A project's directory slug: forward-only, NOT invertible. */
export function slugFor(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}
