import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  RepsArtifact as RepsArtifactRow,
  RepsEvent as RepsEventRow,
  RepsJob,
  RepsQuestion as RepsQuestionRow,
  RepsTask as RepsTaskRow,
} from '@prisma/client';
import type {
  RepsArtifact,
  RepsEvent,
  RepsEventPage,
  RepsJobAccepted,
  RepsJobDetail,
  RepsJobKind,
  RepsJobListItem,
  RepsQuestion,
  RepsTask,
} from '../../contracts/index.js';

import type { UserPrincipal } from '../../common/auth/principal.js';
import { idOf, isoOf, nullableIdOf } from '../../common/utils/serialization.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { QueueService } from '../../queue/queue.service.js';
import { ProjectAccessService } from '../projects/project-access.service.js';
import type { CreateRepsJobDto } from './dto/create-reps-job.dto.js';
import type {
  ListRepsEventsQueryDto,
  ListRepsJobsQueryDto,
} from './dto/list-reps-jobs.query.dto.js';
import type { ResumeRepsJobDto } from './dto/resume-reps-job.dto.js';
import type { RepsJobWithChildren, RepsVisibility } from './reps.repository.js';
import { RepsRepository } from './reps.repository.js';

export interface PaginatedRepsJobs {
  items: RepsJobListItem[];
  pagination: { limit: number; offset: number; total: number };
}

export interface ArtifactDownload {
  content: string;
  mediaType: string;
  filename: string;
}

@Injectable()
export class RepsService {
  private readonly logger = new Logger(RepsService.name);

  constructor(
    private readonly repo: RepsRepository,
    private readonly queue: QueueService,
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
  ) {}

  /**
   * Stores the job and hands it to the worker. The request ends here: the agent
   * takes minutes, and nothing about it belongs on an HTTP connection.
   */
  async create(dto: CreateRepsJobDto, actor: UserPrincipal): Promise<RepsJobAccepted> {
    const { projectId, runId, resultId } = await this.resolveTarget(dto);

    // A job spends money against a project's data, so it takes the same role as
    // any other write there. A job anchored to nothing is nobody else's cost.
    if (projectId !== null) {
      await this.access.assertProjectId(actor, projectId, 'maintainer');
    }

    const job = await this.repo.create({
      kind: dto.kind,
      userRequest: dto.userRequest,
      projectId,
      runId,
      resultId,
      createdByUserId: actor.userId,
      maxAttemptsPerStage: dto.maxAttemptsPerStage ?? 3,
    });

    await this.repo.appendEvent({
      jobId: job.id,
      taskId: null,
      level: 'info',
      message: 'job accepted',
      data: { kind: dto.kind },
    });

    await this.queue.enqueueRepsJob({ jobId: job.id.toString() });
    this.logger.log(`job ${job.id} queued (${dto.kind})`);

    return { jobId: idOf(job.id), status: 'pending' };
  }

  async list(query: ListRepsJobsQueryDto, actor: UserPrincipal): Promise<PaginatedRepsJobs> {
    const visibility = await this.visibilityFor(actor);
    const [rows, total] = await Promise.all([
      this.repo.findMany(query, visibility),
      this.repo.count(query, visibility),
    ]);
    return {
      items: rows.map((row) => this.toListItem(row, row._count.questions)),
      pagination: { limit: query.limit, offset: query.offset, total },
    };
  }

  async findOne(jobRef: string, actor: UserPrincipal): Promise<RepsJobDetail> {
    const job = await this.repo.findJobWithChildren(this.parseId(jobRef));
    if (!job) throw new NotFoundException(`reps job "${jobRef}" not found`);
    await this.assertVisible(job, actor, jobRef);
    return this.toDetail(job);
  }

  async events(
    jobRef: string,
    query: ListRepsEventsQueryDto,
    actor: UserPrincipal,
  ): Promise<RepsEventPage> {
    const jobId = await this.requireJobId(jobRef, actor);
    const rows = await this.repo.findEvents(
      jobId,
      query.after === undefined ? null : BigInt(query.after),
      query.limit,
    );

    return {
      items: rows.map((row) => this.toEvent(row)),
      cursor: rows.length ? idOf(rows[rows.length - 1].id) : (query.after ?? null),
    };
  }

  /**
   * Answers the agent's questions and puts the job back in the queue. The CLI
   * is not held open while the user thinks — the parked task keeps its session
   * id and picks the conversation back up on the next process.
   */
  async resume(
    jobRef: string,
    dto: ResumeRepsJobDto,
    actor: UserPrincipal,
  ): Promise<RepsJobDetail> {
    const jobId = this.parseId(jobRef);
    const job = await this.repo.findJob(jobId);
    if (!job) throw new NotFoundException(`reps job "${jobRef}" not found`);
    await this.assertVisible(job, actor, jobRef);
    if (job.status !== 'waiting_for_user') {
      throw new ConflictException(`job ${jobRef} is ${job.status}, not waiting for answers`);
    }

    const updated = await this.repo.answerAndReopen(
      jobId,
      dto.answers.map((answer) => ({
        questionId: BigInt(answer.questionId),
        answer: answer.answer,
      })),
    );
    if (updated === 0) {
      throw new BadRequestException('none of these questions are open on this job');
    }

    const remaining = await this.repo.countOpenQuestions(jobId);
    if (remaining === 0) {
      await this.repo.appendEvent({
        jobId,
        taskId: null,
        level: 'info',
        message: `answers received (${updated}); resuming`,
      });
      await this.queue.enqueueRepsJob({ jobId: jobId.toString() });
    }

    return this.findOne(jobRef, actor);
  }

  /**
   * Cancellation has to work across processes, so it is a flag the running
   * worker polls. A parked job has no worker to notice, so it is ended here.
   */
  async terminate(jobRef: string, actor: UserPrincipal): Promise<RepsJobDetail> {
    const jobId = this.parseId(jobRef);
    const job = await this.repo.findJob(jobId);
    if (!job) throw new NotFoundException(`reps job "${jobRef}" not found`);
    await this.assertVisible(job, actor, jobRef);

    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      throw new ConflictException(`job ${jobRef} already finished as ${job.status}`);
    }

    await this.repo.requestCancel(jobId);
    await this.repo.appendEvent({
      jobId,
      taskId: null,
      level: 'warn',
      message: 'cancellation requested',
    });

    if (job.status === 'waiting_for_user') {
      await this.repo.finishJob(jobId, 'cancelled', { error: null });
    }

    return this.findOne(jobRef, actor);
  }

  /**
   * Served out of the database, where the agent's answer put it. Nothing about
   * the download depends on the worker that produced it still being around.
   */
  async openArtifact(
    jobRef: string,
    artifactRef: string,
    actor: UserPrincipal,
  ): Promise<ArtifactDownload> {
    const jobId = await this.requireJobId(jobRef, actor);

    const artifact = await this.repo.findArtifact(jobId, this.parseId(artifactRef));
    if (!artifact) throw new NotFoundException(`artifact "${artifactRef}" not found`);

    return {
      content: artifact.content,
      mediaType: artifact.mediaType,
      filename: artifact.name,
    };
  }

  // ----------------------------------------------------------------- helpers

  /**
   * Each kind is anchored to one thing and derives the wider anchors from it,
   * so they can never disagree: a run gives the project, a result gives both.
   * A free-form job may name a project or nothing.
   */
  private async resolveTarget(
    dto: CreateRepsJobDto,
  ): Promise<{ projectId: bigint | null; runId: bigint | null; resultId: bigint | null }> {
    if (dto.kind === 'analyze_test') {
      if (!dto.resultId) {
        throw new BadRequestException('resultId is required for kind "analyze_test"');
      }

      const result = await this.prisma.testResult.findUnique({
        where: { id: BigInt(dto.resultId) },
        select: { id: true, projectId: true, runId: true, run: { select: { ingestStatus: true } } },
      });
      if (!result) throw new NotFoundException(`test result "${dto.resultId}" not found`);
      if (result.run.ingestStatus !== 'ready') {
        throw new ConflictException(
          `result ${dto.resultId} belongs to a run that is ${result.run.ingestStatus}: ` +
            'there is nothing to analyse yet',
        );
      }
      return { projectId: result.projectId, runId: result.runId, resultId: result.id };
    }

    if (dto.kind === 'analyze_run') {
      if (!dto.runId) throw new BadRequestException('runId is required for kind "analyze_run"');

      const run = await this.prisma.testRun.findUnique({
        where: { id: BigInt(dto.runId) },
        select: { id: true, projectId: true, ingestStatus: true },
      });
      if (!run) throw new NotFoundException(`run "${dto.runId}" not found`);
      if (run.ingestStatus !== 'ready') {
        throw new ConflictException(
          `run ${dto.runId} is ${run.ingestStatus}: there is nothing to analyse yet`,
        );
      }
      return { projectId: run.projectId, runId: run.id, resultId: null };
    }

    if (!dto.projectId) return { projectId: null, runId: null, resultId: null };

    const project = await this.prisma.project.findUnique({
      where: { id: BigInt(dto.projectId) },
      select: { id: true },
    });
    if (!project) throw new NotFoundException(`project "${dto.projectId}" not found`);
    return { projectId: project.id, runId: null, resultId: null };
  }

  private async requireJobId(jobRef: string, actor: UserPrincipal): Promise<bigint> {
    const id = this.parseId(jobRef);
    const job = await this.repo.findJob(id);
    if (!job) throw new NotFoundException(`reps job "${jobRef}" not found`);
    await this.assertVisible(job, actor, jobRef);
    return id;
  }

  /**
   * An anchored job follows its project's membership. An unanchored one is
   * private to its author, since there is no project to derive access from.
   * Both refusals are 404: whether a job exists is itself not public.
   */
  private async assertVisible(
    job: Pick<RepsJob, 'projectId' | 'createdByUserId'>,
    actor: UserPrincipal,
    jobRef: string,
  ): Promise<void> {
    if (job.projectId !== null) {
      if (!(await this.access.canRead(actor, job.projectId))) {
        throw new NotFoundException(`reps job "${jobRef}" not found`);
      }
      return;
    }
    if (actor.role === 'admin') return;
    if (job.createdByUserId !== null && job.createdByUserId === actor.userId) return;
    throw new NotFoundException(`reps job "${jobRef}" not found`);
  }

  private async visibilityFor(actor: UserPrincipal): Promise<RepsVisibility> {
    return {
      projectIds: await this.access.visibleProjectIds(actor),
      userId: actor.userId,
    };
  }

  private parseId(ref: string): bigint {
    if (!/^\d{1,19}$/.test(ref)) throw new BadRequestException(`"${ref}" is not an id`);
    return BigInt(ref);
  }

  private toListItem(row: RepsJob, openQuestions: number): RepsJobListItem {
    return {
      id: idOf(row.id),
      kind: row.kind as RepsJobKind,
      status: row.status,
      userRequest: row.userRequest,
      projectId: nullableIdOf(row.projectId),
      runId: nullableIdOf(row.runId),
      resultId: nullableIdOf(row.resultId),
      summary: row.summary,
      error: row.error,
      costUsd: row.costUsd === null ? null : Number(row.costUsd),
      openQuestions,
      createdAt: row.createdAt.toISOString(),
      startedAt: isoOf(row.startedAt),
      finishedAt: isoOf(row.finishedAt),
    };
  }

  private toDetail(job: RepsJobWithChildren): RepsJobDetail {
    const openQuestions = job.questions.filter((question) => question.answer === null).length;

    return {
      ...this.toListItem(job, openQuestions),
      maxAttemptsPerStage: job.maxAttemptsPerStage,
      cancelRequested: job.cancelRequested,
      heartbeatAt: isoOf(job.heartbeatAt),
      tasks: job.tasks.map((task) => this.toTask(task)),
      questions: job.questions.map((question) => this.toQuestion(question)),
      artifacts: job.artifacts.map((artifact) => this.toArtifact(artifact)),
    };
  }

  private toTask(row: RepsTaskRow): RepsTask {
    const output = row.output as { summary?: string; findings?: RepsTask['findings'] } | null;
    return {
      id: idOf(row.id),
      type: row.type,
      status: row.status,
      orderNum: row.orderNum,
      attempt: row.attempt,
      dependsOn: row.dependsOn.map(idOf),
      error: row.error,
      findings: output?.findings ?? [],
      summary: output?.summary ?? null,
      startedAt: isoOf(row.startedAt),
      finishedAt: isoOf(row.finishedAt),
    };
  }

  private toQuestion(row: RepsQuestionRow): RepsQuestion {
    return {
      id: idOf(row.id),
      taskId: nullableIdOf(row.taskId),
      text: row.text,
      answer: row.answer,
      askedAt: row.askedAt.toISOString(),
      answeredAt: isoOf(row.answeredAt),
    };
  }

  /** Takes the body-less row: the document is fetched by its own endpoint. */
  private toArtifact(row: Omit<RepsArtifactRow, 'content'>): RepsArtifact {
    return {
      id: idOf(row.id),
      taskId: idOf(row.taskId),
      name: row.name,
      mediaType: row.mediaType,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toEvent(row: RepsEventRow): RepsEvent {
    return {
      id: idOf(row.id),
      taskId: nullableIdOf(row.taskId),
      level: row.level,
      message: row.message,
      data: row.data ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
