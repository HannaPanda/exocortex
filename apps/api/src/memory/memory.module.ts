import { Module } from '@nestjs/common';

import { DocumentsModule } from '../documents/documents.module';
import { SearchModule } from '../search/search.module';

import { MemoryController } from './memory.controller';
import { MemoryService } from './memory.service';

/**
 * The memory surface reuses the ordinary domain services rather than reaching
 * into Prisma for writes: a memory note is an ordinary page, and it must pass
 * the same permission checks, land in the same outbox and reach an open editor
 * through the same collaboration bridge (ADR-016).
 */
@Module({
  imports: [SearchModule, DocumentsModule],
  controllers: [MemoryController],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
