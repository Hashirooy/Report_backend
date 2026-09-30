# @reports/backend

Backend for the Allure reporting app: ingests `allure-results` from GitLab CI,
parses cases and failures, stores them in PostgreSQL, and serves screen-shaped
DTOs.

Single package, no workspaces: one `package.json`, one `tsconfig.json`, one
build. The response contracts live in `src/contracts/` and are imported by
relative path — a frontend in another repository copies that directory or gets
the types from a published package later.

## Layout

```
src/
├── main.ts                        HTTP entrypoint
├── worker.ts                      queue consumer entrypoint (same modules, no server)
├── app.module.ts
│
├── config/
│   └── configuration.ts           typed config + boot-time env validation
│
├── common/
│   ├── guards/api-token.guard.ts
│   ├── filters/http-exception.filter.ts
│   ├── interceptors/logging.interceptor.ts
│   ├── pipes/parse-bigint.pipe.ts
│   ├── decorators/ci-protected.decorator.ts
│   └── utils/                     serialization, DTO validation helper
│
├── contracts/                     response types, routes, mocks (shared with the client)
│
├── prisma/                        PrismaService (global)
├── queue/                         pg-boss wrapper (global)
│
└── modules/
    ├── projects/    controller · service · repository · dto
    ├── runs/        controller · service · repository · dto
    ├── results/     controller · service · repository · dto
    ├── analytics/   controller · service · repository · dto
    ├── dashboard/   controller · service · dto        (composition only)
    └── ingest/      controller · service · repository · dto
        ├── entities/    ParsedRun — the domain shape between parser and DB
        ├── parser/      archive reader, allure parser, fingerprinting
        └── processors/  parse-run job handler (runs in the worker)
```

Request flow is the same everywhere: **controller → DTO/validation → service →
repository → database**. Controllers touch no Prisma; repositories hold no
business rules; services never see an HTTP object.

`dashboard/` is the one module that owns no data — it composes the others so a
number on the project screen cannot disagree with the same number fetched from
its own endpoint.

## Status

| Piece | State |
| --- | --- |
| Prisma schema + raw SQL indexes | applied to a live database: 7 tables, 28 indexes |
| Contracts + mocks | done, fixtures validated against schemas |
| Nest app: config, common, prisma, queue | done |
| projects / runs / results / analytics / dashboard | done, every endpoint answers 200 |
| ingest: upload, parser, fingerprinting, worker | done, full pipeline exercised end to end |
| Verified against real allure-results | not done — only a synthetic archive so far |
| Automated tests | none yet |
| `raw_result` retention job | not written — only the config knob exists |

A synthetic four-test archive (passed / failed / broken / skipped, plus a
container with `befores`/`afters`) goes in through `POST /api/ingest` and comes
back out of every read endpoint: `passRate` lands on 33.33 with the skipped test
out of the denominator, fixtures show up as `before` steps on the failed test,
the two failures fingerprint into separate error groups, and a re-upload of the
same `ciBuildId` returns `deduplicated: true` instead of a second run.

## Decisions worth knowing

**Ids are strings.** Result rows run into the millions, so primary keys are
`BigInt`. JSON has no 64-bit integer, so every id crosses the wire as a decimal
string and is opaque to the client. `enableBigIntSerialization()` installs the
`toJSON` that makes this work, and is called by both entrypoints.

**A run has two statuses.** `status` (`passed`/`failed`) is the verdict of the
tests. `ingestStatus` (`pending`/`parsing`/`ready`/`parse_failed`) is what
happened to the uploaded archive. Merging them would make a broken upload
indistinguishable from a red suite.

**`passRate` is `passed / (total - skipped)`.** Computed server-side only — a
run that skipped half its suite must not read as 50% healthy.

**Retries are rows, not a special case.** Frameworks rerun failures, producing
several results with one `historyId` inside one run. Every attempt is stored;
superseded ones carry `is_retry = true` and drop out of the counters through a
partial index. They are also the flakiness signal.

**Fixtures share the step tree.** `befores`/`afters` from `*-container.json`
become `test_steps` rows with `kind = before|after`. Without them a failure in
setUp arrives as a `broken` test with no message.

**Failures are grouped by cause, not only by test.** `error_groups` keys a
normalized message plus the first meaningful trace frame into a fingerprint, so
one expired token that breaks 40 tests is one row. `topFailures` answers "which
test breaks most often"; `topErrorGroups` answers "which cause breaks the most
tests".

**`TestStatus` is declared worst-first.** A Postgres enum sorts by declaration
order, so `ORDER BY status` puts failures at the top of a result list with no
CASE expression. The order carries no other meaning.

**`raw_result` is a hedge, not storage.** Written only for `failed`/`broken`,
never selected in list queries, cleared by a retention job past 30 days.

**`run_number` is allocated under a lock.** `MAX(run_number) + 1` races between
parallel pipelines, so the project row is locked with `SELECT … FOR UPDATE` in
the same transaction as the insert.

**`(project_id, ci_build_id)` is the ingest idempotency key.** A retried GitLab
job updates its run instead of creating a second one.

**Ingest ids are reserved up front.** The step tree needs parent ids before its
rows exist, so `nextval()` is drawn in bulk and the whole write becomes a
handful of `createMany` calls instead of thousands of round trips.

**Nothing from the zip is written to disk.** Entries are decoded straight from
the archive, which removes zip-slip entirely; only `*-result.json` and
`*-container.json` are read, so attachments cost nothing.

## Endpoints

```
GET  /api/projects
POST /api/projects
GET  /api/projects/:projectId                      slug or numeric id
GET  /api/projects/:projectId/summary
GET  /api/projects/:projectId/dashboard            one call for the project screen
GET  /api/projects/:projectId/runs
GET  /api/projects/:projectId/trend
GET  /api/projects/:projectId/runs/:runId          run number or numeric id
DELETE /api/projects/:projectId/runs/:runId        maintainer only
GET  /api/projects/:projectId/runs/:runId/results
GET  /api/projects/:projectId/runs/:runId/results/:resultId
GET  /api/projects/:projectId/errors
GET  /api/projects/:projectId/top-failures
GET  /api/projects/:projectId/flaky
GET  /api/projects/:projectId/test-cases/:testCaseId/history
POST /api/ingest                                   X-API-Token, multipart
```

Run results can be filtered by case-insensitive substrings with `suite` and
`name`, for example `?suite=contract&name=get_entity`. The older `q` parameter
remains an alias for `name`.

`POST /api/projects` creates an initial project-scoped CI token and returns it
once as `ingestToken`. Store it in the project's CI secret variables and send it
in the `X-API-Token` header. Later project reads never return the secret.

## Отправка баг-репорта через интеграцию проекта

Готовый документ Reps отправляется во внешнюю систему через единственную
интеграцию проекта:

```http
POST /api/reps/jobs/:jobId/exports
Content-Type: application/json
```

Ручка не создаёт баг-репорт и не ожидает завершения Reps job. Перед вызовом:

1. job должна быть привязана к проекту;
2. job должна уже сформировать хотя бы один artifact с документом;
3. у проекта должна быть настроена и включена интеграция через
   `PUT /api/projects/:projectId/integration`;
4. вызывающий пользователь должен иметь роль `maintainer` в проекте;
5. если шаблон использует `{{secret}}`, у интеграции должен быть сохранён secret.

### Выбор документа

Чтобы отправить конкретный artifact, передайте его числовой id:

```json
{
  "artifactId": "456"
}
```

`artifactId` должен принадлежать job из URL. Artifact другой job считается не
найденным. Если поле не передано, выбирается последний artifact этой job по
`createdAt`, затем по `id`:

```json
{}
```

Перед отправкой Markdown разбирается на поля bug report. Они вместе с данными
проекта, запуска, теста, job и пользователя подставляются в шаблон интеграции.
Получившийся HTTP-запрос выполняется синхронно в рамках вызова `POST /exports`.

Пример с curl:

```bash
curl -X POST \
  "https://reports.example.com/api/reps/jobs/123/exports" \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"artifactId":"456"}'
```

### Успешный ответ

Ручка возвращает `201 Created` и запись о попытке отправки:

```json
{
  "id": "84",
  "jobId": "123",
  "artifactId": "456",
  "integrationId": "7",
  "integrationName": "Jira",
  "status": "succeeded",
  "requestMethod": "POST",
  "requestUrl": "https://jira.example.com/rest/api/2/issue",
  "responseStatus": 201,
  "externalKey": "BUG-42",
  "externalUrl": "https://jira.example.com/browse/BUG-42",
  "error": null,
  "createdAt": "2026-09-24T08:00:00.000Z",
  "finishedAt": "2026-09-24T08:00:01.000Z"
}
```

`externalKey` и `externalUrl` заполняются по настройкам `template.response`.
Если внешняя система приняла запрос, но её ответ невозможно разобрать, export
остаётся `succeeded`, а пояснение записывается в `error`.

### Ошибка внешней системы

HTTP-ошибка Jira, YouTrack или другого приёмника является результатом попытки,
а не ошибкой REST API отчётов. Поэтому ручка также возвращает `201`, но в теле
будет `status: "failed"`:

```json
{
  "id": "85",
  "jobId": "123",
  "artifactId": "456",
  "integrationId": "7",
  "integrationName": "Jira",
  "status": "failed",
  "requestMethod": "POST",
  "requestUrl": "https://jira.example.com/rest/api/2/issue",
  "responseStatus": 400,
  "externalKey": null,
  "externalUrl": null,
  "error": "the target answered HTTP 400",
  "createdAt": "2026-09-24T08:02:00.000Z",
  "finishedAt": "2026-09-24T08:02:01.000Z"
}
```

Сетевая ошибка и таймаут также сохраняются как `status: "failed"`. Необходимо
проверять одновременно HTTP-статус нашей ручки и поле `status` в её ответе.

### Защита от повторной отправки и `force`

Без `force` новый запрос блокируется с `409 Conflict`, если эта job уже успешно
отправлялась через текущую интеграцию либо отправляется прямо сейчас:

```json
{
  "artifactId": "456",
  "force": true
}
```

`force: true` разрешает новую попытку после успешной отправки. Он не обходит
активную попытку со статусом `pending`, чтобы два одновременных запроса не
создали два одинаковых issue. Предыдущая неуспешная попытка со статусом
`failed` повторную отправку не блокирует, поэтому после неё `force` не нужен.

Если процесс завершился во время отправки, старая `pending`-запись после
таймаута помечается как `failed` и перестаёт блокировать новые попытки.

### Предпросмотр без отправки

Перед реальной отправкой можно получить итоговый метод, URL, заголовки, JSON и
значения переменных:

```http
POST /api/reps/jobs/:jobId/exports/preview
Content-Type: application/json

{
  "artifactId": "456"
}
```

Preview возвращает `200 OK`, не создаёт `IssueExport` и не обращается к внешней
системе. Секрет в заголовках всегда заменяется на `***`.

### История отправок

Все попытки для job, включая неуспешные, доступны по ручке:

```http
GET /api/reps/jobs/:jobId/exports
```

Основные ошибки самой ручки:

- `400 Bad Request` — некорректный id, шаблон или запрещённый адрес назначения;
- `404 Not Found` — job, artifact или интеграция не найдены либо недоступны пользователю;
- `409 Conflict` — документ ещё не создан, интеграция выключена, отсутствует
  необходимый secret или отправка заблокирована существующей попыткой.

## Running it

```bash
cp .env.example .env            # set DATABASE_URL
npm install
npx prisma migrate dev --name init
psql "$DATABASE_URL" -f prisma/sql/002_partial_indexes.sql

npm run build
npm run start                    # HTTP API
npm run worker                   # parse worker, separate process
```

The SQL file holds the partial and trigram indexes Prisma's schema language
cannot express, including the unique index enforcing one active result per test
case per run.

## GitLab CI

```yaml
report:
  stage: .post
  when: always                  # a red pipeline is the interesting one
  script:
    - cd allure-results && zip -qr ../results.zip . && cd ..
    - |
      curl -sf -X POST "$REPORT_API/api/ingest" \
        -H "X-API-Token: $REPORT_TOKEN" \
        -F "project=$CI_PROJECT_PATH_SLUG" \
        -F "branch=$CI_COMMIT_REF_NAME" \
        -F "commitSha=$CI_COMMIT_SHA" \
        -F "environment=$TEST_ENV" \
        -F "ciBuildId=$CI_PIPELINE_ID" \
        -F "ciBuildUrl=$CI_JOB_URL" \
        -F "file=@results.zip"
```

Responds `202` with `runId`, `runNumber` and `statusUrl`; parsing happens in the
worker so the job does not wait on it.
