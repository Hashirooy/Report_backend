import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import type {
  IntegrationCatalog,
  ProjectIntegration,
  RenderedIntegrationRequest,
} from '../../contracts/index.js';

import type { UserPrincipal } from '../../common/auth/principal.js';
import { CurrentUser, RequireProjectRole } from '../../common/decorators/auth.decorators.js';
import { ProjectsService } from '../projects/projects.service.js';
import { PreviewIntegrationDraftDto, SaveIntegrationDto } from './dto/integration.dto.js';
import { IntegrationsService } from './integrations.service.js';

/**
 * Where a project's bug reports are sent — one integration per project, so it
 * is a singular resource. Maintainers only: the template decides what leaves
 * the system and with which credential.
 */
@Controller('api/projects/:projectId/integration')
@RequireProjectRole('maintainer')
export class IntegrationsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly integrations: IntegrationsService,
  ) {}

  /** All settings: URL, method, headers, body, response mapping. 404 until saved. */
  @Get()
  async get(@Param('projectId') projectId: string): Promise<ProjectIntegration> {
    const project = await this.projects.requireByRef(projectId);
    return this.integrations.get(project.id);
  }

  /** Creates on the first call, updates afterwards; see SaveIntegrationDto. */
  @Put()
  async save(
    @Param('projectId') projectId: string,
    @Body() dto: SaveIntegrationDto,
    @CurrentUser() actor: UserPrincipal,
  ): Promise<ProjectIntegration> {
    const project = await this.projects.requireByRef(projectId);
    return this.integrations.save(project.id, dto, actor.userId);
  }

  @Delete()
  @HttpCode(204)
  async remove(@Param('projectId') projectId: string): Promise<void> {
    const project = await this.projects.requireByRef(projectId);
    await this.integrations.remove(project.id);
  }

  /** The placeholders and filters a template may use, for the editor. */
  @Get('variables')
  catalog(): IntegrationCatalog {
    return this.integrations.catalog();
  }

  /** Renders an unsaved template against example values. Sends nothing. */
  @Post('preview')
  @HttpCode(200)
  async preview(
    @Param('projectId') projectId: string,
    @Body() dto: PreviewIntegrationDraftDto,
  ): Promise<RenderedIntegrationRequest> {
    const project = await this.projects.requireByRef(projectId);
    return this.integrations.previewDraft(project.id, dto);
  }
}
