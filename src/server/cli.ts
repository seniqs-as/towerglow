import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  billingLines, buildConfig, capsOf, ConfigError, DEFAULT_PORT, envOf, isOwnState, STATE_DIR_NAME,
} from './config.ts';
import type { Config, RawOptions } from './config.ts';
import * as path from 'node:path';
import { createHttpServer, listen, clientDirExists, clientDir } from './httpServer.ts';
import { WsHub } from './wsHub.ts';
import { focusTerminal, followInTerminal, NO_TERMINAL, notifyDesktop, openDocument, openTerminalAt, revealFolder, SESSION_GONE } from './focus.ts';
import type { FocusResult } from './focus.ts';
import { follow, paintFor, processAlive, validSessionId } from './watch.ts';
import {
  dataPath, installStatusline, refreshBridge, sessionsPath, statuslineStatus,
  uninstallStatusline, StatuslineError,
} from './statusline/installer.ts';
import { StatuslineReader } from './statusline/reader.ts';
import { World } from './state/world.ts';
import { createPlacementStore } from './state/placement.ts';
import { createPrefs } from './state/prefs.ts';
import { createHistory, HISTORY_ROW_DAYS } from './state/history.ts';
import { readClosedCosts } from './sources/costSeed.ts';
import { projectIdFor } from './state/ids.ts';
import { clipPlanFrame, isPlanFrame } from './ceoPort.ts';
import type { CeoDesk, CeoModule } from './ceoPort.ts';
import { RegistrySource } from './sources/registrySource.ts';
import { GitSource } from './sources/gitSource.ts';
import { CodexProvider } from './providers/codex/provider.ts';
import { TranscriptSource } from './sources/transcriptSource.ts';
import { findRecap } from './sources/recapSeed.ts';
import { createStats } from './parse/records.ts';
import { assertSafe, clampUnsafe } from './parse/redact.ts';
import type { RedactOptions } from './parse/redact.ts';
import {
  readKnownProjectPaths, readPlanLabel, existsOnDisk, makeExcluder, projectLastActive,
  measureProject,
} from './sources/projectsSource.ts';
import type { PathPolicy } from './paths.ts';
import { PROTOCOL_VERSION } from '../shared/protocol.ts';
import type { DeltaEvent, ProviderId } from '../shared/protocol.ts';

const VERSION = '0.1.0';

/** Vite's dev server. The same default lives in vite.config.ts. */
const DEV_CLIENT_PORT = Number(envOf('DEV_PORT') ?? 5173);

/**
 * How often the projects somebody works in are measured again. A scan is
 * bounded (20,000 files, heavy directories skipped) but it is synchronous:
 * once a minute per live project is a tower that follows its folder without
 * the server ever stalling on it.
 */
const SIZE_REFRESH_MS = 60_000;


const USAGE = `towerglow ${VERSION} — a live 3D city of your running coding agents

  towerglow start [options]
    --port <n>            default ${DEFAULT_PORT} (or TOWERGLOW_PORT)
    --state-dir <path>    where this instance keeps its own state: layout,
                          history, prefs, CEO ledger. Default ~/${STATE_DIR_NAME}
                          (or TOWERGLOW_STATE_DIR). Two copies of the tree
                          need two state dirs, or they overwrite each other
    --claude-dir <path>   default ~/.claude
    --codex-dir <path>    default ~/.codex
    --providers <list>    which tools to watch: claude,codex (default: both;
                          one that is not installed is skipped silently)
    --warmup-bytes <n>    default 8388608 (8 MiB); 0 = only events from now on
    --redact-paths        project names and paths hashed inside the server
    --no-commit-text      no commit subjects
    --no-titles           no session titles above avatars
    --no-recap            no session recap (goal / state / next step)
    --no-cmd-names        no binary names for Bash tools
    --no-focus            never bring a terminal window to the front
    --no-notify           no desktop notice when the plan stops (--ceo)
    --exclude <glob>      skip projects by path (repeatable)
    --ceo                 the CEOs: Board, Planning and the workers they start.
                          Without it the tool is observation only, fully offline
    --no-ceo              observation only (the default; kept so old command lines still work)
    --ceo-model <alias>   Claude's middle rung: haiku for fast, opus for deep.
                          Default sonnet
    --ceo-codex-model <m> Codex's model. Unset = the one in ~/.codex/config.toml;
                          depth moves model_reasoning_effort, not the model
    --ceo-budget <usd>    rolling 24h spending cap, default 10.00 (API key users)
    --ceo-quota-max <pct> refuse to run above this rate-limit usage, default 85
    --ceo-max-call <usd>  cap on a single call, default 2.00; a second opinion
                          asks for its own estimate instead
    --ceo-every <every>   the plan scheduler's tick, e.g. 15s (default 30s, min 10s)
    --no-execute          advisor only: accepted proposals never start work.
                          Default is EXECUTIVE: accepting one starts a session

  towerglow statusline install|uninstall|status
    Bridges Claude Code's status line so Towerglow can read the usage limits
    (5-hour and 7-day). Those numbers exist nowhere else: Claude Code hands them
    to the status line command on stdin and never writes them to disk. Your own
    status line keeps running, wrapped, and uninstall puts it back.
    --quiet

  towerglow watch <session-id> --provider claude|codex --cwd <dir> [--pid <n> | --once]
    Follows a session's transcript in this terminal, read-only. It is what the
    terminal button opens for a session that has no terminal of its own (a
    CEO's worker); it stops when process <n> ends. With --once it prints the
    whole transcript and stops: the log of a session that is over.

  towerglow doctor
  towerglow version

It always binds to 127.0.0.1: there is no --host flag, by design.`;

const OPTIONS = {
  port: { type: 'string' },
  'state-dir': { type: 'string' },
  'claude-dir': { type: 'string' },
  'codex-dir': { type: 'string' },
  providers: { type: 'string' },
  'warmup-bytes': { type: 'string' },
  dev: { type: 'boolean' },
  quiet: { type: 'boolean' },
  'redact-paths': { type: 'boolean' },
  'no-commit-text': { type: 'boolean' },
  'no-titles': { type: 'boolean' },
  'no-recap': { type: 'boolean' },
  'no-cmd-names': { type: 'boolean' },
  'no-focus': { type: 'boolean' },
  'no-notify': { type: 'boolean' },
  exclude: { type: 'string', multiple: true },
  ceo: { type: 'boolean' },
  'no-ceo': { type: 'boolean' },
  'ceo-model': { type: 'string' },
  'ceo-codex-model': { type: 'string' },
  'ceo-budget': { type: 'string' },
  'ceo-quota-max': { type: 'string' },
  'ceo-max-call': { type: 'string' },
  'ceo-every': { type: 'string' },
  'no-execute': { type: 'boolean' },
  provider: { type: 'string' },
  cwd: { type: 'string' },
  pid: { type: 'string' },
  once: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}\n`);
    return 2;
  }

  const command = parsed.positionals[0] ?? 'start';
  if (parsed.values.help || command === 'help') {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (command === 'version') {
    process.stdout.write(`${VERSION} (protocol v${PROTOCOL_VERSION})\n`);
    return 0;
  }

  let cfg: Config;
  try {
    cfg = buildConfig(parsed.values as RawOptions);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`configuration error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  if (command === 'statusline') return statusline(cfg, parsed.positionals[1] ?? 'status');
  if (command === 'doctor') return doctor(cfg);
  if (command === 'start') return start(cfg);
  if (command === 'watch') {
    return watch(
      cfg, parsed.positionals[1] ?? '', parsed.values.provider, parsed.values.cwd, parsed.values.pid,
      parsed.values.once === true,
    );
  }

  process.stderr.write(`unknown command: ${command}\n\n${USAGE}\n`);
  return 2;
}

async function start(cfg: Config): Promise<number> {
  const policy: PathPolicy = {
    claudeDir: cfg.claudeDir,
    codexDir: cfg.codexDir,
    homeDir: cfg.homeDir,
  };

  const placement = createPlacementStore(cfg.stateDir);
  const prefs = createPrefs(cfg.stateDir);
  /*
   * What remains of finished sessions.
   *
   * The world model is a snapshot of the NOW: it deletes a session when it
   * exits. Four analyses out of five, however, are historical questions, and
   * without a place where history survives they would be answered by looking
   * only at whoever is still running.
   */
  const history = createHistory(cfg.stateDir);

  const world = new World({
    homeDir: cfg.homeDir,
    placement,
    prefs,
    redactPaths: cfg.redactPaths,
    titles: cfg.titles,
    // The starting recap is looked up only for Claude Code: it is its
    // `away_summary`, and giving it to a Codex session would mean telling it
    // about another tool's work. With --no-recap nothing is read here.
    seedRecap: (session) =>
      cfg.recap && session.provider === 'claude'
        ? findRecap({
            claudeDir: cfg.claudeDir,
            cwd: session.cwd,
            sessionId: session.sessionId,
            policy,
          })
        : null,
    providersSeed: (projectId) => history.providersOf(projectId),
    /*
     * A CEO's worker registers in the registry like everyone else: without
     * this question it would show up twice, once as a session of the project
     * and once as a turret on the HQ. The discovered one wins -- it carries the
     * real tokens -- and the desk withdraws its own placeholder by answering.
     *
     * `ceoDesk` is null until the module is there, and null forever in the
     * passive version: nothing that lives in `./ceo/` is named here.
     */
    adoptCeoSession: (pid, sessionId) => ceoDesk?.adopt(pid, sessionId) ?? null,
    /*
     * A session leaves the stage: it goes on record before we lose it.
     *
     * `inferred` and not `reported`: we counted these numbers ourselves by
     * watching the events go by, and they cover only what the tailer read.
     * If the tool's final tally arrives later, the row gets promoted.
     */
    onSessionClosed: (session) => {
      if (history.has(session.id)) return;
      history.record({
        id: session.id,
        projectId: session.projectId,
        provider: session.provider,
        startedAt: session.startedAt,
        confidence: 'inferred',
        // We watched it work: turns and calls are real counts.
        watched: true,
        costUsd: 0,
        tokens: session.tokens,
        turns: session.turns,
        toolCalls: session.toolCalls,
        apiMs: 0,
        toolMs: 0,
        wallMs: Math.max(0, session.lastActivityAt - session.startedAt),
        linesAdded: 0,
        linesRemoved: 0,
      });
      history.save();
    },
  });

  const isExcluded = makeExcluder(cfg.exclude);

  /**
   * Two predicates, and the difference between them matters.
   *
   * `known` -- the project exists as far as the program is concerned.
   * `--exclude` is a startup rule: what it excludes is not even discovered.
   *
   * `produces` -- a session can come from this project. What you DISABLED
   * falls out here too, but the difference is that a disabled project stays
   * known: it must keep reaching the client, or the button to re-enable it
   * would disappear as well, and the choice would become irreversible.
   *
   * The `prefs` check in `produces` is not cosmetic: without it, the server
   * still followed the transcripts of disabled projects and shipped their
   * sessions, and it was the client that didn't draw them. Work done and data
   * shipped for something you had declared out of play.
   */
  /*
   * The CEO's home is not a project of the city.
   *
   * It really happened: the runner runs in `~/.towerglow/ceo/<provider>/`,
   * and `claude -p` in there created a Claude Code project like any other.
   * Result: a "CLAUDE" building popped up next to the HQ, with its slot
   * frozen in layout.json. The CEO has the HQ, not a tower.
   *
   * All of `~/.towerglow` is excluded, not just `ceo/`: nothing in there is
   * a project of yours, today or tomorrow.
   */
  const isOurs = (cwd: string): boolean => isOwnState(cwd, cfg);
  const known = (cwd: string): boolean => !isExcluded(cwd) && !isOurs(cwd);
  const produces = (cwd: string): boolean => known(cwd) && !prefs.isDisabled(projectIdFor(cwd));

  if (!clientDirExists()) {
    process.stderr.write(
      `interface not built: ${clientDir()} has no index.html.\n` +
        `Run 'npm run build' (or 'npm run dev:client' for Vite development).\n`,
    );
    return 1;
  }

  // Created before the HTTP server because `/healthz` exposes its counters.
  const stats = createStats();

  const server = createHttpServer(cfg, stats);

  let port: number;
  try {
    port = await listen(server, cfg.port);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      // No auto-increment: the address you bookmarked would silently become
      // another copy's, or nothing. Better to fail explicitly.
      process.stderr.write(
        `port ${cfg.port} is already in use.\n` +
          `Free it or pass --port <n>.\n`,
      );
      return 1;
    }
    throw err;
  }

  /**
   * The CEOs' desk, if switched on.
   *
   * Declared here and filled in later, with a DYNAMIC import: it is the only
   * place where the rest of the program names `./ceo/`. Without `--ceo` that
   * module is not even loaded, and deleting the folder the rest keeps
   * compiling -- which is the condition for deriving two repositories from it.
   */
  let ceoDesk: CeoDesk | null = null;
  let ceoProviders: readonly ProviderId[] = [];

  const hub = new WsHub({
    server,
    port,
    token: cfg.token,
    // A function and not a value: `ceoProviders` is known only after learning
    // whether Codex is installed, that is, long after the server is listening.
    caps: () =>
      capsOf(
        cfg,
        statuslineStatus({ claudeDir: cfg.claudeDir, stateDir: cfg.stateDir }).installed,
        ceoProviders,
        // The module declares them, when it is there: without CEOs the list
        // stays empty and the panel that would use them does not even exist.
        ceoDesk?.analyses ?? [],
        ceoDesk !== null,
      ),
    // The client's port in development is the same one vite.config.ts reads:
    // two copies of the tree cannot share a single one, and a wrong origin
    // here shows up as a WebSocket refused with no explanation.
    devOrigins: cfg.dev ? [`http://127.0.0.1:${DEV_CLIENT_PORT}`, `http://localhost:${DEV_CLIENT_PORT}`] : [],
    /*
     * The net on every event that leaves, whoever built it. It used to be
     * cast by each source on its own events, and the registry, Codex's
     * sessions and the world's own patches never were: a session name of any
     * length went straight to the page. Casting it twice costs nothing --
     * a string already cut is not cut again, nor counted.
     */
    guard: (ev) => {
      if (cfg.dev) assertSafe(ev);
      else stats.redactionClamps += clampUnsafe(ev);
    },
    /*
     * The snapshot, plus the CEOs' notice board.
     *
     * `report`s and `proposal`s are not in the world model: the desk keeps
     * them, and the desk is not the world but a reading of it. They travel in
     * `recent` because it is the only channel a client finds already full when
     * it connects -- and that is exactly the case in which the panel stayed
     * empty without saying whether there was nothing or whether it had missed it.
     */
    snapshot: () => {
      const snap = world.snapshot();
      if (!ceoDesk) return snap;
      return { ...snap, recent: [...snap.recent, ...ceoDesk.states()] };
    },
    onClientFrame: (frame, reply) => {
      // Display preferences: they change only what is seen, and they are all
      // reversible. They stay inside ~/.towerglow.
      if (frame.t === 'project.alias') {
        hub.broadcast(world.renameProject(frame.projectId, frame.name));
        return;
      }
      if (frame.t === 'project.disabled') {
        hub.broadcast(world.setProjectDisabled(frame.projectId, frame.disabled));
        return;
      }
      if (frame.t === 'project.showAll') {
        hub.broadcast(world.showAllProjects());
        return;
      }

      // ── organization: accepted only if the CEOs are really there ─────────
      if (frame.t === 'ceo.say' || frame.t === 'meeting') {
        if (!ceoDesk) {
          const provider = frame.t === 'ceo.say' ? frame.provider : ceoProviders[0] ?? 'claude';
          reply({
            t: 'ceo.stream', at: Date.now(), provider, surface: 'board',
            delta: 'The CEOs are not running: restart with --ceo.', done: true,
          });
          return;
        }
        // The text comes from the client: it is cut here, before it becomes a
        // prompt. No other check -- it is a question, not a command.
        if (frame.t === 'ceo.say') {
          ceoDesk.ask(frame.provider, frame.text.slice(0, 2000), frame.analysis, frame.depth, reply);
        } else {
          // `with` carries provider ids; anything else in it is simply not at
          // the table, because the desk only knows the CEOs it actually built.
          ceoDesk.meeting(
            frame.with as ProviderId[], frame.topic.slice(0, 2000), frame.analysis,
            frame.depth, reply,
          );
        }
        return;
      }
      if (frame.t === 'proposal.decide') {
        if (!ceoDesk) {
          reply({ t: 'error', code: 'internal', detail: 'the CEOs are not running' });
          return;
        }
        ceoDesk.decide(frame.id, frame.accept, reply);
        return;
      }
      if (frame.t === 'proposal.read') {
        if (!ceoDesk) {
          reply({ t: 'error', code: 'internal', detail: 'the CEOs are not running' });
          return;
        }
        // To whoever asked, like an outcome: a task is up to a thousand
        // characters, and the delta channel carries metadata.
        ceoDesk.readProposal(frame.id, reply);
        return;
      }
      if (frame.t === 'job.read' || frame.t === 'job.dismiss') {
        if (!ceoDesk) {
          reply({ t: 'error', code: 'internal', detail: 'the CEOs are not running' });
          return;
        }
        // The outcome goes back to whoever asked for it; everyone sees the
        // dismissal, because the turret sits on the roof of a single HQ.
        if (frame.t === 'job.read') ceoDesk.read(frame.id, reply);
        else ceoDesk.dismiss(frame.id);
        return;
      }
      if (frame.t === 'board.reset' || frame.t === 'jobs.reset') {
        if (!ceoDesk) {
          reply({ t: 'error', code: 'internal', detail: 'the CEOs are not running' });
          return;
        }
        if (frame.t === 'board.reset') ceoDesk.resetBoard();
        else ceoDesk.resetJobs();
        return;
      }
      if (frame.t === 'job.watch' || frame.t === 'job.open') {
        /*
         * The log of a job, or a document it wrote, opened from Reports.
         *
         * A worker's window used to be reachable only through its astronaut,
         * and the astronaut goes back aboard when the session ends: of a
         * finished task nothing could be read but the worker's last message.
         * The transcript is still on disk, and the ledger still knows the
         * session and the project: this is the click that puts them together.
         * The same discipline as `focus`: an id crosses from the client, the
         * session, the folder and the file names come from the server's own
         * records, and the pid -- when the session is still alive -- from the
         * world model.
         */
        const action = frame.t === 'job.watch' ? 'watch' : 'open';
        const fail = (reason: string): void => {
          reply({ t: 'job.result', id: frame.id, action, ok: false, reason });
        };
        if (!ceoDesk) return fail('the CEOs are not running');
        if (!cfg.focus) return fail('disabled');
        const where = ceoDesk.locate(frame.id);
        if (!where) return fail('unknown job');
        const cwd = where.projectId ? world.cwdOf(where.projectId) : undefined;
        if (!cwd) return fail('unknown project');
        const done = (r: FocusResult): void => {
          reply({ t: 'job.result', id: frame.id, action, ok: r.ok, reason: r.ok ? null : r.reason });
        };
        if (frame.t === 'job.open') {
          // An index into the ledger's own list, never a path from the client.
          const file = Number.isInteger(frame.index) && frame.index >= 0 ? where.wrote[frame.index] : undefined;
          if (file === undefined) return fail('no such document');
          void openDocument(cwd, file).then(done);
          return;
        }
        if (!where.sessionId) return fail('the worker never surfaced a session');
        // Still alive: the window follows it and stops when it does. Over:
        // the window prints everything and stops.
        const live = world.session(where.sessionId);
        void followInTerminal({
          provider: where.provider, sessionId: where.sessionId, cwd, pid: live?.pid ?? null,
          node: process.execPath, entry: path.resolve(process.argv[1] ?? ''),
          claudeDir: cfg.claudeDir, codexDir: cfg.codexDir,
        }).then(done);
        return;
      }
      if (frame.t === 'effect.read' || frame.t === 'effect.judge') {
        if (!ceoDesk) {
          reply({ t: 'error', code: 'internal', detail: 'the CEOs are not running' });
          return;
        }
        // Like `job.read`: it is pulled and goes back to whoever asked. The whole
        // board in one go, because recomputation is lazy and one request per row
        // would mean N recomputations for a panel that opens once.
        if (frame.t === 'effect.read') ceoDesk.effects(reply);
        else ceoDesk.judge(frame.id, reply);
        return;
      }
      if (isPlanFrame(frame)) {
        if (!ceoDesk) {
          reply({ t: 'error', code: 'internal', detail: 'the CEOs are not running' });
          return;
        }
        // Text is cut HERE, before it becomes a prompt or a file on disk, as
        // for `ceo.say`: the caps are declared in the protocol and the client
        // enforces them first, so a cut here is a client that lied.
        ceoDesk.plan(clipPlanFrame(frame), reply);
        return;
      }
      if (frame.t === 'project.reveal') {
        const fail = (reason: string): void => {
          reply({ t: 'reveal.result', projectId: frame.projectId, ok: false, reason });
        };
        if (!cfg.focus) return fail('disabled');
        // The path comes from the MODEL: only an id comes from the client.
        const cwd = world.cwdOf(frame.projectId);
        if (!cwd) return fail('unknown project');
        void revealFolder(cwd).then((r) =>
          reply({
            t: 'reveal.result',
            projectId: frame.projectId,
            ok: r.ok,
            reason: r.ok ? null : r.reason,
          }),
        );
        return;
      }
      if (frame.t === 'project.terminal') {
        const fail = (reason: string): void => {
          reply({ t: 'terminal.result', projectId: frame.projectId, ok: false, reason });
        };
        if (!cfg.focus) return fail('disabled');
        // The path comes from the MODEL: only an id comes from the client.
        const cwd = world.cwdOf(frame.projectId);
        if (!cwd) return fail('unknown project');
        void openTerminalAt(cwd).then((r) =>
          reply({ t: 'terminal.result', projectId: frame.projectId, ok: r.ok, reason: r.ok ? null : r.reason }),
        );
        return;
      }
      if (frame.t !== 'focus') return;
      // The capability is checked here and not only in the interface: a client
      // can ask for anything, and a flag that is off must really mean off.
      if (!cfg.focus) {
        reply({ t: 'focus.result', sessionId: frame.sessionId, ok: false, reason: 'disabled' });
        return;
      }
      const session = world.session(frame.sessionId);
      if (!session) {
        reply({ t: 'focus.result', sessionId: frame.sessionId, ok: false, reason: 'unknown session' });
        return;
      }
      // The PID comes from the MODEL, never from the client. `expect` guards
      // against the case where that PID has meanwhile been reassigned to
      // another process.
      void focusTerminal(session.pid, session.provider === 'codex' ? 'codex' : 'claude')
        .then(async (r) => {
          if (r.ok) return r;
          // No process any more: its terminal went with it, so a new one opens
          // in the project, where the next session is one word away.
          if (SESSION_GONE.has(r.reason)) {
            const dir = world.cwdOf(session.projectId);
            return dir ? openTerminalAt(dir) : r;
          }
          // No window of its own -- a CEO's worker, headless: a window that
          // follows it instead. The folder comes from the model, like the pid.
          const cwd = r.reason === NO_TERMINAL ? world.cwdOf(session.projectId) : undefined;
          if (!cwd) return r;
          return followInTerminal({
            provider: session.provider, sessionId: session.id, cwd, pid: session.pid,
            node: process.execPath, entry: path.resolve(process.argv[1] ?? ''),
            claudeDir: cfg.claudeDir, codexDir: cfg.codexDir,
          });
        })
        // The badge waits for this answer: a throw must still send one, or it
        // would spin until its own timeout for nothing.
        .catch((): FocusResult => ({ ok: false, reason: 'the terminal did not respond' }))
        .then((r) => reply({
          t: 'focus.result',
          sessionId: frame.sessionId,
          ok: r.ok,
          reason: r.ok ? null : r.reason,
        }));
    },
  });

  /**
   * The single entry point for the sources' events.
   *
   * `file.touch` cannot go straight to the client: the world model must first
   * assign the file its window and keep count of churn and evictions.
   * Everything else passes through with no intermediary.
   */
  const ingest = (events: readonly DeltaEvent[]): void => {
    const passthrough: DeltaEvent[] = [];
    for (const ev of events) {
      if (ev.t === 'file.touch') hub.broadcast(world.touchFile(ev));
      else if (ev.t === 'git') hub.broadcast(world.applyGit(ev));
      else if (ev.t === 'session.update') hub.broadcast(world.applySessionPatch(ev.id, ev.patch, ev.at));
      // A quota reading carries only the windows its source knows: the model
      // lays it over the others and what leaves here is the merged state.
      else if (ev.t === 'limits') hub.broadcast(world.applyLimits(ev));
      // A subagent's end goes through the model, which keeps count of how many
      // remain in play: just relaying it would leave the counter stuck. A
      // background shell ends with the same notification.
      else if (ev.t === 'agent.remove') {
        hub.broadcast([...world.endAgent(ev.id, ev.at), ...world.endShell(ev.id, ev.at)]);
      }
      else if (ev.t === 'session.cost') {
        noteCost(ev);
        passthrough.push(ev);
      }
      else {
        // The model takes note silently: the event is already on its way to
        // the client, which applies it by itself. It is needed so the snapshot
        // is right also for whoever opens the page with work already under way.
        world.noteSessionEvent(ev);
        passthrough.push(ev);
        // A subagent spawn is not just a tool call: it is one more inhabitant
        // in the building, and it goes into the model as such.
        const born = world.trackAgent(ev);
        if (born.length > 0) passthrough.push(...born);
        // After the agents: an async launch they claimed is not a shell.
        passthrough.push(...world.openShell(ev));
      }
    }
    if (passthrough.length > 0) hub.broadcast(passthrough);
  };

  /**
   * A session's closing tally.
   *
   * It is the only COMPLETE source of its numbers: `usage` events cover only
   * what the tailer read, and on a session older than the warmup window they
   * are a fraction. It is written by ID, never by summing: the tailer rereads
   * the tail of every transcript at every startup, and a ledger that
   * accumulated would double everything at every restart.
   */
  const noteCost = (ev: Extract<DeltaEvent, { t: 'session.cost' }>): void => {
    const totals = {
      confidence: 'reported' as const,
      costUsd: ev.costUsd,
      tokens: ev.tokens,
      apiMs: ev.apiMs,
      toolMs: ev.toolMs,
      wallMs: ev.wallMs,
      linesAdded: ev.linesAdded,
      linesRemoved: ev.linesRemoved,
    };
    if (history.has(ev.sessionId)) {
      history.merge(ev.sessionId, totals);
      history.save();
      return;
    }
    const session = world.session(ev.sessionId);
    // Without a session there is no project to attribute it to, and a row
    // without a project would answer none of the questions one asks.
    if (!session) return;
    history.record({
      id: ev.sessionId,
      projectId: session.projectId,
      provider: session.provider,
      startedAt: ev.at,
      watched: true,
      turns: session.turns,
      toolCalls: session.toolCalls,
      ...totals,
    });
    history.save();
  };

  // Claude Code's consumed quota arrives only from here, and only if the
  // statusline bridge is installed. Without it, the reader idles at no cost,
  // and the CLAUDE row shows the tokens but not the percentages.
  const statuslineFile = dataPath(cfg.stateDir);
  // The plan is read only once: it does not change during a session, and that
  // file is large enough that we don't want to reread it at every update.
  const claudePlan = readPlanLabel(cfg.homeDir, policy);
  // The bridge is our own file: if this version writes a different one, it is
  // updated here, without touching Claude Code's configuration.
  if (refreshBridge({ claudeDir: cfg.claudeDir, stateDir: cfg.stateDir }) && !cfg.quiet) {
    process.stdout.write('  statusline bridge updated\n');
  }
  const statusReader = new StatuslineReader({
    file: statuslineFile,
    sessionsDir: sessionsPath(cfg.stateDir),
    plan: claudePlan,
    emit: (events) => ingest(events),
  });
  // The plan alone, before the first reading: it is the one thing the status
  // line does not carry, and the row shows the tool's name with its plan even
  // while no turn has published a quota yet. It erases nothing -- the model
  // merges windows and keeps the plan -- so the order only decides how soon
  // the name appears.
  if (claudePlan) {
    ingest([
      { t: 'limits', limits: { provider: 'claude', at: Date.now(), windows: [], plan: claudePlan } },
    ]);
  }

  const git = new GitSource({
    policy,
    commitText: cfg.commitText,
    emit: (events) => ingest(events),
  });
  git.start();

  // Buildings exist even without active sessions: the city has a stable
  // geography, and projects that are switched off stay in their place.
  const lastActive = (cwd: string): number => projectLastActive(cfg.claudeDir, cwd);

  // Size is a directory scan, and redoing it at every registry update would
  // be wasteful: it is measured when a project is first seen, and from then
  // on only by `sizeTimer` below, where somebody is working.
  const sizeCache = new Map<string, number>();
  const measureNow = (cwd: string): number => {
    const size = existsOnDisk(cwd) ? measureProject(cwd, cfg.homeDir) : 0;
    sizeCache.set(cwd, size);
    return size;
  };
  const measure = (cwd: string): number => sizeCache.get(cwd) ?? measureNow(cwd);

  const knownProjects = readKnownProjectPaths(cfg.homeDir, policy).filter(known);

  // Order matters only HERE, once: projects still without a place are placed
  // from most recent to oldest, so the most recent takes the center. From now
  // on no building moves any more.
  placement.assignMany(
    knownProjects.map((cwd) => ({ id: projectIdFor(cwd), lastActiveAt: lastActive(cwd) })),
  );
  hub.broadcast(world.ensureProjects(knownProjects, existsOnDisk, lastActive, measure));
  placement.save();
  git.watch(knownProjects.filter(existsOnDisk));

  /*
   * The tallies of already closed sessions, recovered only once.
   *
   * Without them, history would start empty and fill only going forward: the
   * tailer follows the sessions in the registry, and nobody opens a closed
   * transcript. Only the tail of each file is read -- 275 MB of transcripts
   * are not scanned at startup -- and only within the row window, because
   * beyond it history is already aggregated by month, and a half-built
   * aggregate would state a wrong number instead of staying silent.
   *
   * `has()` guards against two things at once: the restart, which would
   * reread the same files, and a row already written while watching that
   * session work, which also carries the counters and must not be replaced
   * by one that doesn't.
   */
  let seeded = 0;
  for (const seed of readClosedCosts(knownProjects, {
    claudeDir: cfg.claudeDir,
    policy,
    maxAgeMs: HISTORY_ROW_DAYS * 24 * 60 * 60 * 1000,
  })) {
    const rec = seed.record;
    if (history.has(rec.sessionId)) continue;
    history.record({
      id: rec.sessionId,
      projectId: projectIdFor(seed.cwd),
      // Only Claude Code writes `cost-state`: Codex leaves no tallies.
      provider: 'claude',
      startedAt: rec.timestamp,
      confidence: 'reported',
      // We found its receipt, we didn't watch it work: turns and calls stay
      // at zero, and whoever reads must know it.
      watched: false,
      costUsd: rec.costUsd,
      tokens: rec.tokens,
      turns: 0,
      toolCalls: 0,
      apiMs: rec.apiMs,
      toolMs: rec.toolMs,
      wallMs: rec.wallMs,
      linesAdded: rec.linesAdded,
      linesRemoved: rec.linesRemoved,
    });
    seeded++;
  }
  if (seeded > 0) {
    history.save();
    if (!cfg.quiet) process.stdout.write(`  history:   ${seeded} closed sessions recovered\n`);
  }

  const transcripts = new TranscriptSource({
    claudeDir: cfg.claudeDir,
    policy,
    warmupBytes: cfg.warmupBytes,
    stats,
    // The guard costs little but it is a safety net: in development it makes
    // a too-long string fail at once instead of letting it be found in
    // production.
    devAssert: cfg.dev,
    emit: ingest,
  });

  const redactFor = (cwd: string): RedactOptions => ({
    projectId: projectIdFor(cwd),
    cwd,
    redactPaths: cfg.redactPaths,
    cmdNames: cfg.cmdNames,
    titles: cfg.titles,
    recap: cfg.recap,
  });

  const registry = new RegistrySource(cfg.claudeDir, policy, (sessions) => {
    hub.broadcast(
      world.applyLiveSessions(
        'claude', sessions.filter((s) => produces(s.cwd)), existsOnDisk, lastActive, measure,
      ),
    );
    placement.save();
    transcripts.sync(
      sessions
        .filter((s) => produces(s.cwd))
        .map((s) => ({ sessionId: s.sessionId, cwd: s.cwd, startedAt: s.startedAt })),
      redactFor,
    );
  });
  if (cfg.providers.includes('claude')) registry.start();
  // After the registry, which reads its sessions at once: the reader's first
  // pass reads every status line copy and then only the ones that change, so
  // read before the sessions existed, a context was dropped and not read again
  // until that session redrew its line. The world also keeps an early reading
  // for a session born a second later.
  statusReader.start();

  // A project grows while a session works in it, and the first measure of a
  // new one is of an empty folder: the towers where somebody lives are
  // measured again, and the map hears about it only if the number moved.
  const sizeTimer = setInterval(() => {
    hub.broadcast(world.refreshSizes(measureNow));
  }, SIZE_REFRESH_MS);
  sizeTimer.unref();

  // ── Codex, if installed ──────────────────────────────────────────────
  // A missing provider is not an error: it is skipped silently and the city
  // shows only the other tool.
  const codex = new CodexProvider({
    codexDir: cfg.codexDir,
    policy,
    redactPaths: cfg.redactPaths,
    cmdNames: cfg.cmdNames,
    titles: cfg.titles,
    known,
    produces,
    devAssert: cfg.dev,
    stats,
  });

  const codexEnabled = cfg.providers.includes('codex') && codex.isAvailable();
  if (codexEnabled) {
    codex.start({
      onProjects: (cwds) => {
        hub.broadcast(world.ensureProjects(cwds, existsOnDisk, lastActive, measure));
        placement.save();
        git.watch(cwds.filter(existsOnDisk));
      },
      onSessions: (sessions) => {
        hub.broadcast(world.applyLiveSessions('codex', sessions, existsOnDisk, lastActive, measure));
        placement.save();
      },
      onEvents: ingest,
    });
  }

  /* ── the CEOs, if you asked for them ───────────────────────────────────
   * Dynamic import and not static: without `--ceo` this module is never
   * loaded, and deleting `src/server/ceo/` the rest of the program keeps
   * compiling. A failure here does not stop the world from running: you lose
   * the desk, not the observatory.
   */
  if (cfg.ceo) {
    try {
      // Composed at runtime, and NOT a whim: with a string literal TypeScript
      // resolves the module even in a dynamic import, and the passive version
      // stops compiling. `npm run check:passive` catches it.
      const where = ['.', 'ceo', 'index.ts'].join('/');
      const { createCeoDesk } = (await import(where)) as CeoModule;
      ceoProviders = codexEnabled ? cfg.providers : cfg.providers.filter((p) => p !== 'codex');
      ceoDesk = createCeoDesk({
        providers: ceoProviders,
        model: cfg.ceoModel,
        codexModel: cfg.ceoCodexModel,
        stateDir: cfg.stateDir,
        caps: {
          quotaMaxPercent: cfg.ceoQuotaMaxPercent,
          budgetUsd: cfg.ceoBudgetUsd,
          maxCallUsd: cfg.ceoMaxCallUsd,
          metered: cfg.ceoMetered,
        },
        snapshot: () => world.snapshot(),
        // The real path comes from the MODEL, never from the client: an id
        // comes from the browser, as for `focus` and for `project.reveal`.
        cwdOf: (projectId) => world.cwdOf(projectId),
        history: (days) => history.digest(Date.now(), days),
        weightedSince: (provider, since, at) => history.weightedSince(provider, since, at),
        /*
         * A reading from a CEO's own process, into the state the status line
         * feeds. Only the windows the event carries: laying them over the ones
         * already known -- the status line may know one more, a model's own
         * week -- and keeping the plan, which comes from elsewhere, is the
         * model's job, the same for every source.
         */
        noteQuota: (provider, windows) => {
          ingest([{ t: 'limits', limits: { provider, at: Date.now(), windows, plan: null } }]);
        },
        projectSessions: (projectId, from, to) => history.between(projectId, from, to),
        // Rows of one fleet across every project: the price of a planned task
        // before an attempt has taught it. Read-only, like the line above.
        closedSessions: (provider, from, to) => world.snapshot().projects
          .flatMap((p) => history.between(p.id, from, to))
          .filter((s) => s.provider === provider),
        tickMs: cfg.ceoEveryMs,
        execute: cfg.execute,
        ...(cfg.notify ? { notify: notifyDesktop } : {}),
        /*
         * The same guard the transcript sources use, on the way out of the desk.
         *
         * A CEO writes text, which is exactly the kind of source this net was
         * built for: `report.title` and `proposal.summary` are model output, and
         * nothing else on the delta channel is. The wrapper lives HERE and not
         * inside `ceo/` so that deleting the folder cannot delete the guard.
         */
        broadcast: (events) => {
          for (const ev of events) {
            if (cfg.dev) assertSafe(ev);
            else stats.redactionClamps += clampUnsafe(ev);
          }
          hub.broadcast(events);
        },
      });
      hub.broadcast(ceoDesk.states());
    } catch (err) {
      process.stderr.write(`ceo: not started (${String((err as Error)?.message)})\n`);
    }
  }

  if (!cfg.quiet) {
    const c = world.counts;
    process.stdout.write(
      `\n  TOWERGLOW\n` +
        `  open:      http://127.0.0.1:${port}/?t=${cfg.token}\n` +
        `  claudeDir: ${cfg.claudeDir}\n` +
        // With two copies of the tree running it is the first thing to know:
        // which city you are looking at. The URL tells the port, not the state.
        `  state:     ${cfg.stateDir}\n` +
        `  city:      ${c.projects} towers, ${c.sessions} live sessions\n` +
        `  providers: claude${codexEnabled ? ' + codex' : ' (codex not found)'}\n` +
        `  ceo:       ${cfg.ceo ? `on, ${cfg.ceoModel} - stops above ${cfg.ceoQuotaMaxPercent}% quota` : 'off'}\n` +
        billingLines(cfg, ceoDesk ? ceoProviders : []) +
        // Without the CEOs nothing can be executed: saying EXECUTIVE there
        // would tell someone who chose the observatory the opposite of the truth.
        `  mode:      ${!cfg.ceo ? 'observatory' : cfg.execute ? 'EXECUTIVE' : 'advisor'}\n` +
        `  network:   no outbound connections` +
        `${cfg.ceo ? " (except the claude and codex processes the CEOs start)" : ''}\n\n`,
    );
  }

  const shutdown = (): void => {
    clearInterval(sizeTimer);
    registry.stop();
    transcripts.stop();
    codex.stop();
    git.stop();
    statusReader.stop();
    history.save();
    ceoDesk?.close();
    hub.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return -1; // keeps listening
}

/**
 * `towerglow watch`: a session's transcript in this terminal, followed.
 *
 * What the terminal button opens for a session with no terminal of its own.
 * Every argument is checked here even though the server wrote them: this is a
 * command anyone can type.
 */
async function watch(
  cfg: Config,
  sessionId: string,
  provider: string | undefined,
  cwd: string | undefined,
  pid: string | undefined,
  once: boolean,
): Promise<number> {
  if (!validSessionId(sessionId)) {
    process.stderr.write('watch: a session id is required\n');
    return 2;
  }
  if (provider !== 'claude' && provider !== 'codex') {
    process.stderr.write('watch: --provider must be claude or codex\n');
    return 2;
  }
  if (!cwd || !path.isAbsolute(cwd)) {
    process.stderr.write('watch: --cwd must be the absolute path of the project\n');
    return 2;
  }
  const n = pid === undefined ? null : Number(pid);
  if (n !== null && (!Number.isInteger(n) || n <= 1)) {
    process.stderr.write('watch: --pid must be a process id\n');
    return 2;
  }
  return follow({
    provider,
    sessionId,
    cwd,
    policy: { claudeDir: cfg.claudeDir, codexDir: cfg.codexDir, homeDir: cfg.homeDir },
    alive: n === null ? null : () => processAlive(n),
    // `--once` wins over a pid: the log is read after the fact, whatever the process does now.
    once,
    write: (text) => { process.stdout.write(text); },
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    now: () => Date.now(),
    paint: paintFor(process.stdout.isTTY === true),
  });
}

function doctor(cfg: Config): number {
  const out: string[] = [];
  out.push(`towerglow ${VERSION} (protocol v${PROTOCOL_VERSION})`);
  out.push(`node        ${process.version}`);
  out.push(`platform    ${process.platform} ${process.arch}`);
  if (process.platform === 'win32') {
    out.push(`WARNING     v1 targets macOS/Linux: session discovery does not work on Windows`);
  }
  out.push(`homeDir     ${cfg.homeDir}`);
  out.push(`claudeDir   ${cfg.claudeDir} ${fs.existsSync(cfg.claudeDir) ? '(found)' : '(MISSING)'}`);
  out.push(`stateDir    ${cfg.stateDir}`);
  out.push(`token       ${cfg.token.slice(0, 4)}… (${cfg.token.length} chars, mode 0600)`);

  const sessionsDir = `${cfg.claudeDir}/sessions`;
  let live = 0;
  try {
    for (const name of fs.readdirSync(sessionsDir)) {
      if (!/^\d+\.json$/.test(name)) continue;
      live++;
    }
    out.push(`sessions    ${live} registry files in ${sessionsDir}`);
  } catch {
    out.push(`sessions    cannot read ${sessionsDir}`);
  }

  out.push(`cpu         ${os.cpus().length} cores`);
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

const code = await main(process.argv.slice(2));
if (code >= 0) process.exit(code);

/**
 * The bridge to the statusline: install, uninstall, status.
 *
 * It is the only command that writes into `~/.claude`, and it does so on a
 * single key, with backup and restore. It must be asked for: it never turns
 * itself on.
 */
function statusline(cfg: Config, action: string): number {
  const paths = { claudeDir: cfg.claudeDir, stateDir: cfg.stateDir };
  try {
    if (action === 'install') {
      const before = statuslineStatus(paths);
      const after = installStatusline(paths);
      process.stdout.write(
        `status line bridged.\n` +
          `  wrapping: ${after.wrapped ?? '(nothing was configured)'}\n` +
          `  bridge:   ${after.bridgePath}\n` +
          `  data:     ${after.dataPath}\n` +
          (before.installed ? '  (updated an existing bridge)\n' : '') +
          `\nThe numbers appear after Claude Code answers once in any session.\n`,
      );
      return 0;
    }
    if (action === 'uninstall') {
      const done = uninstallStatusline(paths);
      process.stdout.write(
        done === 'restored'
          ? 'status line restored: your previous status line is back in settings.json.\n'
          : 'the bridge is not your status line: settings.json left untouched.\n',
      );
      return 0;
    }
    if (action === 'status') {
      const s = statuslineStatus(paths);
      process.stdout.write(
        s.installed
          ? `bridged.\n  wrapping: ${s.wrapped ?? '(nothing)'}\n  data: ${s.dataPath}\n`
          : 'not bridged. Run: towerglow statusline install\n',
      );
      return 0;
    }
  } catch (err) {
    if (err instanceof StatuslineError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
  process.stderr.write(`unknown statusline action: ${action}\n`);
  return 2;
}
