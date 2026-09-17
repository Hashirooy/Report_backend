import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type RepsArtifact,
  type RepsEvent,
  type RepsJob,
  type RepsJobStatus,
  type RepsQuestion,
  type RepsTask,
  type RepsTaskType,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';
import type { ListRepsJobsQueryDto } from './dto/list-reps-jobs.query.dto.js';

/**
 * A job with everything the detail endpoint shows. Artifact bodies are left
 * out: the detail is polled every couple of seconds, and the document is
 * fetched once by its own endpoint.
 */
export type RepsJobWithChildren = RepsJob & {
  tasks: RepsTask[];
  questions: RepsQuestion[];
  artifacts: Omit<RepsArtifact, 'content'>[];
};

export type RepsJobWithCounts = RepsJob & { _count: { questions: number } };

/**
 * What the caller is allowed to see. `projectIds: null` means no restriction,
 * which is what administrators get.
 */
export interface RepsVisibility {
  projectIds: bigint[] | null;
  userId: bigint;
}

@Injectable()
export class RepsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- API side

  create(data: {
    kind: string;
    userRequest: string;
    projectId: bigint | null;
    runId: bigint | null;
    resultId: bigint | null;
    createdByUserId: bigint;
    maxAttemptsPerStage: number;
  }): Promise<RepsJob> {
    return this.prisma.repsJob.create({ data });
  }

  findJob(id: bigint): Promise<RepsJob | null> {
    return this.prisma.repsJob.findUnique({ where: { id } });
  }

  findJobWithChildren(id: bigint): Promise<RepsJobWithChildren | null> {
    return this.prisma.repsJob.findUnique({
      where: { id },
      include: {
        tasks: { orderBy: [{ orderNum: 'asc' }, { id: 'asc' }] },
        questions: { orderBy: { askedAt: 'asc' } },
        artifacts: { orderBy: { createdAt: 'asc' }, omit: { content: true } },
      },
    });
  }

  /** Unanswered questions per job, for the list badge. */
  findMany(
    query: ListRepsJobsQueryDto,
    visibility: RepsVisibility,
  ): Promise<RepsJobWithCounts[]> {
    return this.prisma.repsJob.findMany({
      where: this.whereOf(query, visibility),
      orderBy: { id: 'desc' },
      skip: query.offset,
      take: query.limit,
      include: { _count: { select: { questions: { where: { answer: null } } } } },
    });
  }

  count(query: ListRepsJobsQueryDto, visibility: RepsVisibility): Promise<number> {
    return this.prisma.repsJob.count({ where: this.whereOf(query, visibility) });
  }

  countOpenQuestions(jobId: bigint): Promise<number> {
    return this.prisma.repsQuestion.count({ where: { jobId, answer: null } });
  }

  /** `after` is the last event id the caller already has. */
  findEvents(jobId: bigint, after: bigint | null, limit: number): Promise<RepsEvent[]> {
    return this.prisma.repsEvent.findMany({
      where: { jobId, ...(after === null ? {} : { id: { gt: after } }) },
      orderBy: { id: 'asc' },
      take: limit,
    });
  }

  /** The document the review stage is asked to judge, body included. */
  findLatestArtifact(jobId: bigint): Promise<RepsArtifact | null> {
    return this.prisma.repsArtifact.findFirst({ where: { jobId }, orderBy: { id: 'desc' } });
  }

  findArtifact(jobId: bigint, artifactId: bigint): Promise<RepsArtifact | null> {
    return this.prisma.repsArtifact
      .findUnique({ where: { id: artifactId } })
      .then((row) => (row && row.jobId === jobId ? row : null));
  }

  /**
   * Records answers and hands the job back to the queue in one transaction, so
   * a job can never be requeued with half its answers stored.
   */
  async answerAndReopen(
    jobId: bigint,
    answers: { questionId: bigint; answer: string }[],
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      let updated = 0;

      for (const { questionId, answer } of answers) {
        const result = await tx.repsQuestion.updateMany({
          where: { id: questionId, jobId, answer: null },
          data: { answer, answeredAt: now },
        });
        updated += result.count;
      }

      const remaining = await tx.repsQuestion.count({ where: { jobId, answer: null } });
      if (remaining === 0) {
        await tx.repsJob.update({ where: { id: jobId }, data: { status: 'pending' } });
        await tx.repsTask.updateMany({
          where: { jobId, status: 'waiting_for_user' },
          data: { status: 'pending' },
        });
      }

      return updated;
    });
  }

  requestCancel(jobId: bigint): Promise<number> {
    return this.prisma.repsJob
      .updateMany({
        where: { id: jobId, status: { in: ['pending', 'running', 'waiting_for_user'] } },
        data: { cancelRequested: true },
      })
      .then((result) => result.count);
  }

  // ------------------------------------------------------------- worker side

  /**
   * Takes the job only if it is still waiting to run. `updateMany` makes this a
   * conditional write, so two workers handed the same message cannot both
   * proceed.
   */
  async claim(jobId: bigint): Promise<boolean> {
    const claimed = await this.prisma.repsJob.updateMany({
      where: { id: jobId, status: 'pending' },
      data: { status: 'running', heartbeatAt: new Date() },
    });
    if (claimed.count === 0) return false;

    await this.prisma.repsJob.updateMany({
      where: { id: jobId, startedAt: null },
      data: { startedAt: new Date() },
    });
    return true;
  }

  updateJob(jobId: bigint, data: Prisma.RepsJobUpdateInput): Promise<RepsJob> {
    return this.prisma.repsJob.update({ where: { id: jobId }, data });
  }

  finishJob(
    jobId: bigint,
    status: Extract<RepsJobStatus, 'succeeded' | 'failed' | 'cancelled'>,
    data: { error?: string | null; summary?: string | null; costUsd?: number | null },
  ): Promise<RepsJob> {
    return this.prisma.repsJob.update({
      where: { id: jobId },
      data: {
        status,
        finishedAt: new Date(),
        error: data.error ?? null,
        ...(data.summary === undefined ? {} : { summary: data.summary }),
        ...(data.costUsd === undefined || data.costUsd === null
          ? {}
          : { costUsd: new Prisma.Decimal(data.costUsd) }),
      },
    });
  }

  /** Adds to the job's total rather than replacing it: tasks each cost money. */
  addCost(jobId: bigint, costUsd: number): Promise<unknown> {
    return this.prisma.$executeRaw`
      UPDATE reps_jobs
         SET cost_usd = COALESCE(cost_usd, 0) + ${new Prisma.Decimal(costUsd)}::decimal
       WHERE id = ${jobId}
    `;
  }

  createTask(data: {
    jobId: bigint;
    type: RepsTaskType;
    orderNum: number;
    attempt: number;
    dependsOn: bigint[];
    input: Prisma.InputJsonValue;
  }): Promise<RepsTask> {
    return this.prisma.repsTask.create({ data });
  }

  /**
   * Called when a stage is retried: the rest of the current branch is dead, and
   * leaving it pending would strand tasks whose dependency can never succeed.
   */
  cancelPendingTasks(jobId: bigint): Promise<number> {
    return this.prisma.repsTask
      .updateMany({
        where: { jobId, status: 'pending' },
        data: { status: 'cancelled', finishedAt: new Date() },
      })
      .then((result) => result.count);
  }

  findTasks(jobId: bigint): Promise<RepsTask[]> {
    return this.prisma.repsTask.findMany({
      where: { jobId },
      orderBy: [{ orderNum: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * The handoff is rewritten here rather than at planning time: fresh context
   * and any answers that arrived meanwhile are folded in just before the run,
   * and the row is meant to hold what the agent actually saw.
   */
  startTask(taskId: bigint, input: Prisma.InputJsonValue): Promise<RepsTask> {
    return this.prisma.repsTask.update({
      where: { id: taskId },
      data: { status: 'running', input, startedAt: new Date(), heartbeatAt: new Date() },
    });
  }

  finishTask(
    taskId: bigint,
    data: {
      status: 'succeeded' | 'failed' | 'cancelled' | 'waiting_for_user';
      output?: Prisma.InputJsonValue;
      error?: string | null;
      sessionId?: string | null;
    },
  ): Promise<RepsTask> {
    return this.prisma.repsTask.update({
      where: { id: taskId },
      data: {
        status: data.status,
        finishedAt: new Date(),
        error: data.error ?? null,
        ...(data.output === undefined ? {} : { output: data.output }),
        ...(data.sessionId ? { sessionId: data.sessionId } : {}),
      },
    });
  }

  appendEvent(data: {
    jobId: bigint;
    taskId: bigint | null;
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    data?: Prisma.InputJsonValue;
  }): Promise<RepsEvent> {
    return this.prisma.repsEvent.create({
      data: {
        jobId: data.jobId,
        taskId: data.taskId,
        level: data.level,
        message: data.message,
        ...(data.data === undefined ? {} : { data: data.data }),
      },
    });
  }

  /**
   * Proof of life for a running task, and the read that carries the cancel flag
   * back from the API process — the job may have been started by a different
   * one, so an in-memory signal would never reach here.
   */
  async touchHeartbeat(jobId: bigint, taskId: bigint | null): Promise<boolean> {
    const now = new Date();
    const job = await this.prisma.repsJob.update({
      where: { id: jobId },
      data: { heartbeatAt: now },
      select: { cancelRequested: true },
    });
    if (taskId !== null) {
      await this.prisma.repsTask.update({ where: { id: taskId }, data: { heartbeatAt: now } });
    }
    return job.cancelRequested;
  }

  saveQuestions(
    jobId: bigint,
    taskId: bigint,
    questions: { externalId: string; text: string }[],
  ): Promise<unknown> {
    return this.prisma.repsQuestion.createMany({
      data: questions.map((question) => ({ jobId, taskId, ...question })),
    });
  }

  findAnswers(jobId: bigint): Promise<RepsQuestion[]> {
    return this.prisma.repsQuestion.findMany({
      where: { jobId, answer: { not: null } },
      orderBy: { askedAt: 'asc' },
    });
  }

  /**
   * Artifacts are keyed by name, so a second attempt that returns the same
   * document replaces the body instead of leaving the superseded version behind
   * under a second id.
   */
  async saveArtifacts(
    jobId: bigint,
    taskId: bigint,
    documents: { name: string; mediaType: string; content: string; sizeBytes: number }[],
  ): Promise<void> {
    for (const file of documents) {
      await this.prisma.repsArtifact.upsert({
        where: { jobId_name: { jobId, name: file.name } },
        create: { jobId, taskId, ...file },
        update: {
          taskId,
          mediaType: file.mediaType,
          content: file.content,
          sizeBytes: file.sizeBytes,
        },
      });
    }
  }

  /**
   * A job anchored to a project is visible to that project's members. A job
   * anchored to nothing has no project to derive access from, so it stays with
   * the person who asked for it.
   */
  private whereOf(
    query: ListRepsJobsQueryDto,
    visibility: RepsVisibility,
  ): Prisma.RepsJobWhereInput {
    const filters: Prisma.RepsJobWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.projectId ? { projectId: BigInt(query.projectId) } : {}),
      ...(query.runId ? { runId: BigInt(query.runId) } : {}),
      ...(query.resultId ? { resultId: BigInt(query.resultId) } : {}),
    };

    if (visibility.projectIds === null) return filters;

    return {
      ...filters,
      OR: [
        { projectId: { in: visibility.projectIds } },
        { projectId: null, createdByUserId: visibility.userId },
      ],
    };
  }
}
