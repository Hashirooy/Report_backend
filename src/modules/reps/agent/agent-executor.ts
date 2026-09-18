import type { RepsEventLevel } from '../../../contracts/index.js';

/** Why a task's process did not produce a usable answer. */
export type AgentFailureReason =
  | 'spawn'
  | 'timeout'
  | 'cancelled'
  | 'exit'
  | 'no_result'
  | 'unparsable';

export class AgentProcessError extends Error {
  constructor(
    readonly reason: AgentFailureReason,
    message: string,
    /** Whatever the session got to before it broke, for the resume path. */
    readonly sessionId: string | null = null,
  ) {
    super(message);
    this.name = 'AgentProcessError';
  }
}

export interface AgentProgressEvent {
  level: RepsEventLevel;
  message: string;
  data?: unknown;
}

export interface AgentRunRequest {
  /** The job's handoff. Goes in over stdin, never on the command line. */
  prompt: string;
  /**
   * Role, skill and answer format. An implementation is expected to put this in
   * front of the agent by whatever means its CLI offers — a flag, a file in the
   * working directory — rather than to fold it into the prompt.
   */
  systemPrompt: string;
  /**
   * Session to continue. When absent a fresh session is started under
   * `newSessionId` so the id is known before the process says anything.
   */
  resumeSessionId?: string | null;
  newSessionId: string;
  signal: AbortSignal;
  /** Called as the stream arrives. Must not throw and must not block. */
  onEvent: (event: AgentProgressEvent) => void;
}

export interface AgentRunResult {
  /** The agent's final text, still unparsed. Null if the result carried none. */
  payload: string | null;
  sessionId: string | null;
  /** Null when the backing CLI does not report spend. */
  costUsd: number | null;
  durationMs: number;
  numTurns: number | null;
}

/**
 * One task, run by whichever agent CLI the deployment is configured for.
 *
 * The orchestrator depends on this and never on a particular CLI: a task goes
 * in as a prompt, progress comes back through `onEvent`, and the answer is
 * returned as text for `parseAgentOutput` to make sense of. Anything a process
 * failure has to say travels as an `AgentProcessError`, whose `sessionId` is
 * what the retry path resumes from.
 *
 * Abstract class rather than an interface so Nest can use it as both the
 * injection token and the type.
 */
export abstract class AgentExecutor {
  abstract run(request: AgentRunRequest): Promise<AgentRunResult>;
}
