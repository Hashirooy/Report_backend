import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import PgBoss from 'pg-boss';

export const PARSE_RUN_QUEUE = 'parse-run';
export const REPS_JOB_QUEUE = 'reps-job';

export interface ParseRunJob {
  runId: string;
  archivePath: string;
}

/**
 * Carries only the id: a Reps job is long-lived and its state changes while it
 * queues, so the worker reads it fresh rather than trusting a snapshot.
 */
export interface RepsAgentJob {
  jobId: string;
}

/**
 * Job queue backed by the same PostgreSQL instance as the data.
 *
 * Parsing thousands of JSON files is CPU-bound; doing it inside the HTTP
 * process would stall the event loop and with it every other request. Keeping
 * the queue in Postgres avoids running Redis for a single queue.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private boss: PgBoss;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const connectionString = this.config.getOrThrow<string>('database.url');
    this.boss = new PgBoss({ connectionString, schema: 'pgboss' });
    this.boss.on('error', (error) => this.logger.error('queue error', error));
    await this.boss.start();
    await this.boss.createQueue(PARSE_RUN_QUEUE);
    await this.boss.createQueue(REPS_JOB_QUEUE);
    this.logger.log('queue ready');
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss?.stop({ graceful: true });
  }

  async enqueueParse(job: ParseRunJob): Promise<void> {
    await this.boss.send(PARSE_RUN_QUEUE, job, {
      retryLimit: 3,
      retryBackoff: true,
      expireInMinutes: 30,
    });
  }

  /**
   * An agent job is retried by the orchestrator, not by the queue: a half-done
   * job has tasks and events on disk, and blindly replaying it would pay for
   * the same generation twice. A crash therefore leaves the job for the stale
   * heartbeat check rather than bouncing it back into the queue.
   */
  async enqueueRepsJob(job: RepsAgentJob): Promise<void> {
    await this.boss.send(REPS_JOB_QUEUE, job, {
      retryLimit: 0,
      expireInHours: 6,
    });
  }

  async consumeRepsJobs(
    handler: (job: RepsAgentJob) => Promise<void>,
    concurrency: number,
  ): Promise<void> {
    await this.boss.work<RepsAgentJob>(
      REPS_JOB_QUEUE,
      { batchSize: concurrency, pollingIntervalSeconds: 2 },
      // Handled in parallel — a batch of agent jobs is `concurrency` CLI
      // processes running side by side, and each one is mostly waiting on the
      // model. The orchestrator records its own failures, so a rejection here
      // would only mean a bug; allSettled keeps one from cancelling the rest.
      async (jobs) => {
        await Promise.allSettled(jobs.map((job) => handler(job.data)));
      },
    );
  }

  /** Registers the consumer. Only the worker entrypoint calls this. */
  async consumeParse(
    handler: (job: ParseRunJob) => Promise<void>,
    concurrency: number,
  ): Promise<void> {
    await this.boss.work<ParseRunJob>(
      PARSE_RUN_QUEUE,
      { batchSize: concurrency, pollingIntervalSeconds: 2 },
      async (jobs) => {
        for (const job of jobs) {
          await handler(job.data);
        }
      },
    );
  }
}
