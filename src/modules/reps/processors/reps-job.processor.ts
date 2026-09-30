import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type RepsJob, type RepsTask } from '@prisma/client';

import type { RepsAgentJob } from '../../../queue/queue.service.js';
import {
  AgentOutputSchema,
  parseAgentOutput,
  type AgentOutput,
} from '../agent/agent-output.contract.js';
import {
  AgentExecutor,
  AgentProcessError,
  type AgentProgressEvent,
} from '../agent/agent-executor.js';
import { PromptBuilder, type TaskHandoff } from '../agent/prompt.builder.js';
import { RunContextBuilder, type JobContext } from '../agent/run-context.builder.js';
import { RepsRepository } from '../reps.repository.js';

/**
 * The name the produced document carries. One document per job, by design; the
 * name follows the kind so a downloaded file says what it is without its job.
 */
const REPORT_NAMES: Record<string, string> = {
  analyze_run: 'report.md',
  analyze_test: 'test-analysis.md',
};
const DEFAULT_REPORT_NAME = 'report.md';

/** Guards against a plan that keeps growing if a decision rule ever misfires. */
const MAX_TASKS_PER_JOB = 12;

/** What a finished task tells the orchestrator to do next. */
type Decision =
  | { kind: 'continue' }
  | { kind: 'retry'; findings: { id: string; message: string }[] }
  | { kind: 'fail'; error: string }
  | { kind: 'cancelled' };

/**
 * Runs a Reps job to completion, one task at a time.
 *
 * Lives in the worker process. The job's whole state is in the database, so an
 * orchestrator that dies mid-run leaves a job with a stale heartbeat rather
 * than a lost one, and nothing here holds state between tasks that could not be
 * read back.
 */
@Injectable()
export class RepsJobProcessor {
  private readonly logger = new Logger(RepsJobProcessor.name);

  constructor(
    private readonly config: ConfigService,
    private readonly repo: RepsRepository,
    private readonly context: RunContextBuilder,
    private readonly prompts: PromptBuilder,
    private readonly executor: AgentExecutor,
  ) {}

  async process({ jobId }: RepsAgentJob): Promise<void> {
    const id = BigInt(jobId);

    const job = await this.repo.findJob(id);
    if (!job) {
      this.logger.warn(`job ${jobId} vanished before it ran; dropping message`);
      return;
    }

    // Conditional claim: a resumed job is queued again, and a message can be
    // delivered more than once. Only the write that flips `pending` proceeds.
    if (!(await this.repo.claim(id))) {
      this.logger.warn(`job ${jobId} is ${job.status}, not pending; dropping message`);
      return;
    }

    try {
      await this.runJob(id);
    } catch (error) {
      // Nothing below is expected to throw; if it does, the job must not be
      // left sitting in `running` forever.
      const message = (error as Error).message || 'unknown orchestrator failure';
      this.logger.error(`job ${jobId}: ${message}`, (error as Error).stack);
      await this.repo.appendEvent({ jobId: id, taskId: null, level: 'error', message });
      await this.repo.finishJob(id, 'failed', { error: message });
    }
  }

  private async runJob(jobId: bigint): Promise<void> {
    const job = await this.repo.findJob(jobId);
    if (!job) return;

    if (job.cancelRequested) {
      await this.cancel(jobId, 'cancelled before the first task started');
      return;
    }

    const context = await this.context.build(job);
    await this.repo.appendEvent({
      jobId,
      taskId: null,
      level: 'info',
      message: 'context prepared',
      data: { bytes: context.json?.length ?? 0 },
    });

    await this.ensurePlan(job, context);

    // One task per turn of the loop; the plan is re-read every time because a
    // rejected review appends to it.
    for (;;) {
      const tasks = await this.repo.findTasks(jobId);
      const next = tasks.find(
        (task) => task.status === 'pending' && this.dependenciesMet(task, tasks),
      );

      if (!next) {
        await this.succeed(jobId, tasks);
        return;
      }

      const decision = await this.runTask(job, next, context);

      switch (decision.kind) {
        case 'continue':
          break;

        case 'retry': {
          const attempt = tasks.filter((task) => task.type === 'generate').length + 1;
          if (attempt > job.maxAttemptsPerStage || tasks.length >= MAX_TASKS_PER_JOB) {
            await this.repo.appendEvent({
              jobId,
              taskId: next.id,
              level: 'error',
              message: `giving up after ${attempt - 1} attempt(s)`,
              data: { findings: decision.findings },
            });
            await this.repo.finishJob(jobId, 'failed', {
              error:
                `the document still did not pass review after ${attempt - 1} attempt(s): ` +
                decision.findings.map((finding) => finding.message).join('; '),
            });
            return;
          }
          await this.appendRetry(job, context, attempt, decision.findings);
          break;
        }

        case 'cancelled':
          await this.cancel(jobId, 'cancelled while a task was running');
          return;

        case 'fail':
          await this.repo.finishJob(jobId, 'failed', { error: decision.error });
          return;
      }
    }
  }

  // --------------------------------------------------------------- the plan

  /** The fixed route: write it, then review it. */
  private async ensurePlan(job: RepsJob, context: JobContext): Promise<void> {
    if ((await this.repo.findTasks(job.id)).length > 0) return;

    const generate = await this.repo.createTask({
      jobId: job.id,
      type: 'generate',
      orderNum: 0,
      attempt: 1,
      dependsOn: [],
      input: this.handoff(job, context, {
        type: 'generate',
        attempt: 1,
        taskId: 'pending',
        findings: [],
      }) as unknown as Prisma.InputJsonValue,
    });

    await this.repo.createTask({
      jobId: job.id,
      type: 'validate',
      orderNum: 1,
      attempt: 1,
      dependsOn: [generate.id],
      input: this.handoff(job, context, {
        type: 'validate',
        attempt: 1,
        taskId: 'pending',
        findings: [],
      }) as unknown as Prisma.InputJsonValue,
    });
  }

  /** A rejected review adds a fresh pair, so the history of attempts survives. */
  private async appendRetry(
    job: RepsJob,
    context: JobContext,
    attempt: number,
    findings: { id: string; message: string }[],
  ): Promise<void> {
    await this.repo.cancelPendingTasks(job.id);
    const tasks = await this.repo.findTasks(job.id);
    const orderNum = tasks.length;

    const generate = await this.repo.createTask({
      jobId: job.id,
      type: 'generate',
      orderNum,
      attempt,
      dependsOn: [],
      input: this.handoff(job, context, {
        type: 'generate',
        attempt,
        taskId: 'pending',
        findings,
      }) as unknown as Prisma.InputJsonValue,
    });

    await this.repo.createTask({
      jobId: job.id,
      type: 'validate',
      orderNum: orderNum + 1,
      attempt,
      dependsOn: [generate.id],
      input: this.handoff(job, context, {
        type: 'validate',
        attempt,
        taskId: 'pending',
        findings: [],
      }) as unknown as Prisma.InputJsonValue,
    });

    await this.repo.appendEvent({
      jobId: job.id,
      taskId: null,
      level: 'info',
      message: `review rejected the document; starting attempt ${attempt}`,
      data: { findings },
    });
  }

  private dependenciesMet(task: RepsTask, tasks: RepsTask[]): boolean {
    return task.dependsOn.every(
      (id) => tasks.find((candidate) => candidate.id === id)?.status === 'succeeded',
    );
  }

  // -------------------------------------------------------------- one task

  private async runTask(job: RepsJob, task: RepsTask, context: JobContext): Promise<Decision> {
    const answers = await this.repo.findAnswers(job.id);

    // The reviewer reads the document out of the database, where the generation
    // stage just put it. That is also the only copy — there is no file for the
    // two stages to share, and they run as separate sessions on purpose.
    const documentUnderReview =
      task.type === 'validate' ? await this.repo.findLatestArtifact(job.id) : null;

    const handoff = this.handoff(job, context, {
      type: task.type,
      attempt: task.attempt,
      taskId: task.id.toString(),
      findings: (task.input as { validatorFeedback?: { id: string; message: string }[] })
        ?.validatorFeedback ?? [],
      answers: answers.map((row) => ({
        id: row.externalId,
        question: row.text,
        answer: row.answer ?? '',
      })),
      documentUnderReview: documentUnderReview
        ? {
            name: documentUnderReview.name,
            mediaType: documentUnderReview.mediaType,
            content: documentUnderReview.content,
          }
        : null,
    });

    await this.repo.startTask(task.id, handoff as unknown as Prisma.InputJsonValue);
    await this.repo.appendEvent({
      jobId: job.id,
      taskId: task.id,
      level: 'info',
      message: `${task.type} stage started (attempt ${task.attempt})`,
    });

    const controller = new AbortController();
    // Events are written in order behind one promise so the stream cannot
    // interleave, and so a slow database never back-pressures the child.
    let writes: Promise<unknown> = Promise.resolve();
    const emit = (event: AgentProgressEvent): void => {
      writes = writes
        .then(() =>
          this.repo.appendEvent({
            jobId: job.id,
            taskId: task.id,
            level: event.level,
            message: event.message,
            ...(event.data === undefined
              ? {}
              : { data: event.data as Prisma.InputJsonValue }),
          }),
        )
        .catch((error: Error) => this.logger.warn(`event not stored: ${error.message}`));
    };

    // The cancel flag is set by the API in another process, so it can only
    // arrive through the database. The same tick doubles as the heartbeat.
    const heartbeat = setInterval(() => {
      void this.repo
        .touchHeartbeat(job.id, task.id)
        .then((cancelRequested) => {
          if (cancelRequested) controller.abort();
        })
        .catch((error: Error) => this.logger.warn(`heartbeat failed: ${error.message}`));
    }, this.config.getOrThrow<number>('reps.heartbeatMs'));

    try {
      const { system, prompt } = this.prompts.build(handoff);
      const result = await this.executor.run({
        prompt,
        systemPrompt: system,
        resumeSessionId: task.sessionId,
        newSessionId: randomUUID(),
        signal: controller.signal,
        onEvent: emit,
      });

      await writes;
      if (result.costUsd !== null) await this.repo.addCost(job.id, result.costUsd);
      if (result.sessionId) {
        await this.repo.updateJob(job.id, { sessionId: result.sessionId });
      }

      return await this.acceptOutput(
        job,
        task,
        result.sessionId,
        parseAgentOutput(result.payload, handoff.documentName),
      );
    } catch (error) {
      await writes;
      return this.rejectProcess(job, task, error);
    } finally {
      clearInterval(heartbeat);
    }
  }

  /**
   * Exit code 0 only says the CLI survived. A task counts as done when the
   * answer parses, matches the contract, and carries what its stage owes.
   */
  private async acceptOutput(
    job: RepsJob,
    task: RepsTask,
    sessionId: string | null,
    payload: unknown,
  ): Promise<Decision> {
    const parsed = AgentOutputSchema.safeParse(payload);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'output'}: ${issue.message}`)
        .join('; ');
      await this.repo.finishTask(task.id, {
        status: 'failed',
        error: `answer does not match the result contract — ${detail}`,
        sessionId,
        output: (payload ?? null) as Prisma.InputJsonValue,
      });
      await this.repo.appendEvent({
        jobId: job.id,
        taskId: task.id,
        level: 'error',
        message: `answer does not match the result contract: ${detail}`,
      });
      return {
        kind: 'retry',
        findings: [{ id: 'CONTRACT', message: `previous answer was malformed — ${detail}` }],
      };
    }

    const output: AgentOutput = parsed.data;

    const stored = await this.storeDocuments(job, task, output);
    if (stored.rejected.length) {
      const message = `document(s) could not be stored: ${stored.rejected.join(', ')}`;
      await this.repo.finishTask(task.id, {
        status: 'failed',
        error: message,
        sessionId,
        output: output as unknown as Prisma.InputJsonValue,
      });
      await this.repo.appendEvent({ jobId: job.id, taskId: task.id, level: 'error', message });
      return { kind: 'retry', findings: [{ id: 'FILES', message }] };
    }

    if (task.type === 'validate') {
      if (output.status === 'rejected') {
        await this.repo.finishTask(task.id, {
          status: 'succeeded',
          sessionId,
          output: output as unknown as Prisma.InputJsonValue,
        });
        const findings = output.findings.length
          ? output.findings
          : [{ id: 'REVIEW', message: output.summary }];
        return { kind: 'retry', findings };
      }
      if (output.status !== 'approved') {
        return {
          kind: 'retry',
          findings: [
            {
              id: 'CONTRACT',
              message: `review returned "${output.status}" instead of approved or rejected`,
            },
          ],
        };
      }
    } else if (output.status !== 'generated') {
      return {
        kind: 'retry',
        findings: [
          {
            id: 'CONTRACT',
            message: `generation returned "${output.status}" instead of generated`,
          },
        ],
      };
    } else if (!output.documents.length) {
      // A generator that reports success with no document leaves the reviewer
      // nothing to read, so it is a rejection, not a silent success.
      return {
        kind: 'retry',
        findings: [{ id: 'DOCUMENT', message: 'no document was returned' }],
      };
    }

    await this.repo.finishTask(task.id, {
      status: 'succeeded',
      sessionId,
      output: output as unknown as Prisma.InputJsonValue,
    });
    await this.repo.appendEvent({
      jobId: job.id,
      taskId: task.id,
      level: 'info',
      message: `${task.type} stage finished: ${output.summary}`,
    });

    return { kind: 'continue' };
  }

  /** Stores the documents the agent returned, refusing any that is too large. */
  private async storeDocuments(
    job: RepsJob,
    task: RepsTask,
    output: AgentOutput,
  ): Promise<{ rejected: string[] }> {
    const maxBytes = this.config.getOrThrow<number>('reps.maxArtifactBytes');
    const accepted: { name: string; mediaType: string; content: string; sizeBytes: number }[] = [];
    const rejected: string[] = [];

    for (const document of output.documents) {
      const sizeBytes = Buffer.byteLength(document.content, 'utf8');
      if (sizeBytes > maxBytes) {
        rejected.push(`${document.name} (${sizeBytes} bytes, over the ${maxBytes} byte limit)`);
        continue;
      }
      accepted.push({
        name: document.name,
        mediaType: document.mediaType,
        content: document.content,
        sizeBytes,
      });
    }

    if (accepted.length) await this.repo.saveArtifacts(job.id, task.id, accepted);
    return { rejected };
  }

  /**
   * A process that never got to answer. Cancellation ends the job; a timeout or
   * a crash fails it rather than paying to try again — the same prompt would
   * most likely break the same way, and the operator should see why.
   */
  private async rejectProcess(job: RepsJob, task: RepsTask, error: unknown): Promise<Decision> {
    const failure =
      error instanceof AgentProcessError
        ? error
        : new AgentProcessError('exit', (error as Error).message || 'unknown agent failure');

    await this.repo.finishTask(task.id, {
      status: failure.reason === 'cancelled' ? 'cancelled' : 'failed',
      error: `${failure.reason}: ${failure.message}`,
      sessionId: failure.sessionId,
    });
    await this.repo.appendEvent({
      jobId: job.id,
      taskId: task.id,
      level: failure.reason === 'cancelled' ? 'warn' : 'error',
      message: `${task.type} stage failed (${failure.reason}): ${failure.message}`,
    });

    return failure.reason === 'cancelled'
      ? { kind: 'cancelled' }
      : { kind: 'fail', error: `${failure.reason}: ${failure.message}` };
  }

  // ------------------------------------------------------------- endings

  private async succeed(jobId: bigint, tasks: RepsTask[]): Promise<void> {
    const last = [...tasks].reverse().find((task) => task.status === 'succeeded');
    const summary = (last?.output as { summary?: string } | null)?.summary ?? null;

    await this.repo.finishJob(jobId, 'succeeded', { summary });
    await this.repo.appendEvent({
      jobId,
      taskId: null,
      level: 'info',
      message: 'job finished',
    });
  }

  private async cancel(jobId: bigint, message: string): Promise<void> {
    await this.repo.finishJob(jobId, 'cancelled', { error: null });
    await this.repo.appendEvent({ jobId, taskId: null, level: 'warn', message });
  }

  private handoff(
    job: RepsJob,
    context: JobContext,
    task: {
      type: 'generate' | 'validate';
      attempt: number;
      taskId: string;
      findings: { id: string; message: string }[];
      answers?: { id: string; question: string; answer: string }[];
      documentUnderReview?: TaskHandoff['documentUnderReview'];
    },
  ): TaskHandoff {
    return {
      jobId: job.id.toString(),
      taskId: task.taskId,
      type: task.type,
      attempt: task.attempt,
      kind: job.kind,
      userRequest: job.userRequest,
      context: context.json,
      contextDigest: context.digest,
      documentName: REPORT_NAMES[job.kind] ?? DEFAULT_REPORT_NAME,
      documentUnderReview: task.documentUnderReview ?? null,
      validatorFeedback: task.findings,
      answers: task.answers ?? [],
    };
  }
}
