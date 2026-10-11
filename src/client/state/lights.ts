import type { AgentInfo, DeltaEvent, ProviderId, SessionInfo } from '../../shared/protocol.ts';
import { fnv1a32 } from '../../shared/hash.ts';

/**
 * How long a window stays lit, at minimum.
 *
 * Real work often lasts less than it takes to notice it: a `Read` returns
 * in a few milliseconds, a quick Explore in ten seconds, and a light that
 * turns on and off while you are looking at another building might as well
 * never have been there. The minimum counts from the START of the work:
 * longer work goes dark when it actually ends, with no tail added.
 */
export const MIN_LIT_MS = 45_000;

/**
 * How long it takes to go fully dark.
 *
 * A light that vanishes at once reads as a drawing glitch; one that dims
 * reads as someone leaving. At the end of the fade the instance is removed:
 * nothing is left half-lit.
 */
export const FADE_MS = 1_200;

/**
 * Who lights the window.
 *
 * `turn`: the session itself, while one of its turns is running -- the main
 * agent at its desk. `tool`: a call to a tool. `subagent` and `skill`: the
 * inhabitants that come from the server's model.
 */
export type LightKind = 'turn' | 'tool' | 'subagent' | 'skill';

export interface Light {
  readonly id: string;
  readonly kind: LightKind;
  readonly sessionId: string;
  readonly projectId: string;
  /** The session's provider: it gives turns and calls their colour. */
  readonly provider: ProviderId | null;
  /**
   * What the work is called: the tool called, the subagent type, the skill's
   * name. `null` for the turn, whose name is the session's title and is read
   * at the time, because it changes while the session works.
   *
   * Never goes on stage by itself: it is read by hovering over the window.
   */
  readonly name: string | null;
  /** When the work began, in epoch ms: the minimum counts from here. */
  readonly bornAt: number;
  /** When the window appeared on screen: the light's ramp-up starts here. */
  readonly litAt: number;
  /** When the work ended. `null` while it is still running. */
  endedAt: number | null;
  /** Place on the facade: assigned when it lights up, then frozen. */
  readonly slot: number;
}

export type LightSpec = Omit<Light, 'litAt' | 'endedAt' | 'slot'>;

/** When the window starts to go dark. Infinite while the work is running. */
export function offAt(light: Light): number {
  return light.endedAt === null ? Infinity : Math.max(light.endedAt, light.bornAt + MIN_LIT_MS);
}

/** Random slot attempts before walking the facade in order. */
const SLOT_TRIES = 16;

/**
 * The city's lit windows: who lights them, for how long, and where.
 *
 * Lives in the client and not in the server's model on purpose. The server
 * says what is true -- an agent is in play, a tool has started -- and that
 * stays exact; the minimum lit time is a PRESENTATION choice, and putting it
 * in the model would count as alive an agent that has already delivered.
 */
export class Lights {
  #lights = new Map<string, Light>();
  #capacity: (projectId: string) => number;
  #now: () => number;

  /** `capacity`: how many window slots a project's building has. */
  constructor(capacity: (projectId: string) => number, now: () => number = Date.now) {
    this.#capacity = capacity;
    this.#now = now;
  }

  values(): IterableIterator<Light> {
    return this.#lights.values();
  }

  get(id: string): Light | undefined {
    return this.#lights.get(id);
  }

  /**
   * Lights a window, or relights it if it was still fading out.
   * Returns true if the facade needs redrawing.
   */
  light(spec: LightSpec): boolean {
    const known = this.#lights.get(spec.id);
    if (known) {
      if (known.endedAt === null) return false;
      // Same slot and same birth: it is the same light coming back up, not
      // a new one jumping to another part of the facade.
      known.endedAt = null;
      return true;
    }
    this.#lights.set(spec.id, {
      ...spec,
      litAt: this.#now(),
      endedAt: null,
      slot: this.#freeSlot(spec.id, spec.projectId),
    });
    return true;
  }

  /** The work is over: the window stays lit until the minimum, then dims. */
  end(id: string, at: number): boolean {
    const light = this.#lights.get(id);
    if (!light || light.endedAt !== null) return false;
    light.endedAt = at;
    // Ended when its time had already passed: it is the tail of a transcript
    // that the server rereads when it attaches to it, even with the page
    // open. It is removed at once, in the same batch it was born in, instead
    // of waiting for the cleanup: hundreds of old calls would all flash at
    // once.
    if (offAt(light) + FADE_MS <= this.#now()) this.#lights.delete(id);
    return true;
  }

  /** Removes the windows that have gone fully dark. True if it removed at least one. */
  prune(now: number): boolean {
    let changed = false;
    for (const [id, light] of this.#lights) {
      if (now < offAt(light) + FADE_MS) continue;
      this.#lights.delete(id);
      changed = true;
    }
    return changed;
  }

  /** From server event to windows. True if the facade needs redrawing. */
  apply(ev: DeltaEvent, sessions: ReadonlyMap<string, SessionInfo>): boolean {
    switch (ev.t) {
      case 'tool.start': {
        // Subagents and skills have their own window, which arrives with `agent.add`:
        // lighting another one for the call that summons them would count them twice.
        if (ev.target?.kind === 'agent' || ev.target?.kind === 'skill') return false;
        const s = sessions.get(ev.sessionId);
        if (!s) return false;
        return this.light({
          id: toolLightId(ev.id),
          kind: 'tool',
          sessionId: s.id,
          projectId: s.projectId,
          provider: s.provider,
          name: ev.name,
          bornAt: ev.at,
        });
      }
      case 'tool.end':
        return this.end(toolLightId(ev.id), ev.at);
      case 'agent.add':
        return this.light(agentSpec(ev.agent, sessions));
      case 'agent.remove':
        return this.end(agentLightId(ev.id), ev.at);
      case 'turn.end':
        // No call outlives the turn that made it -- background ones return
        // at once -- so if its end got lost, this is where the window stops
        // waiting for it.
        return this.#endWhere((l) => l.kind === 'tool' && l.sessionId === ev.sessionId, ev.at);
      default:
        return false;
    }
  }

  /**
   * Realigns the windows with the state: one for each running turn, one for
   * each live agent, and darkness for whoever is gone.
   *
   * Idempotent, so it can be called on every presence change. It is also
   * needed after a snapshot: whoever opens the page with work already under
   * way must find the windows of those at work already lit.
   */
  sync(
    sessions: ReadonlyMap<string, SessionInfo>,
    agents: ReadonlyMap<string, AgentInfo>,
    now: number,
  ): boolean {
    let changed = false;

    for (const s of sessions.values()) {
      const id = turnLightId(s.id);
      if (s.status === 'busy') {
        changed = this.light({
          id,
          kind: 'turn',
          sessionId: s.id,
          projectId: s.projectId,
          provider: s.provider,
          name: null,
          // The turn began when the session became busy, not when the
          // page noticed.
          bornAt: s.statusSince,
        }) || changed;
        continue;
      }
      // Waiting for you or finished: either way it is not working, and it
      // stopped when it changed state.
      changed = this.end(id, s.statusSince) || changed;
      // Only once the turn is over: while waiting for a permission the tool
      // is still there, ready to start as soon as you answer.
      if (s.status === 'idle') {
        changed = this.#endWhere((l) => l.kind === 'tool' && l.sessionId === s.id, now) || changed;
      }
    }

    for (const a of agents.values()) changed = this.light(agentSpec(a, sessions)) || changed;

    changed = this.#endWhere((l) => {
      if (!sessions.has(l.sessionId)) return true;
      if (l.kind === 'subagent' || l.kind === 'skill') return !agents.has(l.id.slice(AGENT.length));
      return false;
    }, now) || changed;

    return changed;
  }

  #endWhere(match: (light: Light) => boolean, at: number): boolean {
    let changed = false;
    for (const light of this.#lights.values()) {
      if (match(light)) changed = this.end(light.id, at) || changed;
    }
    return changed;
  }

  /**
   * A free slot on the facade.
   *
   * First a few random attempts, then the facade in order: walking it
   * straight from the starting point would put the windows of a burst of
   * calls all in a row on the same floor, and the building would light up
   * in stripes instead of here and there. The slot depends on the id, so it
   * stays the same for the whole life of the light.
   */
  #freeSlot(id: string, projectId: string): number {
    const capacity = Math.max(1, this.#capacity(projectId));
    const taken = new Set<number>();
    for (const l of this.#lights.values()) {
      if (l.projectId === projectId) taken.add(l.slot % capacity);
    }
    for (let k = 0; k < SLOT_TRIES; k++) {
      const slot = fnv1a32(k === 0 ? id : `${id}#${k}`) % capacity;
      if (!taken.has(slot)) return slot;
    }
    const start = fnv1a32(id) % capacity;
    for (let k = 0; k < capacity; k++) {
      const slot = (start + k) % capacity;
      if (!taken.has(slot)) return slot;
    }
    // Facade full: accept the overlap rather than not light up at all.
    return start;
  }
}

const TURN = 'turn:';
const TOOL = 'tool:';
const AGENT = 'agent:';

const turnLightId = (sessionId: string): string => TURN + sessionId;
const toolLightId = (toolUseId: string): string => TOOL + toolUseId;
const agentLightId = (agentId: string): string => AGENT + agentId;

function agentSpec(agent: AgentInfo, sessions: ReadonlyMap<string, SessionInfo>): LightSpec {
  return {
    id: agentLightId(agent.id),
    kind: agent.kind,
    sessionId: agent.sessionId,
    projectId: agent.projectId,
    provider: sessions.get(agent.sessionId)?.provider ?? null,
    name: agent.agentType,
    bornAt: agent.startedAt,
  };
}
