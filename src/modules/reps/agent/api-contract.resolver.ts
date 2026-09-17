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
    const spec = await this.pickSpec(input.projectId, input.runStartedAt);
    if (!spec) {
      return {
        json: { status: 'no_spec' },
        digest:
          'API contract: none uploaded for this project — the Swagger section is "Не указано" ' +
          'and no contract violation may be claimed.',
      };
    }

    const specInfo = {
      id: idOf(spec.id),
      title: spec.title,
      version: spec.version,
      uploadedAt: isoOf(spec.createdAt),
      /** Whether this is the contract in force when the run started, or only the newest. */
      selectedBy: spec.selectedBy,
    };

    const calls = observedCalls(input.attachments, input.testName);
    if (!calls.length) {
      return {
        json: { status: 'no_call', spec: specInfo },
        digest:
          `API contract: spec "${spec.title}" ${spec.version} exists, but the test's HTTP call ` +
          'could not be identified — the Swagger section is "Не указано".',
      };
    }

    const operations = await this.prisma.apiOperation.findMany({
      where: { specId: spec.id },
      select: { method: true, path: true },
    });
    const document = spec.document as Json;

    const matched: Json[] = [];
    const unmatched: ObservedCall[] = [];
    for (const call of calls) {
      const operation = bestMatch(call, operations);
      if (!operation) {
        unmatched.push(call);
        continue;
      }
      if (matched.some((m) => m.method === operation.method && m.path === operation.path)) continue;
      matched.push({
        ...operationContract(document, operation.method, operation.path),
        calledAs: `${call.method} ${call.path}`,
        matchedBy: call.source,
      });
    }

    const json: Json = {
      status: matched.length ? 'matched' : 'no_match',
      spec: specInfo,
      servers: serverUrls(document),
      operations: matched,
      /** Calls with no operation in the spec. The endpoint is undocumented there. */
      unmatchedCalls: unmatched,
    };
    if (unmatched.length) {
      json.documentedPaths = [...new Set(operations.map((o) => `${o.method.toUpperCase()} ${o.path}`))]
        .sort()
        .slice(0, MAX_LISTED_PATHS);
    }

    const described = matched.map((o) => `${String(o.method).toUpperCase()} ${String(o.path)}`);
    const digest = matched.length
      ? `API contract: spec "${spec.title}" ${spec.version} (${spec.selectedBy}), operation(s) ` +
        `${described.join(', ')} — fill the Swagger section and judge the contract violation ` +
        'only from contract.operations.'
      : `API contract: spec "${spec.title}" ${spec.version} has no operation for ` +
        `${unmatched.map((c) => `${c.method} ${c.path}`).join(', ')} — the Swagger section is ` +
        '"Не указано"; the endpoint being absent from the spec may be stated, nothing else about it.';

    return { json, digest };
  }

  /**
   * The contract that was current when the run started: a bug found in March is
   * judged against March's spec, not one uploaded afterwards. A run older than
   * every upload falls back to the newest, and says so.
   */
  private async pickSpec(projectId: bigint, runStartedAt: Date | null) {
    const select = { id: true, title: true, version: true, createdAt: true, document: true };

    if (runStartedAt) {
      const current = await this.prisma.apiSpec.findFirst({
        where: { projectId, createdAt: { lte: runStartedAt } },
        select,
        orderBy: { createdAt: 'desc' },
      });
      if (current) return { ...current, selectedBy: 'uploaded_before_run' as const };
    }

    const latest = await this.prisma.apiSpec.findFirst({
      where: { projectId },
      select,
      orderBy: { id: 'desc' },
    });
    return latest ? { ...latest, selectedBy: 'latest_upload' as const } : null;
  }
}

/**
 * Calls in the order the test made them. A request attachment is evidence; the
 * test name is only a label someone typed, so it is used when nothing better is.
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
    if (calls.length === MAX_OPERATIONS) return calls;
  }
  if (calls.length) return calls;

  const named = /\b(GET|PUT|POST|DELETE|OPTIONS|HEAD|PATCH|TRACE)\s+(\/[^\s·\]|,;]*)/i.exec(testName);
  return named
    ? [{ method: named[1].toUpperCase(), path: normalizePath(named[2]), source: 'test_name' }]
    : [];
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
  const called = segments(call.path);
  let best: { operation: T; literals: number; length: number } | null = null;

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
      best = { operation, literals, length: template.length };
    }
  }
  return best?.operation ?? null;
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
