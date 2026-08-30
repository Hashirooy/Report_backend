import { timingSafeEqual } from 'node:crypto';

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Shared-secret check for endpoints called by CI rather than by a signed-in
 * user. An empty token disables it, which is only intended for local work —
 * `validateEnv` refuses to boot production without one.
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('ingest.token') ?? '';
    if (!expected) return true;

    const request = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const raw = request.headers['x-api-token'];
    const provided = Array.isArray(raw) ? raw[0] : raw;

    if (typeof provided !== 'string' || !constantTimeEquals(provided, expected)) {
      throw new UnauthorizedException('invalid or missing X-API-Token');
    }
    return true;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
