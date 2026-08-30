import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import PgBoss from 'pg-boss';

export const PARSE_RUN_QUEUE = 'parse-run';

export interface ParseRunJob {
  runId: string;
  archivePath: string;
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
