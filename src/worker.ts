import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { enableBigIntSerialization } from './common/utils/serialization.js';
import { ParseRunProcessor } from './modules/ingest/processors/parse-run.processor.js';
import { QueueService } from './queue/queue.service.js';

/**
 * Second entrypoint over the same modules: no HTTP server, just the queue
 * consumer. Parsing is CPU-bound, so it runs in its own process where it cannot
 * stall the API's event loop.
 */
async function bootstrap(): Promise<void> {
  enableBigIntSerialization();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.enableShutdownHooks();

  const queue = app.get(QueueService);
  const processor = app.get(ParseRunProcessor);
  const concurrency = app.get(ConfigService).get<number>('worker.concurrency') ?? 2;

  await queue.consumeParse((job) => processor.process(job), concurrency);

  new Logger('Worker').log(`parse worker ready, concurrency ${concurrency}`);
}

void bootstrap();
