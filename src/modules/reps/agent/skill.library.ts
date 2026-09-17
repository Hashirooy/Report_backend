import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Which skill writes the document for a job kind.
 *
 * The choice belongs here rather than to the agent: the tool set is empty, so
 * nothing can pick a skill on its own. That makes the mapping deterministic — a
 * kind always gets the same instructions, whatever the user's request says. A
 * kind absent from this map keeps the generic role instructions.
 */
export const GENERATION_SKILL_BY_KIND: Record<string, string> = {
  analyze_test: 'api-bug-report',
};

/** Every skill that must be on disk. All of them load when the module boots. */
const REQUIRED_SKILLS: readonly string[] = [
  ...new Set(Object.values(GENERATION_SKILL_BY_KIND)),
];

/** A skill body shorter than this is a stub or a truncated file, not a skill. */
const MIN_SKILL_CHARS = 200;

/**
 * The instruction documents the generation stage writes to.
 *
 * They are ordinary Claude Code skills — `<root>/.claude/skills/<name>/SKILL.md`
 * — so the same file can be invoked by hand in an interactive session. The agent
 * is not asked to find them, though: they are read here and inlined into the
 * prompt.
 *
 * That is deliberate. A `/name` line only becomes a skill if the CLI discovers
 * it, and when discovery fails the line is sent on as ordinary text — the job
 * then succeeds, having written a document to no particular format, and nothing
 * in the result says the instructions were missing. Reading the file ourselves
 * turns that silent case into a boot failure.
 */
@Injectable()
export class SkillLibrary implements OnModuleInit {
  private readonly logger = new Logger(SkillLibrary.name);
  private readonly bodies = new Map<string, string>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const configured = this.config.getOrThrow<string>('reps.skillsRoot');
    const root = isAbsolute(configured) ? configured : resolve(process.cwd(), configured);

    for (const name of REQUIRED_SKILLS) {
      const path = join(root, '.claude', 'skills', name, 'SKILL.md');

      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch (error) {
        throw new Error(
          `agent skill "${name}" could not be read from ${path}: ${(error as Error).message}. ` +
            'Set REPS_SKILLS_ROOT to the directory holding .claude/skills, or ship that ' +
            'directory with the deployment.',
        );
      }

      const body = stripFrontmatter(raw).trim();
      if (body.length < MIN_SKILL_CHARS) {
        throw new Error(`agent skill "${name}" at ${path} has no usable body`);
      }

      this.bodies.set(name, body);
      this.logger.log(`loaded skill "${name}" (${body.length} chars) from ${path}`);
    }
  }

  /** The skill's instructions, or null when the kind has no skill. */
  forKind(kind: string): { name: string; body: string } | null {
    const name = GENERATION_SKILL_BY_KIND[kind];
    if (!name) return null;

    const body = this.bodies.get(name);
    // Unreachable once the module is up: onModuleInit loads every mapped name.
    if (!body) return null;

    return { name, body };
  }
}

/**
 * Drops the YAML frontmatter a SKILL.md carries. Its `name` and `description`
 * exist so an interactive session can offer the skill; the prompt already knows
 * which one it is asking for, so only the instructions below it are wanted.
 */
function stripFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text;

  const end = text.indexOf('\n---', 3);
  if (end === -1) return text;

  const afterFence = text.indexOf('\n', end + 1);
  return afterFence === -1 ? '' : text.slice(afterFence + 1);
}
