import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { enableBigIntSerialization } from './common/utils/serialization.js';
import { ParseRunProcessor } from './modules/ingest/processors/parse-run.processor.js';
import { RepsJobProcessor } from './modules/reps/processors/reps-job.processor.js';
import { RepsRecoveryService } from './modules/reps/reps.recovery.js';
import { QueueService } from './queue/queue.service.js';

/**
 * Second entrypoint over the same modules: no HTTP server, just the queue
 * consumers. Parsing is CPU-bound and agent jobs run for minutes, so both stay
 * out of the API process where they would stall its event loop or die with it.
 */
async function bootstrap(): Promise<void> {
  enableBigIntSerialization();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.enableShutdownHooks();

  const queue = app.get(QueueService);
  const config = app.get(ConfigService);

  const parser = app.get(ParseRunProcessor);
  const parseConcurrency = config.get<number>('worker.concurrency') ?? 2;
  await queue.consumeParse((job) => parser.process(job), parseConcurrency);

  // Before taking new work: any job left in `running` by a previous worker has
  // nobody finishing it, and would otherwise sit there forever.
  const recovered = await app.get(RepsRecoveryService).recoverStaleJobs();
  if (recovered > 0) {
    new Logger('Worker').warn(`recovered ${recovered} stranded agent job(s)`);
  }

  const reps = app.get(RepsJobProcessor);
  const repsConcurrency = config.get<number>('reps.concurrency') ?? 1;
  await queue.consumeRepsJobs((job) => reps.process(job), repsConcurrency);

  new Logger('Worker').log(
    `worker ready — parse concurrency ${parseConcurrency}, reps concurrency ${repsConcurrency}`,
  );
}

void bootstrap();
