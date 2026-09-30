import type { IntegrationTemplate } from '../../../contracts/index.js';

/**
 * Renders an integration template. No expressions, no helpers, no code: a
 * placeholder is a variable path and a chain of filters from the fixed list
 * below, and the body is walked as a JSON tree so substituted text can never
 * change its structure.
 */

/** Where a placeholder sits. Decides escaping and which variables are allowed. */
export type TemplateSlot = 'url' | 'header' | 'body' | 'responseUrl';

export interface TemplateIssue {
  /** Location inside the template: `body.fields.summary`, `headers.Authorization`. */
  at: string;
  message: string;
}

export class TemplateError extends Error {
  constructor(readonly issues: TemplateIssue[]) {
    super(issues.map((issue) => `${issue.at}: ${issue.message}`).join('; '));
  }
}

export type TemplateValue = string | number | boolean | null | TemplateValue[] | { [key: string]: TemplateValue };

type Maps = IntegrationTemplate['maps'];

interface FilterCall {
  name: string;
  arg: string | number | null;
}

interface Placeholder {
  path: string;
  filters: FilterCall[];
}

type ArgKind = 'none' | 'string' | 'optional-string' | 'number' | 'map';

interface FilterDef {
  arg: ArgKind;
  argument: string | null;
  description: string;
  apply(value: unknown, arg: string | number | null, maps: Maps): unknown;
}

const isEmpty = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  value === '' ||
  (Array.isArray(value) && value.length === 0);

/** Text form of any value: what a placeholder inside other text becomes. */
export function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(stringify).join('\n');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const asList = (value: unknown): unknown[] | null =>
  Array.isArray(value) ? value : isEmpty(value) ? null : [value];

export const FILTERS: Record<string, FilterDef> = {
  default: {
    arg: 'string',
    argument: '"text"',
    description: 'Подставляет текст, если значение пустое (null, пустая строка, пустой список).',
    apply: (value, arg) => (isEmpty(value) ? arg : value),
  },
  truncate: {
    arg: 'number',
    argument: 'N',
    description: 'Обрезает текст до N символов, последним ставит «…».',
    apply: (value, arg) => {
      if (value === null || value === undefined) return value;
      const text = stringify(value);
      const limit = arg as number;
      return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
    },
  },
  join: {
    arg: 'optional-string',
    argument: '", "',
    description: 'Склеивает список в строку через разделитель (по умолчанию ", ").',
    apply: (value, arg) => {
      const list = asList(value);
      return list === null ? value : list.map(stringify).join((arg as string | null) ?? ', ');
    },
  },
  numbered: {
    arg: 'none',
    argument: null,
    description: 'Список в нумерованный текст: «1. …» с новой строки.',
    apply: (value) => asList(value)?.map((item, i) => `${i + 1}. ${stringify(item)}`).join('\n') ?? value,
  },
  bullets: {
    arg: 'none',
    argument: null,
    description: 'Список в маркированный текст: «- …» с новой строки.',
    apply: (value) => asList(value)?.map((item) => `- ${stringify(item)}`).join('\n') ?? value,
  },
  split: {
    arg: 'string',
    argument: '","',
    description: 'Строку в список по разделителю, пустые элементы отбрасываются.',
    apply: (value, arg) =>
      isEmpty(value)
        ? []
        : stringify(value)
            .split(arg as string)
            .map((part) => part.trim())
            .filter(Boolean),
  },
  map: {
    arg: 'map',
    argument: 'имя_таблицы',
    description: 'Заменяет значение по таблице из maps. Ключ "*" — значение по умолчанию.',
    apply: (value, arg, maps) => {
      const table = maps[arg as string];
      const key = stringify(value);
      if (Object.hasOwn(table, key)) return table[key];
      return Object.hasOwn(table, '*') ? table['*'] : value;
    },
  },
  lower: {
    arg: 'none',
    argument: null,
    description: 'В нижний регистр.',
    apply: (value) => (isEmpty(value) ? value : stringify(value).toLowerCase()),
  },
  upper: {
    arg: 'none',
    argument: null,
    description: 'В верхний регистр.',
    apply: (value) => (isEmpty(value) ? value : stringify(value).toUpperCase()),
  },
  trim: {
    arg: 'none',
    argument: null,
    description: 'Убирает пробелы и переводы строк по краям.',
    apply: (value) => (isEmpty(value) ? value : stringify(value).trim()),
  },
  string: {
    arg: 'none',
    argument: null,
    description: 'Приводит к строке (null станет пустой строкой).',
    apply: (value) => stringify(value),
  },
  number: {
    arg: 'none',
    argument: null,
    description: 'Приводит к числу; нечисловое значение станет null.',
    apply: (value) => {
      if (isEmpty(value)) return null;
      const parsed = Number(stringify(value));
      return Number.isFinite(parsed) ? parsed : null;
    },
  },
  json: {
    arg: 'none',
    argument: null,
    description: 'Значение как JSON-текст — например, чтобы вставить список внутрь строки.',
    apply: (value) => JSON.stringify(value ?? null),
  },
};

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{([^{}]*)\}\}$/;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;
const FILTER = /^([a-z]+)(?:\s*:\s*(.+))?$/;
/** Scheme and host written out, so a substituted value can never pick the server. */
const LITERAL_ORIGIN = /^https?:\/\/[^/?#{}\s]+(?:[/?#]|$)/i;
const KEY_PATH = /^(\$\.)?[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const RESERVED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection']);
const MAX_BODY_CHARS = 64_000;

/** Splits on `|` outside double quotes, so `default:"a | b"` stays one filter. */
function splitPipes(source: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' && source[i - 1] !== '\\') quoted = !quoted;
    if (ch === '|' && !quoted) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim());
}

function parsePlaceholder(source: string, maps: Maps): Placeholder {
  const [path, ...rawFilters] = splitPipes(source);
  if (!PATH.test(path)) throw new Error(`"${path}" is not a variable path`);

  const filters = rawFilters.map((raw): FilterCall => {
    const match = FILTER.exec(raw);
    const def = match && Object.hasOwn(FILTERS, match[1]) ? FILTERS[match[1]] : undefined;
    if (!match || !def) throw new Error(`unknown filter "${raw}"`);
    const [, name, rawArg] = match;

    if (rawArg === undefined) {
      if (def.arg === 'none' || def.arg === 'optional-string') return { name, arg: null };
      throw new Error(`filter "${name}" needs an argument: ${name}:${def.argument}`);
    }
    if (def.arg === 'none') throw new Error(`filter "${name}" takes no argument`);

    if (def.arg === 'number') {
      const n = Number(rawArg);
      if (!Number.isInteger(n) || n < 1) throw new Error(`filter "${name}" needs a positive integer`);
      return { name, arg: n };
    }
    if (def.arg === 'map') {
      if (!Object.hasOwn(maps, rawArg)) throw new Error(`map "${rawArg}" is not defined in maps`);
      return { name, arg: rawArg };
    }
    let text: unknown;
    try {
      text = JSON.parse(rawArg);
    } catch {
      text = undefined;
    }
    if (typeof text !== 'string') {
      throw new Error(`filter "${name}" needs a quoted argument: ${name}:${def.argument}`);
    }
    return { name, arg: text };
  });

  return { path, filters };
}

/**
 * Which variables a slot may use. The secret is confined to headers: in a URL
 * it ends up in proxy logs, in a body inside the created issue.
 */
function checkPath(path: string, slot: TemplateSlot, known: ReadonlySet<string>): string | null {
  if (path === 'secret') {
    return slot === 'header' ? null : '{{secret}} is allowed in header values only';
  }
  if (slot === 'responseUrl' && (path === 'externalKey' || path.startsWith('response.'))) {
    return null;
  }
  if (path === 'externalKey' || path.startsWith('response.')) {
    return `{{${path}}} is only available in response.urlTemplate`;
  }
  return known.has(path) ? null : `unknown variable "${path}"`;
}

function checkString(
  text: string,
  at: string,
  slot: TemplateSlot,
  known: ReadonlySet<string>,
  maps: Maps,
  issues: TemplateIssue[],
): void {
  for (const match of text.matchAll(PLACEHOLDER)) {
    try {
      const placeholder = parsePlaceholder(match[1], maps);
      const problem = checkPath(placeholder.path, slot, known);
      if (problem) issues.push({ at, message: problem });
    } catch (error) {
      issues.push({ at, message: (error as Error).message });
    }
  }
  // An unbalanced brace is almost always a typo that would otherwise go out
  // verbatim in every issue.
  const leftover = text.replace(PLACEHOLDER, '');
  if (leftover.includes('{{') || leftover.includes('}}')) {
    issues.push({ at, message: 'unbalanced "{{" or "}}"' });
  }
}

/** Every static problem at once, so the settings form can show them together. */
export function validateTemplate(
  template: IntegrationTemplate,
  known: ReadonlySet<string>,
): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const { maps } = template;

  if (!LITERAL_ORIGIN.test(template.url)) {
    issues.push({
      at: 'url',
      message: 'must start with http:// or https:// and a host written without placeholders',
    });
  }
  checkString(template.url, 'url', 'url', known, maps, issues);

  for (const [name, value] of Object.entries(template.headers)) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      issues.push({ at: `headers.${name}`, message: 'this header is set by the server' });
    }
    checkString(value, `headers.${name}`, 'header', known, maps, issues);
  }

  const walk = (node: unknown, at: string): void => {
    if (typeof node === 'string') {
      checkString(node, at, 'body', known, maps, issues);
    } else if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${at}.${i}`));
    } else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key.includes('{{')) issues.push({ at: `${at}.${key}`, message: 'keys cannot contain placeholders' });
        walk(value, `${at}.${key}`);
      }
    }
  };
  walk(template.body, 'body');
  if (JSON.stringify(template.body).length > MAX_BODY_CHARS) {
    issues.push({ at: 'body', message: `longer than ${MAX_BODY_CHARS} characters` });
  }

  if (template.response.keyPath !== null && !KEY_PATH.test(template.response.keyPath)) {
    issues.push({ at: 'response.keyPath', message: 'must be a dot path such as "key" or "data.iid"' });
  }
  if (template.response.urlTemplate !== null) {
    checkString(template.response.urlTemplate, 'response.urlTemplate', 'responseUrl', known, maps, issues);
  }

  return issues;
}

/** True when a header value references the stored secret. */
export function usesSecret(template: IntegrationTemplate): boolean {
  return Object.values(template.headers).some((value) =>
    [...value.matchAll(PLACEHOLDER)].some((match) => splitPipes(match[1])[0] === 'secret'),
  );
}

/** Reads `a.b.0.c` out of nested objects and arrays; undefined when absent. */
export function lookup(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of path.replace(/^\$\./, '').split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function evaluate(source: string, vars: unknown, maps: Maps): unknown {
  const placeholder = parsePlaceholder(source, maps);
  let value = lookup(vars, placeholder.path);
  for (const filter of placeholder.filters) {
    value = FILTERS[filter.name].apply(value, filter.arg, maps);
  }
  return value;
}

/** Text with every placeholder replaced; `escape` is applied per substitution. */
export function renderString(
  text: string,
  vars: unknown,
  maps: Maps,
  escape: (value: string) => string = (value) => value,
): string {
  return text.replace(PLACEHOLDER, (_, source: string) => escape(stringify(evaluate(source, vars, maps))));
}

/** A body node: a lone placeholder keeps its type, anything else becomes text. */
function renderNode(node: unknown, vars: unknown, maps: Maps): TemplateValue {
  if (typeof node === 'string') {
    const whole = WHOLE_PLACEHOLDER.exec(node);
    if (whole) return toJson(evaluate(whole[1], vars, maps));
    return renderString(node, vars, maps);
  }
  if (Array.isArray(node)) return node.map((item) => renderNode(item, vars, maps));
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, renderNode(value, vars, maps)]),
    );
  }
  return node as TemplateValue;
}

/** Variables are plain data already; this only turns `undefined` into `null`. */
function toJson(value: unknown): TemplateValue {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(toJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]));
  }
  return value as TemplateValue;
}

export interface RenderedRequest {
  method: IntegrationTemplate['method'];
  url: string;
  headers: Record<string, string>;
  body: TemplateValue;
}

/**
 * The request a template describes for these variables. Expects a template
 * that passed validateTemplate; throws TemplateError if the rendered URL is
 * still not a URL (a value that percent-encoding cannot rescue).
 */
export function renderRequest(template: IntegrationTemplate, vars: unknown): RenderedRequest {
  const { maps } = template;

  const url = renderString(template.url, vars, maps, encodeURIComponent);
  try {
    new URL(url);
  } catch {
    throw new TemplateError([{ at: 'url', message: `rendered to an invalid URL: ${url}` }]);
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(template.headers)) {
    // A line break in a header value would start a header of its own.
    headers[name] = renderString(value, vars, maps).replace(/[\r\n]+/g, ' ');
  }
  if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  return { method: template.method, url, headers, body: renderNode(template.body, vars, maps) };
}
