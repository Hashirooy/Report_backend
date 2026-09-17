import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import type { CreatedProjectToken, ProjectToken } from '../../contracts/index.js';

import type { UserPrincipal } from '../../common/auth/principal.js';
import { CurrentUser, RequireProjectRole } from '../../common/decorators/auth.decorators.js';
import { CreateProjectTokenDto } from './dto/create-project-token.dto.js';
import { ProjectTokensService } from './project-tokens.service.js';
import { ProjectsService } from './projects.service.js';

/**
 * Ingest credentials for one project. A CI pipeline gets a token from here
 * instead of the deployment-wide secret, so a leak is contained to the project
 * whose pipeline leaked it.
 */
@Controller('api/projects/:projectId/tokens')
@RequireProjectRole('maintainer')
export class ProjectTokensController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly tokens: ProjectTokensService,
  ) {}

  @Get()
  async list(@Param('projectId') projectId: string): Promise<ProjectToken[]> {
    const project = await this.projects.requireByRef(projectId);
    return this.tokens.list(project.id);
  }

  /** The response carries the secret. It is never retrievable again. */
  @Post()
  async create(
    @Param('projectId') projectId: string,
    @Body() dto: CreateProjectTokenDto,
    @CurrentUser() actor: UserPrincipal,
  ): Promise<CreatedProjectToken> {
    const project = await this.projects.requireByRef(projectId);
    return this.tokens.create(project.id, dto.name, actor.userId);
  }

  @Delete(':tokenId')
  @HttpCode(204)
  async revoke(
    @Param('projectId') projectId: string,
    @Param('tokenId') tokenId: string,
  ): Promise<void> {
    if (!/^\d{1,19}$/.test(tokenId)) {
      throw new BadRequestException(`"${tokenId}" is not a token id`);
    }
    const project = await this.projects.requireByRef(projectId);
    await this.tokens.revoke(project.id, BigInt(tokenId));
  }
}
