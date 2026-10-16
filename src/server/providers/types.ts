import type {
  DeltaEvent, ProviderId, SessionKind, SessionStatus, StatusConfidence,
} from '../../shared/protocol.ts';

/**
 * A live session, normalized: it is the only thing every provider must be
 * able to report. The rest of the system -- world model, protocol, client --
 * does not know which tool it comes from.
 */
export interface LiveSession {
  sessionId: string;
  provider: ProviderId;
  pid: number;
  cwd: string;
  label: string;
  title: string | null;
  status: SessionStatus;
  /** `reported` if the tool declares it, `inferred` if we deduce it. */
  statusConfidence: StatusConfidence;
  waitingFor: string | null;
  kind: SessionKind;
  version: string;
  model: string | null;
  startedAt: number;
  updatedAt: number;
  /** When the current status began: stopwatch of the run in progress. */
  statusSince: number;
  /** Total reasoning time, if the tool times it. */
  reasoningMs?: number | null;
  /** Context window in use, 0-100, if the tool exposes it. */
  contextPct?: number | null;
  /** The last compaction read, when the provider reads it itself (Codex). */
  compactedAt?: number | null;
  /**
   * Stopped at a usage limit, when the provider reads it itself (Codex), and
   * when that limit resets. Left out (`undefined`) by a provider that does not
   * know: Claude Code's comes from the transcript, and a registry pass must
   * not erase it.
   */
  limitStoppedAt?: number | null;
  limitResetsAt?: number | null;
  /**
   * The turn is over but a shell runs in the background. Whether that is
   * work depends on who started it, which only the transcript says: the
   * world model decides, and `status` carries what holds without it.
   */
  backgroundShell?: boolean;
}

export interface ProviderContext {
  /** Projects to show as permanent buildings, even with no live sessions. */
  onProjects: (cwds: readonly string[]) => void;
  /** The COMPLETE set of this provider's live sessions. */
  onSessions: (sessions: readonly LiveSession[]) => void;
  /** Events already redacted, ready for the client. */
  onEvents: (events: readonly DeltaEvent[]) => void;
}

/**
 * A provider is an adapter: it discovers a tool's sessions and activity and
 * translates them into the common vocabulary. It knows nothing of the 3D
 * world, the WebSocket protocol or the city.
 */
export interface Provider {
  readonly id: ProviderId;
  /** false if the tool is not installed: skipped silently. */
  isAvailable(): boolean;
  start(ctx: ProviderContext): void;
  stop(): void;
}
