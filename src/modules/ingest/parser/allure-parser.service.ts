import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import {
  isFailure,
  type ParsedAttachment,
  type ParsedResult,
  type ParsedRun,
  type ParsedStep,
  type ParsedStepKind,
} from '../entities/parsed-run.entity.js';
import {
  normalizeStatus,
  type AllureArchiveContents,
  type AllureAttachment,
  type AllureContainer,
  type AllureLabel,
  type AllureLink,
  type AllureParameter,
  type AllureResult,
  type AllureStep,
  type ArchivedAttachment,
} from './allure-types.js';

/**
 * Turns the raw contents of an allure-results directory into the run shape the
 * repository stores. Pure: no database, no filesystem, no clock.
 */
@Injectable()
export class AllureParserService {
  parse({ results, containers, attachments }: AllureArchiveContents): ParsedRun {
    const warnings: string[] = [];

    const usable = results.filter((result) => {
      if (result?.uuid) return true;
      warnings.push('skipped a result file without uuid');
      return false;
    });

    const fixtures = groupFixtures(usable, containers);

    const parsed = usable.map((raw) =>
      this.convertResult(raw, attachments, fixtures.get(raw.uuid!)),
    );
    markRetries(parsed);

    const active = parsed.filter((result) => !result.isRetry);
    const counters = {
      total: active.length,
      passed: active.filter((r) => r.status === 'passed').length,
      failed: active.filter((r) => r.status === 'failed').length,
      broken: active.filter((r) => r.status === 'broken').length,
      skipped: active.filter((r) => r.status === 'skipped').length,
    };

    const starts = parsed.map((r) => r.startMs).filter((v): v is number => v !== null);
    const stops = parsed.map((r) => r.stopMs).filter((v): v is number => v !== null);
    const startedAt = starts.length ? new Date(Math.min(...starts)) : null;
    const finishedAt = stops.length ? new Date(Math.max(...stops)) : null;

    return {
      results: parsed,
      startedAt,
      finishedAt,
      durationMs: startedAt && finishedAt ? finishedAt.getTime() - startedAt.getTime() : null,
      ...counters,
      status: counters.failed + counters.broken > 0 ? 'failed' : 'passed',
      warnings,
    };
  }

  private convertResult(
    raw: AllureResult,
    bodies: AttachmentBodies,
    fixtures?: Fixtures,
  ): ParsedResult {
    const labels = mapLabels(raw.labels);
    const parameters = mapParameters(raw.parameters);
    const fullName = raw.fullName?.trim() || null;
    const status = normalizeStatus(raw.status);

    let order = 0;
    const steps: ParsedStep[] = [
      ...(fixtures?.before ?? []).map((step) => convertStep(step, 'before', order++, bodies)),
      ...(raw.steps ?? []).map((step) => convertStep(step, 'step', order++, bodies)),
      ...(fixtures?.after ?? []).map((step) => convertStep(step, 'after', order++, bodies)),
    ];

    // A test whose setUp threw carries no statusDetails of its own; without
    // this the UI would show "broken" with nothing to read.
    let message = raw.statusDetails?.message?.trim() || null;
    let trace = raw.statusDetails?.trace?.trim() || null;
    if (!message && !trace && isFailure(status)) {
      const failure = findFailure(steps);
      if (failure) {
        const where = failure.kind === 'step' ? 'step' : `${failure.kind} fixture`;
        message = failure.message ?? `Failed in ${where}: ${failure.name}`;
        trace = failure.trace;
      }
    }

    return {
      uuid: raw.uuid!,
      historyId: deriveHistoryId(raw, parameters),
      fullName,
      name: raw.name?.trim() || fullName || raw.uuid!,
      suite: deriveSuite(labels, fullName),
      status,
      statusMessage: message,
      statusTrace: trace,
      startMs: typeof raw.start === 'number' ? raw.start : null,
      stopMs: typeof raw.stop === 'number' ? raw.stop : null,
      durationMs: durationOf(raw.start, raw.stop),
      description: raw.description?.trim() || null,
      labels,
      parameters,
      links: mapLinks(raw.links),
      steps,
      attachments: mapAttachments(raw.attachments, bodies),
      isRetry: false,
      attempt: 1,
      raw: isFailure(status) ? raw : null,
    };
  }
}

interface Fixtures {
  before: AllureStep[];
  after: AllureStep[];
}

/** Attachment bodies read out of the archive, by the `source` that names them. */
type AttachmentBodies = Map<string, ArchivedAttachment>;

/**
 * A declared attachment joined to the file that backs it. A reference with no
 * file behind it is kept: "the adapter promised a response body and the archive
 * does not have it" is worth seeing, and dropping the row would hide it.
 */
const mapAttachments = (
  declared: AllureAttachment[] | undefined,
  bodies: AttachmentBodies,
): ParsedAttachment[] =>
  (declared ?? []).map((attachment) => {
    const source = attachment.source?.trim() || null;
    const file = source ? bodies.get(source) : undefined;
    return {
      name: attachment.name?.trim() || source || '(unnamed attachment)',
      source,
      type: attachment.type?.trim() || null,
      sizeBytes: file?.sizeBytes ?? null,
      content: file?.content ?? null,
      truncated: file?.truncated ?? false,
    };
  });

const asString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
};

const mapParameters = (params?: AllureParameter[]) =>
  (params ?? [])
    .filter((param) => param?.name && !param.excluded && param.mode !== 'hidden')
    .map((param) => ({ name: param.name!, value: asString(param.value) ?? '' }));

const mapLabels = (labels?: AllureLabel[]) =>
  (labels ?? [])
    .filter((label): label is { name: string; value: string } =>
      Boolean(label?.name && label.value),
    )
    .map((label) => ({ name: label.name, value: label.value }));

const mapLinks = (links?: AllureLink[]) =>
  (links ?? [])
    .filter((link) => link?.url)
    .map((link) => ({ type: link.type ?? null, name: link.name ?? null, url: link.url! }));

const durationOf = (start?: number, stop?: number): number | null =>
  typeof start === 'number' && typeof stop === 'number' && stop >= start ? stop - start : null;

const labelValue = (labels: { name: string; value: string }[], name: string): string | null =>
  labels.find((label) => label.name === name)?.value ?? null;

/**
 * Suite path for grouping and for the denormalized `test_cases.suite` column.
 * Adapters disagree on which labels they emit, so several are tried before
 * falling back to the package part of fullName.
 */
function deriveSuite(
  labels: { name: string; value: string }[],
  fullName: string | null,
): string | null {
  const parts = [
    labelValue(labels, 'parentSuite'),
    labelValue(labels, 'suite'),
    labelValue(labels, 'subSuite'),
  ].filter(Boolean) as string[];
  if (parts.length) return parts.join('/');

  const feature = labelValue(labels, 'feature');
  if (feature) return feature;

  const pkg = labelValue(labels, 'package') ?? labelValue(labels, 'testClass');
  if (pkg) return pkg;

  if (fullName?.includes('.')) return fullName.slice(0, fullName.lastIndexOf('.'));
  return null;
}

function convertStep(
  raw: AllureStep,
  kind: ParsedStepKind,
  orderNum: number,
  bodies: AttachmentBodies,
): ParsedStep {
  return {
    kind,
    orderNum,
    name: raw.name?.trim() || '(unnamed step)',
    status: normalizeStatus(raw.status),
    durationMs: durationOf(raw.start, raw.stop),
    message: raw.statusDetails?.message?.trim() || null,
    trace: raw.statusDetails?.trace?.trim() || null,
    parameters: mapParameters(raw.parameters),
    attachmentsCount: raw.attachments?.length ?? 0,
    attachments: mapAttachments(raw.attachments, bodies),
    children: (raw.steps ?? []).map((child, index) => convertStep(child, kind, index, bodies)),
  };
}

/** Depth-first search for the deepest failing node, which holds the real cause. */
function findFailure(steps: ParsedStep[]): ParsedStep | null {
  for (const step of steps) {
    if (!isFailure(step.status)) continue;
    return findFailure(step.children) ?? step;
  }
  return null;
}

/**
 * A container's children may name results or other containers (suite-level
 * fixtures wrap test-level ones), so the chain is followed down to results.
 */
function resolveTargets(
  container: AllureContainer,
  containers: Map<string, AllureContainer>,
  resultUuids: Set<string>,
  seen = new Set<string>(),
): string[] {
  const out: string[] = [];
  for (const child of container.children ?? []) {
    if (resultUuids.has(child)) {
      out.push(child);
      continue;
    }
    const nested = containers.get(child);
    if (nested?.uuid && !seen.has(nested.uuid)) {
      seen.add(nested.uuid);
      out.push(...resolveTargets(nested, containers, resultUuids, seen));
    }
  }
  return out;
}

/**
 * Fixture bodies per result. Outer (suite-level) containers start earlier, so
 * ordering by start puts them ahead of the test-level ones.
 */
function groupFixtures(
  results: AllureResult[],
  containers: AllureContainer[],
): Map<string, Fixtures> {
  const resultUuids = new Set(results.map((result) => result.uuid!));
  const byUuid = new Map<string, AllureContainer>();
  for (const container of containers) {
    if (container?.uuid) byUuid.set(container.uuid, container);
  }

  const grouped = new Map<string, Fixtures>();
  const ordered = [...containers].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  for (const container of ordered) {
    if (!container.befores?.length && !container.afters?.length) continue;
    for (const uuid of resolveTargets(container, byUuid, resultUuids)) {
      const bucket = grouped.get(uuid) ?? { before: [], after: [] };
      bucket.before.push(...(container.befores ?? []));
      bucket.after.push(...(container.afters ?? []));
      grouped.set(uuid, bucket);
    }
  }
  return grouped;
}

/**
 * Allure's historyId ties a test to its past runs. Adapters that omit it get a
 * deterministic substitute so history and retry detection still work.
 */
function deriveHistoryId(
  result: AllureResult,
  parameters: { name: string; value: string }[],
): string {
  if (result.historyId) return result.historyId;
  const seed = [
    result.fullName ?? result.name ?? '',
    ...parameters.map((param) => `${param.name}=${param.value}`).sort(),
  ].join('|');
  return createHash('md5').update(seed).digest('hex');
}

/**
 * Frameworks that rerun failures emit several results with one historyId in a
 * single run. The last attempt is the verdict; earlier ones are kept as the
 * flakiness signal but excluded from the counters.
 */
function markRetries(results: ParsedResult[]): void {
  const byHistory = new Map<string, ParsedResult[]>();
  for (const result of results) {
    const bucket = byHistory.get(result.historyId) ?? [];
    bucket.push(result);
    byHistory.set(result.historyId, bucket);
  }

  for (const attempts of byHistory.values()) {
    if (attempts.length < 2) continue;
    attempts.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
    attempts.forEach((result, index) => {
      result.attempt = index + 1;
      result.isRetry = index < attempts.length - 1;
    });
  }
}
