import { Module } from '@nestjs/common';

import { OutboxService } from '../common/outbox.service';
import { RealtimeModule } from '../realtime/realtime.module';

import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  imports: [RealtimeModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, OutboxService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
