/**
 * Fields of a report written by the api-bug-report skill.
 *
 * The skill fixes the format — every section is a bold label ending in a colon
 * on its own line, in a known order — and the review stage rejects a report
 * that strays from it. That makes a deterministic parse reliable enough, and
 * keeps the agent's answer format untouched.
 *
 * A value the report gives as "Не указано" is null here, so a template can use
 * `default` instead of sending the placeholder text into a tracker field.
 */
export interface ParsedBugReport {
  title: string | null;
  environment: string | null;
  endpoint: string | null;
  method: string | null;
  path: string | null;
  preconditions: string | null;
  steps: string[];
  stepsText: string | null;
  expected: string | null;
  actual: string | null;
  request: string | null;
  response: string | null;
  swagger: string | null;
  contractViolation: string | null;
  severity: string | null;
  priority: string | null;
  additionalInfo: string | null;
  markdown: string;
}

type SectionKey = Exclude<keyof ParsedBugReport, 'method' | 'path' | 'steps' | 'markdown'>;

const LABELS: Record<string, SectionKey> = {
  'заголовок': 'title',
  'окружение': 'environment',
  'эндпоинт': 'endpoint',
  'предусловия': 'preconditions',
  'шаги воспроизведения': 'stepsText',
  'ожидаемый результат': 'expected',
  'фактический результат': 'actual',
  'запрос': 'request',
  'ответ': 'response',
  'swagger': 'swagger',
  'нарушение контракта': 'contractViolation',
  'severity': 'severity',
  'priority': 'priority',
  'дополнительная информация': 'additionalInfo',
};

/** `**Label:**` alone, or with the value on the same line after it. */
const LABEL_LINE = /^\s*\*\*\s*([^*]+?)\s*:?\s*\*\*\s*:?\s*(.*)$/;
const NOT_GIVEN = /^не указано\.?$/i;
const HTTP_METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i;
const NUMBERED = /^\s*\d+[.)]\s+(.+)$/;
const BULLET = /^\s*[-*•]\s+(.+)$/;

export function parseBugReport(markdown: string, fallbackTitle: string | null = null): ParsedBugReport {
  const sections = new Map<SectionKey, string[]>();
  let current: SectionKey | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const label = LABEL_LINE.exec(line);
    const key = label ? LABELS[label[1].toLowerCase()] : undefined;
    if (label && key) {
      current = key;
      sections.set(key, label[2] ? [label[2]] : []);
      continue;
    }
    // Text before the first known label (a heading, a preamble) belongs to no field.
    if (current) sections.get(current)!.push(line);
  }

  const field = (key: SectionKey): string | null => {
    const text = sections.get(key)?.join('\n').trim() ?? '';
    return text === '' || NOT_GIVEN.test(text) ? null : text;
  };

  const endpoint = field('endpoint');
  const call = endpoint ? HTTP_METHOD.exec(endpoint.replace(/`/g, '').trim()) : null;
  const stepsText = field('stepsText');

  return {
    title: field('title') ?? firstHeading(markdown) ?? fallbackTitle,
    environment: field('environment'),
    endpoint,
    method: call ? call[1].toUpperCase() : null,
    path: call ? call[2] : null,
    preconditions: field('preconditions'),
    steps: stepsText ? splitSteps(stepsText) : [],
    stepsText,
    expected: field('expected'),
    actual: field('actual'),
    request: field('request'),
    response: field('response'),
    swagger: field('swagger'),
    contractViolation: field('contractViolation'),
    severity: field('severity'),
    priority: field('priority'),
    additionalInfo: field('additionalInfo'),
    markdown,
  };
}

/**
 * Numbered items, each with any continuation lines folded in. Falls back to
 * bullets, then to non-empty lines, for a report that numbered nothing.
 */
function splitSteps(text: string): string[] {
  const lines = text.split('\n');
  for (const pattern of [NUMBERED, BULLET]) {
    if (!lines.some((line) => pattern.test(line))) continue;
    const steps: string[] = [];
    for (const line of lines) {
      const match = pattern.exec(line);
      if (match) steps.push(match[1].trim());
      else if (steps.length && line.trim()) steps[steps.length - 1] += `\n${line.trim()}`;
    }
    return steps;
  }
  return lines.map((line) => line.trim()).filter(Boolean);
}

function firstHeading(markdown: string): string | null {
  const match = /^#{1,3}\s+(.+)$/m.exec(markdown);
  return match ? match[1].trim() : null;
}
