import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { OutboxService } from '../common/outbox.service';

import {
  AdminInvitationsController,
  PublicInvitationsController,
  WorkspaceInvitationsController,
} from './invitations.controller';
import { InvitationsService } from './invitations.service';

/**
 * Invitations (issue #3).
 *
 * Depends on `AuthModule` for two things it must not duplicate: Better Auth's
 * configured password hasher, so an invited account's credential is byte-for-byte
 * what a sign-up would have produced, and the single SMTP transport.
 */
@Module({
  imports: [AuthModule],
  controllers: [
    AdminInvitationsController,
    WorkspaceInvitationsController,
    PublicInvitationsController,
  ],
  providers: [InvitationsService, OutboxService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
