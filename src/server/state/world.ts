import * as path from 'node:path';
import type {
  AgentInfo, DeltaEvent, FileNode, ProjectInfo, ProviderId, ProviderLimits, SessionInfo,
  SessionStatus, Snapshot, TargetRef, TokenTotals,
} from '../../shared/protocol.ts';
import { mergeWindows } from '../../shared/limits.ts';
import { projectIdFor, redactName } from './ids.ts';
import { RingLedger } from '../../shared/rings.ts';
import { floorOfDir, floorsForSize, windowColumn } from '../../shared/layout.ts';
import { RingBuffer } from './ringBuffer.ts';
import type { PlacementStore } from './placement.ts';
import type { Prefs } from './prefs.ts';
import type { LiveSession } from '../providers/types.ts';

export interface WorldOptions {
  homeDir: string;
  placement: PlacementStore;
  redactPaths: boolean;
  titles: boolean;
  /** Beyond this number of files per project, the least recent is evicted. */
  maxFilesPerProject?: number;
  /** Aliases and hidden projects. Absent in tests, which always start clean. */
  prefs?: Prefs | null;
  /**
   * The recap a session is born with, if one is found.
   *
   * It is a read from disk, and the model does not read from disk: it is
   * handed over already done, so that only the decision about what to show
   * stays here. Absent in tests, and null for providers that do not write a
   * recap.
   */
  seedRecap?: (session: LiveSession) => SeededRecap | null;
  /**
   * The tools that have already worked on a project, from whoever remembers
   * them.
   *
   * The model forgets a session as soon as it exits, so on its own it could
   * only answer "who is working on it right now". The question that matters
   * is a different one -- "do I use both tools here" -- and history knows
   * that one.
   */
  providersSeed?: (projectId: string) => readonly ProviderId[];
  /**
   * A session has left the stage.
   *
   * It lives here and not in `cli.ts` because this is the ONLY place where a
   * session is deleted: hooking it elsewhere would mean guessing when it
   * happens, and losing precisely the sessions that closed while you were not
   * looking.
   */
  onSessionClosed?: (session: SessionInfo) => void;
  /**
   * Is a newly discovered session a worker opened by the CEOs?
   *
   * It is asked by PID, which is the only thing the two paths have in common:
   * whoever launched it knows the process, whoever discovered it reads the
   * registry. Answering with a provider makes the session be born with
   * `spawnedByCeo`, so it goes up onto the HQ's roof instead of settling in
   * the project -- and it is the same one the fleet's placeholder was
   * standing in for, so answering also means removing that.
   *
   * Injected, and null by default: `world.ts` is not CEO code, and must
   * compile even when that folder does not exist.
   */
  adoptCeoSession?: (pid: number, sessionId: string) => ProviderId | null;
}

/** The recap found elsewhere, with the warning if it does not belong to the session. */
export interface SeededRecap {
  text: string;
  at: number;
  inherited: boolean;
}

/**
 * Beyond this age a subagent is considered finished, once its session's tool
 * no longer says that something of it runs.
 *
 * It is not a deadline invented on top of good data, it is a safety net: the
 * warm-up reads the tail of the transcript, and it can happen to find an
 * agent's BIRTH without its delivery, which was a few megabytes further back.
 * Without this pruning that window would stay lit forever -- and a window
 * that never goes dark stops saying anything.
 */
const MAX_AGENT_AGE_MS = 30 * 60_000;

/**
 * Background shells whose end has not been seen. A live session's are
 * dropped when it exits; this cap is for the dead ones: the warm-up reads the
 * tails of old transcripts too, and a launch whose notification was never
 * written belongs to a session no registry will show again.
 */
const MAX_OPEN_SHELLS = 256;

const ZERO_TOKENS: TokenTotals = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };

/**
 * Authoritative model of the world.
 *
 * The sources observe; this is where it is decided what changed. Keeping the
 * diff in one place stops every source from reinventing its own add/update
 * logic.
 */
export class World {
  #opts: Required<WorldOptions>;
  #placement: PlacementStore;
  #prefs: Prefs | null = null;
  #projects = new Map<string, ProjectInfo>();
  /**
   * The real path of every project.
   *
   * It lives here and NOT in `ProjectInfo` on purpose: the client does not
   * need the path at all, and what does not cross the WebSocket cannot end up
   * in a screenshot. A `pathHint` with the path under `~` used to travel in
   * every snapshot, read by nobody: it is gone. Whoever wants to open that
   * folder sends the id, and the path is found again here.
   */
  #cwds = new Map<string, string>();
  #sessions = new Map<string, SessionInfo>();
  #agents = new Map<string, AgentInfo>();
  /**
   * Shells Claude sent to the background, by call id, with their session.
   * They are what makes a registry `shell` work, with the subagents still
   * open (`#statusOf`): a shell typed with `!` is not here, and leaves its
   * session idle.
   */
  #shells = new Map<string, string>();
  /** Sessions whose registry says the turn is over and a shell still runs. */
  #shellReported = new Set<string>();
  #files = new Map<string, FileNode>();
  /** Occupied columns per project and floor: prevents two overlapping windows. */
  #windows = new Map<string, Map<number, Set<number>>>();
  /** Occupied desks per project: index 0 is the boss's workstation. */
  #desks = new Map<string, Set<number>>();
  #recent = new RingBuffer<DeltaEvent>(256);
  /** A context reading for a session the registry has not shown yet: kept until it is born. */
  #earlyContext = new Map<string, number>();
  /** The git events on the towers: the last hour's, each once. */
  #rings = new RingLedger();
  /** Quota consumed per tool: one state per provider, not per session. */
  #limits = new Map<ProviderId, ProviderLimits>();
  #version = 0;

  constructor(opts: WorldOptions) {
    this.#placement = opts.placement;
    this.#prefs = opts.prefs ?? null;
    this.#opts = {
      homeDir: opts.homeDir,
      placement: opts.placement,
      redactPaths: opts.redactPaths,
      titles: opts.titles,
      maxFilesPerProject: opts.maxFilesPerProject ?? 512,
      prefs: opts.prefs ?? null,
      seedRecap: opts.seedRecap ?? (() => null),
      providersSeed: opts.providersSeed ?? (() => []),
      onSessionClosed: opts.onSessionClosed ?? (() => {}),
      adoptCeoSession: opts.adoptCeoSession ?? (() => null),
    };
  }

  /**
   * What a project is called on screen. It touches nothing on disk: it is a
   * sign, and the real name stays underneath so it can be restored.
   */
  renameProject(projectId: string, alias: string | null): DeltaEvent[] {
    const project = this.#projects.get(projectId);
    if (!project || !this.#prefs) return [];
    this.#prefs.setAlias(projectId, alias);
    this.#prefs.save();
    const name = this.#prefs.aliasOf(projectId) ?? project.realName;
    if (name === project.name) return [];
    const next = { ...project, name };
    this.#projects.set(projectId, next);
    return this.#record([{ t: 'project.add', project: next }]);
  }

  /** Hides or re-shows a project. The slot stays its own: shown again, it returns where it was. */
  setProjectDisabled(projectId: string, disabled: boolean): DeltaEvent[] {
    const project = this.#projects.get(projectId);
    if (!project || !this.#prefs || project.disabled === disabled) return [];
    this.#prefs.setDisabled(projectId, disabled);
    this.#prefs.save();
    const next = { ...project, disabled };
    this.#projects.set(projectId, next);
    return this.#record([{ t: 'project.add', project: next }]);
  }

  /** Brings back into view everything that had been hidden. */
  showAllProjects(): DeltaEvent[] {
    if (!this.#prefs) return [];
    const out: DeltaEvent[] = [];
    for (const id of this.#prefs.showAll()) {
      const project = this.#projects.get(id);
      if (!project) continue;
      const next = { ...project, disabled: false };
      this.#projects.set(id, next);
      out.push({ t: 'project.add', project: next });
    }
    this.#prefs.save();
    return this.#record(out);
  }

  get version(): number {
    return this.#version;
  }

  /** Registers the known projects: the buildings exist even without active sessions. */
  ensureProjects(
    cwds: readonly string[],
    existsCheck: (cwd: string) => boolean,
    lastActive: (cwd: string) => number,
    measure: (cwd: string) => number,
  ): DeltaEvent[] {
    const out: DeltaEvent[] = [];
    for (const cwd of cwds) {
      const ev = this.#ensureProject(cwd, existsCheck(cwd), lastActive(cwd), measure(cwd));
      if (ev) out.push(ev);
    }
    return this.#record(out);
  }

  #ensureProject(cwd: string, exists: boolean, lastActiveAt: number, size: number): DeltaEvent | null {
    const id = projectIdFor(cwd);
    const known = this.#projects.get(id);
    if (known) {
      if (known.exists !== exists || lastActiveAt > known.lastActiveAt) {
        this.#projects.set(id, { ...known, exists, lastActiveAt: Math.max(known.lastActiveAt, lastActiveAt) });
      }
      return null;
    }
    const base = path.basename(cwd) || cwd;
    const realName = this.#opts.redactPaths ? redactName(base) : base;
    const project: ProjectInfo = {
      id,
      name: this.#prefs?.aliasOf(id) ?? realName,
      realName,
      disabled: this.#prefs?.isDisabled(id) ?? false,
      slot: this.#placement.slotOf(id),
      exists,
      firstSeenAt: Date.now(),
      lastActiveAt,
      size,
      lastCommit: null,
      branch: null,
      commits: 0,
      providers: [...this.#opts.providersSeed(id)],
    };
    this.#projects.set(id, project);
    this.#cwds.set(id, cwd);
    this.#desks.set(id, new Set());
    return { t: 'project.add', project };
  }

  /**
   * Measures again the projects somebody is working in.
   *
   * A project is measured when it is first seen, and a new project is first
   * seen as an empty folder: the session that will fill it has just opened.
   * Seen on 2026-09-28: tower_defense, created an hour earlier, had grown to
   * 98 files and still stood as the tower of an empty folder -- four floors
   * on the narrowest base in the city -- because the size was read once per
   * server, and the server stays up for days.
   *
   * Only where a session lives: that is where files appear, and scanning
   * every folder on the map again and again would be the cost of startup,
   * paid forever. An unchanged size says nothing: the event rebuilds the
   * map on the other side.
   */
  refreshSizes(measure: (cwd: string) => number): DeltaEvent[] {
    const worked = new Set<string>();
    for (const s of this.#sessions.values()) worked.add(s.projectId);
    const out: DeltaEvent[] = [];
    for (const id of worked) {
      const project = this.#projects.get(id);
      const cwd = this.#cwds.get(id);
      if (!project || cwd === undefined || !project.exists) continue;
      const size = measure(cwd);
      if (size === project.size) continue;
      const next = { ...project, size };
      this.#projects.set(id, next);
      out.push({ t: 'project.add', project: next });
    }
    return this.#record(out);
  }

  /**
   * Reconciles the complete set of live sessions.
   * The sources always send everything: this is where it is computed what was
   * born, what changed and what disappeared.
   */
  /**
   * Reconciles the live sessions OF A SINGLE provider.
   *
   * The per-provider filter is not a detail: without it, each adapter would
   * delete the other's sessions on every pass, and the two tools would switch
   * each other off in the same city.
   */
  applyLiveSessions(
    provider: ProviderId,
    live: readonly LiveSession[],
    existsCheck: (cwd: string) => boolean,
    lastActive: (cwd: string) => number,
    measure: (cwd: string) => number,
  ): DeltaEvent[] {
    const out: DeltaEvent[] = [];
    const now = Date.now();
    const seen = new Set<string>();
    /** Sessions whose tool says something of theirs still runs: see the age net below. */
    const running = new Set<string>();

    for (const s of live) {
      seen.add(s.sessionId);
      if (s.status !== 'idle' || s.backgroundShell) running.add(s.sessionId);
      // A live session is in itself very recent activity: the building
      // slides toward the center of the row even if the transcript has not
      // been touched yet.
      const projectEvent = this.#ensureProject(
        s.cwd,
        existsCheck(s.cwd),
        Math.max(lastActive(s.cwd), s.updatedAt),
        measure(s.cwd),
      );
      if (projectEvent) out.push(projectEvent);

      const projectId = projectIdFor(s.cwd);
      const existing = this.#sessions.get(s.sessionId);
      if (s.backgroundShell) this.#shellReported.add(s.sessionId);
      else this.#shellReported.delete(s.sessionId);
      const status = this.#statusOf(s.sessionId, s.status);

      if (!existing) {
        // A session born just now has not written an `away_summary` yet, and
        // after a `/clear` the one that had it has just walked out the door
        // next to it: without this graft the card would stay silent for a
        // good half hour, right while the work goes on.
        const seed = this.#opts.seedRecap(s);
        // Asked only once, at birth: that is the moment the session chooses
        // where to be, and the adoption has an effect on the other side.
        const spawnedByCeo = this.#opts.adoptCeoSession(s.pid, s.sessionId);
        const session: SessionInfo = {
          id: s.sessionId,
          projectId,
          pid: s.pid,
          label: this.#opts.redactPaths ? redactName(s.label) : s.label,
          title: s.title,
          status,
          waitingFor: s.waitingFor,
          kind: s.kind,
          model: s.model,
          ccVersion: s.version,
          gitBranch: null,
          permissionMode: null,
          isCeo: false,
          spawnedByCeo,
          provider: s.provider,
          statusConfidence: s.statusConfidence,
          startedAt: s.startedAt,
          lastActivityAt: s.updatedAt,
          statusSince: s.statusSince,
          tokens: { ...ZERO_TOKENS },
          contextLeft: null,
          contextPct: s.contextPct ?? this.#takeContext(s.sessionId),
          compactedAt: s.compactedAt ?? null,
          turns: 0,
          toolCalls: 0,
          lastTurnMs: null,
          turnsMs: 0,
          reasoningMs: s.reasoningMs ?? null,
          recap: seed?.text ?? null,
          recapAt: seed?.at ?? null,
          recapInherited: seed?.inherited ?? false,
          activityTool: null,
          activityTarget: null,
          agentsActive: 0,
          deskIndex: this.#claimDesk(projectId),
        };
        this.#sessions.set(s.sessionId, session);
        out.push({ t: 'session.add', session });
        const marked = this.#markProvider(projectId, s.provider);
        if (marked) out.push(marked);
        continue;
      }

      const patch: Partial<SessionInfo> = {};
      if (existing.status !== status) patch.status = status;
      if (existing.statusConfidence !== s.statusConfidence) patch.statusConfidence = s.statusConfidence;
      if (s.title !== null && existing.title !== s.title) patch.title = s.title;
      if (s.model !== null && existing.model !== s.model) patch.model = s.model;
      if (existing.statusSince !== s.statusSince) patch.statusSince = s.statusSince;
      if (existing.waitingFor !== s.waitingFor) patch.waitingFor = s.waitingFor;
      if (existing.lastActivityAt !== s.updatedAt) patch.lastActivityAt = s.updatedAt;
      const reasoning = s.reasoningMs ?? null;
      if (reasoning !== null && reasoning !== existing.reasoningMs) patch.reasoningMs = reasoning;
      const ctx = s.contextPct ?? null;
      if (ctx !== null && ctx !== existing.contextPct) patch.contextPct = ctx;
      // Only a provider that reads it says it: Claude Code's comes from the
      // transcript, and a registry pass knows nothing of it.
      const compacted = s.compactedAt ?? null;
      if (compacted !== null && compacted !== existing.compactedAt) patch.compactedAt = compacted;
      const label = this.#opts.redactPaths ? redactName(s.label) : s.label;
      if (existing.label !== label) patch.label = label;

      if (Object.keys(patch).length > 0) {
        this.#sessions.set(s.sessionId, { ...existing, ...patch });
        out.push({ t: 'session.update', id: s.sessionId, patch, at: now });
      }
    }

    // Agents too old to still be at work: they are closed here, where time
    // passes anyway, instead of adding a timer just for them. Not one launched
    // in the background while its session's tool says something still runs:
    // Claude Code's registry says `busy` while such a subagent runs and
    // `shell` while one waits on its own shell, and a real one ran 31 minutes
    // and then waited an hour on its tests (2026-10-15). Closed at 30, it
    // took the tower's lightning along. A synchronous one ends with its call.
    for (const [id, agent] of [...this.#agents]) {
      if (now - agent.startedAt < MAX_AGENT_AGE_MS) continue;
      if (agent.agentId !== null && running.has(agent.sessionId)) continue;
      const owner = this.#sessions.get(agent.sessionId);
      if (owner && owner.provider !== provider) continue;
      out.push(...this.endAgent(id, now));
    }

    for (const [id, session] of this.#sessions) {
      if (session.provider !== provider) continue;
      // No exception for CEO workers: they sign up to the registry like
      // everyone else, so they get reaped like everyone else. When the fleet
      // invented one of its own there was a skip here, and that skip --
      // applied to a real session -- would have kept it lit forever after its
      // death.
      if (seen.has(id)) continue;
      this.#releaseDesk(session.projectId, session.deskIndex);
      // Before the deletion: afterwards, nothing is left of this session.
      this.#opts.onSessionClosed(session);
      this.#sessions.delete(id);
      this.#earlyContext.delete(id);
      this.#shellReported.delete(id);
      for (const [callId, owner] of [...this.#shells]) if (owner === id) this.#shells.delete(callId);
      for (const [agentId, agent] of this.#agents) {
        if (agent.sessionId !== id) continue;
        this.#agents.delete(agentId);
        out.push({ t: 'agent.remove', id: agentId, at: now, reason: 'stop' });
      }
      out.push({ t: 'session.remove', id, at: now, reason: 'exit' });
    }

    return this.#record(out);
  }

  /**
   * Marks that a tool has worked here. Sticky: it is never removed.
   *
   * `project.add` is sent again because on the client it is an upsert by id:
   * there is no `project.update`, and inventing one for a single field would
   * cost more than it is worth.
   */
  #markProvider(projectId: string, provider: ProviderId): DeltaEvent | null {
    const project = this.#projects.get(projectId);
    if (!project || project.providers.includes(provider)) return null;
    const next = { ...project, providers: [...project.providers, provider] };
    this.#projects.set(projectId, next);
    return { t: 'project.add', project: next };
  }

  /** The lowest free workstation: 0 is the desk at the head. */
  #claimDesk(projectId: string): number {
    let desks = this.#desks.get(projectId);
    if (!desks) {
      desks = new Set();
      this.#desks.set(projectId, desks);
    }
    let i = 0;
    while (desks.has(i)) i++;
    desks.add(i);
    return i;
  }

  #releaseDesk(projectId: string, index: number): void {
    this.#desks.get(projectId)?.delete(index);
  }

  /**
   * A touched file lights up its window.
   *
   * Floor and column are assigned on the FIRST appearance and never change
   * again: a window that jumps around on every edit would make it impossible
   * to recognize the file by looking at the facade.
   */
  touchFile(ev: Extract<DeltaEvent, { t: 'file.touch' }>): DeltaEvent[] {
    const out: DeltaEvent[] = [];
    const project = this.#projects.get(ev.projectId);
    if (!project) return out;

    let node = this.#files.get(ev.fileId);
    if (!node) {
      const floors = floorsForSize(project.size);
      const floor = floorOfDir(ev.dir, floors);

      let taken = this.#windows.get(ev.projectId);
      if (!taken) {
        taken = new Map();
        this.#windows.set(ev.projectId, taken);
      }
      let onFloor = taken.get(floor);
      if (!onFloor) {
        onFloor = new Set();
        taken.set(floor, onFloor);
      }
      const col = windowColumn(ev.path, onFloor);
      onFloor.add(col);

      node = {
        id: ev.fileId,
        projectId: ev.projectId,
        path: ev.path,
        ext: ev.ext,
        dir: ev.dir,
        floor,
        col,
        reads: 0,
        writes: 0,
        churn: 0,
        firstSeenAt: ev.at,
        lastTouchAt: ev.at,
      };
      this.#files.set(ev.fileId, node);
    }

    const updated: FileNode = {
      ...node,
      reads: node.reads + (ev.op === 'read' ? 1 : 0),
      writes: node.writes + (ev.op === 'read' ? 0 : 1),
      churn: node.churn + Math.max(0, ev.changed),
      lastTouchAt: Math.max(node.lastTouchAt, ev.at),
    };
    this.#files.set(ev.fileId, updated);

    out.push({ ...ev, fileId: updated.id, floor: updated.floor, col: updated.col });
    out.push(...this.#evictFiles(ev.projectId));
    return this.#record(out);
  }

  /**
   * Applies a session update that arrived from the transcript.
   *
   * Without this step the event reached the client but NOT the model:
   * whoever opened the page later did not see the turn's title, because the
   * snapshot still held the session as it was at birth.
   */
  applySessionPatch(id: string, patch: Partial<SessionInfo>, at: number): DeltaEvent[] {
    const existing = this.#sessions.get(id);
    if (!existing) {
      // The status line can speak before the registry: at startup the reader
      // reads every copy once, then only the ones that change. A context
      // dropped here stayed lost until that session next redrew its status
      // line -- after a restart, a busy tower_defense showed no context at all.
      if (typeof patch.contextPct === 'number') this.#rememberContext(id, patch.contextPct);
      return [];
    }
    this.#sessions.set(id, { ...existing, ...patch });
    return this.#record([{ t: 'session.update', id, patch, at }]);
  }

  #rememberContext(id: string, pct: number): void {
    this.#earlyContext.delete(id);
    this.#earlyContext.set(id, pct);
    // A handful at most: a copy for a session that never shows up must not pile up.
    while (this.#earlyContext.size > 64) this.#earlyContext.delete(this.#earlyContext.keys().next().value!);
  }

  #takeContext(id: string): number | null {
    const pct = this.#earlyContext.get(id);
    this.#earlyContext.delete(id);
    return pct ?? null;
  }

  /**
   * Closes an agent by call id, or by the `agentId` its launch returned,
   * which is the id of its task. Used by whoever watches for its end.
   */
  endAgent(ref: string, at: number): DeltaEvent[] {
    const id = this.#agents.has(ref) ? ref : this.#agentByTask(ref);
    const agent = id === undefined ? undefined : this.#agents.get(id);
    if (id === undefined || !agent) return [];
    this.#agents.delete(id);
    this.#releaseDesk(agent.projectId, agent.deskIndex);
    const session = this.#sessions.get(agent.sessionId);
    if (session) {
      this.#sessions.set(agent.sessionId, {
        ...session,
        agentsActive: Math.max(0, session.agentsActive - 1),
      });
    }
    return [
      ...this.#record([{ t: 'agent.remove', id, at, reason: 'stop' }]),
      // It may have been the one keeping a registry `shell` working.
      ...this.#restatus(agent.sessionId, at),
    ];
  }

  #agentByTask(taskId: string): string | undefined {
    for (const [id, agent] of this.#agents) if (agent.agentId === taskId) return id;
    return undefined;
  }

  /**
   * Birth and death of a subagent, from the call to the `Task` tool.
   *
   * It is the signal that already exists: `redact.ts` recognizes
   * `subagent_type` and carries it into the call's target, so a `tool.start`
   * of category `agent` IS the spawn of a subagent. The tool use id becomes
   * the agent's id: it is unique, and the same identifier comes back in the
   * `tool.end`, so the end hooks onto the start without keeping other state.
   *
   * It is not yet the hook into the subagent's transcript -- that will bring
   * tokens and tool counts -- but birth, type and duration are real.
   */
  trackAgent(ev: DeltaEvent): DeltaEvent[] {
    if (ev.t === 'tool.start') {
      const target = ev.target;
      if (target?.kind !== 'agent' && target?.kind !== 'skill') return [];
      const session = this.#sessions.get(ev.sessionId);
      if (!session) return [];
      const agent: AgentInfo = {
        id: ev.id,
        sessionId: ev.sessionId,
        projectId: session.projectId,
        kind: target.kind === 'skill' ? 'skill' : 'subagent',
        agentType: target.kind === 'skill' ? target.name : target.agentType,
        // Known only once the call has finished, if it was launched async.
        agentId: null,
        model: session.model,
        startedAt: ev.at,
        lastActivityAt: ev.at,
        endedAt: null,
        toolCalls: 0,
        tokens: { ...ZERO_TOKENS },
        deskIndex: this.#claimDesk(session.projectId),
      };
      this.#agents.set(agent.id, agent);
      this.#sessions.set(ev.sessionId, { ...session, agentsActive: session.agentsActive + 1 });
      return this.#record([{ t: 'agent.add', agent }]);
    }

    if (ev.t === 'tool.end') {
      const agent = this.#agents.get(ev.id);
      if (!agent) return [];
      // A skill returns immediately -- it loads its instructions and that is
      // all -- but it keeps steering the turn. The end of the turn closes it,
      // below.
      if (agent.kind === 'skill') return [];
      // Launched async: the tool has finished, the agent has not.
      //
      // And the turn is NOT its boundary: verified on a real session, the
      // turn had been closed for minutes while the terminal still said
      // "waiting for 3 background agents". What closes it is its transcript,
      // when it stops growing -- here we only record where to look for it.
      if (ev.asyncLaunch) {
        if (!ev.spawnedAgentId) return [];
        this.#agents.set(agent.id, { ...agent, agentId: ev.spawnedAgentId });
        // At startup the registry's `shell` can be read before the launch.
        return this.#restatus(agent.sessionId, ev.at);
      }
      return this.endAgent(agent.id, ev.at);
    }

    // The turn closes: the skills that steered it are finished along with it.
    // SUBAGENTS are not -- verified on a real session, a turn had been closed
    // for minutes while three background agents were still working.
    if (ev.t === 'turn.end') {
      const out: DeltaEvent[] = [];
      for (const [id, agent] of [...this.#agents]) {
        if (agent.sessionId !== ev.sessionId || agent.kind !== 'skill') continue;
        out.push(...this.endAgent(id, ev.at));
      }
      return out;
    }

    return [];
  }

  /**
   * A shell Claude sent to the background: an async launch that is not a
   * subagent. It stays open until its notification (`endShell`).
   *
   * If the registry already said a shell runs, the session turns busy here:
   * at startup the registry can be read before the transcript.
   */
  openShell(ev: DeltaEvent): DeltaEvent[] {
    if (ev.t !== 'tool.end' || !ev.asyncLaunch) return [];
    if (ev.spawnedAgentId !== null || this.#agents.has(ev.id)) return [];
    this.#shells.set(ev.id, ev.sessionId);
    if (this.#shells.size > MAX_OPEN_SHELLS) this.#shells.delete(this.#shells.keys().next().value!);
    return this.#restatus(ev.sessionId, ev.at);
  }

  /**
   * The end of a background shell. It arrives as a subagent's does -- a task
   * notification carrying the id of the call that started it -- so whoever
   * closes agents calls this too.
   */
  endShell(id: string, at: number): DeltaEvent[] {
    const sessionId = this.#shells.get(id);
    if (sessionId === undefined) return [];
    this.#shells.delete(id);
    return this.#restatus(sessionId, at);
  }

  /**
   * A registry `shell` is work only while a shell Claude started is open.
   * Without one it is the user's `!` -- an `npm run dev` that never ends --
   * and the turn that mattered is over.
   *
   * A subagent launched in the background and still open is one: the
   * registry says `busy` while one runs, so under a `shell` it is waiting on
   * a shell of its own, which this model never sees because it is in the
   * subagent's transcript. Claude Code calls it "waiting on its own
   * background work" and has not delivered yet. Measured on tower_defense on
   * 2026-10-15: a subagent waiting an hour on the full test suite, and the
   * tower showed "done".
   */
  #statusOf(sessionId: string, reported: SessionStatus): SessionStatus {
    if (!this.#shellReported.has(sessionId)) return reported;
    for (const owner of this.#shells.values()) if (owner === sessionId) return 'busy';
    for (const agent of this.#agents.values()) {
      if (agent.sessionId === sessionId && agent.agentId !== null) return 'busy';
    }
    return reported;
  }

  #restatus(sessionId: string, at: number): DeltaEvent[] {
    const session = this.#sessions.get(sessionId);
    if (!session || !this.#shellReported.has(sessionId)) return [];
    const status = this.#statusOf(sessionId, 'idle');
    if (session.status === status) return [];
    this.#sessions.set(sessionId, { ...session, status });
    return this.#record([{ t: 'session.update', id: sessionId, patch: { status }, at }]);
  }

  /** A project's path, which never travels over the WebSocket. */
  cwdOf(projectId: string): string | undefined {
    return this.#cwds.get(projectId);
  }

  /** A session by id: used to resolve the PID without exposing the map. */
  session(id: string): SessionInfo | undefined {
    return this.#sessions.get(id);
  }

  /**
   * Takes note of what a session is doing, how long the last turn lasted and
   * how much it consumed, WITHOUT emitting anything.
   *
   * The client already receives `tool.start` and `turn.end` and applies them
   * itself: re-sending a `session.update` for every tool call would double
   * the traffic to say something that is already in flight. This only exists
   * so that the SNAPSHOT is right for whoever opens the page later.
   */
  noteSessionEvent(ev: DeltaEvent): void {
    if (ev.t === 'tool.start') {
      const s = this.#sessions.get(ev.sessionId);
      if (!s) return;
      this.#sessions.set(ev.sessionId, {
        ...s,
        activityTool: ev.name,
        activityTarget: targetLabel(ev.target),
        toolCalls: s.toolCalls + 1,
      });
      return;
    }
    if (ev.t === 'turn.end') {
      const s = this.#sessions.get(ev.sessionId);
      if (!s) return;
      this.#sessions.set(ev.sessionId, {
        ...s,
        lastTurnMs: ev.durationMs,
        turnsMs: s.turnsMs + Math.max(0, ev.durationMs),
        turns: s.turns + 1,
        // The turn is over: whatever it was doing, it is no longer doing it.
        activityTool: null,
        activityTarget: null,
      });
      return;
    }
    if (ev.t === 'usage') {
      const s = this.#sessions.get(ev.sessionId);
      if (!s) return;
      this.#sessions.set(ev.sessionId, {
        ...s,
        model: s.model ?? ev.model,
        tokens: {
          in: s.tokens.in + ev.delta.in,
          out: s.tokens.out + ev.delta.out,
          cacheRead: s.tokens.cacheRead + ev.delta.cacheRead,
          cacheWrite: s.tokens.cacheWrite + ev.delta.cacheWrite,
          thinking: s.tokens.thinking + ev.delta.thinking,
        },
      });
      return;
    }
    if (ev.t === 'context') {
      const s = this.#sessions.get(ev.sessionId);
      if (!s) return;
      this.#sessions.set(ev.sessionId, { ...s, contextLeft: ev.tokensLeft });
    }
  }

  /**
   * A quota reading over the one already held.
   *
   * It is MERGED, not replaced, and here and nowhere else: the status line,
   * the Codex rollouts and a CEO's own process all publish only the windows
   * their last response carried, and each of them replacing the whole state
   * would make a window blink out whenever a source that does not know it
   * speaks last. What the client receives is what the model holds, so the
   * bars and the gates cannot read two different things.
   */
  applyLimits(ev: Extract<DeltaEvent, { t: 'limits' }>): DeltaEvent[] {
    const prev = this.#limits.get(ev.limits.provider);
    const windows = mergeWindows(prev?.windows ?? [], ev.limits.windows);
    // The plan is in neither tool's payload: it is repeated by whoever knows
    // it, and a source that does not must not erase it.
    const plan = ev.limits.plan ?? prev?.plan ?? null;
    const limits: ProviderLimits = { ...ev.limits, windows, plan };
    this.#limits.set(limits.provider, limits);
    return [{ t: 'limits', limits }];
  }

  /**
   * Records a git event on the project.
   *
   * Keeping it in the model and not only in the stream serves one precise
   * purpose: whoever opens the page later must find the last commit already
   * in the snapshot, instead of seeing an empty sign until a new one arrives.
   */
  applyGit(ev: Extract<DeltaEvent, { t: 'git' }>): DeltaEvent[] {
    this.#rings.accept(ev, Date.now());
    const project = this.#projects.get(ev.projectId);
    if (!project) return this.#record([ev]);

    // Only real commits give a name. A `pull` writes "Fast-forward" in the
    // reflog, a `reset` writes the destination ref: those are outcomes, not
    // descriptions of work, and they would replace a useful title with noise.
    const lastCommit = ev.kind === 'commit' && ev.subject ? ev.subject : project.lastCommit;
    const commits = project.commits + (ev.kind === 'commit' ? 1 : 0);
    if (lastCommit !== project.lastCommit || ev.branch !== project.branch || commits !== project.commits) {
      this.#projects.set(ev.projectId, { ...project, lastCommit, branch: ev.branch, commits });
    }
    return this.#record([ev]);
  }

  /** Cap per project: the least recently touched is evicted, not the oldest. */
  #evictFiles(projectId: string): DeltaEvent[] {
    const mine: FileNode[] = [];
    for (const f of this.#files.values()) if (f.projectId === projectId) mine.push(f);
    if (mine.length <= this.#opts.maxFilesPerProject) return [];

    mine.sort((a, b) => a.lastTouchAt - b.lastTouchAt);
    const out: DeltaEvent[] = [];
    for (const victim of mine.slice(0, mine.length - this.#opts.maxFilesPerProject)) {
      this.#files.delete(victim.id);
      this.#windows.get(projectId)?.get(victim.floor)?.delete(victim.col);
      out.push({ t: 'file.evict', projectId, fileId: victim.id });
    }
    return out;
  }

  #record(events: DeltaEvent[]): DeltaEvent[] {
    if (events.length === 0) return events;
    this.#version++;
    for (const ev of events) this.#recent.push(ev);
    return events;
  }

  snapshot(): Snapshot {
    return {
      at: Date.now(),
      projects: [...this.#projects.values()],
      sessions: [...this.#sessions.values()],
      agents: [...this.#agents.values()],
      files: [...this.#files.values()],
      recent: this.#recent.toArray(),
      limits: [...this.#limits.values()],
      rings: (this.#rings.prune(Date.now()), this.#rings.all()),
    };
  }

  get counts(): { projects: number; sessions: number; agents: number; files: number } {
    return {
      projects: this.#projects.size,
      sessions: this.#sessions.size,
      agents: this.#agents.size,
      files: this.#files.size,
    };
  }
}

/**
 * The target reduced to a single word. These are scalars already derived and
 * already passed through the redaction choke point: no information is added
 * here, it only picks which of the forms to show.
 */
function targetLabel(target: TargetRef | null): string | null {
  if (!target) return null;
  switch (target.kind) {
    case 'file': return target.path;
    case 'cmd': return target.bin;
    case 'agent': return target.agentType;
    case 'skill': return target.name;
    case 'peer': return target.name;
  }
}
