import { Injectable } from '@nestjs/common';
import type { RepsTaskType } from '../../../contracts/index.js';

import { AGENT_OUTPUT_FORMAT } from './agent-output.contract.js';
import { SkillLibrary } from './skill.library.js';

/**
 * Everything a task is given.
 *
 * The agent has no tools, so this is literally all it knows: whatever is not
 * here does not exist as far as the task is concerned. It is stored verbatim on
 * the task row, so a finished job can be read back and it is always clear what
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
    'Required sections are present, labelled and ordered as in the Reference Example: Заголовок, ' +
      'Окружение, Эндпоинт, Предусловия, Шаги воспроизведения, Ожидаемый результат, ' +
      'Фактический результат, Swagger, Severity, Priority.',
    'Нарушение контракта sits between Swagger and Severity when a contract was available ' +
      '(context.contract.status "matched", or a contract in the request); otherwise its absence is correct.',
    'Запрос, Ответ and Дополнительная информация are optional sections the skill allows; their ' +
      'presence is not a defect as long as they hold only data from the context.',
    'Заголовок starts with `[API]` and names the concrete failure; it carries METHOD and endpoint ' +
      'when they are known, and omits them (never "Не указано") when they are not.',
    'Шаги воспроизведения are numbered, concrete, and derived from the context.',
    'Ожидаемый and Фактический результат are both present and distinguishable.',
    'The report is written in Russian; only identifiers, codes, JSON and Severity/Priority values stay untranslated.',
    'Swagger and Нарушение контракта come only from context.contract (or a contract in the request); ' +
      'no response code or schema is cited that is not there.',
    'Missing data is marked "Не указано"; for Severity and Priority ' +
      '"Недостаточно данных для определения" is equally correct.',
    'No root cause is asserted where the context only supports a possible cause.',
  ],
};

const ROLE_INSTRUCTIONS: Record<RepsTaskType, string> = {
  generate: [
    'You are the generation stage of a Reps job.',
    '',
    'Write the requested document and return it after the document marker — you',
    'have no tools, no filesystem and no network, so the text of the document is',
    'the answer itself. Base it only on the context and the user request:',
    'anything not given to you there is something you do not know. Prefer naming',
    'concrete tests, error groups and numbers over general advice.',
    '',
    'If the context genuinely does not let you answer, do not guess: return',
    'status "needs_input" with specific questions and no document.',
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
 * A task's prompt in two parts. `system` replaces Claude Code's own system
 * prompt — the coding-assistant instructions are dead weight for a task with no
 * tools — and holds only what is the same for every job of a kind. `prompt`
 * carries the job's data and goes in over stdin.
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
