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
  ingest: {
    /** Shared secret CI sends in X-API-Token. Empty disables the check. */
    token: string;
    uploadDir: string;
    maxUploadBytes: number;
    maxZipEntries: number;
  };
  worker: {
    concurrency: number;
    /** Runs older than this get their raw_result cleared by the retention job. */
    rawResultRetentionDays: number;
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
  ingest: {
    token: process.env.INGEST_TOKEN ?? '',
    uploadDir: process.env.UPLOAD_DIR ?? 'uploads',
    maxUploadBytes: int(process.env.MAX_UPLOAD_BYTES, 512 * 1024 * 1024),
    maxZipEntries: int(process.env.MAX_ZIP_ENTRIES, 50_000),
  },
  worker: {
    concurrency: int(process.env.PARSE_CONCURRENCY, 2),
    rawResultRetentionDays: int(process.env.RAW_RESULT_RETENTION_DAYS, 30),
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
  if (env.NODE_ENV === 'production' && !env.INGEST_TOKEN) {
    throw new Error('INGEST_TOKEN is required in production: ingest would be open to anyone');
  }
  return env;
}
