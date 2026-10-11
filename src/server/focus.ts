import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Brings a session's terminal to the front.
 *
 * It is the SECOND and last exception to the "a single subprocess" rule, and
 * it must be declared rather than hidden: on a click on a single session the
 * server runs `ps` and `osascript`. Neither of them modifies anything -- the
 * first reads the process table, the second moves a window's focus -- and no
 * value coming from the client reaches the command line: the client sends a
 * `sessionId`, and the server takes the PID from its own model.
 *
 * For a session with no terminal (a CEO's worker) the same click opens one:
 * a Terminal window running `towerglow watch`, which only reads the
 * session's transcript (`watch.ts`). Every value on that command line comes
 * from the server's model or its own config, each one quoted. For a session
 * that is over, the click opens a plain shell in its project (`openTerminalAt`).
 *
 * It is switched off with `--no-focus`, and outside macOS it does not exist.
 *
 * The same `osascript` shows one more thing, and nothing else: the notice of
 * a plan that stopped (`notifyDesktop`), off with `--no-notify`.
 */

export type FocusResult = { ok: true; how: 'tab' | 'app' | 'window' } | { ok: false; reason: string };

/** Why a click found no window: the one refusal a live view can answer. */
export const NO_TERMINAL = 'that session has no terminal window';

/**
 * Why a click found no process at all: the session is over, or was never
 * seen running. Its terminal is gone with it, so the click opens a new one in
 * the project instead, where `claude` or `codex` starts the next session.
 */
export const SESSION_GONE: ReadonlySet<string> = new Set([
  'no process id',
  'that session is no longer running',
  'that process id belongs to something else now',
]);

/** An acceptable tty. Anything that isn't one never reaches osascript. */
const RE_TTY = /^tty[a-z]*[0-9]+$/;

/** Tight timeout: a focus that doesn't move right away is no longer any use. */
const TIMEOUT_MS = 4000;

export interface Proc {
  pid: number;
  ppid: number;
  tty: string;
  comm: string;
}

/**
 * The terminal apps that can select the right tab, and how to call them.
 * For all the others we just bring the application forward: better than doing
 * nothing, and honest about the fact that we didn't get to the tab.
 */
const SCRIPTED: Record<string, string> = {
  Terminal: `on run argv
  set target to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if (tty of t) ends with target then
          set selected of t to true
          set index of w to 1
          activate
          return "tab"
        end if
      end repeat
    end repeat
  end tell
  return "none"
end run`,
  iTerm2: `on run argv
  set target to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s) ends with target then
            select w
            select t
            select s
            activate
            return "tab"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "none"
end run`,
};

/** The app's name as AppleScript knows it, from the running binary. */
const APP_OF: Record<string, string> = {
  Terminal: 'Terminal',
  iTerm2: 'iTerm2',
  iTerm: 'iTerm2',
  Ghostty: 'Ghostty',
  WezTerm: 'WezTerm',
  'wezterm-gui': 'WezTerm',
  alacritty: 'Alacritty',
  kitty: 'kitty',
  Warp: 'Warp',
  Hyper: 'Hyper',
  Electron: 'Code',
  Code: 'Code',
};

function run(cmd: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
}

/**
 * A macOS notification. The strings travel as arguments of the script, never
 * inside its source: a stall text quoting a project name cannot become
 * AppleScript. Fire and forget -- a notice that fails is a notice missed,
 * not an error of the planner.
 */
export const NOTICE_SCRIPT = [
  'on run argv',
  'display notification (item 2 of argv) with title "Towerglow" subtitle (item 1 of argv)',
  'end run',
].join('\n');

export function notifyDesktop(title: string, text: string): void {
  run('osascript', ['-', title.slice(0, 80), text.slice(0, 240)], NOTICE_SCRIPT).catch(() => undefined);
}

/** A single read of the process table: tty plus the chain of parents. */
async function processTable(): Promise<Map<number, Proc>> {
  const out = new Map<number, Proc>();
  const text = await run('ps', ['-axo', 'pid=,ppid=,tty=,comm=']);
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    out.set(Number(m[1]), {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      tty: m[3]!,
      comm: m[4]!.trim(),
    });
  }
  return out;
}

/**
 * Climbs up the parents until it finds a known terminal application.
 * Between the session and the window sit `login` and the shell, so the jump
 * is always more than one level.
 */
function terminalAppOf(table: Map<number, Proc>, pid: number): string | null {
  let cur = table.get(pid);
  for (let i = 0; i < 12 && cur && cur.ppid > 1; i++) {
    cur = table.get(cur.ppid);
    if (!cur) break;
    const name = path.basename(cur.comm);
    const app = APP_OF[name];
    if (app) return app;
  }
  return null;
}

/**
 * A process's terminal, if it really has one.
 *
 * The tty is checked BEFORE climbing up to the parents, and the order is
 * everything. A process without a tty -- a `claude -p` started by the CEOs,
 * which only has pipes -- still has a chain of parents, and that chain goes
 * through the server and reaches the terminal of WHOEVER STARTED THE SERVER.
 * Measured: the CEOs' worker climbed up to node, then to bash, then to the
 * interactive session of whoever was watching, and the click brought HIS
 * window to the front. Not "no terminal" but the wrong terminal, which is
 * worse: it looks like it works.
 */
export function terminalOf(table: Map<number, Proc>, pid: number): { tty: string; app: string } | null {
  const proc = table.get(pid);
  if (!proc) return null;
  const tty = proc.tty.replace(/^\/dev\//, '');
  // Without a tty there is no window to bring forward, and the parents must
  // not be looked at: they belong to someone else.
  if (!RE_TTY.test(tty)) return null;
  return { tty, app: terminalAppOf(table, pid) ?? 'Terminal' };
}

/**
 * @param pid the session's process, taken from the server's model.
 * @param expect expected process name: if it doesn't match we give up. It is
 *        needed for PIDs derived from an index that may be stale -- a
 *        recycled PID would bring the wrong window to the front.
 */
export async function focusTerminal(pid: number, expect?: string): Promise<FocusResult> {
  if (process.platform !== 'darwin') return { ok: false, reason: 'only on macOS' };
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, reason: 'no process id' };

  let table: Map<number, Proc>;
  try {
    table = await processTable();
  } catch {
    return { ok: false, reason: 'cannot read the process table' };
  }

  const proc = table.get(pid);
  if (!proc) return { ok: false, reason: 'that session is no longer running' };
  if (expect && path.basename(proc.comm) !== expect) {
    return { ok: false, reason: 'that process id belongs to something else now' };
  }

  const term = terminalOf(table, pid);
  if (!term) return { ok: false, reason: NO_TERMINAL };
  return bringForward(term);
}

/** Select the tab of a tty, or at least bring its application forward. */
async function bringForward(term: { tty: string; app: string }): Promise<FocusResult> {
  const script = SCRIPTED[term.app];
  try {
    if (script) {
      const answer = (await run('osascript', ['-', term.tty], script)).trim();
      if (answer === 'tab') return { ok: true, how: 'tab' };
    }
    // No tab found, or a terminal without AppleScript: at least the
    // application is brought forward.
    await run('osascript', ['-e', `tell application "${term.app}" to activate`]);
    return { ok: true, how: 'app' };
  } catch (err) {
    return automationFailure(err, 'the terminal did not respond');
  }
}

function automationFailure(err: unknown, fallback: string): FocusResult {
  const msg = String((err as Error).message ?? '');
  // -1743 is how macOS says automation has not been granted.
  if (msg.includes('-1743') || msg.toLowerCase().includes('not allowed')) {
    return { ok: false, reason: 'macOS has not granted automation access' };
  }
  return { ok: false, reason: fallback };
}

/* ───────────────────── a live view, for a session with no terminal ───────────────────── */

/**
 * Whether a value holds a character a terminal acts on: C0 but tab, DEL, C1.
 *
 * Quoting is not enough for what Terminal's `do script` receives: it TYPES
 * the command, as if from the keyboard, and the line editor reads control
 * characters before any shell parses quotes. A folder named with a ^U in it
 * erases the quoted `cd '...` typed so far and leaves the rest of its name
 * to run. Such a value is refused, never cleaned: a cleaned path is another
 * folder.
 */
export function typeable(value: string): boolean {
  for (const ch of value) {
    const c = ch.charCodeAt(0);
    if ((c < 0x20 && c !== 0x09) || (c >= 0x7f && c <= 0x9f)) return false;
  }
  return true;
}

/** One shell word, whatever it holds: single quotes, and a quote as `'\''`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface FollowSpec {
  provider: 'claude' | 'codex';
  sessionId: string;
  /** The project folder: where the window starts, so the resume hint works as printed. */
  cwd: string;
  /**
   * The session's process, or `null` when the session is over.
   *
   * With a pid the window follows the transcript and stops when the process
   * ends; without one it prints the whole transcript and stops (`--once`):
   * the log of a finished task, read from Reports after the fact.
   */
  pid: number | null;
  /** This Node, and the script this server was started with. */
  node: string;
  entry: string;
  claudeDir: string;
  codexDir: string;
}

/** The marker a viewer's command line carries: how a second click finds the first window. */
function marker(sessionId: string): string {
  return ` watch ${sessionId} `;
}

/**
 * The command the new window runs.
 *
 * `cd` first and no `exec`: when the session ends the viewer exits and leaves
 * a shell in the project, where the `--resume` it prints can be typed as is.
 */
export function followCommand(spec: FollowSpec): string {
  return [
    'cd', shellQuote(spec.cwd), '&&',
    shellQuote(spec.node), shellQuote(spec.entry),
    'watch', spec.sessionId, '--provider', spec.provider, '--cwd', shellQuote(spec.cwd),
    ...(spec.pid === null ? ['--once'] : ['--pid', String(spec.pid)]),
    '--claude-dir', shellQuote(spec.claudeDir), '--codex-dir', shellQuote(spec.codexDir),
  ].join(' ');
}

/**
 * The tty of a viewer already following this session, from `ps -axo tty=,command=`.
 *
 * A second click should not stack a second window on the first: the first is
 * brought forward instead, as a session's own terminal would be.
 */
export function viewerTty(psText: string, sessionId: string): string | null {
  const needle = marker(sessionId);
  for (const line of psText.split('\n')) {
    const m = /^\s*(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const tty = m[1]!.replace(/^\/dev\//, '');
    if (!RE_TTY.test(tty)) continue;
    if (`${m[2]!} `.includes(needle) && m[2]!.includes('towerglow')) return tty;
  }
  return null;
}

const OPEN_IN_TERMINAL = `on run argv
  tell application "Terminal"
    do script (item 1 of argv)
    activate
  end tell
  return "window"
end run`;

/**
 * Open (or bring back) a Terminal window that follows a session with no terminal.
 *
 * Terminal and not the user's own emulator: it is on every Mac and it takes a
 * command over AppleScript. The command goes in as an argument, never spliced
 * into the script, and every value in it is quoted.
 */
export async function followInTerminal(spec: FollowSpec): Promise<FocusResult> {
  if (process.platform !== 'darwin') return { ok: false, reason: 'only on macOS' };
  if (!/^[A-Za-z0-9-]{8,64}$/.test(spec.sessionId)) return { ok: false, reason: 'not a session id' };
  if (spec.pid !== null && (!Number.isInteger(spec.pid) || spec.pid <= 1)) return { ok: false, reason: 'no process id' };
  if (![spec.cwd, spec.node, spec.entry, spec.claudeDir, spec.codexDir].every(typeable)) {
    return { ok: false, reason: 'a path with control characters in it cannot be typed into a terminal' };
  }
  try {
    const tty = viewerTty(await run('ps', ['-axo', 'tty=,command=']), spec.sessionId);
    if (tty) return bringForward({ tty, app: 'Terminal' });
  } catch {
    // No process table: a second window is better than none.
  }
  try {
    await run('osascript', ['-', followCommand(spec)], OPEN_IN_TERMINAL);
    return { ok: true, how: 'window' };
  } catch (err) {
    return automationFailure(err, 'Terminal did not open a window');
  }
}

/**
 * The command a new window runs to start in a project: only a `cd`, so what
 * is left is your own shell, in the folder, waiting for `claude` or `codex`.
 */
export function shellInCommand(dir: string): string {
  return `cd ${shellQuote(dir)}`;
}

/**
 * Opens a Terminal window in a project whose session is over.
 *
 * It starts nothing: the window holds a shell in the folder, and which agent
 * runs there -- if any -- is typed by you. The folder comes from the
 * server's model, never from the client, and goes in quoted as an argument.
 */
export async function openTerminalAt(dir: string): Promise<FocusResult> {
  if (process.platform !== 'darwin') return { ok: false, reason: 'only on macOS' };
  if (!path.isAbsolute(dir)) return { ok: false, reason: 'not an absolute path' };
  if (!typeable(dir)) return { ok: false, reason: 'a path with control characters in it cannot be typed into a terminal' };
  try {
    if (!fs.statSync(dir).isDirectory()) return { ok: false, reason: 'not a folder' };
  } catch {
    return { ok: false, reason: 'that folder is no longer on disk' };
  }
  try {
    await run('osascript', ['-', shellInCommand(dir)], OPEN_IN_TERMINAL);
    return { ok: true, how: 'window' };
  } catch (err) {
    return automationFailure(err, 'Terminal did not open a window');
  }
}

/**
 * Opens a project's folder in the file manager.
 *
 * Same discipline as the jump to the terminal: the path comes from the
 * server's model, never from the client, and `execFile` passes it as an
 * argument instead of inside a shell line -- a directory can contain spaces,
 * quotes and anything else, and concatenating it would be an invitation to
 * get it wrong.
 *
 * It modifies nothing: it shows a folder.
 */
export async function revealFolder(dir: string): Promise<FocusResult> {
  if (!path.isAbsolute(dir)) return { ok: false, reason: 'not an absolute path' };

  // It must exist AND be a directory: `open` on a vanished path would open a
  // system error window, which is worse than silence.
  try {
    if (!fs.statSync(dir).isDirectory()) return { ok: false, reason: 'not a folder' };
  } catch {
    return { ok: false, reason: 'that folder is no longer on disk' };
  }

  const command = revealCommand(dir, process.platform);
  if (!command) return { ok: false, reason: 'not supported on this platform' };

  try {
    await run(command.cmd, command.args);
    return { ok: true, how: 'app' };
  } catch {
    return { ok: false, reason: 'the file manager did not open' };
  }
}

/**
 * The command that shows a project folder, and never runs it.
 *
 * On macOS `open` on a folder named `tool.app` LAUNCHES it: a repository
 * cloned under that name, with an executable script in `Contents/MacOS`, ran
 * on the click meant to show its files -- git sets no quarantine, so
 * Gatekeeper never looked. A folder with an extension may be a package, so it
 * is revealed in Finder (`-R`, selected in its parent) instead of opened.
 */
export function revealCommand(dir: string, platform: NodeJS.Platform): { cmd: string; args: string[] } | null {
  if (platform === 'darwin') return { cmd: 'open', args: path.extname(dir) ? ['-R', dir] : [dir] };
  if (platform === 'linux') return { cmd: 'xdg-open', args: [dir] };
  return null;
}

/** What a worker may hand you to read: a document, never a program. */
const DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

/**
 * Opens a document a worker wrote, with whatever reads that kind of file.
 *
 * The plan of a "planning only" task lives in the repository, as a markdown
 * file the worker names in its closing block (`wrote`), and Reports carried
 * only the worker's last message about it: this is the click that opens the
 * file itself. The folder comes from the world model and the relative path
 * from the ledger, never from the client, and both are checked again here
 * because a model wrote the second: it must resolve INSIDE the project --
 * through symlinks too, hence `realpath` on both ends -- exist, be a file,
 * and be a document by extension. `open` on a script would run it.
 *
 * `launch` is injected so the rule can be tested without opening anything.
 */
export async function openDocument(
  cwd: string,
  rel: string,
  launch: (cmd: string, args: string[]) => Promise<unknown> = run,
): Promise<FocusResult> {
  if (!path.isAbsolute(cwd)) return { ok: false, reason: 'not an absolute path' };
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    return { ok: false, reason: 'not a path inside the project' };
  }
  if (!DOCUMENT_EXTENSIONS.has(path.extname(rel).toLowerCase())) return { ok: false, reason: 'not a document' };

  let file: string;
  try {
    const root = fs.realpathSync(cwd);
    file = fs.realpathSync(path.resolve(root, rel));
    if (!file.startsWith(root + path.sep)) return { ok: false, reason: 'not a path inside the project' };
    // The name was checked above, but `open` gets the file the name leads to:
    // a `notes.md` that is a symlink to a script inside the project would run it.
    if (!DOCUMENT_EXTENSIONS.has(path.extname(file).toLowerCase())) return { ok: false, reason: 'not a document' };
    if (!fs.statSync(file).isFile()) return { ok: false, reason: 'not a file' };
  } catch {
    return { ok: false, reason: 'that file is no longer on disk' };
  }

  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [file]]
      : process.platform === 'linux'
        ? ['xdg-open', [file]]
        : [null, []];
  if (!cmd) return { ok: false, reason: 'not supported on this platform' };

  try {
    await launch(cmd, args as string[]);
    return { ok: true, how: 'app' };
  } catch {
    return { ok: false, reason: 'nothing opened it' };
  }
}
