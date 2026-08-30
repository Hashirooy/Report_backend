import { createHash } from 'node:crypto';

/**
 * Turns a failure into a stable identity so one cause shows up once instead of
 * once per affected test.
 *
 * The message alone is too volatile (it carries ids, timestamps, hosts) and the
 * trace alone is too specific (line numbers move on every refactor). The
 * volatile parts of the message are masked and pinned to the first meaningful
 * trace frame with its line number stripped.
 */

/** Order matters: broader patterns run after the specific ones they contain. */
const MASKS: [RegExp, string][] = [
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TS>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>'],
  [/\bhttps?:\/\/[^\s"'<>)]+/gi, '<URL>'],
  [/\b[A-Za-z]:\\[^\s"'<>)]+/g, '<PATH>'],
  [/(?<![\w<])\/(?:[\w.-]+\/)+[\w.-]+/g, '<PATH>'],
  [/\b0x[0-9a-f]+\b/gi, '<HEX>'],
  [/\b[0-9a-f]{8,}\b/gi, '<HEX>'],
  // No trailing \b: a number glued to a unit ("30000ms", "5s") must mask too.
  [/(?<![\w.])\d+(?:\.\d+)?/g, '<NUM>'],
  [/[ \t]+/g, ' '],
];

/** Frames from the language runtime and the test framework carry no signal. */
const NOISE_FRAME =
  /node_modules|site-packages|(^|[/\\])(?:internal|lib)[/\\]|<anonymous>|pytest|_pytest|unittest|jest|mocha|junit|testng/i;

const ERROR_TYPE =
  /(?:^|[\s(])((?:[\w$]+\.)*[\w$]*(?:Error|Exception|Failure|Assertion|Timeout|Panic))\b/;

export interface Fingerprint {
  fingerprint: string;
  errorType: string | null;
  normalizedMessage: string;
}

export function normalizeMessage(message: string): string {
  // Only the first line: adapters append the whole diff or payload after it,
  // which differs per test and would defeat grouping.
  let out = message.split(/\r?\n/, 1)[0] ?? '';
  for (const [pattern, replacement] of MASKS) {
    out = out.replace(pattern, replacement);
  }
  return out.trim().slice(0, 500);
}

/**
 * Exception class name, from the message when the adapter prefixes it
 * ("AssertionError: ..."), otherwise from the trace. Python puts it on the last
 * line, JVM and JS on the first, so both ends are checked.
 */
export function extractErrorType(message: string, trace?: string | null): string | null {
  const candidates: string[] = [];

  const fromMessage = ERROR_TYPE.exec(message.split(/\r?\n/, 1)[0] ?? '');
  if (fromMessage?.[1]) candidates.push(fromMessage[1]);

  if (trace) {
    const lines = trace.split(/\r?\n/).filter((line) => line.trim());
    for (const line of [...lines].reverse().slice(0, 3).concat(lines.slice(0, 3))) {
      const match = ERROR_TYPE.exec(line);
      if (match?.[1]) candidates.push(match[1]);
    }
  }
  if (!candidates.length) return null;

  // A real class name beats the bare word that matched in prose: "Timeout of
  // 30s exceeded" yields "Timeout", while the trace under it says
  // "TimeoutError" — the group should be named after the latter.
  return candidates.find((name) => /(?:Error|Exception|Failure)$/.test(name)) ?? candidates[0]!;
}

/**
 * The first frame belonging to the project rather than to a dependency, with
 * line numbers removed so an edit above the failure does not fork the group.
 */
export function firstMeaningfulFrame(trace?: string | null): string | null {
  if (!trace) return null;
  for (const line of trace.split(/\r?\n/)) {
    const frame = line.trim();
    if (!frame || NOISE_FRAME.test(frame)) continue;
    if (!/(?:\.(?:py|ts|js|java|kt|rb|go|cs)\b|\bat\s|File\s)/.test(frame)) continue;
    return frame
      .replace(/:\d+(?::\d+)?/g, ':<LINE>')
      .replace(/line \d+/g, 'line <LINE>')
      .slice(0, 300);
  }
  return null;
}

export function fingerprintFailure(
  message: string | null | undefined,
  trace: string | null | undefined,
): Fingerprint | null {
  const text = (message ?? '').trim() || (trace ?? '').trim();
  if (!text) return null;

  const normalizedMessage = normalizeMessage(text);
  const errorType = extractErrorType(text, trace);
  const frame = firstMeaningfulFrame(trace);

  return {
    fingerprint: createHash('sha256')
      .update([errorType ?? '', normalizedMessage, frame ?? ''].join(' '))
      .digest('hex'),
    errorType,
    normalizedMessage,
  };
}
