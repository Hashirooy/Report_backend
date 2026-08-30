/**
 * Primary keys are BigInt because result rows run into the millions, but JSON
 * has no 64-bit integer. Every id crosses the wire as a decimal string and is
 * opaque to the client.
 *
 * Called once at boot, before anything serializes a response.
 */
export function enableBigIntSerialization(): void {
  (BigInt.prototype as unknown as { toJSON(): string }).toJSON = function toJSON(this: bigint) {
    return this.toString();
  };
}

export const idOf = (value: bigint): string => value.toString();

export const nullableIdOf = (value: bigint | null | undefined): string | null =>
  value === null || value === undefined ? null : value.toString();

export const isoOf = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

/**
 * passed / (total - skipped), rounded to two decimals. A run that skipped half
 * its suite must not read as 50% healthy, so skips leave the denominator.
 */
export function passRate(counters: { total: number; passed: number; skipped: number }): number {
  const executed = counters.total - counters.skipped;
  if (executed <= 0) return 0;
  return Math.round((counters.passed / executed) * 10_000) / 100;
}

/** Splits bulk inserts into statements Postgres is comfortable with. */
export function chunked<T>(items: T[], size = 2_000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
