import { Injectable } from '@nestjs/common';
import type { RepsTaskType } from '../../../contracts/index.js';

import { AGENT_OUTPUT_FORMAT } from './agent-output.contract.js';
import { SkillLibrary } from './skill.library.js';

/**
 * Everything a task is given.
 *
 * The agent must use only this handoff: whatever is not here must not influence
 * the answer. It is stored verbatim on the task row, so a finished job can be
 * read back and it is always clear what
 * the agent actually had in front of it.
 */
export interface TaskHandoff {
  jobId: string;
  taskId: string;
  type: RepsTaskType;
  attempt: number;
  kind: string;
  userRequest: string;
  /** Source data as JSON, or null when the request stands alone. */
  context: string | null;
  contextDigest: string;
  /** Name the produced document should carry. */
  documentName: string;
  /** The document under review. Only set for a `validate` task. */
  documentUnderReview: { name: string; mediaType: string; content: string } | null;
  /** What the previous review objected to. Empty on a first attempt. */
  validatorFeedback: { id: string; message: string }[];
  /** Questions the agent asked earlier, with the user's answers. */
  answers: { id: string; question: string; answer: string }[];
}

/**
 * What the review stage additionally demands of a document a skill wrote.
 *
 * Without this the reviewer judges only whether claims are supported, so a bug
 * report missing its reproduction steps would pass: nothing in it is false. The
 * skill's structure is the contract, and the reviewer has to hold it to that.
 */
const REVIEW_CHECKLISTS: Record<string, string[]> = {
  analyze_test: [
    'The document is a bug report in the structure the api-bug-report skill above defines.',
    'The document starts with one level-one heading and contains exactly nine labelled sections in this order: ' +
      'Окружение, Метод и эндпоинт, Предусловия, Шаги воспроизведения, Фактический результат, ' +
      'Ожидаемый результат, Дефект, Фактический ответ, Ожидаемый ответ. Any other section, preamble, ' +
      'analysis or missing-data list is a defect.',
    'The heading starts with `[API]`, includes the method and parameterized contract endpoint, ' +
      'and names the concrete mismatch.',
    'Окружение and Метод и эндпоинт contain the concrete values established by the context.',
    'Предусловия contain the known state and authorization conditions required before reproduction.',
    'Предусловия never contain evidence-quality analysis such as saying that an absent header, body or operation ' +
      'was not confirmed by the recorded request. An unconfirmed condition is omitted or its limitation is stated ' +
      'only in the section whose conclusion it affects.',
    'An unmatched Swagger/OpenAPI operation is contract evidence, not a precondition. When ' +
      'context.contract.status is "no_match", Ожидаемый результат explicitly states that the observed operation ' +
      'is absent from the supplied specification and that Swagger/OpenAPI therefore does not establish its expected ' +
      'response, unless an explicit requirement does. Фактический результат still reports the concrete observed behavior.',
    'Шаги воспроизведения reproduce the issue by sending the API request with the known triggering condition. ' +
      'They never instruct the reader to run a test file or inspect an assertion.',
    'For a response-schema defect in an explicitly successful/valid test scenario, Шаги воспроизведения may say that ' +
      'all required request fields are correctly filled according to Swagger; exact payload values are not required ' +
      'unless a value triggers the defect.',
    'When context.contract.status is "matched", Ожидаемый результат gives a concrete status, field, type, value or ' +
      'constraint supported by that operation and the test scenario. For "no_match", apply the unmatched-operation ' +
      'rule above instead. Vague schema-validation wording is a defect.',
    'Фактический результат gives the concrete observed API status, field, type, value or complete error from the recorded ' +
      'response. A bare assertion failure or a truncated unknown key is not a concrete actual result.',
    'Фактический результат contains only directly observed behavior in at most two short sentences: the API status, ' +
      'concrete response value and exact validator error. It never cites Swagger, explains the cause or names the defect.',
    'Ожидаемый результат contains only the behavior required by the matching contract or explicit requirement in at ' +
      'most two short sentences. It never repeats the actual result or explains why the difference is a defect.',
    'Дефект compares Фактический результат with Ожидаемый результат in at most three short sentences. For a schema or ' +
      'matcher failure it says what the validator rejected, what Swagger/OpenAPI permits or requires, why the disagreement ' +
      'made the test fail, and which layer must be corrected. When a matcher rejects a contract-allowed field, Дефект ' +
      'identifies the runtime validation schema as the failing layer and does not call the API response invalid. Name Zod, ' +
      'strictObject or another implementation detail only when the supplied context contains that evidence. Do not list ' +
      'every occurrence, unrelated field, or the complete response schema.',
    'One report covers exactly one primary defect: the mismatch that caused the recorded assertion. Omit independent ' +
      'mismatches completely. In particular, do not mention a Content-Type disagreement in a report about a runtime ' +
      'validator rejecting a contract-allowed field; that requires a separate report.',
    'Фактический ответ and Ожидаемый ответ are fenced http blocks containing the minimal raw response fragments ' +
      'that demonstrate the mismatch, without invented body content. When no matching operation or explicit ' +
      'requirement establishes an expected response, Ожидаемый ответ contains `Не установлено по данным отчёта`.',
    'For a runtime-validator mismatch where the recorded API field is allowed by the contract, Ожидаемый ответ contains ' +
      'only the contract-established HTTP status line. Do not add an unrelated media type or repeat the response schema; ' +
      'the expected correction belongs to the runtime validator and is stated in Дефект.',
    'A required response property and its integer/string/object type do not establish a concrete value. ' +
      'Ожидаемый ответ never fills such a property with 0, an empty string, a placeholder, an example or another ' +
      'guessed value; it uses only an established status line or `Не установлено по данным отчёта`.',
    'An attachment marked contentAvailable=false, empty=true, or with unavailableReason is not evidence of the ' +
      'HTTP content. In particular, a zero-byte attachment is not proof that the request or response body was empty.',
    'When context.result.assertion.actual is present, it takes precedence over context.result.message for detailed ' +
      'matcher failures. Фактический результат uses its field names, values, types and validation details instead of ' +
      'quoting an ellipsis, a truncated fragment, or asking for information already present there.',
    'context.bugReportEvidence is the prepared join of the recorded exchange, assertion and matching contract. ' +
      'For Фактический ответ, copy response.exactHttpFragment verbatim and report only response.primaryMismatch. ' +
      'The fragment was rendered from one complete value at one source path. Do not add another mismatchGroups item, ' +
      'wrap the value in a reconstructed parent object or array, remove fields, reorder fields, or use ellipses.',
    'A request whose context.bugReportEvidence.request.contentAvailable is false has no recorded concrete payload. ' +
      'contentAvailable, unavailableReason and attachment availability are control metadata: never mention them in ' +
      'the document, especially not in Предусловия or Шаги воспроизведения. For a successful schema scenario, use ' +
      'the required request conditions from contractRule without inventing values.',
    'context.result.assertion.expected is used as expected API behavior only when it agrees with the matching ' +
      'Swagger operation or an explicit requirement.',
    'Every factual value is supported by the request, response, matching contract or explicit user input.',
    'Missing evidence must never cause a question or block the report. The document explicitly marks an unknown ' +
      'value as `Не установлено по данным отчёта` in the relevant section and does not invent it.',
    'The report is written in Russian; API identifiers, codes and HTTP response fragments remain unchanged.',
  ],
};

const ROLE_INSTRUCTIONS: Record<RepsTaskType, string> = {
  generate: [
    'You are the generation stage of a Reps job.',
    '',
    'Write the requested document and return it after the document marker — you',
    'must not use tools, the filesystem or network; the text of the document is',
    'the answer itself. Base it only on the context and the user request:',
    'anything not given to you there is something you do not know. Prefer naming',
    'concrete tests, error groups and numbers over general advice.',
    '',
    'Never ask the user questions and never return status "needs_input". Always',
    'return the best complete document possible from the available evidence. If a',
    'required fact is unavailable, state that it is not established by the supplied',
    'data in the relevant document section instead of guessing or blocking.',
  ].join('\n'),

  validate: [
    'You are the review stage of a Reps job.',
    '',
    'The document produced by the previous stage is included in the message. Judge',
    'it against the user request and the context: does it answer what was asked,',
    'does every test name, error group and number it cites actually appear in the',
    'context, and does it draw any conclusion the data does not support?',
    '',
    'Return status "approved" when it is fit to hand back, with no document.',
    'Return "rejected" with one finding per defect, each naming what is wrong and',
    'what would fix it. Do not rewrite the document yourself — the next',
    'generation attempt does that. Style preferences are not defects; reject on',
    'substance.',
  ].join('\n'),
};

/**
 * A task's prompt in two parts. `system` carries shared role instructions
 * through the selected CLI's instruction mechanism. `prompt` carries the job's
 * data and goes in over stdin.
 */
export interface BuiltPrompt {
  system: string;
  prompt: string;
}

@Injectable()
export class PromptBuilder {
  constructor(private readonly skills: SkillLibrary) {}

  build(handoff: TaskHandoff): BuiltPrompt {
    return { system: this.system(handoff), prompt: this.message(handoff) };
  }

  private system(handoff: TaskHandoff): string {
    const skill = this.skills.forKind(handoff.kind);

    const sections: string[] = [ROLE_INSTRUCTIONS[handoff.type], ''];

    // The reviewer gets the same skill the writer followed. Judged against a
    // checklist alone it rejects what the skill explicitly allows — optional
    // sections, a section omitted for lack of data — and the writer, bound to
    // the skill, cannot satisfy it on any attempt.
    if (skill && handoff.type === 'validate') {
      sections.push(
        `The document was written following the "${skill.name}" skill:`,
        '--- begin skill ---',
        skill.body,
        '--- end skill ---',
        '',
        'Judge the document by that skill. What it allows or makes conditional is not',
        'a defect, and a finding must not ask for something the skill forbids.',
        '',
      );
    }

    if (skill && handoff.type === 'generate') {
      sections.push(
        `Instructions for the document itself, from the "${skill.name}" skill:`,
        '--- begin skill ---',
        skill.body,
        '--- end skill ---',
        '',
        // The skill is written for a person reading a chat reply, where the
        // report is the whole answer. Here the report is the part after the
        // document marker. Everything else the skill says still holds, and it
        // is the authority on what the document contains.
        'That skill defines the document you are writing: its structure, its rules',
        'about invented values, and what it refuses to assert. Follow it. Where it',
        "says to return only the finished report, that governs the document's",
        'content — the report is the whole of it, with no preamble — and not the',
        'shape of your answer, which is still the format below.',
        '',
      );
    }

    const checklist = handoff.type === 'validate' ? REVIEW_CHECKLISTS[handoff.kind] : undefined;
    if (checklist) {
      sections.push(
        'This document was written to a fixed format. A document that fails any',
        'of these is defective regardless of whether its claims are true:',
        ...checklist.map((item) => `- ${item}`),
        '',
      );
    }

    sections.push(AGENT_OUTPUT_FORMAT);
    return sections.join('\n');
  }

  private message(handoff: TaskHandoff): string {
    const sections: string[] = [
      'Request:',
      handoff.userRequest,
      '',
      'Context:',
      handoff.contextDigest,
    ];

    if (handoff.context) {
      sections.push('', '```json', handoff.context, '```');
    }

    if (handoff.answers.length) {
      sections.push(
        '',
        'The user answered your earlier questions. Treat these as given:',
        ...handoff.answers.map((entry) => `- ${entry.question}\n  → ${entry.answer}`),
      );
    }

    if (handoff.documentUnderReview) {
      sections.push(
        '',
        `Document under review (${handoff.documentUnderReview.name}, ` +
          `${handoff.documentUnderReview.mediaType}):`,
        '--- begin document ---',
        handoff.documentUnderReview.content,
        '--- end document ---',
      );
    }

    if (handoff.validatorFeedback.length) {
      sections.push(
        '',
        `This is attempt ${handoff.attempt}. The review rejected the previous version.`,
        'Fix exactly these findings and change nothing else:',
        ...handoff.validatorFeedback.map((finding) => `- [${finding.id}] ${finding.message}`),
      );
    }

    return sections.join('\n');
  }
}
