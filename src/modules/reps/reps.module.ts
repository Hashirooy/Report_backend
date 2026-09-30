import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProjectsModule } from '../projects/projects.module.js';
import { AgentExecutor } from './agent/agent-executor.js';
import { ApiContractResolver } from './agent/api-contract.resolver.js';
import { ClaudeCliExecutor } from './agent/claude-cli.executor.js';
import { CodexCliExecutor } from './agent/codex-cli.executor.js';
import { PromptBuilder } from './agent/prompt.builder.js';
import { RunContextBuilder } from './agent/run-context.builder.js';
import { SkillLibrary } from './agent/skill.library.js';
import { RepsJobProcessor } from './processors/reps-job.processor.js';
import { RepsController } from './reps.controller.js';
import { RepsRecoveryService } from './reps.recovery.js';
import { RepsRepository } from './reps.repository.js';
import { RepsService } from './reps.service.js';

/**
 * Both entrypoints load this module: the API creates and reads jobs, the worker
 * resolves `RepsJobProcessor` out of it and runs them. The controller is simply
 * never routed in the worker, which has no HTTP server.
 */
@Module({
  // Jobs are not addressed by project in the URL, so visibility is checked
  // against the project access service rather than by the path guard.
  imports: [ProjectsModule],
  controllers: [RepsController],
  providers: [
    RepsService,
    RepsRepository,
    RunContextBuilder,
    ApiContractResolver,
    SkillLibrary,
    PromptBuilder,
    // Which CLI backs the agent is a deployment choice, so the processor is
    // given the abstraction and this is the one place that names a CLI.
    {
      provide: AgentExecutor,
      inject: [ConfigService],
      useFactory: (config: ConfigService): AgentExecutor =>
        config.getOrThrow<string>('reps.provider') === 'codex'
          ? new CodexCliExecutor(config)
          : new ClaudeCliExecutor(config),
    },
    RepsJobProcessor,
    RepsRecoveryService,
  ],
  exports: [RepsService, RepsJobProcessor, RepsRecoveryService],
})
export class RepsModule {}
