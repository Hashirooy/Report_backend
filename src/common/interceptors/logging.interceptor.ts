import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { tap } from 'rxjs';
import type { Observable } from 'rxjs';

/** Request log with duration, kept to one line per request. */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const started = Date.now();

    return next.handle().pipe(
      tap({
        next: () =>
          this.logger.log(`${request.method} ${request.url} ${Date.now() - started}ms`),
        error: (error: Error) =>
          this.logger.warn(
            `${request.method} ${request.url} ${Date.now() - started}ms — ${error.message}`,
          ),
      }),
    );
  }
}
