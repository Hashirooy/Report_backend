/**
 * Application configuration, loaded once by ConfigModule and read through
 * ConfigService. Grouped by concern rather than mirroring the flat env names.
 */
export interface AppConfig {
  http: {
    host: string;
    port: number;
  };
  database: {
    url: string;
  };
  auth: {
    /** HMAC key for session tokens. Rotating it logs everyone out. */
    jwtSecret: string;
    /** Session lifetime in seconds. There are no refresh tokens by design. */
    ttlSeconds: number;
    cookieName: string;
    /** Off for plain-HTTP local work; the browser drops secure cookies there. */
    cookieSecure: boolean;
  };
  ingest: {
    /**
     * Legacy shared secret CI sends in X-API-Token, valid for every project.
     * Per-project tokens are the supported mechanism; empty disables this one.
     */
    token: string;
    uploadDir: string;
    maxUploadBytes: number;
    maxZipEntries: number;
  };
  apiSpecs: {
    /**
     * Largest OpenAPI document accepted. Held in memory while it is parsed, so
     * this is deliberately far below the archive limit.
     */
    maxBytes: number;
  };
  integrations: {
    /**
     * Encrypts the credentials integrations send. Changing it makes every
     * stored secret unreadable, so they have to be entered again. Empty means
     * integrations can be configured without a secret only.
     */
    secretKey: string;
    /**
     * Hosts a template may target although they resolve to a private address
     * or use plain http — an internal Jira, for instance. `*.corp.example`
     * matches subdomains. Everything else must be public and https.
     */
    allowedHosts: string[];
    /** Whole request, connect to last byte. */
    timeoutMs: number;
    /** Response body read for the issue key; the rest is dropped. */
    maxResponseBytes: number;
  };
  worker: {
    concurrency: number;
    /** Runs older than this get their raw_result cleared by the retention job. */
    rawResultRetentionDays: number;
  };
  reps: {
    provider: 'claude' | 'codex';
    /** Agent CLI executable. Resolved on PATH unless an absolute path is given. */
    cli: string;
    model: string;
    /** Directory with `.claude/skills`, read by SkillLibrary into the prompt. */
    skillsRoot: string;
    /** Wall clock for one task before the process is killed. */
    taskTimeoutMs: number;
    /** Claude-only spend ceiling per task. 0 disables it. */
    maxBudgetUsd: number;
    /** How often a running task refreshes its heartbeat and checks for cancel. */
    heartbeatMs: number;
    /** Jobs a single worker runs at once. Each one is a whole CLI process. */
    concurrency: number;
    /**
     * Largest document accepted into the database. A task that returns more
     * than this is rejected rather than silently truncated.
     */
    maxArtifactBytes: number;
  };
}

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export default (): AppConfig => ({
  http: {
    host: process.env.HOST ?? '0.0.0.0',
    port: int(process.env.PORT, 3000),
  },
  database: {
    url: process.env.DATABASE_URL ?? '',
  },
  auth: {
    jwtSecret: process.env.JWT_SECRET ?? 'dev-only-insecure-secret',
    ttlSeconds: int(process.env.SESSION_TTL_SECONDS, 12 * 60 * 60),
    cookieName: process.env.SESSION_COOKIE_NAME ?? 'reports_session',
    cookieSecure: process.env.SESSION_COOKIE_SECURE === 'true',
  },
  ingest: {
    token: process.env.INGEST_TOKEN ?? '',
    uploadDir: process.env.UPLOAD_DIR ?? 'uploads',
    maxUploadBytes: int(process.env.MAX_UPLOAD_BYTES, 512 * 1024 * 1024),
    maxZipEntries: int(process.env.MAX_ZIP_ENTRIES, 50_000),
  },
  apiSpecs: {
    maxBytes: int(process.env.MAX_SPEC_BYTES, 8 * 1024 * 1024),
  },
  integrations: {
    secretKey: process.env.INTEGRATIONS_SECRET_KEY ?? '',
    allowedHosts: (process.env.INTEGRATIONS_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
    timeoutMs: int(process.env.INTEGRATIONS_TIMEOUT_MS, 15_000),
    maxResponseBytes: int(process.env.INTEGRATIONS_MAX_RESPONSE_BYTES, 1024 * 1024),
  },
  worker: {
    concurrency: int(process.env.PARSE_CONCURRENCY, 2),
    rawResultRetentionDays: int(process.env.RAW_RESULT_RETENTION_DAYS, 30),
  },
  reps: {
    provider: (process.env.REPS_PROVIDER ?? 'claude') as 'claude' | 'codex',
    cli: process.env.REPS_CLI || (process.env.REPS_PROVIDER === 'codex' ? 'codex' : 'claude'),
    model: process.env.REPS_MODEL || (process.env.REPS_PROVIDER === 'codex' ? '' : 'claude-sonnet-5'),
    skillsRoot: process.env.REPS_SKILLS_ROOT ?? 'agent-skills',
    taskTimeoutMs: int(process.env.REPS_TASK_TIMEOUT_MS, 15 * 60_000),
    maxBudgetUsd: Number(process.env.REPS_MAX_BUDGET_USD ?? 2) || 0,
    heartbeatMs: int(process.env.REPS_HEARTBEAT_MS, 5_000),
    concurrency: int(process.env.REPS_CONCURRENCY, 1),
    maxArtifactBytes: int(process.env.REPS_MAX_ARTIFACT_BYTES, 2 * 1024 * 1024),
  },
});

/**
 * Fails the boot instead of the first request. Runs before the DI container is
 * built, so it cannot use ConfigService.
 */
export function validateEnv(env: Record<string, unknown>): Record<string, unknown> {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  if (env.REPS_PROVIDER !== undefined && env.REPS_PROVIDER !== 'claude' && env.REPS_PROVIDER !== 'codex') {
    throw new Error('REPS_PROVIDER must be claude or codex');
  }
  if (env.NODE_ENV === 'production') {
    const secret = typeof env.JWT_SECRET === 'string' ? env.JWT_SECRET : '';
    if (secret.length < 32) {
      throw new Error('JWT_SECRET of at least 32 characters is required in production');
    }
    if (env.SESSION_COOKIE_SECURE !== 'false' && env.SESSION_COOKIE_SECURE !== 'true') {
      throw new Error('SESSION_COOKIE_SECURE must be set explicitly in production');
    }
  }
  const integrationsKey = env.INTEGRATIONS_SECRET_KEY;
  if (typeof integrationsKey === 'string' && integrationsKey !== '' && integrationsKey.length < 32) {
    throw new Error('INTEGRATIONS_SECRET_KEY must be at least 32 characters when set');
  }
  // INGEST_TOKEN is no longer required: ingest accepts per-project tokens, and
  // an unset shared token simply turns the project-wide credential off.
  return env;
}
