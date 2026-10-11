import type { ToolCategory } from '../../shared/protocol.ts';
import type { ClipKey } from '../assets/crew.ts';

/**
 * What a working astronaut does with its hands, from what the session is
 * calling.
 *
 * One hammer for every tool said "busy" and nothing else: a session reading
 * forty files and one running the test suite looked identical. The rig has
 * clips the colony never played -- inspecting, operating a console, a thinking
 * stance -- and the tool category is exactly the fact that tells them apart.
 *
 * The colour of the work is already said by the lamp and the sparks; this is
 * the shape of it, so the two read together.
 */
export type Gesture = 'hammer' | 'inspect' | 'operate' | 'uplink' | 'ponder';

export function gestureFor(cat: ToolCategory): Gesture {
  switch (cat) {
    case 'edit':
      return 'hammer';
    case 'read':
    case 'search':
      return 'inspect';
    case 'exec':
      return 'operate';
    case 'net':
    case 'mcp':
      return 'uplink';
    case 'plan':
      return 'ponder';
    // Handing work to a subagent shows as the subagent walking out, and a
    // question to you as waiting: the hands keep doing what they did.
    case 'agent':
    case 'msg':
    case 'other':
      return 'hammer';
  }
}

/** The clip each gesture plays, standing at the structure. */
export const GESTURE_CLIP: Readonly<Record<Gesture, ClipKey>> = {
  hammer: 'work',
  inspect: 'interact',
  operate: 'workAlt',
  uplink: 'interact',
  ponder: 'idleAlt',
};

/**
 * How long a gesture holds before the next may replace it, in seconds.
 *
 * A burst of forty reads and an edit arrives inside a second; switching clip
 * on each would be an astronaut twitching between poses, which reads as a
 * glitch rather than as work. The last call asked for wins when the hold ends.
 */
export const GESTURE_HOLD_S = 3;

export interface GestureState {
  current: Gesture;
  /** When `current` started, on the crew's clock. */
  since: number;
  /** The latest gesture asked for while the hold ran; null when there is none. */
  pending: Gesture | null;
}

export function restingGesture(): GestureState {
  return { current: 'hammer', since: -Infinity, pending: null };
}

/** Ask for a gesture: taken at once if the hold has run out, queued otherwise. */
export function requestGesture(s: GestureState, wanted: Gesture, now: number): void {
  if (wanted === s.current) {
    s.pending = null;
    return;
  }
  if (now - s.since >= GESTURE_HOLD_S) {
    s.current = wanted;
    s.since = now;
    s.pending = null;
    return;
  }
  s.pending = wanted;
}

/** Apply a queued gesture once its hold has run out. True when the gesture changed. */
export function settleGesture(s: GestureState, now: number): boolean {
  if (s.pending === null || now - s.since < GESTURE_HOLD_S) return false;
  s.current = s.pending;
  s.since = now;
  s.pending = null;
  return true;
}
