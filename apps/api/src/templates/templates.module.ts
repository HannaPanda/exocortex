import { Module } from '@nestjs/common';

import { DocumentsModule } from '../documents/documents.module';

import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

/**
 * Page templates (issue #79, ADR-039). A copy is made by the ordinary document
 * services, so a page from a template passes the same permission checks, gets
 * the same outbox event and is indexed like any other page.
 */
@Module({
  imports: [DocumentsModule],
  controllers: [TemplatesController],
  providers: [TemplatesService],
  exports: [TemplatesService],
})
export class TemplatesModule {}
