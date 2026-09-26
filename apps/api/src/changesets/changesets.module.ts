import { Module } from '@nestjs/common';

import { DocumentsModule } from '../documents/documents.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { WorkItemsModule } from '../work-items/work-items.module';

import { ChangesetApplyService } from './changeset-apply.service';
import { ChangesetProposalService } from './changeset-proposal.service';
import { ChangesetReviewService } from './changeset-review.service';
import { ChangesetsController } from './changesets.controller';
import { ChangesetsService } from './changesets.service';

/**
 * Proposed changes (issue #141, ADR-070).
 *
 * `DocumentsModule` for the writes a proposal previews and an apply replays;
 * `WorkItemsModule` for the review a hand-in raises and the run a decision
 * carries on.
 */
@Module({
  imports: [DocumentsModule, RealtimeModule, WorkItemsModule],
  controllers: [ChangesetsController],
  providers: [
    ChangesetsService,
    ChangesetProposalService,
    ChangesetApplyService,
    ChangesetReviewService,
  ],
})
export class ChangesetsModule {}
