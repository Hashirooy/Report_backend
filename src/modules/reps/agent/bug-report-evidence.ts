type JsonObject = Record<string, unknown>;

export interface EvidenceAttachment {
  name: string;
  content: string | null;
  sizeBytes: number | null;
  truncated: boolean;
}

interface AssertionDetails {
  actual: string | null;
  expected: string | null;
}

export interface BugReportEvidenceInput {
  environment: string | null;
  testName: string;
  assertion: AssertionDetails | null;
  attachments: EvidenceAttachment[];
  contract: JsonObject;
}

interface ParsedAttachment {
  index: number;
  source: EvidenceAttachment;
  value: JsonObject | null;
}

interface MismatchOccurrence {
  message: string;
  path: string | null;
  fields: string[];
}

/**
 * Joins the four evidence sources a report writer otherwise has to correlate by
 * hand: the target operation, its recorded exchange, the matcher failure and
 * the matching OpenAPI rule. The original attachments and contract stay in the
 * context; this is the compact, deterministic index into them.
 */
export function buildBugReportEvidence(input: BugReportEvidenceInput): JsonObject {
  const operation = firstObject(input.contract.operations);
  const fromName = operationFromTestName(input.testName);
  const method = stringValue(operation?.method) ?? fromName?.method;
  const path = stringValue(operation?.path) ?? fromName?.path;

  const parsed = input.attachments.map((source, index): ParsedAttachment => ({
    index,
    source,
    value: parseObject(source.content),
  }));
  const request = selectRequest(parsed, method, path);
  const response = selectResponse(parsed, request);
  const responseStatus = numberOrString(response?.value?.status);
  const responseHeaders = objectValue(response?.value?.headers);
  const responseBody = response?.value?.body;
  const mismatches = parseMismatches(input.assertion?.actual ?? null);
  const mismatchGroups = groupMismatches(mismatches, responseBody);
  const primary = mismatchGroups[0] ?? null;
  const responses = objectValue(operation?.responses);
  const responseRule = responseStatus === null
    ? null
    : responses?.[String(responseStatus)] ?? responses?.default ?? null;

  return {
    purpose:
      'Prepared evidence for bug-report generation. Prefer this joined view; use the original ' +
      'attachments and contract only to verify or expand it.',
    environment: input.environment,
    operation: {
      method: method ?? null,
      path: path ?? null,
      calledAs: stringValue(operation?.calledAs),
      contractStatus: stringValue(input.contract.status),
    },
    request: requestEvidence(request, operation),
    response: {
      contentAvailable: attachmentAvailable(response?.source),
      unavailableReason: attachmentUnavailableReason(response?.source),
      status: responseStatus,
      contentType: header(responseHeaders, 'content-type'),
      exactHttpFragment: renderHttpFragment(
        responseStatus,
        header(responseHeaders, 'content-type'),
        primary,
      ),
      primaryMismatch: primary,
      mismatchGroups,
      sourceAttachment: response?.source.name ?? null,
      sourceTruncated: response?.source.truncated ?? false,
    },
    validation: {
      source: 'context.result.assertion',
      mismatchCount: mismatches.length,
      distinctMismatchCount: mismatchGroups.length,
    },
    contractRule: operation
      ? {
          operationId: operation.operationId ?? null,
          summary: operation.summary ?? null,
          requiredParameters: requiredParameters(operation.parameters),
          requestBody: operation.requestBody ?? null,
          security: operation.security ?? null,
          responseForObservedStatus: responseRule,
          schemasTruncated: operation.schemasTruncated === true,
          schemasOmitted: operation.schemasOmitted === true,
        }
      : null,
  };
}

function renderHttpFragment(
  status: number | string | null,
  contentType: string | null,
  primaryMismatch: JsonObject | null,
): string | null {
  const lines: string[] = [];
  if (status !== null) lines.push(`HTTP/1.1 ${status}`);
  if (contentType) lines.push(`Content-Type: ${contentType}`);

  const container = primaryMismatch?.exactContainerValue;
  if (container !== null && container !== undefined) {
    if (lines.length) lines.push('');
    lines.push(JSON.stringify(container, null, 2));
  }
  return lines.length ? lines.join('\n') : null;
}

function requestEvidence(
  request: ParsedAttachment | null,
  operation: JsonObject | null,
): JsonObject {
  const value = request?.value;
  return {
    contentAvailable: attachmentAvailable(request?.source),
    unavailableReason: attachmentUnavailableReason(request?.source),
    method: stringValue(value?.method) ?? stringValue(operation?.method),
    url: stringValue(value?.url) ?? stringValue(operation?.calledAs) ?? stringValue(operation?.path),
    headers: objectValue(value?.headers),
    body: value?.body ?? null,
    sourceAttachment: request?.source.name ?? null,
    sourceTruncated: request?.source.truncated ?? false,
  };
}

function selectRequest(
  attachments: ParsedAttachment[],
  method: string | null | undefined,
  path: string | null | undefined,
): ParsedAttachment | null {
  const requests = attachments.filter((item) => /request/i.test(item.source.name));
  const matching = requests.find((item) => {
    const actualMethod = stringValue(item.value?.method);
    const actualPath = pathFromUrl(stringValue(item.value?.url));
    return (
      (!method || actualMethod?.toLowerCase() === method.toLowerCase()) &&
      (!path || actualPath === path)
    );
  });
  if (matching) return matching;
  return requests.length === 1 ? requests[0] : requests.at(-1) ?? null;
}

function selectResponse(
  attachments: ParsedAttachment[],
  request: ParsedAttachment | null,
): ParsedAttachment | null {
  const responses = attachments.filter((item) => /response/i.test(item.source.name));
  if (request) {
    const nextRequest = attachments.find(
      (item) => item.index > request.index && /request/i.test(item.source.name),
    );
    const paired = responses.find(
      (item) => item.index > request.index && (!nextRequest || item.index < nextRequest.index),
    );
    if (paired) return paired;
  }
  return responses.length === 1 ? responses[0] : responses.at(-1) ?? null;
}

function parseMismatches(actual: string | null): MismatchOccurrence[] {
  if (!actual) return [];
  const lines = actual.split(/\r?\n/);
  const occurrences: MismatchOccurrence[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]?.trim() ?? '';
    const marker = raw.indexOf('✖');
    if (marker === -1) continue;
    const message = raw.slice(marker);
    const next = lines[index + 1]?.trim();
    const path = next?.startsWith('→ at ') ? next.slice(5).trim() : null;
    const fields = [...message.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    occurrences.push({
      message,
      path,
      fields: /Unrecognized keys?:/.test(message) ? fields : [],
    });
  }
  return occurrences;
}

function groupMismatches(
  occurrences: MismatchOccurrence[],
  responseBody: unknown,
): JsonObject[] {
  const groups = new Map<string, { sample: MismatchOccurrence; count: number }>();
  for (const occurrence of occurrences) {
    const key = occurrence.message;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { sample: occurrence, count: 1 });
  }

  return [...groups.values()].map(({ sample, count }) => {
    const containerValue = sample.path ? valueAtPath(responseBody, sample.path) : undefined;
    const actualValues = Object.fromEntries(
      sample.fields.map((field) => [
        field,
        isObject(containerValue) ? containerValue[field] ?? null : null,
      ]),
    );
    return {
      message: sample.message,
      occurrences: count,
      containerPath: sample.path,
      fields: sample.fields,
      fieldPaths: sample.fields.map((field) =>
        sample.path ? `${sample.path}.${field}` : field,
      ),
      actualValues,
      /** One complete value from one response path; never assembled from separate array items. */
      exactContainerValue: containerValue ?? null,
    };
  });
}

function valueAtPath(root: unknown, path: string): unknown {
  const parts = [...path.matchAll(/(?:^|\.)([^.\[\]]+)|\[(\d+)\]/g)].map((match) =>
    match[1] ?? Number(match[2]),
  );
  let value = root;
  for (const part of parts) {
    if (typeof part === 'number') {
      if (!Array.isArray(value)) return undefined;
      value = value[part];
    } else {
      if (!isObject(value)) return undefined;
      value = value[part];
    }
  }
  return value;
}

function requiredParameters(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((parameter) => isObject(parameter) && parameter.required === true);
}

function attachmentAvailable(attachment: EvidenceAttachment | undefined): boolean {
  return Boolean(attachment?.content && attachment.sizeBytes !== 0);
}

function attachmentUnavailableReason(
  attachment: EvidenceAttachment | undefined,
): 'empty_file' | 'not_stored' | null {
  if (!attachment) return 'not_stored';
  if (attachment.sizeBytes === 0) return 'empty_file';
  if (attachment.content === null) return 'not_stored';
  return null;
}

function header(headers: JsonObject | null, wanted: string): string | null {
  if (!headers) return null;
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === wanted);
  return entry ? stringValue(entry[1]) ?? null : null;
}

function operationFromTestName(testName: string): { method: string; path: string } | null {
  const match = testName.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(\/[^\s\]]+)/i);
  return match ? { method: match[1].toUpperCase(), path: match[2] } : null;
}

function pathFromUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value, 'http://local.invalid').pathname;
  } catch {
    return value.split('?')[0] ?? null;
  }
}

function parseObject(value: string | null): JsonObject | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstObject(value: unknown): JsonObject | null {
  return Array.isArray(value) ? objectValue(value[0]) : null;
}

function objectValue(value: unknown): JsonObject | null {
  return isObject(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrString(value: unknown): number | string | null {
  return typeof value === 'number' || typeof value === 'string' ? value : null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
