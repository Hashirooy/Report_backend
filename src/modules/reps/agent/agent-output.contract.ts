import { z } from 'zod';

/**
 * What every Reps task must end with.
 *
 * The agent answers in plain text (see AGENT_OUTPUT_FORMAT) rather than a JSON
 * object: a document escaped into a JSON string is slower to produce, and the
 * CLI's --json-schema mode costs an extra tool turn per task. The text is turned
 * into the object below by parseAgentOutput, and the Zod parse is still the one
 * that decides whether a task is accepted.
 */

/**
 * A document, body and all. The agent has no filesystem — it returns what it
 * wrote here, and the orchestrator stores it.
 */
export const AgentDocumentSchema = z.object({
  /** A file name for the download, not a path. Directories are not accepted. */
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^/\\:*?"<>|]+$/, 'name must be a plain file name'),
  mediaType: z.string().min(1).max(200),
  content: z.string().min(1),
});

export const AgentQuestionSchema = z.object({
  /** The agent's own id, echoed back beside the answer on the next attempt. */
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(2_000),
});

export const AgentFindingSchema = z.object({
  id: z.string().min(1).max(64),
  message: z.string().min(1).max(2_000),
});

/**
 * `status` is what the agent claims; the orchestrator decides what happens.
 *
 * - `generated` — a generator finished a document.
 * - `approved` / `rejected` — a reviewer's verdict; `rejected` must carry findings.
 * - `needs_input` — the agent cannot continue without answers; must carry questions.
 */
export const AgentOutputSchema = z.object({
  status: z.enum(['generated', 'approved', 'rejected', 'needs_input']),
  documents: z.array(AgentDocumentSchema).max(10).default([]),
  questions: z.array(AgentQuestionSchema).max(20).default([]),
  findings: z.array(AgentFindingSchema).max(50).default([]),
  summary: z.string().min(1).max(4_000),
});
export type AgentOutput = z.infer<typeof AgentOutputSchema>;

const DOCUMENT_MARKER = '=== DOCUMENT ===';

/** The answer format, as the agent is told it. Kept beside the parser below. */
export const AGENT_OUTPUT_FORMAT = [
  'Answer format — plain text, no JSON, no code fence around the whole answer:',
  '',
  'STATUS: <generated | approved | rejected | needs_input>',
  'SUMMARY: <one line saying what you did or decided>',
  'FINDING [<id>]: <what is wrong and what would fix it>   (one line per defect, only when rejected)',
  'QUESTION [<id>]: <a specific question>                  (one line per question, only when needs_input)',
  DOCUMENT_MARKER,
  '<the full document in markdown, only when generated>',
  '',
  `Everything after the "${DOCUMENT_MARKER}" line is the document, verbatim, to the`,
  'end of the answer. Omit that line entirely when there is no document.',
].join('\n');

const STATUS_LINE = /^STATUS:\s*(\S+)/i;
const SUMMARY_LINE = /^SUMMARY:\s*(.+)$/i;
const FINDING_LINE = /^FINDING\s*\[([^\]]+)\]\s*:\s*(.+)$/i;
const QUESTION_LINE = /^QUESTION\s*\[([^\]]+)\]\s*:\s*(.+)$/i;

/**
 * Turns the agent's text answer into the shape AgentOutputSchema checks. It
 * does not validate: a missing status or summary is left missing, so the Zod
 * parse reports it the same way it reports any other malformed answer.
 */
export function parseAgentOutput(text: unknown, documentName: string): unknown {
  if (typeof text !== 'string') return text;

  const markerAt = text.indexOf(DOCUMENT_MARKER);
  const head = markerAt === -1 ? text : text.slice(0, markerAt);
  const body = markerAt === -1 ? '' : stripOuterFence(text.slice(markerAt + DOCUMENT_MARKER.length));

  const output: {
    status?: string;
    summary?: string;
    findings: { id: string; message: string }[];
    questions: { id: string; text: string }[];
    documents: { name: string; mediaType: string; content: string }[];
  } = { findings: [], questions: [], documents: [] };

  // Lines are matched wherever they sit, so a sentence of preamble before
  // STATUS does not sink an otherwise good answer.
  for (const raw of head.split(/\r?\n/)) {
    const line = raw.trim();
    let match: RegExpExecArray | null;
    if ((match = STATUS_LINE.exec(line))) output.status ??= match[1].toLowerCase();
    else if ((match = SUMMARY_LINE.exec(line))) output.summary ??= match[1].trim();
    else if ((match = FINDING_LINE.exec(line)))
      output.findings.push({ id: match[1].trim(), message: match[2].trim() });
    else if ((match = QUESTION_LINE.exec(line)))
      output.questions.push({ id: match[1].trim(), text: match[2].trim() });
  }

  if (body) {
    output.documents.push({ name: documentName, mediaType: 'text/markdown', content: body });
  }
  return output;
}

/** Drops a ```markdown fence the model sometimes wraps the whole document in. */
function stripOuterFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:markdown|md)?\r?\n([\s\S]*)\r?\n```$/i.exec(trimmed);
  // A document that merely starts and ends with its own code blocks is left
  // alone: an inner fence means the outer pair is not a wrapper.
  return (fenced && !fenced[1].includes('```') ? fenced[1] : trimmed).trim();
}
