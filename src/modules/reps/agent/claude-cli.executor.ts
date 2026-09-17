import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  /** Role, skill and answer format; replaces the CLI's own system prompt. */
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
  costUsd: number | null;
  durationMs: number;
  numTurns: number | null;
}

/** Keeps a runaway stderr out of the job's error column. */
const STDERR_CAP = 8_000;
/** Assistant text is logged as progress, not stored in full. */
const EVENT_TEXT_CAP = 1_000;

/**
 * Runs one task as a Claude Code process.
 *
 * The four channels of the contract map straight onto the child: the handoff
 * goes in on stdin, progress comes back as NDJSON on stdout, diagnostics on
 * stderr, and the exit tells us whether the process itself survived. Exit code
 * 0 is necessary but not sufficient — the orchestrator still has to like what
 * the final message says.
 */
@Injectable()
export class ClaudeCliExecutor {
  private readonly logger = new Logger(ClaudeCliExecutor.name);
  private resolvedCli: string | null = null;

  constructor(private readonly config: ConfigService) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const started = Date.now();
    const args = this.argsFor(request);

    const child = spawn(this.executable(), args, {
      // The agent has no tools, so its working directory is only ever the place
      // it was started from. A temporary directory keeps it away from the
      // repository, whose CLAUDE.md and settings would otherwise be picked up.
      // Skill instructions reach it through the prompt, not from here.
      cwd: tmpdir(),
      // No shell: the prompt never reaches a command line, but the CLI path and
      // model come from configuration and should not be word-split either.
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
    });

    // Held in an object rather than plain locals: everything below is written
    // from stream callbacks, and TypeScript cannot narrow a `let` that a
    // closure assigns to.
    const state: {
      sessionId: string | null;
      result: AgentRunResult | null;
      failure: AgentProcessError | null;
    } = { sessionId: request.resumeSessionId ?? null, result: null, failure: null };

    let stderr = '';
    let stdoutBytes = 0;

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // Not every line is ours — an updater notice or a stray log would
        // otherwise kill an otherwise healthy run.
        request.onEvent({ level: 'debug', message: truncate(trimmed, EVENT_TEXT_CAP) });
        return;
      }

      if (typeof message.session_id === 'string') state.sessionId = message.session_id;

      if (message.type === 'result') {
        state.result = {
          payload: typeof message.result === 'string' ? message.result : null,
          sessionId: state.sessionId,
          costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : null,
          durationMs:
            typeof message.duration_ms === 'number' ? message.duration_ms : Date.now() - started,
          numTurns: typeof message.num_turns === 'number' ? message.num_turns : null,
        };
      }

      const event = toProgressEvent(message);
      if (event) request.onEvent(event);
    };

    const finished = new Promise<void>((resolve) => {
      let pending = '';

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBytes += chunk.length;
        // A chunk boundary lands anywhere, including the middle of a JSON
        // object, so only whole lines are parsed and the tail is carried over.
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < STDERR_CAP) stderr += chunk;
      });

      child.on('error', (error) => {
        // Fires when the executable is missing or not runnable, in which case
        // 'close' may never come.
        state.failure ??= new AgentProcessError(
          'spawn',
          `cannot start "${this.config.get<string>('reps.cli')}": ${error.message}`,
          state.sessionId,
        );
        resolve();
      });

      child.on('close', (code, signal) => {
        if (pending) handleLine(pending);
        if (!state.failure && code !== 0) {
          state.failure = new AgentProcessError(
            'exit',
            `agent exited with ${signal ? `signal ${signal}` : `code ${code}`}` +
              (stderr.trim() ? `: ${truncate(stderr.trim(), 500)}` : ''),
            state.sessionId,
          );
        }
        resolve();
      });
    });

    const timeoutMs = this.config.getOrThrow<number>('reps.taskTimeoutMs');
    const timer = setTimeout(() => {
      state.failure ??= new AgentProcessError(
        'timeout',
        `agent exceeded ${Math.round(timeoutMs / 1000)}s`,
        state.sessionId,
      );
      void killTree(child.pid);
    }, timeoutMs);

    const onAbort = (): void => {
      state.failure ??= new AgentProcessError('cancelled', 'job cancelled', state.sessionId);
      void killTree(child.pid);
    };
    request.signal.addEventListener('abort', onAbort, { once: true });

    try {
      child.stdin.on('error', () => {
        // The child can die before the prompt is written; 'error' or 'close'
        // already carries the real reason.
      });
      child.stdin.end(request.prompt);
      await finished;
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
    }

    if (state.failure) throw state.failure;
    if (!state.result) {
      throw new AgentProcessError(
        'no_result',
        `agent finished without a result message (${stdoutBytes} bytes on stdout)`,
        state.sessionId,
      );
    }

    this.logger.debug(`agent finished in ${Date.now() - started}ms, session ${state.sessionId}`);
    return state.result;
  }

  /**
   * Turns the configured name into something spawn can actually execute.
   *
   * On Windows the CLI is a `.cmd` shim, and spawn without a shell will not
   * apply PATHEXT for you — a bare "claude" is ENOENT even though the same word
   * works in a terminal. Resolving it here keeps `shell: false`, so nothing on
   * the command line is ever handed to a shell to re-parse.
   */
  private executable(): string {
    if (this.resolvedCli) return this.resolvedCli;

    const configured = this.config.getOrThrow<string>('reps.cli');
    this.resolvedCli = resolveOnPath(configured) ?? configured;

    if (this.resolvedCli !== configured) {
      this.logger.log(`agent CLI "${configured}" resolved to ${this.resolvedCli}`);
    }
    return this.resolvedCli;
  }

  private argsFor(request: AgentRunRequest): string[] {
    const budget = this.config.getOrThrow<number>('reps.maxBudgetUsd');

    const args = [
      '--print',
      '--output-format',
      'stream-json',
      // stream-json in print mode only emits the intermediate messages we build
      // progress from when verbose is on.
      '--verbose',
      '--model',
      this.config.getOrThrow<string>('reps.model'),
      // The empty tool set is the real boundary, and the prompt only explains
      // it: with no file, shell or network tools there is nothing for a task to
      // reach for even if its input talks it into trying. Everything it may use
      // is in the prompt, and the answer comes back as structured output.
      '--tools',
      '',
      // Replaces Claude Code's own system prompt, which is written for a coding
      // assistant with tools and only slows a task like this down. Its content
      // is the role, skill and answer format — static text from this
      // repository, never job data, so it is safe on a command line.
      '--system-prompt',
      request.systemPrompt,
    ];

    if (budget > 0) args.push('--max-budget-usd', String(budget));

    if (request.resumeSessionId) {
      args.push('--resume', request.resumeSessionId);
    } else {
      args.push('--session-id', request.newSessionId);
    }

    return args;
  }
}

/**
 * Finds a bare command name on PATH, honouring PATHEXT on Windows. Returns null
 * when the name already carries a directory, or when nothing matches — spawn's
 * own ENOENT is then the clearer error.
 *
 * Extensions are tried real-executable-first because Node refuses to run a
 * `.cmd` or `.bat` without a shell, and a shell would have to re-parse our
 * arguments. When only a shim is on PATH, the binary it wraps is used instead.
 */
function resolveOnPath(command: string): string | null {
  if (command.includes('/') || command.includes('\\')) return null;

  const directories = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32' ? ['.exe', '.com', '.cmd', '.bat'] : [''];

  for (const extension of extensions) {
    for (const directory of directories) {
      const candidate = join(directory, command + extension);
      if (!existsSync(candidate)) continue;
      return extension === '.cmd' || extension === '.bat'
        ? (targetOfWindowsShim(candidate) ?? candidate)
        : candidate;
    }
  }
  return null;
}

/**
 * Pulls the executable out of an npm-generated `.cmd` shim, which calls it as
 * `"%dp0%\path\to\thing.exe" %*`. Returns null for anything else — including a
 * shim that runs `node script.js`, where the script argument would have to come
 * along too and spawn's plain EINVAL is the more honest failure.
 */
function targetOfWindowsShim(shimPath: string): string | null {
  let text: string;
  try {
    text = readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }

  for (const match of text.matchAll(/"%dp0%\\+([^"]+\.exe)"/gi)) {
    const target = join(dirname(shimPath), match[1]);
    if (basename(target).toLowerCase() === 'node.exe') return null;
    if (existsSync(target)) return target;
  }
  return null;
}

/** Turns one CLI message into a progress line, or nothing if it is noise. */
function toProgressEvent(message: Record<string, unknown>): AgentProgressEvent | null {
  switch (message.type) {
    case 'system':
      return message.subtype === 'init'
        ? { level: 'info', message: 'agent session started', data: { model: message.model } }
        : null;

    case 'assistant': {
      const blocks = contentBlocksOf(message);
      const text = blocks
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('\n')
        .trim();
      const tools = blocks
        .filter((block) => block.type === 'tool_use' && typeof block.name === 'string')
        .map((block) => block.name as string);

      if (tools.length) {
        return { level: 'debug', message: `using ${tools.join(', ')}` };
      }
      return text ? { level: 'info', message: truncate(text, EVENT_TEXT_CAP) } : null;
    }

    case 'result':
      return message.is_error === true
        ? { level: 'warn', message: `agent reported ${String(message.subtype ?? 'an error')}` }
        : {
            level: 'info',
            message: 'agent finished',
            data: { costUsd: message.total_cost_usd, turns: message.num_turns },
          };

    default:
      return null;
  }
}

function contentBlocksOf(message: Record<string, unknown>): Record<string, unknown>[] {
  const inner = message.message;
  if (!inner || typeof inner !== 'object') return [];
  const content = (inner as { content?: unknown }).content;
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The agent spawns children of its own, so killing the process alone can leave
 * them holding the workspace. Windows has no process group to signal, hence the
 * split.
 */
async function killTree(pid: number | undefined): Promise<void> {
  if (!pid) return;

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => resolve());
      killer.on('close', () => resolve());
    });
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }, 5_000).unref();
}
