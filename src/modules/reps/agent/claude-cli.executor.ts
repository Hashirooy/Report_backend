import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AgentRunRequest } from './agent-executor.js';
import { CliAgentExecutor, EVENT_TEXT_CAP, truncate, type StreamUpdate } from './cli-agent.executor.js';

/**
 * Runs a task as a Claude Code process.
 *
 * Everything about spawning, streaming and killing is the base class's; what
 * is Claude's own is the command line and the shape of a stream message.
 */
@Injectable()
export class ClaudeCliExecutor extends CliAgentExecutor {
  constructor(config: ConfigService) {
    super(config);
  }

  protected override argsFor(request: AgentRunRequest): string[] {
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

  protected override interpret(message: Record<string, unknown>): StreamUpdate {
    const update: StreamUpdate = {};

    if (typeof message.session_id === 'string') update.sessionId = message.session_id;

    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          update.event = {
            level: 'info',
            message: 'agent session started',
            data: { model: message.model },
          };
        }
        break;

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
          update.event = { level: 'debug', message: `using ${tools.join(', ')}` };
        } else if (text) {
          update.event = { level: 'info', message: truncate(text, EVENT_TEXT_CAP) };
        }
        break;
      }

      case 'result':
        update.result = {
          payload: typeof message.result === 'string' ? message.result : null,
          costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : null,
          durationMs: typeof message.duration_ms === 'number' ? message.duration_ms : null,
          numTurns: typeof message.num_turns === 'number' ? message.num_turns : null,
        };
        update.event =
          message.is_error === true
            ? { level: 'warn', message: `agent reported ${String(message.subtype ?? 'an error')}` }
            : {
                level: 'info',
                message: 'agent finished',
                data: { costUsd: message.total_cost_usd, turns: message.num_turns },
              };
        break;

      default:
        break;
    }

    return update;
  }
}

function contentBlocksOf(message: Record<string, unknown>): Record<string, unknown>[] {
  const inner = message.message;
  if (!inner || typeof inner !== 'object') return [];
  const content = (inner as { content?: unknown }).content;
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
}
