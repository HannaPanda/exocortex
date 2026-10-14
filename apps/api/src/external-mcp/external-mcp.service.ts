import { Inject, Injectable } from '@nestjs/common';

import { discoverMcpServer, McpClientError, type McpDiscovery } from '@exocortex/ai';
import {
  assertPolicy,
  canManageExternalMcpServers,
  CredentialCipherError,
  credentialHint,
  decryptCredential,
  encryptCredential,
  parseCredentialKey,
  WorkspaceAccessService,
} from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  type CreateExternalMcpServerRequest,
  type DeleteExternalMcpServerResponse,
  EXTERNAL_MCP_LIMITS,
  externalMcpAuthHeaders,
  type ExternalMcpAuthKind,
  type ExternalMcpErrorCode,
  externalMcpSecretPurpose,
  type ExternalMcpServerListResponse,
  type ExternalMcpServerResponse,
  redactSecret,
  type SetExternalMcpToolAccessRequest,
  type UpdateExternalMcpServerRequest,
} from '@exocortex/contracts';
import { Prisma, type PrismaClient, type PrismaTransactionClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { API_ENV, LOGGER } from '../common/logger.provider';
import { type AuditAction, OutboxService } from '../common/outbox.service';
import { PRISMA } from '../platform/platform-tokens';
import { SettingsService } from '../platform/settings.service';
import { type WorkItemActor } from '../work-items/work-item-actor';

import { reconcileTools } from './external-mcp-check';
import {
  ACCESS_ROW,
  AUTH_KIND_ROW,
  externalMcpServerInclude,
  type ExternalMcpServerRow,
  toExternalMcpServer,
} from './external-mcp-mapper';

/** Who is asking, and whether it is a person at the browser. */
export interface ExternalMcpCaller {
  actor: WorkItemActor;
  viaBrowser: boolean;
}

const MAX_ERROR_DETAIL_CHARS = 300;

/**
 * External MCP servers of a workspace (issue #196, ADR-086).
 *
 * The service is the whole of the permission model, in three layers that are
 * deliberately separate checks rather than one combined condition:
 *
 * 1. `ai.externalMcpEnabled` -- the deployment allows it at all. Reading the
 *    list still works when it is off, so a person can see what is configured.
 * 2. OWNER of the workspace, for everything, reading included: the list names
 *    where this workspace's data may go and which secrets are stored.
 * 3. A person at the browser for every change that widens anything: adding,
 *    changing, deleting a server and approving a tool. Every token is refused,
 *    a person's own admin token included, because an agent can hold one;
 *    `workflow_human_only` (ADR-080) draws the same line. A connection check
 *    only reads, so any credential of an owner may ask for one except a run
 *    of the built-in AI.
 *
 * Unlike a workspace's provider key, this secret is decrypted in the API: a
 * connection check is a person waiting for an answer, and it makes the same
 * request a tool call will. The plaintext lives for the length of that one
 * request and goes nowhere else -- not into a response, a log line, an audit
 * row or an error detail (`redactSecret`).
 */
@Injectable()
export class ExternalMcpService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly outbox: OutboxService,
    private readonly settings: SettingsService,
  ) {}

  async list(
    workspaceId: string,
    caller: ExternalMcpCaller,
  ): Promise<ExternalMcpServerListResponse> {
    await this.assertOwner(workspaceId, caller);
    const [rows, settings] = await Promise.all([
      this.prisma.externalMcpServer.findMany({
        where: { workspaceId },
        include: externalMcpServerInclude,
        orderBy: { createdAt: 'asc' },
      }),
      this.settings.getForWorkspace(workspaceId),
    ]);
    return {
      servers: rows.map(toExternalMcpServer),
      enabled: settings['ai.externalMcpEnabled'],
      credentialsAvailable: this.encryptionKey() !== null,
    };
  }

  async get(
    workspaceId: string,
    serverId: string,
    caller: ExternalMcpCaller,
  ): Promise<ExternalMcpServerResponse> {
    await this.assertOwner(workspaceId, caller);
    return { server: toExternalMcpServer(await this.loadRow(workspaceId, serverId)) };
  }

  async create(
    workspaceId: string,
    caller: ExternalMcpCaller,
    request: CreateExternalMcpServerRequest,
    correlationId: string,
  ): Promise<ExternalMcpServerResponse> {
    await this.assertPersonOwner(workspaceId, caller);
    await this.assertEnabled(workspaceId);

    const count = await this.prisma.externalMcpServer.count({ where: { workspaceId } });
    if (count >= EXTERNAL_MCP_LIMITS.serversPerWorkspace) {
      throw new AppError(
        'external_mcp_limit_reached',
        `A workspace may connect at most ${String(EXTERNAL_MCP_LIMITS.serversPerWorkspace)} MCP servers`,
      );
    }

    const secret = this.secretColumns(workspaceId, request.key, request.secret ?? null);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.externalMcpServer.create({
          data: {
            workspaceId,
            key: request.key,
            name: request.name,
            url: request.url,
            authKind: AUTH_KIND_ROW[request.authKind],
            authHeaderName: request.authKind === 'header' ? (request.authHeaderName ?? null) : null,
            ...secret,
            createdById: caller.actor.userId,
          },
          include: externalMcpServerInclude,
        });
        await this.audit(tx, {
          workspaceId: workspaceId,
          caller: caller,
          action: 'external_mcp.server.created',
          targetId: created.id,
          correlationId: correlationId,
          metadata: {
            key: created.key,
            host: new URL(created.url).host,
          },
        });
        return created;
      });
      return { server: toExternalMcpServer(row) };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(
          'external_mcp_key_taken',
          'Another server in this workspace has that key',
        );
      }
      throw error;
    }
  }

  async update(
    workspaceId: string,
    serverId: string,
    caller: ExternalMcpCaller,
    request: UpdateExternalMcpServerRequest,
    correlationId: string,
  ): Promise<ExternalMcpServerResponse> {
    await this.assertPersonOwner(workspaceId, caller);
    const current = await this.loadRow(workspaceId, serverId);
    if (request.enabled === true) await this.assertEnabled(workspaceId);

    const data = this.updateData(workspaceId, current, request);
    const urlChanged = request.url !== undefined && request.url !== current.url;

    const row = await this.prisma.$transaction(async (tx) => {
      if (urlChanged) {
        // A different address may be a different server: nothing approved
        // for the old one carries over, and its last check says nothing now.
        await tx.externalMcpTool.updateMany({
          where: { serverId },
          data: {
            access: 'BLOCKED',
            approvedFingerprint: null,
            approvedById: null,
            approvedAt: null,
          },
        });
      }
      const updated = await tx.externalMcpServer.update({
        where: { id: serverId },
        data: urlChanged ? { ...data, status: 'UNCHECKED' } : data,
        include: externalMcpServerInclude,
      });
      await this.audit(tx, {
        workspaceId: workspaceId,
        caller: caller,
        action: 'external_mcp.server.updated',
        targetId: serverId,
        correlationId: correlationId,
        metadata: {
          fields: Object.keys(request)
            .filter((key) => key !== 'secret')
            .join(','),
          secretChanged: request.secret !== undefined,
          ...(urlChanged ? { host: new URL(updated.url).host } : {}),
        },
      });
      return updated;
    });
    return { server: toExternalMcpServer(row) };
  }

  async remove(
    workspaceId: string,
    serverId: string,
    caller: ExternalMcpCaller,
    correlationId: string,
  ): Promise<DeleteExternalMcpServerResponse> {
    await this.assertPersonOwner(workspaceId, caller);
    const current = await this.loadRow(workspaceId, serverId);
    await this.prisma.$transaction(async (tx) => {
      await tx.externalMcpServer.delete({ where: { id: serverId } });
      await this.audit(tx, {
        workspaceId: workspaceId,
        caller: caller,
        action: 'external_mcp.server.deleted',
        targetId: serverId,
        correlationId: correlationId,
        metadata: {
          key: current.key,
        },
      });
    });
    return { deleted: true };
  }

  /**
   * Connects, lists the tools and stores what came back.
   *
   * A failed check is an answer, not an error: it is stored on the server and
   * returned with status `error` and a code, so a person sees why and a later
   * reader sees when. The tools of a failed check are left as they were.
   */
  async check(
    workspaceId: string,
    serverId: string,
    caller: ExternalMcpCaller,
  ): Promise<ExternalMcpServerResponse> {
    await this.assertOwner(workspaceId, caller);
    if (caller.actor.kind === 'assistant') {
      throw AppError.forbidden('A run of the built-in AI cannot check an external MCP server');
    }
    await this.assertEnabled(workspaceId);
    const row = await this.loadRow(workspaceId, serverId);
    const settings = await this.settings.getForWorkspace(workspaceId);
    const now = new Date();

    let secret: string | null = null;
    try {
      secret = this.readSecret(row);
    } catch (error) {
      this.logger.warn('External MCP secret could not be decrypted', {
        serverId,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return this.storeFailure(
        row,
        now,
        'credential_unreadable',
        'The stored secret cannot be decrypted',
      );
    }

    let discovery: McpDiscovery;
    try {
      discovery = await discoverMcpServer(
        {
          url: row.url,
          headers: externalMcpAuthHeaders({
            authKind: this.authKind(row),
            authHeaderName: row.authHeaderName,
            secret,
          }),
        },
        {
          limits: {
            timeoutMs: settings['ai.externalMcpTimeoutSeconds'] * 1_000,
            maxTools: EXTERNAL_MCP_LIMITS.toolsPerServer,
          },
        },
      );
    } catch (error) {
      const failure =
        error instanceof McpClientError
          ? error
          : new McpClientError('unreachable', error instanceof Error ? error.message : 'unknown');
      this.logger.info('External MCP check failed', {
        serverId,
        code: failure.code,
        status: failure.status,
      });
      return this.storeFailure(row, now, failure.code, redactSecret(failure.detail, secret));
    }

    return this.storeDiscovery(row, now, discovery);
  }

  async setToolAccess(input: {
    workspaceId: string;
    serverId: string;
    toolId: string;
    caller: ExternalMcpCaller;
    request: SetExternalMcpToolAccessRequest;
    correlationId: string;
  }): Promise<ExternalMcpServerResponse> {
    const { workspaceId, serverId, toolId, caller, request, correlationId } = input;
    await this.assertPersonOwner(workspaceId, caller);
    await this.loadRow(workspaceId, serverId);
    const tool = await this.prisma.externalMcpTool.findFirst({ where: { id: toolId, serverId } });
    if (tool === null) throw AppError.notFound('External MCP tool');

    const blocking = request.access === 'blocked';
    if (!blocking && (tool.problem !== null || !tool.available)) {
      throw new AppError('external_mcp_tool_unusable', 'This tool cannot be approved', {
        problem: tool.problem,
        available: tool.available,
      });
    }

    const row = await this.prisma.$transaction(async (tx) => {
      await tx.externalMcpTool.update({
        where: { id: toolId },
        data: blocking
          ? { access: 'BLOCKED', approvedFingerprint: null, approvedById: null, approvedAt: null }
          : {
              access: ACCESS_ROW[request.access],
              approvedFingerprint: tool.fingerprint,
              approvedById: caller.actor.userId,
              approvedAt: new Date(),
            },
      });
      await this.audit(tx, {
        workspaceId: workspaceId,
        caller: caller,
        action: 'external_mcp.tool.access',
        targetId: serverId,
        correlationId: correlationId,
        metadata: {
          tool: tool.name,
          access: request.access,
          fingerprint: tool.fingerprint,
        },
      });
      return tx.externalMcpServer.findUniqueOrThrow({
        where: { id: serverId },
        include: externalMcpServerInclude,
      });
    });
    return { server: toExternalMcpServer(row) };
  }

  // -- writing a check's result -------------------------------------------

  private async storeFailure(
    row: ExternalMcpServerRow,
    now: Date,
    code: ExternalMcpErrorCode,
    detail: string,
  ): Promise<ExternalMcpServerResponse> {
    const updated = await this.prisma.externalMcpServer.update({
      where: { id: row.id },
      data: {
        status: 'ERROR',
        lastCheckedAt: now,
        lastErrorCode: code,
        lastErrorDetail: detail.slice(0, MAX_ERROR_DETAIL_CHARS),
      },
      include: externalMcpServerInclude,
    });
    return { server: toExternalMcpServer(updated) };
  }

  private async storeDiscovery(
    row: ExternalMcpServerRow,
    now: Date,
    discovery: McpDiscovery,
  ): Promise<ExternalMcpServerResponse> {
    const plan = reconcileTools({
      serverId: row.id,
      serverKey: row.key,
      discovery,
      stored: row.tools,
      now,
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      if (plan.creates.length > 0) await tx.externalMcpTool.createMany({ data: plan.creates });
      for (const update of plan.updates) {
        await tx.externalMcpTool.update({ where: { id: update.id }, data: update.data });
      }
      if (plan.goneIds.length > 0) {
        await tx.externalMcpTool.updateMany({
          where: { id: { in: plan.goneIds } },
          data: { available: false, access: 'BLOCKED' },
        });
      }
      return tx.externalMcpServer.update({
        where: { id: row.id },
        data: {
          status: 'OK',
          lastCheckedAt: now,
          lastOkAt: now,
          lastErrorCode: null,
          lastErrorDetail: null,
          serverName: discovery.serverName,
          serverVersion: discovery.serverVersion,
          protocolVersion: discovery.protocolVersion,
          instructions: discovery.instructions,
          toolsTruncated: discovery.truncated,
        },
        include: externalMcpServerInclude,
      });
    });
    return { server: toExternalMcpServer(updated) };
  }

  // -- secrets ---------------------------------------------------------------

  private encryptionKey(): Buffer | null {
    return parseCredentialKey(this.env.CREDENTIAL_ENCRYPTION_KEY);
  }

  private secretColumns(
    workspaceId: string,
    key: string,
    secret: string | null,
  ): Pick<
    Prisma.ExternalMcpServerUncheckedCreateInput,
    'secretCiphertext' | 'secretIv' | 'secretAuthTag' | 'secretKeyVersion' | 'secretHint'
  > {
    if (secret === null) {
      return {
        secretCiphertext: null,
        secretIv: null,
        secretAuthTag: null,
        secretKeyVersion: null,
        secretHint: null,
      };
    }
    const encryptionKey = this.encryptionKey();
    if (encryptionKey === null) {
      throw new AppError(
        'credential_storage_unavailable',
        'This deployment has no CREDENTIAL_ENCRYPTION_KEY, so a secret cannot be stored',
      );
    }
    const record = encryptCredential({
      key: encryptionKey,
      purpose: externalMcpSecretPurpose(workspaceId, key),
      plaintext: secret,
    });
    return {
      secretCiphertext: record.ciphertext,
      secretIv: record.iv,
      secretAuthTag: record.authTag,
      secretKeyVersion: record.keyVersion,
      secretHint: credentialHint(secret),
    };
  }

  private readSecret(row: ExternalMcpServerRow): string | null {
    if (
      row.secretCiphertext === null ||
      row.secretIv === null ||
      row.secretAuthTag === null ||
      row.secretKeyVersion === null
    ) {
      return null;
    }
    const key = this.encryptionKey();
    if (key === null) throw new CredentialCipherError('No CREDENTIAL_ENCRYPTION_KEY');
    return decryptCredential({
      key,
      purpose: externalMcpSecretPurpose(row.workspaceId, row.key),
      record: {
        ciphertext: row.secretCiphertext,
        iv: row.secretIv,
        authTag: row.secretAuthTag,
        keyVersion: row.secretKeyVersion,
      },
    });
  }

  private authKind(row: ExternalMcpServerRow): ExternalMcpAuthKind {
    return row.authKind === 'BEARER' ? 'bearer' : row.authKind === 'HEADER' ? 'header' : 'none';
  }

  /**
   * The columns an update writes, with the combination checked after merging:
   * a request may change the auth kind without resending the secret, and only
   * the merged result says whether that leaves a header kind without a header.
   */
  private updateData(
    workspaceId: string,
    current: ExternalMcpServerRow,
    request: UpdateExternalMcpServerRequest,
  ): Prisma.ExternalMcpServerUpdateInput {
    const authKind = request.authKind ?? this.authKind(current);
    const headerName =
      authKind === 'header' ? (request.authHeaderName ?? current.authHeaderName) : null;
    const hasSecret =
      request.secret === undefined ? current.secretCiphertext !== null : request.secret !== null;

    if (authKind === 'header' && headerName === null) {
      throw AppError.validation('A header auth kind needs a header name');
    }
    if (authKind !== 'none' && !hasSecret) {
      throw AppError.validation('This auth kind needs a secret');
    }

    const data: Prisma.ExternalMcpServerUpdateInput = {
      authKind: AUTH_KIND_ROW[authKind],
      authHeaderName: headerName,
    };
    if (request.name !== undefined) data.name = request.name;
    if (request.url !== undefined) data.url = request.url;
    if (request.enabled !== undefined) data.enabled = request.enabled;
    if (authKind === 'none') {
      Object.assign(data, this.secretColumns(workspaceId, current.key, null));
    } else if (request.secret !== undefined) {
      Object.assign(data, this.secretColumns(workspaceId, current.key, request.secret));
    }
    return data;
  }

  // -- who may -----------------------------------------------------------------

  private async assertOwner(workspaceId: string, caller: ExternalMcpCaller): Promise<void> {
    const role = await this.access.findRole(workspaceId, caller.actor.userId);
    assertPolicy(canManageExternalMcpServers(role));
  }

  private async assertPersonOwner(workspaceId: string, caller: ExternalMcpCaller): Promise<void> {
    await this.assertOwner(workspaceId, caller);
    if (!caller.viaBrowser || caller.actor.kind !== 'human') {
      throw new AppError(
        'external_mcp_human_only',
        'Connecting an MCP server, changing it or approving its tools is decided by a person in the browser',
      );
    }
  }

  private async assertEnabled(workspaceId: string): Promise<void> {
    const settings = await this.settings.getForWorkspace(workspaceId);
    if (!settings['ai.externalMcpEnabled']) {
      throw new AppError('external_mcp_disabled', 'External MCP servers are switched off');
    }
  }

  private async loadRow(workspaceId: string, serverId: string): Promise<ExternalMcpServerRow> {
    const row = await this.prisma.externalMcpServer.findFirst({
      where: { id: serverId, workspaceId },
      include: externalMcpServerInclude,
    });
    if (row === null) throw AppError.notFound('External MCP server');
    return row;
  }

  private async audit(
    tx: PrismaTransactionClient,
    entry: {
      workspaceId: string;
      caller: ExternalMcpCaller;
      action: AuditAction;
      targetId: string;
      correlationId: string;
      metadata: Record<string, string | number | boolean | null>;
    },
  ): Promise<void> {
    await this.outbox.writeAudit(tx, {
      workspaceId: entry.workspaceId,
      actorId: entry.caller.actor.userId,
      action: entry.action,
      targetType: 'external_mcp_server',
      targetId: entry.targetId,
      correlationId: entry.correlationId,
      metadata: entry.metadata,
    });
  }
}
