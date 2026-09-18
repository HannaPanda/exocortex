import { Module } from '@nestjs/common';

import { DocumentsModule } from '../documents/documents.module';
import { ResearchModule } from '../research/research.module';

import { ClipService } from './clip.service';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

/**
 * The inbox reuses the document services rather than writing pages itself: a
 * capture must pass the same permission checks, land in the same outbox and
 * reach an open editor through the same bridge as anything else (ADR-016).
 */
@Module({
  imports: [DocumentsModule, ResearchModule],
  controllers: [InboxController],
  providers: [InboxService, ClipService],
  exports: [InboxService, ClipService],
})
export class InboxModule {}
