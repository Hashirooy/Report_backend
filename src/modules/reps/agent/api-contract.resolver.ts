import { Injectable } from '@nestjs/common';

import { idOf, isoOf } from '../../../common/utils/serialization.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { expand, resolve } from '../../api-specs/openapi-parser.service.js';

/** Operations taken from one test. A test calling more is a scenario, not a check. */
const MAX_OPERATIONS = 3;
/** Ceiling for one operation's contract once references are inlined. */
const OPERATION_CHARS = 15_000;
/** Tried in order until the operation fits; each step inlines fewer references. */
const REF_DEPTHS = [Number.POSITIVE_INFINITY, 8, 5, 3, 1];
/** Paths of the spec listed when a call has no operation, so absence is checkable. */
const MAX_LISTED_PATHS = 60;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

type Json = Record<string, unknown>;

/** A call the test made, as far as its attachments or its name say. */
export interface ObservedCall {
  method: string;
  /** Path only: no scheme, host or query. */
  path: string;
  source: 'request_attachment' | 'test_name';
}

export interface ContractInput {
  projectId: bigint;
  runStartedAt: Date | null;
  testName: string;
  attachments: { name: string; content: string | null }[];
}

export interface ResolvedContract {
  json: Json;
  /** One line for the digest, phrased as an instruction the agent can act on. */
  digest: string;
}

/**
 * Finds the part of the project's OpenAPI contract a test exercised.
 *
 * The whole document would crowd the trace and the payloads out of the prompt,
 * and an agent handed forty endpoints will cite the wrong one. So the call is
 * read off the test's HTTP request attachment (or, failing that, its name) and
 * only the matching operation goes in, with its schemas inlined.
 */
@Injectable()
export class ApiContractResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(input: ContractInput): Promise<ResolvedContract> {
    const specs = await this.pickSpecs(input.projectId, input.runStartedAt);
    if (!specs.length) {
      return {
        json: { status: 'no_spec' },
        digest:
          'API contract: none uploaded for this project — the Swagger section is "Не указано" ' +
          'and no contract violation may be claimed.',
      };
    }

    const specInfo = (spec: (typeof specs)[number]) => ({
      id: idOf(spec.id),
      serviceKey: spec.serviceKey,
      title: spec.title,
      version: spec.version,
      uploadedAt: isoOf(spec.createdAt),
      /** Whether this is the contract in force when the run started, or only the newest. */
      selectedBy: spec.selectedBy,
    });

    const calls = observedCalls(input.attachments, input.testName);
    if (!calls.length) {
      return {
        json: { status: 'no_call', specs: specs.map(specInfo) },
        digest:
          `API contract: ${specs.length} active service specification(s) exist, but the test's ` +
          'HTTP call could not be identified — the Swagger section is "Не указано".',
      };
    }

    const operations = await this.prisma.apiOperation.findMany({
      where: { specId: { in: specs.map((spec) => spec.id) } },
      select: { specId: true, method: true, path: true },
    });
    const specsById = new Map(specs.map((spec) => [spec.id.toString(), spec]));

    const matched: Json[] = [];
    const unmatched: ObservedCall[] = [];
    for (const call of calls) {
      const matches = bestMatches(call, operations);
      if (!matches.length) {
        unmatched.push(call);
        continue;
      }

      // Equally specific paths may legitimately exist in several services.
      // Keep every tied match so the report never silently borrows one
      // service's contract merely because its database row happened to come first.
      for (const operation of matches) {
        const spec = specsById.get(operation.specId.toString());
        if (!spec) continue;
        if (
          matched.some(
            (item) =>
              item.specId === idOf(spec.id) &&
              item.method === operation.method.toUpperCase() &&
              item.path === operation.path,
          )
        ) {
          continue;
        }
        const document = spec.document as Json;
        matched.push({
          ...operationContract(document, operation.method, operation.path),
          specId: idOf(spec.id),
          serviceKey: spec.serviceKey,
          spec: specInfo(spec),
          servers: serverUrls(document),
          calledAs: `${call.method} ${call.path}`,
          matchedBy: call.source,
        });
      }
    }

    const json: Json = {
      status: matched.length ? 'matched' : 'no_match',
      specs: specs.map(specInfo),
      operations: matched,
      /** Calls with no operation in the spec. The endpoint is undocumented there. */
      unmatchedCalls: unmatched,
    };
    if (unmatched.length) {
      json.documentedPaths = [
        ...new Set(
          operations.map((operation) => {
            const service = specsById.get(operation.specId.toString())?.serviceKey ?? 'unknown';
            return `${service}: ${operation.method.toUpperCase()} ${operation.path}`;
          }),
        ),
      ]
        .sort()
        .slice(0, MAX_LISTED_PATHS);
    }

    const described = matched.map(
      (operation) =>
        `${String(operation.serviceKey)}: ${String(operation.method).toUpperCase()} ${String(operation.path)}`,
    );
    const digest = matched.length
      ? `API contract: matched operation(s) across the active service specifications: ` +
        `${described.join(', ')} — fill the Swagger section and judge the contract violation ` +
        'only from contract.operations.'
      : `API contract: none of the ${specs.length} active service specification(s) has an operation for ` +
        `${unmatched.map((c) => `${c.method} ${c.path}`).join(', ')}. State this absence in ` +
        'Ожидаемый результат, never in Предусловия. Swagger/OpenAPI does not establish an expected response ' +
        'for the unmatched operation; Фактический результат must still state the concrete observed behavior.';

    return { json, digest };
  }

  /**
   * The contract that was current when the run started: a bug found in March is
   * judged against March's spec, not one uploaded afterwards. A run older than
   * every upload falls back to the newest, and says so.
   */
  private async pickSpecs(projectId: bigint, runStartedAt: Date | null) {
    const snapshots = await this.prisma.apiSpec.findMany({
      where: { projectId, active: true },
      select: {
        id: true,
        serviceKey: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const latest = new Map<string, (typeof snapshots)[number]>();
    const atRun = new Map<string, (typeof snapshots)[number]>();
    for (const snapshot of snapshots) {
      if (!latest.has(snapshot.serviceKey)) latest.set(snapshot.serviceKey, snapshot);
      if (
        runStartedAt &&
        snapshot.createdAt <= runStartedAt &&
        !atRun.has(snapshot.serviceKey)
      ) {
        atRun.set(snapshot.serviceKey, snapshot);
      }
    }

    const selected = [...latest.entries()].map(([serviceKey, newest]) => {
      const current = atRun.get(serviceKey);
      return current
        ? { id: current.id, selectedBy: 'uploaded_before_run' as const }
        : { id: newest.id, selectedBy: 'latest_upload' as const };
    });
    const selectedById = new Map(selected.map((item) => [item.id.toString(), item.selectedBy]));

    const documents = await this.prisma.apiSpec.findMany({
      where: { id: { in: selected.map((item) => item.id) } },
      select: {
        id: true,
        serviceKey: true,
        title: true,
        version: true,
        createdAt: true,
        document: true,
      },
    });

    return documents
      .map((document) => ({
        ...document,
        selectedBy: selectedById.get(document.id.toString()) ?? ('latest_upload' as const),
      }))
      .sort((left, right) => left.serviceKey.localeCompare(right.serviceKey));
  }
}

/**
 * The test name identifies the operation under assertion; request attachments
 * supply its concrete deployed URL. A test may make setup calls before the
 * target call, so an unrelated non-empty attachment must not replace the named
 * operation merely because the target attachment was empty.
 */
export function observedCalls(
  attachments: ContractInput['attachments'],
  testName: string,
): ObservedCall[] {
  const calls: ObservedCall[] = [];
  const seen = new Set<string>();

  for (const attachment of attachments) {
    const call = requestFromAttachment(attachment.content);
    if (!call) continue;
    const key = `${call.method} ${call.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push({ ...call, source: 'request_attachment' });
  }

  const named = /\b(GET|PUT|POST|DELETE|OPTIONS|HEAD|PATCH|TRACE)\s+(\/[^\s·\]|,;]*)/i.exec(testName);
  if (named) {
    const target: ObservedCall = {
      method: named[1].toUpperCase(),
      path: normalizePath(named[2]),
      source: 'test_name',
    };
    const recordedTarget = calls.filter((call) => sameObservedEndpoint(call, target));
    return recordedTarget.length ? recordedTarget.slice(0, MAX_OPERATIONS) : [target];
  }

  return calls.slice(0, MAX_OPERATIONS);
}

/** Same method and endpoint suffix, allowing a deployment-only base path. */
function sameObservedEndpoint(
  left: Pick<ObservedCall, 'method' | 'path'>,
  right: Pick<ObservedCall, 'method' | 'path'>,
): boolean {
  if (left.method.toLowerCase() !== right.method.toLowerCase()) return false;

  const leftParts = segments(left.path).map((part) => part.toLowerCase());
  const rightParts = segments(right.path).map((part) => part.toLowerCase());
  const [shorter, longer] =
    leftParts.length <= rightParts.length ? [leftParts, rightParts] : [rightParts, leftParts];
  const offset = longer.length - shorter.length;
  return shorter.every((part, index) => part === longer[offset + index]);
}

/** Recognises the `{ method, url, baseURL? }` shape HTTP clients log requests in. */
function requestFromAttachment(content: string | null): Omit<ObservedCall, 'source'> | null {
  if (!content || !content.trimStart().startsWith('{')) return null;

  let body: unknown;
  try {
    body = JSON.parse(content);
  } catch {
    // A truncated body is not JSON; the head still names the call.
    body = {
      method: /"method"\s*:\s*"([A-Za-z]+)"/.exec(content)?.[1],
      url: /"url"\s*:\s*"([^"]+)"/.exec(content)?.[1],
      baseURL: /"baseURL"\s*:\s*"([^"]+)"/.exec(content)?.[1],
    };
  }
  if (!isObject(body)) return null;

  const method = typeof body.method === 'string' ? body.method.toLowerCase() : null;
  const url = typeof body.url === 'string' ? body.url : null;
  if (!method || !url || !HTTP_METHODS.includes(method)) return null;

  const base = typeof body.baseURL === 'string' ? body.baseURL : '';
  return { method: method.toUpperCase(), path: normalizePath(joinUrl(base, url)) };
}

function joinUrl(base: string, url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || !base) return url;
  return `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

/** Scheme, host, query and fragment removed; no trailing slash. */
export function normalizePath(url: string): string {
  const withoutOrigin = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  const path = withoutOrigin.split(/[?#]/)[0] ?? '';
  const trimmed = `/${path.replace(/^\/+/, '')}`.replace(/\/+$/, '');
  return trimmed || '/';
}

/**
 * The operation whose template matches the end of the called path.
 *
 * Matched from the end because the prefix is deployment detail: a spec written
 * against `/applications` is served as `/api/v1/applications`. A template made
 * only of parameters would then match any path, so at least one literal segment
 * has to agree unless the lengths are equal. Most literal segments wins, then
 * the longer template.
 */
export function bestMatch<T extends { method: string; path: string }>(
  call: Pick<ObservedCall, 'method' | 'path'>,
  operations: T[],
): T | null {
  return bestMatches(call, operations)[0] ?? null;
}

/** Every equally specific match; ties across services must remain visible. */
function bestMatches<T extends { method: string; path: string }>(
  call: Pick<ObservedCall, 'method' | 'path'>,
  operations: T[],
): T[] {
  const called = segments(call.path);
  let best: { literals: number; length: number; operations: T[] } | null = null;

  for (const operation of operations) {
    if (operation.method.toLowerCase() !== call.method.toLowerCase()) continue;

    const template = segments(operation.path);
    if (template.length > called.length) continue;

    const offset = called.length - template.length;
    let literals = 0;
    let fits = true;
    for (const [index, part] of template.entries()) {
      if (/^\{[^}]+\}$/.test(part)) continue;
      if (part.toLowerCase() !== called[offset + index]?.toLowerCase()) {
        fits = false;
        break;
      }
      literals += 1;
    }
    if (!fits || (literals === 0 && offset > 0)) continue;

    if (
      !best ||
      literals > best.literals ||
      (literals === best.literals && template.length > best.length)
    ) {
      best = { literals, length: template.length, operations: [operation] };
    } else if (literals === best.literals && template.length === best.length) {
      best.operations.push(operation);
    }
  }
  return best?.operations ?? [];
}

const segments = (path: string): string[] => path.split('/').filter(Boolean);

/**
 * One operation with its references inlined. Path-level parameters apply to
 * every method under the path, so they are merged in — an agent reading only
 * the operation would miss a required header declared one level up.
 */
function operationContract(document: Json, method: string, path: string): Json {
  const paths = isObject(document.paths) ? document.paths : {};
  const item = resolve(document, paths[path]) ?? {};
  const operation = resolve(document, item[method.toLowerCase()]) ?? {};

  const raw: Json = {
    method: method.toUpperCase(),
    path,
    operationId: operation.operationId,
    summary: operation.summary,
    description: operation.description,
    deprecated: operation.deprecated === true || undefined,
    parameters: [
      ...(Array.isArray(item.parameters) ? item.parameters : []),
      ...(Array.isArray(operation.parameters) ? operation.parameters : []),
    ],
    requestBody: operation.requestBody,
    responses: operation.responses,
    security: operation.security,
  };

  for (const depth of REF_DEPTHS) {
    const expanded = expand(document, raw, depth) as Json;
    if (JSON.stringify(expanded).length <= OPERATION_CHARS) {
      return depth === Number.POSITIVE_INFINITY ? expanded : { ...expanded, schemasTruncated: true };
    }
  }

  // Even shallow it does not fit: keep what a status-code judgement needs.
  const responses = isObject(operation.responses) ? operation.responses : {};
  return {
    method: raw.method,
    path,
    operationId: raw.operationId,
    summary: raw.summary,
    responses: Object.fromEntries(
      Object.entries(responses).map(([code, response]) => [
        code,
        { description: resolve(document, response)?.description },
      ]),
    ),
    schemasOmitted: true,
  };
}

function serverUrls(document: Json): string[] {
  if (!Array.isArray(document.servers)) return [];
  return document.servers
    .map((server) => (isObject(server) && typeof server.url === 'string' ? server.url : null))
    .filter((url): url is string => url !== null);
}

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
