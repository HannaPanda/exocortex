import { Module } from '@nestjs/common';

import { OutboxService } from '../common/outbox.service';
import { RealtimeModule } from '../realtime/realtime.module';

import { WorkspaceCredentialsService } from './workspace-credentials.service';
import { WorkspaceOverviewService } from './workspace-overview.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  imports: [RealtimeModule],
  controllers: [WorkspacesController],
  providers: [
    WorkspacesService,
    WorkspaceOverviewService,
    WorkspaceCredentialsService,
    OutboxService,
  ],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
