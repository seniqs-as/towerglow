import type { NoticeCode, SessionInfo } from '../../shared/protocol.ts';

/**
 * What an astronaut is doing, decided ONCE.
 *
 * A strict precedence rather than a set of independent flags, so a session
 * can only ever be telling you one thing and the loudest true thing wins.
 * The scene, the badge and the session card all read this function: if two
 * places could disagree they eventually would.
 *
 *   blocked   -> an error notice is held: the session fell over, it is not busy
 *   working   -> a turn is running: hammering at its structure
 *   waiting   -> it wants a reply from you: stopped, waving
 *   sleeping  -> quiet for a long while: sat down
 *   idle      -> anything else: pottering about its zone
 *
 * Errored outranks working because a session that fell over is stuck, not
 * busy. Waiting sits below working because a running turn is not waiting on
 * anyone yet.
 */
export type CrewStatus = 'blocked' | 'working' | 'waiting' | 'sleeping' | 'idle';

/** Quiet for this long and the astronaut sits down. */
export const SLEEP_AFTER_MS = 20 * 60_000;

/** The fields the precedence reads; a test needs no more than these. */
export type CrewSession = Pick<SessionInfo, 'status' | 'statusSince' | 'lastActivityAt'>;

/**
 * A subagent's astronaut is always working.
 *
 * It is on the map from the call that launched it until it delivers, and in
 * between there is nothing else it can be: it never waits for you (its
 * session does) and the server reports no idle for it. Decided here all the
 * same, next to the session's precedence, so the scene cannot grow a second
 * opinion about what a status is.
 */
export function subagentStatus(): CrewStatus {
  return 'working';
}

/**
 * A session's helper is always working, for the same reason.
 *
 * It comes out on a tool call and goes back in once the turn is over, so the
 * only thing it is ever on the map to do is the work: the waiting, the
 * sleeping and the falling over are its session's, told by the bigger one.
 */
export function helperStatus(): CrewStatus {
  return 'working';
}

export function crewStatus(session: CrewSession, notice: NoticeCode | null, now: number): CrewStatus {
  if (notice === 'error') return 'blocked';
  if (session.status === 'busy') return 'working';
  if (session.status === 'waiting') return 'waiting';
  // Quiet since whichever came last: the status change or the last event.
  const quietSince = Math.max(session.statusSince, session.lastActivityAt);
  if (now - quietSince > SLEEP_AFTER_MS) return 'sleeping';
  return 'idle';
}
