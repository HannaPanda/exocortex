import { Module } from '@nestjs/common';

import { DocumentsModule } from '../documents/documents.module';

import { AgentSessionRevertService } from './agent-session-revert.service';
import { AgentSessionsController } from './agent-sessions.controller';
import { AgentSessionsService } from './agent-sessions.service';

/**
 * Provenance per agent session (ADR-022).
 *
 * `DocumentsModule` for `DocumentSnapshotService`: a bulk revert is a series of
 * ordinary snapshot restores and must not become a second way to write a page.
 */
@Module({
  imports: [DocumentsModule],
  controllers: [AgentSessionsController],
  providers: [AgentSessionsService, AgentSessionRevertService],
  exports: [AgentSessionsService],
})
export class AgentSessionsModule {}
