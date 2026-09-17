import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type {
  RepsEventPage,
  RepsJobAccepted,
  RepsJobDetail,
} from '../../contracts/index.js';

import type { UserPrincipal } from '../../common/auth/principal.js';
import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import { CreateRepsJobDto } from './dto/create-reps-job.dto.js';
import {
  ListRepsEventsQueryDto,
  ListRepsJobsQueryDto,
} from './dto/list-reps-jobs.query.dto.js';
import { ResumeRepsJobDto } from './dto/resume-reps-job.dto.js';
import { RepsService, type PaginatedRepsJobs } from './reps.service.js';

/**
 * Reps agent jobs.
 *
 * The UI polls `GET /:jobId` for state and `GET /:jobId/events` for progress —
 * the events endpoint is a cursor over an append-only table, so switching it to
 * SSE later needs no contract change.
 *
 * These routes carry no `:projectId`, so the path guard does not cover them:
 * every handler passes the caller down and the service checks the job's own
 * anchor.
 */
@Controller('api/reps/jobs')
export class RepsController {
  constructor(private readonly reps: RepsService) {}

  /** 202: the job is stored and queued, and the agent has not started yet. */
  @Post()
  @HttpCode(202)
  create(
    @Body() dto: CreateRepsJobDto,
    @CurrentUser() actor: UserPrincipal,
  ): Promise<RepsJobAccepted> {
    return this.reps.create(dto, actor);
  }

  @Get()
  list(
    @Query() query: ListRepsJobsQueryDto,
    @CurrentUser() actor: UserPrincipal,
  ): Promise<PaginatedRepsJobs> {
    return this.reps.list(query, actor);
  }

  @Get(':jobId')
  findOne(
    @Param('jobId') jobId: string,
    @CurrentUser() actor: UserPrincipal,
  ): Promise<RepsJobDetail> {
    return this.reps.findOne(jobId, actor);
  }

  @Get(':jobId/events')
  events(
    @Param('jobId') jobId: string,
    @Query() query: ListRepsEventsQueryDto,
    @CurrentUser() actor: UserPrincipal,
  ): Promise<RepsEventPage> {
    return this.reps.events(jobId, query, actor);
  }

  /** Answers the agent's questions and lets the job continue. */
  @Post(':jobId/resume')
  resume(
    @Param('jobId') jobId: string,
    @Body() dto: ResumeRepsJobDto,
    @CurrentUser() actor: UserPrincipal,
  ): Promise<RepsJobDetail> {
    return this.reps.resume(jobId, dto, actor);
  }

  @Post(':jobId/terminate')
  terminate(
    @Param('jobId') jobId: string,
    @CurrentUser() actor: UserPrincipal,
  ): Promise<RepsJobDetail> {
    return this.reps.terminate(jobId, actor);
  }

  /**
   * The produced document, straight from the database as its own media type —
   * so the client can `fetch(...).then(r => r.text())` and render it, or point
   * a download link at the same URL.
   */
  @Get(':jobId/artifacts/:artifactId')
  async download(
    @Param('jobId') jobId: string,
    @Param('artifactId') artifactId: string,
    @CurrentUser() actor: UserPrincipal,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const artifact = await this.reps.openArtifact(jobId, artifactId, actor);

    await reply
      .type(`${artifact.mediaType}; charset=utf-8`)
      .header('content-disposition', `inline; filename="${encodeURIComponent(artifact.filename)}"`)
      .send(artifact.content);
  }
}
