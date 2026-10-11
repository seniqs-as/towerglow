import type { GitRules } from '../../shared/protocol.ts';
import { MAX_COMMAND_CHARS, MAX_PROJECT_COMMANDS } from '../../shared/protocol.ts';

/**
 * From what a worker may do to the flags that make it so.
 *
 * `acceptEdits` accepts writes; everything else is decided by the permission
 * rules of the installation, and where there are none the worker acts --
 * measured on a real audit: twelve Bash commands with no allow-list behind
 * them. So the plan's rules become an explicit allow-list AND an explicit
 * deny-list: the deny holds even where the installation would have said yes,
 * and with `--permission-prompts none` anything not allowed fails at once
 * instead of waiting for a prompt nobody will answer.
 *
 * The tests always run (decision of the user, 2026-09-19). The common
 * runners are allowed everywhere; what a project runs besides them is its
 * list of commands in the plan. That list is not a sandbox: a worker that
 * may run `php tests/*` may write a file there and run it, exactly as one
 * that may run `npm test` may edit `package.json`. So the list decides what
 * may START, and the OS sandbox (`sandboxFor`) decides what it can REACH:
 * the git deny-list alone stopped only `git push` typed as such, and an
 * `npm run` with a push inside went through it.
 *
 * Codex has no per-command rule. Its sandbox has no network unless told, so
 * "no push" is enforced by the sandbox; "no commit" only by the prompt, and
 * that is said where the rules are shown.
 */

/**
 * The test runners and syntax checks a worker may invoke in any project.
 *
 * `php -l` and `node --check` joined the list after decsim2 and
 * visibilitycheck: PHP projects with no runner here, whose workers could not
 * even lint the files they had edited.
 */
export const TEST_COMMANDS: readonly string[] = [
  'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(npx:*)', 'Bash(node --test:*)',
  'Bash(node --check:*)', 'Bash(php -l:*)', 'Bash(composer test:*)', 'Bash(vendor/bin/phpunit:*)',
  'Bash(pytest:*)', 'Bash(python -m pytest:*)', 'Bash(cargo test:*)', 'Bash(go test:*)',
  'Bash(make test:*)',
];

/**
 * Reading the repository state is never the risk, so it is always allowed: an
 * audit with commits off must still be able to count them -- the CEO once
 * proposed "review 20 commits" on a repo with 72, and `git log` refuted it.
 */
const GIT_READ: readonly string[] = ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)'];
/** Pulling changes the working tree: it goes with commits. */
const GIT_PULL: readonly string[] = ['Bash(git pull:*)'];
const GIT_COMMIT: readonly string[] = ['Bash(git add:*)', 'Bash(git commit:*)'];
const GIT_PUSH: readonly string[] = ['Bash(git push:*)'];

/**
 * Programs a project command may never start with. Git has its own rules
 * (the commit and push boxes); the others delete, escalate or reach the
 * network, and none of them runs a test.
 */
const NEVER: ReadonlySet<string> = new Set([
  'git', 'sudo', 'su', 'rm', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'gh', 'eval', 'exec',
]);
/** Flags that turn an interpreter into "run this string": `node -e *` is any program. */
const INLINE: ReadonlySet<string> = new Set([
  '-e', '-c', '-r', '-p', '--eval', '--print', '--command',
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;

/**
 * Why a command cannot be a project's test command, or null when it can.
 *
 * The pattern is Claude Code's: an exact command, or a prefix followed by a
 * `*` (`php tests/*`). Refused: shell operators and parentheses (a rule is
 * matched per command, and a paren would end the `Bash(...)` it goes into),
 * a program followed by nothing but a wildcard (`php *` is every PHP
 * program), inline code, and the programs in `NEVER`.
 */
export function commandProblem(raw: string): string | null {
  const text = unwrap(raw);
  if (!text) return 'an empty command';
  if (text.length > MAX_COMMAND_CHARS) return `${text.length} chars, the cap is ${MAX_COMMAND_CHARS}`;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(text)) return 'a control character';
  if (/[;&|<>`()]|\$\(/.test(text)) return 'one command only: no pipes, redirects, subshells or parentheses';
  const words = text.split(' ');
  let i = 0;
  while (i < words.length && ASSIGNMENT.test(words[i]!)) i += 1;
  const program = words[i];
  if (!program) return 'no program to run';
  if (program.endsWith(':*')) return `${program.slice(0, -2)} followed by a wildcard is any command`;
  if (program.includes('*')) return 'the program itself cannot be a wildcard';
  if (NEVER.has(program)) {
    return program === 'git' ? 'git follows the commit and push boxes' : `${program} does not run tests`;
  }
  const args = words.slice(i + 1);
  if (args.length > 0 && args.every((w) => /^[*:]+$/.test(w))) return `${program} followed by a wildcard is any command`;
  if (args.length > 0 && INLINE.has(args[0]!)) return `${program} ${args[0]} runs inline code`;
  return null;
}

/** The command as it is stored: one line, single spaces, no `Bash(...)` around it. */
function unwrap(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  const wrapped = /^Bash\((.*)\)$/.exec(text);
  if (wrapped) text = wrapped[1]!.trim();
  if (text.startsWith('`') && text.endsWith('`') && text.length > 1) text = text.slice(1, -1).trim();
  return text;
}

/** A command as stored, or null when it is refused. */
export function commandPattern(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return commandProblem(raw) === null ? unwrap(raw) : null;
}

/** A list from a model or a file: the valid ones, once each, up to the cap. */
export function commandsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return mergeCommands([], raw.map(commandPattern).filter((c): c is string => c !== null));
}

/** `base` first, then what is new in `more`, up to the cap: an addition never reorders. */
export function mergeCommands(base: readonly string[], more: readonly string[]): string[] {
  const out = [...base];
  for (const c of more) {
    if (out.length >= MAX_PROJECT_COMMANDS) break;
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

export function allowedToolsFor(rules: GitRules, commands: readonly string[] = []): string[] {
  const out: string[] = [...TEST_COMMANDS, ...GIT_READ];
  for (const c of commands) out.push(`Bash(${c})`);
  if (rules.commit) out.push(...GIT_PULL, ...GIT_COMMIT);
  if (rules.push) out.push(...GIT_PUSH);
  return out;
}

export function disallowedToolsFor(rules: GitRules): string[] {
  const out: string[] = [];
  if (!rules.push) out.push(...GIT_PUSH);
  if (!rules.commit) out.push(...GIT_COMMIT);
  return out;
}

/**
 * Where credentials and other people's work live: no worker reads them, by
 * shell or by the Read tool. Your other sessions' transcripts are on the
 * list too -- everything you did elsewhere is in them.
 */
export const SECRET_PATHS: readonly string[] = [
  '~/.ssh', '~/.aws', '~/.gnupg', '~/.config/gh', '~/.netrc', '~/.docker', '~/.kube',
  '~/.towerglow', '~/.codex', '~/.claude/projects', '~/.claude.json',
];

/**
 * The Claude worker's OS sandbox, passed with `--settings` (Claude Code's
 * Seatbelt on macOS, bubblewrap on Linux).
 *
 * The allow-list alone was a fence, not a boundary: `npm run`, `npx` and the
 * test runners run whatever a worker that can edit `package.json` or a
 * Makefile writes, so an injected worker could push with push unticked. In
 * the sandbox its shell writes only inside the project and reaches no host:
 *
 * - `failIfUnavailable`: no sandbox, no worker. Claude Code otherwise runs
 *   the commands unsandboxed, silently.
 * - `allowUnsandboxedCommands: false`: the model cannot ask to retry outside,
 *   and a repository's own `.claude/settings` cannot open exclusions.
 * - `autoAllowBashIfSandboxed: false`: a sandboxed command is approved by
 *   default, which would have turned the allow-list into "anything"; off, the
 *   list stays the gate.
 * - With push ticked, `git push` and `git pull` run outside: against an SSH
 *   remote they fail inside on macOS whatever the allowed hosts. They reach
 *   any host they are pointed at -- the documented cost of an exclusion.
 */
export function sandboxFor(rules: GitRules): { sandbox: Record<string, unknown> } {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      ...(rules.push ? { excludedCommands: ['git push', 'git push *', 'git pull', 'git pull *'] } : {}),
      network: { strictAllowlist: true },
      filesystem: { denyRead: [...SECRET_PATHS] },
    },
  };
}

/**
 * What a sandboxed worker is denied besides git: the tools that live outside
 * the sandbox. The web tools would be a way out to the network, and Read
 * would reach the files the shell may not.
 */
export const OUTSIDE_SANDBOX_DENIED: readonly string[] = [
  'WebFetch', 'WebSearch',
  ...SECRET_PATHS.map((p) => `Read(${p.endsWith('.json') ? p : `${p}/**`})`),
];

/** The Codex sandbox for these rules: writes stay in the workspace, the network opens only for a push. */
export function codexSandboxFor(rules: GitRules): string[] {
  const out = ['-s', 'workspace-write'];
  if (rules.push) out.push('-c', 'sandbox_workspace_write.network_access=true');
  return out;
}

/** The same sandbox, for `codex exec resume`, which takes no `-s`. */
export function codexResumeSandboxFor(rules: GitRules): string[] {
  const out = ['-c', 'sandbox_mode="workspace-write"'];
  if (rules.push) out.push('-c', 'sandbox_workspace_write.network_access=true');
  return out;
}
