---
name: api-bug-report
description: Generate a reproducible Russian API bug report from a failed API test, its recorded request and response, and the matching Swagger/OpenAPI operation.
---

# API Bug Report

Write a finished API bug report in Russian. Use only facts present in the user
request or structured context. Do not infer missing request or response values,
contract fields, status codes, environment, business impact, or unobserved
implementation root causes. A cause-and-effect explanation derived from the
recorded response, matcher output, test evidence, and matching contract is
required; distinguish that evidenced failure mechanism from speculation about
why the service or test code was implemented that way.

## Required evidence

Before generating a report, establish:

- the environment;
- the HTTP method and endpoint;
- the preconditions and request condition that trigger the defect;
- the matching Swagger/OpenAPI operation and exact relevant contract rule;
- the concrete expected result;
- the concrete observed result.

Use `context.contract.operations[]` as the Swagger source when
`context.contract.status` is `matched`. The failed test supplies the scenario
and may contain a concrete expectation, but its name, the word `schema`, or an
assertion such as `expect(...).not.toThrow()` does not define the API contract.

When `context.contract.status` is `no_match`, explicitly state in
`Ожидаемый результат` that the observed `<METHOD> <path>` operation is not
described in the supplied Swagger/OpenAPI specification. Do not put this fact
in `Предусловия`: it is contract evidence, not data state or an authorization
condition. If an expected API behavior is established by an explicit
requirement, state it as well; otherwise say that the expected behavior cannot
be established from Swagger/OpenAPI. The absence of a matching operation never
replaces the observed behavior in `Фактический результат`.

Use recorded HTTP request and response attachments as evidence of what was
sent and received. An attachment with `contentAvailable: false`, `empty: true`,
or an `unavailableReason` contains no usable evidence. Do not treat a zero-byte
attachment as proof that the HTTP request or response itself had an empty body.
Do not infer its headers, parameters or body from another request in the test.

When `context.bugReportEvidence` is present, use it as the primary joined index
of the target operation, recorded exchange, assertion and relevant contract
rule. For `Фактический ответ`, copy `response.exactHttpFragment` verbatim and
describe only `response.primaryMismatch`. The fragment was rendered from one
complete value at one source path. Do not add another `mismatchGroups` item,
wrap it in a reconstructed parent object or array, remove or reorder fields,
or replace nested data with ellipses. The original `attachments` and
`contract` remain authoritative when the prepared evidence is absent or needs
verification.

If `context.bugReportEvidence.request.contentAvailable` is false, no concrete
request payload was recorded. Availability fields such as `contentAvailable`,
`unavailableReason`, `empty`, and attachment names are control metadata:
never mention them in the report, especially not in Preconditions or Steps.
For an explicitly successful response-schema scenario, describe sending a valid
request containing all required fields from

For the detailed failure, prefer `context.result.assertion.actual` over
`context.result.message` whenever `assertion.actual` is present. This field
retains the matcher output that Allure may shorten in `message`. If `message`
contains `…`, `...`, `truncated`, or an incomplete fragment such as
`Unrecognized key: "…`, never quote it as the complete error and never infer the
hidden text. Read the field names, values, types and validation details from
`assertion.actual` instead. If neither the response attachment nor
`assertion.actual` contains the missing detail, mark that detail as
`Не установлено по данным отчёта` in the relevant section.

Determine which layer actually failed before writing the report: the API
response, transport metadata, the Swagger/OpenAPI contract, or the test runtime
validator/schema. Explain the evidence chain rather than copying the matcher
message. In particular, when the matcher rejects a response property but the
matching Swagger/OpenAPI operation allows that property, state that the runtime
validation rule disagrees with the supplied contract and that this disagreement
caused the matcher failure. Do not mislabel the allowed property as an API
schema violation. Name a concrete library or construct such as Zod or
`strictObject()` only when it is present in the supplied context; otherwise use
the evidenced wording `runtime-схема проверки` or `валидатор теста`.

One report covers exactly one defect: the mismatch that caused the recorded
assertion. Omit every independent mismatch from this report. In particular, do
not mention a Content-Type disagreement in a report about a runtime validator
rejecting a contract-allowed field; create a separate report for that defect
instead.

`context.result.assertion.expected` is test evidence, not an API contract. Use
it only when it agrees with the matching Swagger/OpenAPI operation or an
explicit requirement.

Never ask the user for missing facts and never return `needs_input`. Always
generate the finished report from the available evidence. When a required fact
is absent, write `Не установлено по данным отчёта` in the relevant section. Do
not invent a value, add a separate missing-data list, or replace missing API
steps with instructions to run an automated test.

## Exact output structure

The finished report has one title followed by exactly these nine sections in
this order:

1. `# [API] ...` — the report title;
2. `**Окружение:**`;
3. `**Метод и эндпоинт:**`;
4. `**Предусловия:**`;
5. `**Шаги воспроизведения:**`;
6. `**Фактический результат:**`;
7. `**Ожидаемый результат:**`;
8. `**Дефект:**`;
9. `**Фактический ответ:**`;
10. `**Ожидаемый ответ:**`.

Do not add Priority, Severity, Swagger, contract violation, request, additional
information, analysis, caveats, or a missing-data list.

Use the formatting shown in the reference example exactly:

- the title is a level-one Markdown heading;
- every section label is bold and ends with a colon;
- for a short scalar value, put a Markdown hard line break (`\`) after the
  label and write the value on the next line;
- put a blank line between a label and a following list or fenced response;
- Preconditions use a bulleted list, Steps use a numbered list;
- Actual and expected raw responses use fenced `http` blocks.

## Field rules

### Title

Use `[API] <METHOD> <contract endpoint> <concrete mismatch>`. Name the observed
mismatch, including the relevant status, field, value, or type. Use the
parameterized contract path in the title, for example `{id}`, while concrete
test values belong in Preconditions and Steps.

### Окружение

Use the environment exactly as supplied, for example `DEV`, `STAGE`, or `PROD`.

### Метод и эндпоинт

Write `<METHOD> <contract endpoint>` using the parameterized Swagger/OpenAPI
path when available.

### Предусловия

List only state or data that must already exist and known authorization
conditions. Keep concrete identifiers that distinguish the scenario. Never
list the absence of an operation in Swagger/OpenAPI as a precondition. Never
put evidence-quality commentary here, such as saying that an absent header or
body was not confirmed by the recorded request; omit an unconfirmed condition
or state the evidence limitation only in the section whose conclusion it
affects.

### Шаги воспроизведения

Describe reproduction through the API, not through the test runner:

1. Send the request to the concrete URL, substituting known path parameters.
2. Add authorization or other required conditions when known.
3. Send the request.

Include request fields, query parameters, headers, or test data only when they
affect reproduction and their values or conditions are known. Never instruct
the reader to run a test file or inspect an assertion.

### Фактический и ожидаемый результат

`Фактический результат` contains only directly observed behavior: the concrete
HTTP status, response path and value, and the exact validator error. It never
cites Swagger/OpenAPI, explains the cause, or identifies the faulty layer. Use
at most two short sentences.

`Ожидаемый результат` contains only the concrete behavior required by the
matching Swagger/OpenAPI operation or an explicit requirement. For a runtime
validator mismatch, state which recorded field and type must be accepted and
that validation must succeed. Use at most two short sentences.

### Дефект

Compare the actual and expected results and explain exactly why they differ.
For a schema or matcher failure, state what the validator rejected, what the
matching contract permits or requires, why the disagreement caused the test to
fail, and which layer must be corrected. If a matcher rejects a contract-allowed
field, identify the runtime validation schema as the faulty layer and do not call
the API response invalid. Use at most three short sentences. Do not list every
occurrence, unrelated fields, or the complete response schema. Name only facts
from the current context.

For `context.contract.status: "no_match"`, keep the concrete value from
`context.result.assertion.actual` in `Фактический результат`. In
`Ожидаемый результат`, state that the operation is absent from the supplied
Swagger/OpenAPI specification and therefore Swagger/OpenAPI does not establish
an expected response for it, unless an explicit requirement supplies one.

### Фактический и ожидаемый ответ

Show the minimal raw HTTP response fragment that demonstrates the mismatch.
For a status-only defect, write the HTTP status line. Preserve an available
response body exactly; do not invent one. The expected response must contain
only facts established by Swagger/OpenAPI or explicit requirements. A required
property and its type do not establish its concrete value: never fill expected
JSON with `0`, an empty string, a placeholder, a schema example, or any other
guessed value. When the contract establishes only a status or schema rule, show
only the established status line; if no raw expected fragment is established,
write `Не установлено по данным отчёта`.
For a runtime-validator mismatch where the recorded API field is allowed by the
contract, show only the contract-established HTTP status line in
`Ожидаемый ответ`. Do not add an unrelated media type or repeat the response
schema: the expected validator correction belongs in `Ожидаемый результат`.
If
`context.contract.status` is `no_match` and no explicit requirement establishes
an expected response, write `Не установлено по данным отчёта` in the expected
response block.

## Reference example

# [API] GET /api/v1/applications/{id} возвращает 500 вместо 200 для существующей заявки

**Окружение:**\
DEV

**Метод и эндпоинт:**\
`GET /api/v1/applications/{id}`

**Предусловия:**

- В системе существует заявка с `id=12345`.
- Используется валидный токен авторизации.

**Шаги воспроизведения:**

1. Отправить GET-запрос на `/api/v1/applications/12345`.
2. Передать валидный токен авторизации.
3. Отправить запрос.

**Фактический результат:**\
API возвращает HTTP-статус `500 Internal Server Error`.

**Ожидаемый результат:**\
API должен вернуть HTTP-статус `200 OK` и данные существующей заявки с идентификатором `12345`.

**Дефект:**\
Вместо предусмотренного контрактом HTTP `200 OK` API возвращает HTTP `500 Internal Server Error`, поэтому успешное получение существующей заявки невозможно.

**Фактический ответ:**

```http
HTTP/1.1 500 Internal Server Error
```

**Ожидаемый ответ:**

```http
HTTP/1.1 200
```
