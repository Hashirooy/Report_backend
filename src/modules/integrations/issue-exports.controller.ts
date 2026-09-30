import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { IssueExport, RenderedIntegrationRequest } from '../../contracts/index.js';

import type { UserPrincipal } from '../../common/auth/principal.js';
import { CurrentUser } from '../../common/decorators/auth.decorators.js';
import { CreateIssueExportDto, PreviewIssueExportDto } from './dto/integration.dto.js';
import { IssueExportsService } from './issue-exports.service.js';

/**
 * Sending a job's report through its project's integration. Like the rest of Reps these
 * routes carry no `:projectId`, so the service checks the job's project itself.
 */
@Controller('api/reps/jobs/:jobId/exports')
export class IssueExportsController {
  constructor(private readonly exports: IssueExportsService) {}

  @Get()
  list(@Param('jobId') jobId: string, @CurrentUser() actor: UserPrincipal): Promise<IssueExport[]> {
    return this.exports.list(jobId, actor);
  }

  /** What would be sent, with the secret masked. Sends nothing. */
  @Post('preview')
  @HttpCode(200)
  preview(
    @Param('jobId') jobId: string,
    @Body() dto: PreviewIssueExportDto,
    @CurrentUser() actor: UserPrincipal,
  ): Promise<RenderedIntegrationRequest> {
    return this.exports.preview(jobId, dto, actor);
  }

  /**
   * 201 with the recorded attempt whether or not the target accepted it: a
   * refusal from the tracker is a result to show, not an error of this API.
   * 409 when the report was already sent there and `force` is not set.
   */
  @Post()
  create(
    @Param('jobId') jobId: string,
    @Body() dto: CreateIssueExportDto,
    @CurrentUser() actor: UserPrincipal,
  ): Promise<IssueExport> {
    return this.exports.create(jobId, dto, actor);
  }
}
