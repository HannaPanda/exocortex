import { Module } from '@nestjs/common';

import { OutboxService } from '../common/outbox.service';
import { DocumentsModule } from '../documents/documents.module';
import { RealtimeModule } from '../realtime/realtime.module';

import { DatabasePropertiesController } from './database-properties.controller';
import { DatabasePropertiesService } from './database-properties.service';
import { DatabaseRowsController } from './database-rows.controller';
import { DatabaseRowsService } from './database-rows.service';
import { DatabaseViewsController } from './database-views.controller';
import { DatabaseViewsService } from './database-views.service';

@Module({
  imports: [RealtimeModule, DocumentsModule],
  controllers: [DatabasePropertiesController, DatabaseViewsController, DatabaseRowsController],
  providers: [DatabasePropertiesService, DatabaseViewsService, DatabaseRowsService, OutboxService],
  // The entity layer provisions its own database and its two columns through
  // the ordinary schema service (issue #47), so the checks are the same ones a
  // person adding a column passes.
  exports: [DatabasePropertiesService, DatabaseRowsService],
})
export class DatabasesModule {}
