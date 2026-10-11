import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { ChangesetsModule } from '../changesets/changesets.module';
import { DocumentsModule } from '../documents/documents.module';
import { RealtimeModule } from '../realtime/realtime.module';

import { EvalCasesService } from './eval-cases.service';
import { EvalRunsService } from './eval-runs.service';
import { EvalSandboxService } from './eval-sandbox.service';
import { EvalSettlementService } from './eval-settlement.service';
import { EvalsController } from './evals.controller';

/**
 * Agent evals (issue #146, ADR-074).
 *
 * `AiModule` for the conversation an attempt runs in, `DocumentsModule` for
 * the fixture sandbox, `ChangesetsModule` to reject what a proposing attempt
 * handed in.
 */
@Module({
  imports: [AiModule, ChangesetsModule, DocumentsModule, RealtimeModule],
  controllers: [EvalsController],
  providers: [EvalCasesService, EvalRunsService, EvalSandboxService, EvalSettlementService],
})
export class EvalsModule {}
