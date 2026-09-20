import { Module } from '@nestjs/common';

import { DocumentsModule } from '../documents/documents.module';
import { EntitiesModule } from '../entities/entities.module';
import { SearchModule } from '../search/search.module';

import { AgentMessagesService } from './agent-messages.service';
import { MemoryController } from './memory.controller';
import { MemoryService } from './memory.service';
import { MemoryCheckpointService } from './memory-checkpoint.service';
import { MemoryFactsService } from './memory-facts.service';

/**
 * The memory surface reuses the ordinary domain services rather than reaching
 * into Prisma for writes: a memory note is an ordinary page, and it must pass
 * the same permission checks, land in the same outbox and reach an open editor
 * through the same collaboration bridge (ADR-016).
 */
@Module({
  // The entity layer, so a recall can answer "what do I know about X" before it
  // searches (issue #47). One-way: the entity module knows nothing of memory.
  imports: [SearchModule, DocumentsModule, EntitiesModule],
  controllers: [MemoryController],
  providers: [MemoryService, MemoryFactsService, MemoryCheckpointService, AgentMessagesService],
  exports: [MemoryService, MemoryFactsService, MemoryCheckpointService, AgentMessagesService],
})
export class MemoryModule {}
