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
GET  /api/projects/:projectId/runs/:runId/results
GET  /api/projects/:projectId/runs/:runId/results/:resultId
GET  /api/projects/:projectId/errors
GET  /api/projects/:projectId/top-failures
GET  /api/projects/:projectId/flaky
GET  /api/projects/:projectId/test-cases/:testCaseId/history
POST /api/ingest                                   X-API-Token, multipart
```

## Running it

```bash
cp .env.example .env            # set DATABASE_URL and INGEST_TOKEN
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
