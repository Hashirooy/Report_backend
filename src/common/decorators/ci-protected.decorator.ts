import { applyDecorators, UseGuards } from '@nestjs/common';

import { ApiTokenGuard } from '../guards/api-token.guard.js';

/**
 * Marks an endpoint as callable by CI with a shared token. Kept as a decorator
 * so the guard can gain company (rate limiting, audit) without touching every
 * controller that uses it.
 */
export const CiProtected = () => applyDecorators(UseGuards(ApiTokenGuard));
