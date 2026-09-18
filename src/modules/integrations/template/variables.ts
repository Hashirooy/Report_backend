import type { IntegrationFilter, IntegrationVariable } from '../../../contracts/index.js';

import { FILTERS } from './template-engine.js';

/**
 * Everything a template may reference, with the value the settings preview
 * uses in place of a real report. IssueExportsService builds the real values
 * with exactly these paths; a path missing there renders as null.
 */
export const INTEGRATION_VARIABLES: IntegrationVariable[] = [
  { path: 'bug.title', type: 'string', description: 'Заголовок отчёта', example: '[API] POST /api/v1/applications возвращает 500 вместо 201' },
  { path: 'bug.environment', type: 'string', description: 'Окружение', example: 'STAGE' },
  { path: 'bug.endpoint', type: 'string', description: 'Эндпоинт целиком', example: 'POST /api/v1/applications' },
  { path: 'bug.method', type: 'string', description: 'HTTP-метод из эндпоинта', example: 'POST' },
  { path: 'bug.path', type: 'string', description: 'Путь из эндпоинта', example: '/api/v1/applications' },
  { path: 'bug.preconditions', type: 'string', description: 'Предусловия', example: 'Нет' },
  { path: 'bug.steps', type: 'string[]', description: 'Шаги воспроизведения списком', example: ['Отправить POST /api/v1/applications с валидным телом', 'Проверить код ответа'] },
  { path: 'bug.stepsText', type: 'string', description: 'Шаги воспроизведения как в отчёте', example: '1. Отправить POST /api/v1/applications с валидным телом\n2. Проверить код ответа' },
  { path: 'bug.expected', type: 'string', description: 'Ожидаемый результат', example: 'HTTP 201 Created' },
  { path: 'bug.actual', type: 'string', description: 'Фактический результат', example: 'HTTP 500 Internal Server Error' },
  { path: 'bug.request', type: 'string', description: 'Запрос (если есть в отчёте)', example: null },
  { path: 'bug.response', type: 'string', description: 'Ответ (если есть в отчёте)', example: null },
  { path: 'bug.swagger', type: 'string', description: 'Раздел Swagger', example: '- 201 — заявка создана.\n- 400 — невалидный запрос.' },
  { path: 'bug.contractViolation', type: 'string', description: 'Нарушение контракта', example: 'Код 500 не описан в спецификации.' },
  { path: 'bug.severity', type: 'string', description: 'Severity: Blocker / Critical / Major / Minor / Trivial', example: 'Major' },
  { path: 'bug.priority', type: 'string', description: 'Priority: Highest / High / Medium / Low', example: 'High' },
  { path: 'bug.additionalInfo', type: 'string', description: 'Дополнительная информация', example: null },
  { path: 'bug.markdown', type: 'string', description: 'Весь отчёт в markdown', example: '**Заголовок:**\n\n[API] POST /api/v1/applications возвращает 500 вместо 201\n\n…' },

  { path: 'project.id', type: 'string', description: 'Id проекта', example: '1' },
  { path: 'project.slug', type: 'string', description: 'Slug проекта', example: 'autofinance-api' },
  { path: 'project.name', type: 'string', description: 'Название проекта', example: 'Autofinance API' },
  { path: 'project.repositoryUrl', type: 'string', description: 'Репозиторий тестов', example: 'https://git.example.com/autofinance/api-tests' },

  { path: 'run.id', type: 'string', description: 'Id прогона', example: '154' },
  { path: 'run.number', type: 'number', description: 'Номер прогона', example: 154 },
  { path: 'run.branch', type: 'string', description: 'Ветка', example: 'main' },
  { path: 'run.commitSha', type: 'string', description: 'Коммит', example: '9f2c1e7' },
  { path: 'run.environment', type: 'string', description: 'Окружение прогона', example: 'staging' },
  { path: 'run.ciBuildUrl', type: 'string', description: 'Ссылка на CI-job', example: 'https://git.example.com/autofinance/api-tests/-/jobs/884213' },

  { path: 'test.name', type: 'string', description: 'Название теста (для задач по одному тесту)', example: 'Create application returns 201' },
  { path: 'test.fullName', type: 'string', description: 'Полное имя теста', example: 'applications.CreateApplicationTest.returns201' },
  { path: 'test.status', type: 'string', description: 'Статус выполнения теста', example: 'failed' },
  { path: 'result.id', type: 'string', description: 'Id результата теста', example: '48213' },

  { path: 'job.id', type: 'string', description: 'Id задачи агента', example: '11' },
  { path: 'job.summary', type: 'string', description: 'Итог задачи агента', example: 'Составлен баг-репорт по падению create application' },
  { path: 'job.userRequest', type: 'string', description: 'Запрос пользователя к агенту', example: 'Оформи баг по этому падению' },

  { path: 'user.name', type: 'string', description: 'Кто отправляет', example: 'Иван Петров' },
  { path: 'user.email', type: 'string', description: 'Email отправляющего', example: 'ivan@example.com' },

  { path: 'now', type: 'string', description: 'Время отправки, ISO-8601', example: '2026-09-17T12:00:00.000Z' },
];

export const INTEGRATION_VARIABLE_PATHS: ReadonlySet<string> = new Set(
  INTEGRATION_VARIABLES.map((variable) => variable.path),
);

export const INTEGRATION_FILTERS: IntegrationFilter[] = Object.entries(FILTERS).map(
  ([name, def]) => ({ name, argument: def.argument, description: def.description }),
);

/** `{ 'bug.title': x }` → `{ bug: { title: x } }`, the shape lookups walk. */
export function nestVariables(flat: Record<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(flat)) {
    const segments = path.split('.');
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      node = (node[segment] ??= {}) as Record<string, unknown>;
    }
    node[segments[segments.length - 1]] = value;
  }
  return root;
}

export const exampleVariables = (): Record<string, unknown> =>
  nestVariables(Object.fromEntries(INTEGRATION_VARIABLES.map((v) => [v.path, v.example])));
