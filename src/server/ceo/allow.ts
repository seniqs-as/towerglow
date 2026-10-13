import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GitRules } from '../../shared/protocol.ts';
import { MAX_COMMAND_CHARS, MAX_PROJECT_COMMANDS } from '../../shared/protocol.ts';
import { slugFor } from '../paths.ts';

/**
 * From what a worker may do to the flags that make it so.
 *
 * The boundary is the OS sandbox (`sandboxFor`), and inside it the shell
 * runs without asking (decision of the user, 2026-10-13: "give them the
 * permissions automatically, once and for all"). Until that day a list of
 * commands was the gate as well, and nobody was there to open it: measured
 * on one approved plan, seven workers were refused 52 commands -- a `grep`
 * piped into `cut`, an `awk`, a `mkdir`, the project's own
 * `php tests/x.php` -- and four attempts stopped to ask. One asked for
 * `php tests/*` in words, was answered "ok" in words, and resumed into the
 * same refusal. The list never was the boundary: a worker that may run
 * `npm test` may edit `package.json`. What a command can REACH is what the
 * sandbox decides, whatever it is called.
 *
 * Two things still go through rules, with `--permission-prompts none` so
 * that a refusal is immediate instead of a prompt nobody answers:
 *
 * - the deny-list: the git boxes you left unticked, and the tools that live
 *   outside the sandbox. A deny holds over the automatic yes.
 * - the allow-list: the commands that run OUTSIDE the sandbox, which the
 *   automatic yes does not cover. With push ticked they are git's three
 *   network commands. The runners and the project's commands stay on it for
 *   the few sandboxed calls that are not approved by themselves (a command
 *   started through Monitor, a `make VAR=x`).
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
/**
 * Pulling changes the working tree: it goes with commits. `git fetch` is the
 * same reach with less effect, and it was missing: the workers that tried it
 * to see why a pull had failed were refused.
 */
const GIT_PULL: readonly string[] = ['Bash(git pull:*)', 'Bash(git fetch:*)'];
const GIT_COMMIT: readonly string[] = ['Bash(git add:*)', 'Bash(git commit:*)'];
const GIT_PUSH: readonly string[] = ['Bash(git push:*)'];
/**
 * What commit off denies besides committing. In a folder that is not under
 * git there is no `.git` for the sandbox to close, and `git init` would make
 * one where you chose to have none.
 */
const GIT_NO_COMMIT: readonly string[] = [...GIT_COMMIT, 'Bash(git init:*)'];

/**
 * Git's network commands, as the sandbox's exclusions: with push ticked they
 * run outside it, because against an SSH remote they fail inside on macOS
 * whatever the allowed hosts.
 *
 * An exclusion holds only when EVERY command of the call matches one, and
 * never with a `cd`, a `git -C` or a redirect to a file. Measured on the plan
 * of 2026-10-13: `git push 2>&1 | tail -2` and `git add -A && git commit &&
 * git push` stayed inside and failed with "Please make sure you have the
 * correct access rights", while `git push origin main` alone went through --
 * six tasks ended with their commits made and the push left to the user, and
 * the remote was fine. So the worker is told to run them alone
 * (`gitNetworkRule`).
 */
export const GIT_NETWORK: readonly string[] = [
  'git fetch', 'git fetch *', 'git pull', 'git pull *', 'git push', 'git push *',
];

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

/**
 * Claude Code's two web tools. They are the model's way to the web and not
 * the shell's: a bare `WebFetch` allow leaves the hosts a sandboxed command
 * can reach as they were (Claude Code's own rule, and tried on the real
 * `claude` on 2026-10-13: with both tools allowed a page was fetched and a
 * search answered, and `curl` from the shell still got the sandbox's 403).
 */
const WEB_TOOLS: readonly string[] = ['WebFetch', 'WebSearch'];

export function allowedToolsFor(rules: GitRules, commands: readonly string[] = []): string[] {
  const out: string[] = [...TEST_COMMANDS, ...GIT_READ];
  for (const c of commands) out.push(`Bash(${c})`);
  if (rules.commit) out.push(...GIT_PULL, ...GIT_COMMIT);
  if (rules.push) out.push(...GIT_PUSH);
  // Outside the sandbox nothing is approved by itself: the web tools need their rule.
  if (rules.web) out.push(...WEB_TOOLS);
  return out;
}

export function disallowedToolsFor(rules: GitRules): string[] {
  const out: string[] = [];
  if (!rules.push) out.push(...GIT_PUSH);
  if (!rules.commit) out.push(...GIT_NO_COMMIT);
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
 * In the sandbox a worker's shell writes only inside the project and its
 * temp folder, reaches no host and reads no credential, whatever the command
 * is called and whatever starts it:
 *
 * - `failIfUnavailable`: no sandbox, no worker. Claude Code otherwise runs
 *   the commands unsandboxed, silently.
 * - `allowUnsandboxedCommands: false`: the model cannot ask to retry outside,
 *   and a repository's own `.claude/settings` cannot open exclusions.
 * - `autoAllowBashIfSandboxed: true`: a command that runs inside is approved
 *   by itself. It was off until 2026-10-13, to keep the allow-list as a gate
 *   in front of the boundary; see the head of this file for what that cost.
 *   Deny rules still hold, and a command that leaves the sandbox still needs
 *   its allow rule.
 * - With push ticked, git's network commands run outside (`GIT_NETWORK`).
 *   They reach any host they are pointed at -- the documented cost of an
 *   exclusion.
 * - With commit unticked the shell cannot write in `.git`. The deny-list
 *   stops `git commit` typed as such; now that any other command runs, a
 *   `git stash`, a `git update-ref` or a script that commits would have gone
 *   through it. Read-only, the repository can still be read: status, diff
 *   and log work (tried on the real `claude`, 2026-10-13, with a
 *   `git update-ref` from a Python script refused by the system).
 *
 * - The project's own memory folder is readable, inside a `~/.claude/projects`
 *   that is not: see `projectMemoryOf`.
 *
 * @param gitDir the project's `.git` (`gitDirOf`), or null when it has none.
 * @param memoryDir the project's memory folder (`projectMemoryOf`), or null.
 */
export function sandboxFor(
  rules: GitRules,
  gitDir: string | null,
  memoryDir: string | null = null,
): { sandbox: Record<string, unknown> } {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      ...(rules.push ? { excludedCommands: [...GIT_NETWORK] } : {}),
      network: { strictAllowlist: true },
      filesystem: {
        denyRead: [...SECRET_PATHS],
        // The narrower path wins over the wider denial around it.
        ...(memoryDir !== null ? { allowRead: [memoryDir] } : {}),
        ...(!rules.commit && gitDir !== null ? { denyWrite: [gitDir] } : {}),
      },
    },
  };
}

/**
 * A project's `.git`, absolute, or null when the folder has none.
 *
 * Only a path that is there is ever denied: on Linux the sandbox holds a
 * denial on a missing path with an empty placeholder file, and a `.git` file
 * left behind by a killed worker would make a folder that was never a
 * repository fail every git command, `git init` included. In a linked
 * worktree `.git` is a file and the repository is elsewhere: there the fence
 * is the deny-list alone.
 */
export function gitDirOf(cwd: string, exists: (p: string) => boolean = fs.existsSync): string | null {
  const dir = path.join(cwd, '.git');
  return exists(dir) ? dir : null;
}

/** Where Claude Code keeps every project's sessions and notes. */
const CLAUDE_PROJECTS = '~/.claude/projects';
const readRule = (p: string): string => `Read(${p.endsWith('.json') ? p : `${p}/**`})`;

/**
 * A project's memory: the notes Claude Code keeps for it, and the one folder
 * under `~/.claude/projects` a worker may read.
 *
 * Claude Code loads the index of those notes into every session, a worker's
 * too, and until 2026-10-13 a worker could not open one of them: the whole
 * of `~/.claude/projects` was denied, because the transcripts of your other
 * sessions are there. Measured on the plan of that day: the decsim2 worker
 * asked three times for two of them, notes written so that the next session
 * would not learn the same things again the hard way.
 */
export interface ProjectMemory {
  /** `<home>/.claude/projects/<slug>/memory`, absolute. */
  dir: string;
  /** The project's own folder name there: every other one is denied, without being named. */
  slug: string;
}

/** A name the rules can tell apart: the characters their classes are made of. */
const RE_PLAIN_NAME = /^[A-Za-z0-9._-]+$/;
/** A slug as `slugFor` makes it: what `allBut` can take the complement of. */
const RE_SLUG = /^[A-Za-z0-9-]+$/;

/**
 * The memory of the project in `cwd`, or null when it has none to read.
 *
 * Null is the safe answer and the old behaviour: with no memory the whole of
 * `~/.claude/projects` stays denied. So it is null whenever the rules could
 * not be exact -- the folder cannot be listed, or a project folder is named
 * with a character the rules' classes do not hold -- and when the project
 * has no memory folder yet: on Linux the sandbox holds a rule on a missing
 * path with a placeholder file.
 *
 * The other folders are listed only to be checked, never to be named: the
 * first version wrote one rule for each, and the names of all your projects
 * were on the command line of every worker, where another user of the
 * machine reads them with `ps`.
 */
export function projectMemoryOf(
  cwd: string,
  home: string = os.homedir(),
  list: (dir: string) => string[] = (dir) => fs.readdirSync(dir),
  exists: (p: string) => boolean = fs.existsSync,
): ProjectMemory | null {
  const projects = path.join(home, '.claude', 'projects');
  const slug = slugFor(cwd);
  let names: string[];
  try {
    names = list(projects);
  } catch {
    return null;
  }
  if (!RE_SLUG.test(slug) || !names.includes(slug)) return null;
  if (!names.every((n) => RE_PLAIN_NAME.test(n))) return null;
  const dir = path.join(projects, slug, 'memory');
  return exists(dir) ? { dir, slug } : null;
}

/** `lo`..`hi` as a class range, or one character, or nothing when the range is empty. */
function span(lo: number, hi: number): string {
  if (lo > hi) return '';
  const a = String.fromCharCode(lo);
  return lo === hi ? a : `${a}-${String.fromCharCode(hi)}`;
}

/** Every name character but one: a letter in both of its cases, a digit, or the dash. */
function anyBut(c: string): string {
  const gap = (first: string, last: string, x: string): string =>
    span(first.charCodeAt(0), x.charCodeAt(0) - 1) + span(x.charCodeAt(0) + 1, last.charCodeAt(0));
  const letter = /[A-Za-z]/.test(c);
  const digits = /[0-9]/.test(c) ? gap('0', '9', c) : '0-9';
  const upper = letter ? gap('A', 'Z', c.toUpperCase()) : 'A-Z';
  const lower = letter ? gap('a', 'z', c.toLowerCase()) : 'a-z';
  // The dash is last, where a class reads it as itself.
  return `[${digits}${upper}${lower}_.${c === '-' ? '' : '-'}]`;
}

/**
 * Patterns that together match every name but `name` itself.
 *
 * A deny rule cannot say "all but one": a `!` pattern cannot reopen a path
 * inside a folder denied whole, and it is not read after `~/`. So the
 * complement is spelled out: a name that differs at its first letter, at its
 * second, ...; a name that stops short; a name that goes on.
 *
 * Positive classes only, and each without the letter in EITHER case. Both
 * were learned on the real `claude` (2026-10-13), where the first drafts
 * failed the wrong way round: `[!m]` and `[^m]` are read as "`!` or `m`",
 * "`^` or `m`", so a rule meant for everything but the notes matched only
 * them and every transcript could be read; and names are compared ignoring
 * case, so a class holding `A-Z` matched `memory` by its `M`. Where names
 * are compared exactly, a name that differs from `name` only in the case of
 * a letter is not covered: Claude Code makes none.
 *
 * @param name letters, digits and dashes: a folder name of Claude Code's.
 */
export function allBut(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < name.length; i++) out.push(`${name.slice(0, i)}${anyBut(name[i]!)}*`);
  for (let i = 1; i < name.length; i++) out.push(name.slice(0, i));
  out.push(`${name}[0-9A-Za-z_.-]*`);
  return out;
}

/**
 * What a sandboxed worker is denied besides git: what lives outside the
 * sandbox. The web tools are a way out to the network, so they are denied
 * unless you ticked web; Read would reach the files the shell may not.
 *
 * Under `~/.claude/projects`, with a memory to read, three layers: every
 * project folder but this project's own, whole -- by the complement of its
 * name, so none of the others is named and one made after the worker started
 * is denied too; every transcript anywhere, by its extension, which is the
 * plain rule that holds whatever the others turn out to mean; and in any
 * project folder every entry but `memory` -- the session folders with the
 * tool outputs in them, and whatever a later version adds. Nothing there
 * can be written: a note is loaded into every later session of the project,
 * yours included, and a worker that could write one could leave instructions
 * for a session with more rights than its own.
 */
export function outsideSandboxDenied(rules: GitRules, memory: ProjectMemory | null): string[] {
  return [
    ...(rules.web ? [] : WEB_TOOLS),
    ...SECRET_PATHS.filter((p) => p !== CLAUDE_PROJECTS).map(readRule),
    ...(memory
      ? [
          ...allBut(memory.slug).map((pattern) => `Read(${CLAUDE_PROJECTS}/${pattern}/**)`),
          `Read(${CLAUDE_PROJECTS}/**/*.jsonl)`,
          ...allBut('memory').map((pattern) => `Read(${CLAUDE_PROJECTS}/*/${pattern})`),
        ]
      : [readRule(CLAUDE_PROJECTS)]),
    `Edit(${CLAUDE_PROJECTS}/**)`,
  ];
}

/**
 * Whether a Codex worker's sandbox has the network: for a push, or because
 * you ticked web. Codex has one switch for both -- `codex exec` has no web
 * tool to allow by itself -- so with web its shell reaches any host.
 */
function codexOnline(rules: GitRules): boolean {
  return rules.push || rules.web === true;
}

/** The Codex sandbox for these rules: writes stay in the workspace, the network opens for a push or for the web. */
export function codexSandboxFor(rules: GitRules): string[] {
  const out = ['-s', 'workspace-write'];
  if (codexOnline(rules)) out.push('-c', 'sandbox_workspace_write.network_access=true');
  return out;
}

/** The same sandbox, for `codex exec resume`, which takes no `-s`. */
export function codexResumeSandboxFor(rules: GitRules): string[] {
  const out = ['-c', 'sandbox_mode="workspace-write"'];
  if (codexOnline(rules)) out.push('-c', 'sandbox_workspace_write.network_access=true');
  return out;
}
