import type {
  AgentInfo, Caps, CeoSurface, DeltaEvent, FileNode, ProjectInfo, ProviderId, ProviderLimits,
  ServerFrame, SessionInfo,
} from '../../shared/protocol.ts';
import { Trail, targetLabel } from './trail.ts';

export interface StoreListeners {
  /** The topology changed: projects appeared or vanished, so the layout has to be redone. */
  onTopology: () => void;
  /** Only the state of sessions or agents changed: a light update. */
  onPresence: () => void;
  /** A file appeared or vanished: the facade's windows have to be redone. */
  onFiles: () => void;
  onDelta: (event: DeltaEvent) => void;
  onCaps: (caps: Caps) => void;
  /** The consumed quota changed: it concerns the account, not the city. */
  onLimits: () => void;
  /**
   * A piece of a CEO's answer.
   *
   * It does not go through the store like the others: it is not world
   * state, it is a conversation with whoever asked. Putting it in `sessions`
   * or in `recent` would mean two open windows read each other's questions.
   */
  onCeoStream: (provider: ProviderId, delta: string, done: boolean, surface: CeoSurface) => void;
}

/** Mirror of the server's model. No domain logic: only state. */
export class Store {
  projects = new Map<string, ProjectInfo>();
  /**
   * Every live session, the ones a CEO opened included.
   *
   * A worker used to be kept apart here and drawn as a mast by the ship.
   * The user wanted it back where the work is: an astronaut on its project's
   * lot, with the gestures, the lamps and the card every session has. The
   * server still marks it (`spawnedByCeo`), because the scheduler must never
   * mistake a worker for one of yours; the scene only uses the mark to say so
   * in the hover and on the card.
   */
  sessions = new Map<string, SessionInfo>();
  /**
   * The jobs you accepted: what Reports lists and Planning follows.
   *
   * They are not sessions, and that is why they have a map of their own. A
   * session lives as long as its process; a job outlives it, because the
   * thing that matters -- how it went -- only exists after the process has
   * died.
   */
  jobs = new Map<string, Extract<DeltaEvent, { t: 'job' }>>();
  agents = new Map<string, AgentInfo>();
  files = new Map<string, FileNode>();
  limits = new Map<ProviderId, ProviderLimits>();
  /**
   * Tool calls per category, SINCE the page was opened.
   *
   * The server's model keeps the total per session but not the breakdown:
   * that accumulates here, and whoever shows it must say since when it has
   * been counting -- a number without its interval is a number that lies.
   */
  toolsByCat = new Map<string, number>();
  /**
   * The latest steps of each session.
   *
   * It sits here next to the entities and not in a module of its own because
   * it is the same event stream that fills it: a second copy of the events,
   * fed from somewhere else, would diverge from this one at the first resync.
   */
  trail = new Trail();
  #sinceMs = Date.now();

  /** Since when the counts accumulated in the client are valid. */
  get countingSince(): number {
    return this.#sinceMs;
  }
  caps: Caps | null = null;
  lastSeq = 0;

  #l: StoreListeners;

  constructor(listeners: StoreListeners) {
    this.#l = listeners;
  }

  /** Returns true if a resync is needed (a gap in the sequence). */
  apply(frame: ServerFrame): boolean {
    switch (frame.t) {
      case 'hello':
        this.caps = frame.caps;
        this.#l.onCaps(frame.caps);
        return false;

      case 'snapshot': {
        this.projects = new Map(frame.projects.map((p) => [p.id, p]));
        this.sessions = new Map(frame.sessions.map((s) => [s.id, s]));
        this.agents = new Map(frame.agents.map((a) => [a.id, a]));
        this.files = new Map(frame.files.map((f) => [f.id, f]));
        this.limits = new Map((frame.limits ?? []).map((l) => [l.provider, l]));
        // The server's ring carries the events that just went by: without
        // this, whoever opens the page with work already under way would see
        // an empty trail until the next call.
        this.trail.reset(frame.recent ?? []);
        /*
         * The board, replayed.
         *
         * `recent` normally feeds the trail and nothing else, but the CEO
         * events are not traces of a session: they are the state of a panel,
         * and a panel rebuilt from nothing looks exactly like a panel with
         * nothing on it. Replaying is safe because the panel keys on `id` and
         * upserts, so a resync redraws the same cards instead of doubling them.
         */
        for (const ev of frame.recent ?? []) {
          if (ev.t !== 'ceo' && ev.t !== 'report' && ev.t !== 'proposal' && ev.t !== 'job' && ev.t !== 'plan') continue;
          // State BEFORE notifying: a listener that reads `store.jobs` must
          // find in it the event it has just been told about. The bug showed
          // up on the wall inside the HQ, which no longer exists: it rebuilt
          // itself from a still-empty map and stayed bare, with the very
          // same things duly listed in the panel a couple of inches away.
          if (ev.t === 'job') this.jobs.set(ev.id, ev);
          this.#l.onDelta(ev);
        }
        this.#l.onTopology();
        this.#l.onPresence();
        this.#l.onFiles();
        return false;
      }

      case 'batch': {
        // A gap in the sequence means lost events: better to ask for a
        // snapshot than to diverge silently from the server.
        const gap = this.lastSeq > 0 && frame.seq !== this.lastSeq + 1;
        this.lastSeq = frame.seq;
        let topology = false;
        let presence = false;
        let files = false;
        for (const ev of frame.events) {
          const kind = this.#applyDelta(ev);
          if (kind === 'topology') topology = true;
          if (kind === 'files') files = true;
          if (kind === 'topology' || kind === 'presence') presence = true;
          this.#l.onDelta(ev);
        }
        if (topology) this.#l.onTopology();
        if (presence) this.#l.onPresence();
        if (files) this.#l.onFiles();
        return gap;
      }

      case 'ceo.stream':
        this.#l.onCeoStream(frame.provider, frame.delta, frame.done, frame.surface);
        return false;

      default:
        return false;
    }
  }

  #applyDelta(ev: DeltaEvent): 'topology' | 'presence' | 'files' | 'none' {
    this.trail.apply(ev);
    switch (ev.t) {
      case 'project.add':
        this.projects.set(ev.project.id, ev.project);
        return 'topology';
      case 'project.remove':
        this.projects.delete(ev.id);
        return 'topology';

      case 'session.add':
        this.sessions.set(ev.session.id, ev.session);
        return 'topology';
      case 'session.update': {
        const s = this.sessions.get(ev.id);
        if (s) this.sessions.set(ev.id, { ...s, ...ev.patch });
        return 'presence';
      }
      case 'session.remove':
        this.sessions.delete(ev.id);
        return 'topology';

      case 'job':
        this.jobs.set(ev.id, ev);
        // `presence` and not `topology`: a job moves no lot, and one arrives
        // with every tool call a worker makes. Rebuilding the lots for each
        // would rebuild the colony to update a hover.
        return 'presence';

      case 'ceo.cleared': {
        // Reports started over: a worker's hover names its task from here,
        // and a job the server no longer has must not name anything.
        if (ev.what !== 'jobs') return 'none';
        const keep = new Set(ev.keep);
        for (const id of [...this.jobs.keys()]) if (!keep.has(id)) this.jobs.delete(id);
        return 'presence';
      }

      case 'agent.add':
        this.agents.set(ev.agent.id, ev.agent);
        return 'topology';
      case 'agent.update': {
        const a = this.agents.get(ev.id);
        if (a) this.agents.set(ev.id, { ...a, ...ev.patch });
        return 'presence';
      }
      case 'agent.remove':
        this.agents.delete(ev.id);
        return 'topology';

      case 'file.touch': {
        const known = this.files.get(ev.fileId);
        // Files no longer drive the facade -- that belongs to whoever is
        // working: turns, calls, agents -- but they remain the tally of what
        // has been read and written, which is what the stats panel shows.
        this.files.set(ev.fileId, {
          id: ev.fileId,
          projectId: ev.projectId,
          path: ev.path,
          ext: ev.ext,
          dir: ev.dir,
          floor: ev.floor,
          col: ev.col,
          reads: (known?.reads ?? 0) + (ev.op === 'read' ? 1 : 0),
          writes: (known?.writes ?? 0) + (ev.op === 'read' ? 0 : 1),
          churn: (known?.churn ?? 0) + Math.max(0, ev.changed),
          firstSeenAt: known?.firstSeenAt ?? ev.at,
          lastTouchAt: ev.at,
        });
        return 'files';
      }

      case 'tool.start': {
        this.toolsByCat.set(ev.cat, (this.toolsByCat.get(ev.cat) ?? 0) + 1);
        // What it is doing, right now. For Claude Code the session's title is
        // the session's NAME -- often identical to the handle -- so it never
        // says what is happening: the tool in use does.
        const s = this.sessions.get(ev.sessionId);
        if (s) {
          this.sessions.set(ev.sessionId, {
            ...s,
            activityTool: ev.name,
            activityTarget: targetLabel(ev.target),
            toolCalls: s.toolCalls + 1,
          });
        }
        return 'none';
      }

      case 'turn.end': {
        const s = this.sessions.get(ev.sessionId);
        if (s) {
          this.sessions.set(ev.sessionId, {
            ...s,
            lastTurnMs: ev.durationMs,
            turnsMs: s.turnsMs + Math.max(0, ev.durationMs),
            turns: s.turns + 1,
            activityTool: null,
            activityTarget: null,
          });
        }
        return 'none';
      }

      case 'limits': {
        this.limits.set(ev.limits.provider, ev.limits);
        this.#l.onLimits();
        return 'none';
      }

      case 'usage': {
        // The server emits the usage but does not add it up: the per-session
        // total lives here, so the detail panel has a number to show without
        // every event having to rewrite the server-side model.
        const s = this.sessions.get(ev.sessionId);
        if (s) {
          this.sessions.set(ev.sessionId, {
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
        }
        // Not 'presence': the state does not change, and redoing plates and
        // tints on every turn would cost more than what it shows.
        return 'none';
      }

      case 'context': {
        const s = this.sessions.get(ev.sessionId);
        if (s) this.sessions.set(ev.sessionId, { ...s, contextLeft: ev.tokensLeft });
        return 'none';
      }

      case 'file.evict':
        this.files.delete(ev.fileId);
        return 'files';

      case 'git': {
        // The rule of World.applyGit, on the page's copy of the project. The
        // server keeps the last commit in its model but sends only the event,
        // and the page's copy stayed the snapshot's: every topology change
        // within 12 s of a commit put the PREVIOUS commit's subject in its
        // caption, the moment a worker's session left with its commit made
        // (2026-10-22), and Statistics counted commits from the snapshot.
        const p = this.projects.get(ev.projectId);
        if (!p) return 'none';
        const lastCommit = ev.kind === 'commit' && ev.subject ? ev.subject : p.lastCommit;
        const commits = p.commits + (ev.kind === 'commit' ? 1 : 0);
        if (lastCommit !== p.lastCommit || ev.branch !== p.branch || commits !== p.commits) {
          this.projects.set(ev.projectId, { ...p, lastCommit, branch: ev.branch, commits });
        }
        return 'none';
      }

      default:
        return 'none';
    }
  }

  /**
   * The job a worker session is doing, or null for a session of yours.
   *
   * The latest one wins: answering a worker's question resumes the SAME
   * session (`--resume`), so two attempts of a task can share one id, and the
   * one running now is the one that started last. A job learns its session
   * from the worker's first line, so for a moment a worker can already stand
   * on its lot while this still finds nothing.
   */
  jobOf(sessionId: string): Extract<DeltaEvent, { t: 'job' }> | null {
    let best: Extract<DeltaEvent, { t: 'job' }> | null = null;
    for (const j of this.jobs.values()) {
      if (j.sessionId === sessionId && (best === null || j.at >= best.at)) best = j;
    }
    return best;
  }

  get activeProjectIds(): Set<string> {
    const out = new Set<string>();
    for (const s of this.sessions.values()) out.add(s.projectId);
    return out;
  }
}
