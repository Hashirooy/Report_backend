import 'reflect-metadata';

import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor.js';
import { enableBigIntSerialization } from './common/utils/serialization.js';

async function bootstrap(): Promise<void> {
  enableBigIntSerialization();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: 1024 * 1024 }),
  );

  const config = app.get(ConfigService);

  // Parses the session cookie the auth guard reads. Registered before the
  // guards can run, i.e. before the server starts listening.
  await app.register(cookie);

  app.enableCors({
    origin: 'http://localhost:5173',
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    credentials: true,
  })

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.enableShutdownHooks();

  // Uploads are streamed to disk by the ingest controller, so the file limit is
  // the only one that has to be generous.
  await app.register(multipart, {
    limits: {
      files: 1,
      fields: 20,
      fileSize: config.get<number>('ingest.maxUploadBytes') ?? 512 * 1024 * 1024,
    },
  });

  const port = config.get<number>('http.port') ?? 3000;
  const host = config.get<string>('http.host') ?? '0.0.0.0';
  await app.listen({ port, host });

  new Logger('Bootstrap').log(`API listening on http://${host}:${port}`);
}

void bootstrap();
