import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';

import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import {
  AgentExecutor,
  AgentProcessError,
  type AgentProgressEvent,
  type AgentRunRequest,
  type AgentRunResult,
} from './agent-executor.js';

/** Keeps a runaway stderr out of the job's error column. */
const STDERR_CAP = 8_000;
/** Assistant text is logged as progress, not stored in full. */
export const EVENT_TEXT_CAP = 1_000;

interface CliCommand {
  file: string;
  prefixArgs: string[];
}

/** What one line of a CLI's stream tells us. Every field is optional. */
export interface StreamUpdate {
  /** A session id carried by this message, if it names one. */
  sessionId?: string;
  /** Latest agent message; some CLIs signal completion in a later event. */
  text?: string;
  /**
   * Present only on the message that ends the run. `durationMs` may be left out
   * when the CLI does not report one, and wall clock is used instead.
   */
  result?: {
    payload: string | null;
    costUsd: number | null;
    durationMs?: number | null;
    numTurns: number | null;
  };
  /** A terminal failure reported by a CLI even if it exits with code zero. */
  failure?: string;
  /** A line for the job's event log, or nothing if the message is noise. */
  event?: AgentProgressEvent;
}

/**
 * Runs one task as a child process of an agent CLI.
 *
 * The four channels of the contract map straight onto the child: the handoff
 * goes in on stdin, progress comes back as NDJSON on stdout, diagnostics on
 * stderr, and the exit tells us whether the process itself survived. Exit code
 * 0 is necessary but not sufficient — the orchestrator still has to like what
 * the final message says.
 *
 * None of that is particular to one vendor, so it lives here and a subclass
 * says only three things: what to put on the command line, what a line of the
 * stream means, and where the process should run.
 */
export abstract class CliAgentExecutor extends AgentExecutor {
  protected readonly logger = new Logger(this.constructor.name);
  private resolvedCli: CliCommand | null = null;

  constructor(protected readonly config: ConfigService) {
    super();
  }

  /** The command line, minus the executable. The prompt is never on it. */
  protected abstract argsFor(request: AgentRunRequest): string[];

  /** Reads one parsed NDJSON message. Must not throw. */
  protected abstract interpret(message: Record<string, unknown>): StreamUpdate;

  /**
   * Where the child runs. A temporary directory keeps the agent away from the
   * repository, whose agent instructions and settings would otherwise be picked
   * up. Overridden by a CLI that needs something placed in its working
   * directory.
   */
  protected workingDirectory(_request: AgentRunRequest): string {
    return tmpdir();
  }

  /** Called after the child exits, including failed starts and cancellation. */
  protected cleanupWorkingDirectory(_directory: string): void {}

  /** The environment the CLI receives. Providers may remove app secrets. */
  protected childEnvironment(): NodeJS.ProcessEnv {
    return process.env;
  }

  override async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const directory = this.workingDirectory(request);
    try {
      return await this.runInDirectory(request, directory);
    } finally {
      this.cleanupWorkingDirectory(directory);
    }
  }

  private async runInDirectory(
    request: AgentRunRequest,
    directory: string,
  ): Promise<AgentRunResult> {
    const started = Date.now();
    const command = this.executable();
    const child = spawn(command.file, [...command.prefixArgs, ...this.argsFor(request)], {
      cwd: directory,
      // No shell: the prompt never reaches a command line, but the CLI path and
      // model come from configuration and should not be word-split either.
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.childEnvironment(),
      windowsHide: true,
    });

    // Held in an object rather than plain locals: everything below is written
    // from stream callbacks, and TypeScript cannot narrow a `let` that a
    // closure assigns to.
    const state: {
      sessionId: string | null;
      latestText: string | null;
      result: AgentRunResult | null;
      failure: AgentProcessError | null;
    } = {
      sessionId: request.resumeSessionId ?? null,
      latestText: null,
      result: null,
      failure: null,
    };

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

      const update = this.interpret(message);

      // Before the result, so a CLI that names the session on the same message
      // that ends the run still has it recorded against that run.
      if (update.sessionId) state.sessionId = update.sessionId;
      if (update.text !== undefined) state.latestText = update.text;

      if (update.result) {
        state.result = {
          payload: update.result.payload ?? state.latestText,
          sessionId: state.sessionId,
          costUsd: update.result.costUsd,
          durationMs: update.result.durationMs ?? Date.now() - started,
          numTurns: update.result.numTurns,
        };
      }

      if (update.failure) {
        state.failure ??= new AgentProcessError('exit', update.failure, state.sessionId);
      }

      if (update.event) request.onEvent(update.event);
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
   * On Windows a CLI is usually a `.cmd` shim, and spawn without a shell will
   * not apply PATHEXT for you — a bare name is ENOENT even though the same word
   * works in a terminal. Resolving it here keeps `shell: false`, so nothing on
   * the command line is ever handed to a shell to re-parse.
   */
  private executable(): CliCommand {
    if (this.resolvedCli) return this.resolvedCli;

    const configured = this.config.getOrThrow<string>('reps.cli');
    this.resolvedCli = resolveOnPath(configured) ??
      (process.platform === 'win32' && /\.(cmd|bat)$/i.test(configured)
        ? targetOfWindowsShim(configured)
        : null) ?? { file: configured, prefixArgs: [] };

    if (this.resolvedCli.file !== configured || this.resolvedCli.prefixArgs.length) {
      this.logger.log(`agent CLI "${configured}" resolved to ${this.resolvedCli.file}`);
    }
    return this.resolvedCli;
  }
}

/**
 * Finds a bare command name on PATH, honouring PATHEXT on Windows. Returns null
 * when the name already carries a directory, or when nothing matches — spawn's
 * own ENOENT is then the clearer error.
 *
 * Extensions are tried real-executable-first because Node refuses to run a
 * `.cmd` or `.bat` without a shell, and a shell would have to re-parse our
 * arguments. When only a shim is on PATH, its target is launched directly.
 */
function resolveOnPath(command: string): CliCommand | null {
  if (command.includes('/') || command.includes('\\')) return null;

  const directories = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? ['.exe', '.com', '.cmd', '.bat'] : [''];

  for (const extension of extensions) {
    for (const directory of directories) {
      const candidate = join(directory, command + extension);
      if (!existsSync(candidate)) continue;
      return extension === '.cmd' || extension === '.bat'
        ? (targetOfWindowsShim(candidate) ?? { file: candidate, prefixArgs: [] })
        : { file: candidate, prefixArgs: [] };
    }
  }
  return null;
}

/**
 * Extracts a native executable or Node entrypoint from an npm `.cmd` shim.
 * Node shims need the script as a prefix argument; the shell stays off.
 */
export function targetOfWindowsShim(shimPath: string): CliCommand | null {
  let text: string;
  try {
    text = readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }

  for (const match of text.matchAll(/"%dp0%\\+([^"]+\.exe)"/gi)) {
    const target = join(dirname(shimPath), ...match[1].split(/\\+/));
    if (basename(target).toLowerCase() === 'node.exe') continue;
    if (existsSync(target)) return { file: target, prefixArgs: [] };
  }
  for (const match of text.matchAll(/"%dp0%\\+([^"]+\.(?:js|cjs|mjs))"/gi)) {
    const script = join(dirname(shimPath), ...match[1].split(/\\+/));
    if (existsSync(script)) return { file: process.execPath, prefixArgs: [script] };
  }
  return null;
}

export function truncate(text: string, max: number): string {
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
