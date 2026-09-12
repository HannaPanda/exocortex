import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canManageWorkspaceCredentials,
  credentialHint,
  encryptCredential,
  parseCredentialKey,
  WorkspaceAccessService,
} from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  type SetWorkspaceCredentialRequest,
  WORKSPACE_CREDENTIAL_PURPOSES,
  type WorkspaceCredential,
  type WorkspaceCredentialListResponse,
  type WorkspaceCredentialPurpose,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { API_ENV } from '../common/logger.provider';
import { OutboxService } from '../common/outbox.service';
import { PRISMA } from '../platform/platform-tokens';

/**
 * A workspace's own provider keys (issue #52, AP7, ADR-023).
 *
 * The one rule this service exists to keep: a stored secret never travels back
 * out. Reads answer with `configured`, `hint` and two timestamps; the
 * plaintext is decrypted in the worker alone, once per run, immediately before
 * the provider call. Nothing in the API ever needs it, so nothing in the API
 * ever reads it.
 */
@Injectable()
export class WorkspaceCredentialsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly access: WorkspaceAccessService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * The deployment key, or `null` when this deployment has none.
   *
   * Parsed on every call rather than cached at boot on purpose: parsing a
   * 32-byte base64 string costs nothing, and a misconfigured key must surface
   * as a failed save in the form rather than as a process that refused to
   * start (R2).
   */
  private encryptionKey(): Buffer | null {
    return parseCredentialKey(this.env.CREDENTIAL_ENCRYPTION_KEY);
  }

  private requireEncryptionKey(): Buffer {
    const key = this.encryptionKey();
    if (key === null) {
      throw new AppError(
        'credential_storage_unavailable',
        'This deployment has no CREDENTIAL_ENCRYPTION_KEY, so credentials cannot be stored',
      );
    }
    return key;
  }

  async list(workspaceId: string, actorUserId: string): Promise<WorkspaceCredentialListResponse> {
    const role = await this.access.findRole(workspaceId, actorUserId);
    assertPolicy(canManageWorkspaceCredentials(role));

    const rows = await this.prisma.workspaceCredential.findMany({
      where: { workspaceId },
      select: { purpose: true, hint: true, updatedAt: true, lastUsedAt: true },
    });

    // Every purpose is listed, configured or not: the form draws one row per
    // purpose, and an absent row is a state it has to show ("not stored"), not
    // an entry it has to invent.
    const credentials: WorkspaceCredential[] = WORKSPACE_CREDENTIAL_PURPOSES.map((purpose) => {
      const row = rows.find((candidate) => candidate.purpose === purpose);
      return {
        purpose,
        configured: row !== undefined,
        hint: row?.hint ?? '',
        updatedAt: row?.updatedAt.toISOString() ?? null,
        lastUsedAt: row?.lastUsedAt?.toISOString() ?? null,
      };
    });

    return { credentials, available: this.encryptionKey() !== null };
  }

  async set(input: {
    workspaceId: string;
    actorUserId: string;
    purpose: WorkspaceCredentialPurpose;
    request: SetWorkspaceCredentialRequest;
  }): Promise<WorkspaceCredentialListResponse> {
    const role = await this.access.findRole(input.workspaceId, input.actorUserId);
    assertPolicy(canManageWorkspaceCredentials(role));
    const key = this.requireEncryptionKey();

    const secret = input.request.secret.trim();
    const record = encryptCredential({ key, purpose: input.purpose, plaintext: secret });
    const hint = credentialHint(secret);

    await this.prisma.$transaction(async (tx) => {
      await tx.workspaceCredential.upsert({
        where: {
          workspaceId_purpose: { workspaceId: input.workspaceId, purpose: input.purpose },
        },
        create: {
          workspaceId: input.workspaceId,
          purpose: input.purpose,
          ...record,
          hint,
          createdById: input.actorUserId,
        },
        // `lastUsedAt` is cleared with the value it belonged to: a new key has
        // not paid for anything yet, and carrying the old date over would say
        // it had.
        update: { ...record, hint, createdById: input.actorUserId, lastUsedAt: null },
      });

      await this.outbox.writeAudit(tx, {
        workspaceId: input.workspaceId,
        actorId: input.actorUserId,
        action: 'workspace.credential.set',
        targetType: 'workspace_credential',
        targetId: input.purpose,
        correlationId: 'workspace-credential-set',
        // The hint and nothing else. An audit row is read by more people than
        // the form is, and it outlives the credential.
        metadata: { purpose: input.purpose, hint },
      });
    });

    return this.list(input.workspaceId, input.actorUserId);
  }

  async remove(input: {
    workspaceId: string;
    actorUserId: string;
    purpose: WorkspaceCredentialPurpose;
  }): Promise<WorkspaceCredentialListResponse> {
    const role = await this.access.findRole(input.workspaceId, input.actorUserId);
    assertPolicy(canManageWorkspaceCredentials(role));

    await this.prisma.$transaction(async (tx) => {
      // `deleteMany`, so removing a key that is not there is a no-op rather
      // than a 404: the button says "remove", and the state afterwards is the
      // same either way.
      const { count } = await tx.workspaceCredential.deleteMany({
        where: { workspaceId: input.workspaceId, purpose: input.purpose },
      });
      if (count === 0) return;

      await this.outbox.writeAudit(tx, {
        workspaceId: input.workspaceId,
        actorId: input.actorUserId,
        action: 'workspace.credential.removed',
        targetType: 'workspace_credential',
        targetId: input.purpose,
        correlationId: 'workspace-credential-remove',
        metadata: { purpose: input.purpose },
      });
    });

    return this.list(input.workspaceId, input.actorUserId);
  }
}
