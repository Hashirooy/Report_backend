import type { ParsedStatus } from '../entities/parsed-run.entity.js';

/**
 * Shapes found in an allure-results directory. Everything is optional on
 * purpose: these files are written by a dozen framework adapters and none of
 * them fills every field.
 */

export interface AllureStatusDetails {
  message?: string;
  trace?: string;
  flaky?: boolean;
  muted?: boolean;
  known?: boolean;
}

export interface AllureAttachment {
  name?: string;
  source?: string;
  type?: string;
}

export interface AllureParameter {
  name?: string;
  value?: unknown;
  excluded?: boolean;
  mode?: string;
}

export interface AllureStep {
  name?: string;
  status?: string;
  statusDetails?: AllureStatusDetails;
  stage?: string;
  start?: number;
  stop?: number;
  steps?: AllureStep[];
  attachments?: AllureAttachment[];
  parameters?: AllureParameter[];
}

export interface AllureLabel {
  name?: string;
  value?: string;
}

export interface AllureLink {
  type?: string;
  name?: string;
  url?: string;
}

/** Contents of a *-result.json file. */
export interface AllureResult extends AllureStep {
  uuid?: string;
  historyId?: string;
  testCaseId?: string;
  testCaseName?: string;
  fullName?: string;
  description?: string;
  descriptionHtml?: string;
  labels?: AllureLabel[];
  links?: AllureLink[];
}

/**
 * Contents of a *-container.json file: fixture bodies and the uuids they apply
 * to. `children` may point at results or at other containers.
 */
export interface AllureContainer {
  uuid?: string;
  name?: string;
  children?: string[];
  befores?: AllureStep[];
  afters?: AllureStep[];
  start?: number;
  stop?: number;
}

/** What the archive reader hands to the parser. */
export interface AllureArchiveContents {
  results: AllureResult[];
  containers: AllureContainer[];
}

const KNOWN: ParsedStatus[] = ['passed', 'failed', 'broken', 'skipped', 'unknown'];

/**
 * Adapters emit statuses outside the documented set ("pending", "disabled",
 * null). Anything unrecognised becomes "unknown" rather than failing the whole
 * upload over one odd test.
 */
export function normalizeStatus(raw: unknown): ParsedStatus {
  if (typeof raw !== 'string') return 'unknown';
  const value = raw.toLowerCase().trim();
  if ((KNOWN as string[]).includes(value)) return value as ParsedStatus;
  if (value === 'pending' || value === 'disabled' || value === 'canceled') return 'skipped';
  if (value === 'error') return 'broken';
  return 'unknown';
}
