import { createHash } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';

import type { ApiOperation, HttpMethod } from '../../contracts/index.js';

/** The operation keys of a path item. Everything else there is not an endpoint. */
const METHODS: HttpMethod[] = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
];

/** An operation plus the hash that tells a changed endpoint from an untouched one. */
export interface ParsedOperation extends ApiOperation {
  fingerprint: string;
}

export interface ParsedSpec {
  title: string;
  version: string;
  specVersion: string;
  /** sha256 of the canonical document. */
  checksum: string;
  document: Record<string, unknown>;
  operations: ParsedOperation[];
}

type Json = Record<string, unknown>;

/**
 * Turns an exported OpenAPI document into the snapshot the repository stores.
 * Pure: no database, no clock, no network.
 *
 * Deliberately tolerant. The point is to index what a service says it exposes,
 * not to certify the document — a spec that violates the standard in a corner
 * the index does not read still gives a usable endpoint list, and rejecting it
 * would only mean nobody can compare that API at all.
 */
@Injectable()
export class OpenApiParserService {
  parse(raw: string): ParsedSpec {
    const document = this.parseDocument(raw);

    const specVersion = stringAt(document, 'openapi') ?? stringAt(document, 'swagger');
    if (!specVersion) {
      throw new BadRequestException(
        'not an OpenAPI document: no "openapi" or "swagger" version field',
      );
    }

    const info = objectAt(document, 'info') ?? {};
    const operations = this.extractOperations(document);

    return {
      title: stringAt(info, 'title')?.slice(0, 300) ?? 'Untitled API',
      version: stringAt(info, 'version')?.slice(0, 200) ?? '0.0.0',
      specVersion: specVersion.slice(0, 20),
      checksum: sha256(canonicalize(document)),
      document,
      operations,
    };
  }

  /**
   * Swagger UI exports JSON; springdoc and some gateways also offer YAML. YAML
   * is rejected with an instruction rather than parsed, because supporting it
   * means a parser dependency for a format the export dialog can avoid.
   */
  private parseDocument(raw: string): Json {
    const trimmed = raw.trim();
    if (!trimmed) throw new BadRequestException('the uploaded file is empty');
    if (!trimmed.startsWith('{')) {
      throw new BadRequestException(
        'expected a JSON document — export the spec as JSON rather than YAML',
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new BadRequestException(`the file is not valid JSON: ${(error as Error).message}`);
    }
    if (!isObject(parsed)) {
      throw new BadRequestException('expected the document to be a JSON object');
    }
    return parsed;
  }

  private extractOperations(document: Json): ParsedOperation[] {
    const paths = objectAt(document, 'paths');
    if (!paths) return [];

    const operations: ParsedOperation[] = [];
    for (const [path, rawItem] of Object.entries(paths)) {
      // Templates only. Extension keys (`x-…`) share the object with them.
      if (!path.startsWith('/')) continue;

      const item = resolve(document, rawItem);
      if (!item) continue;

      for (const method of METHODS) {
        const operation = objectAt(item, method);
        if (!operation) continue;
        operations.push(toOperation(document, method, path, operation));
      }
    }
    return operations;
  }
}

const toOperation = (
  document: Json,
  method: HttpMethod,
  path: string,
  operation: Json,
): ParsedOperation => {
  const responses = objectAt(operation, 'responses') ?? {};
  return {
    method,
    path: path.slice(0, 500),
    operationId: stringAt(operation, 'operationId')?.slice(0, 300) ?? null,
    summary: stringAt(operation, 'summary')?.slice(0, 1000) ?? null,
    tags: Array.isArray(operation.tags)
      ? operation.tags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    statusCodes: Object.keys(responses).sort(),
    deprecated: operation.deprecated === true,
    // Hashed with references resolved: a change hidden behind a shared schema
    // has to show up as a changed endpoint, not as an untouched one.
    fingerprint: sha256(canonicalize(expand(document, operation))),
  };
};

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const objectAt = (source: Json, key: string): Json | null => {
  const value = source[key];
  return isObject(value) ? value : null;
};

const stringAt = (source: Json, key: string): string | undefined => {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

/** Follows a local `$ref` one hop. Remote refs are left alone: nothing fetches. */
export const resolve = (document: Json, value: unknown): Json | null => {
  if (!isObject(value)) return null;
  const ref = stringAt(value, '$ref');
  if (!ref) return value;
  const target = pointer(document, ref);
  return target ?? value;
};

/** Resolves a `#/a/b/c` JSON pointer against the document. */
const pointer = (document: Json, ref: string): Json | null => {
  if (!ref.startsWith('#/')) return null;
  let current: unknown = document;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return null;
      current = current[Number(segment)];
    } else if (isObject(current)) {
      current = current[segment];
    } else {
      return null;
    }
  }
  return isObject(current) ? current : null;
};

/**
 * Inlines local `$ref`s so two operations can be compared by value. Cycles are
 * normal in schemas that nest themselves, so a reference already on the path
 * back to the root is left as the reference rather than followed forever.
 *
 * `maxRefDepth` caps how many references deep it goes; past that a reference
 * stays as written. Hashing leaves it unbounded, a prompt cannot afford that.
 */
export const expand = (
  document: Json,
  value: unknown,
  maxRefDepth = Number.POSITIVE_INFINITY,
  seen: ReadonlySet<string> = new Set(),
): unknown => {
  if (Array.isArray(value)) return value.map((item) => expand(document, item, maxRefDepth, seen));
  if (!isObject(value)) return value;

  const ref = stringAt(value, '$ref');
  if (ref) {
    if (seen.has(ref) || seen.size >= maxRefDepth) return { $ref: ref };
    const target = pointer(document, ref);
    if (!target) return { $ref: ref };
    return expand(document, target, maxRefDepth, new Set([...seen, ref]));
  }

  const out: Json = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = expand(document, item, maxRefDepth, seen);
  }
  return out;
};

/**
 * Stable JSON: object keys sorted, no insignificant whitespace. Two exports of
 * an unchanged API differ in key order often enough that hashing the bytes
 * would report a new version on every build.
 */
const canonicalize = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
