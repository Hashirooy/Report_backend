import { Module } from '@nestjs/common';

import { ProjectsModule } from '../projects/projects.module.js';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsRepository } from './integrations.repository.js';
import { IntegrationsService } from './integrations.service.js';
import { IssueExportsController } from './issue-exports.controller.js';
import { IssueExportsService } from './issue-exports.service.js';
import { OutboundHttpClient } from './outbound-http.client.js';
import { SecretBox } from './secret-box.service.js';

@Module({
  imports: [ProjectsModule],
  controllers: [IntegrationsController, IssueExportsController],
  providers: [
    IntegrationsService,
    IntegrationsRepository,
    IssueExportsService,
    OutboundHttpClient,
    SecretBox,
  ],
})
export class IntegrationsModule {}
