import { callMcpTool, McpClientError, type McpClientErrorCode } from '@exocortex/ai';
import { decryptCredential, parseCredentialKey } from '@exocortex/auth';
import { type WorkerEnv } from '@exocortex/config';
import {
  externalMcpAuthHeaders,
  type ExternalMcpAuthKind,
  externalMcpFunctionName,
  externalMcpSecretPurpose,
  MODEL_FUNCTION_NAME_MAX,
  redactSecret,
  type Settings,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

/**
 * The approved tools of a workspace's external MCP servers, for one run of the
 * built-in AI (issue #196, stage 3, ADR-086).
 *
 * Two halves, and the second is the reason this is more than a query:
 *
 * - **What a run is offered** is read once, when the run starts: the tools a
 *   person approved, on servers that are switched on, while the deployment
 *   allows external servers and the run's user is a full member of the
 *   workspace.
 * - **Whether a call may still go out** is read again on every call, from the
 *   database rather than from that list. A person who blocks a tool, switches
 *   a server off, replaces its secret or loses their membership while a run is
 *   going stops the next call, not the next run. The secret is decrypted for
 *   that one call and goes nowhere else.
 *
 * Nothing here decides what a call may *do*: whether a write may run after
 * the run read foreign text, in which write mode, under which profile, is
 * decided in the tool runner by the same `decideMutation` every `exo_` tool
 * passes. This file answers only "is this still the tool a person approved".
 */

/** One approved tool, as the run's offer carries it. */
export interface ExternalToolBinding {
  functionName: string;
  toolId: string;
  serverId: string;
  serverKey: string;
  serverName: string;
  toolName: string;
  title: string | null;
  /** The description a person read when they approved it. */
  description: string;
  inputSchema: Record<string, unknown>;
  access: 'read' | 'write';
  /** What was approved; a call checks the row still carries it. */
  fingerprint: string;
}

/** Why a call did not go out although the tool was offered at the start. */
export const EXTERNAL_TOOL_REVOCATIONS = [
  /** The deployment or the workspace switched external servers off. */
  'external_mcp_disabled',
  /** The server was switched off or deleted. */
  'server_disabled',
  /** Blocked, changed since it was approved, no longer listed, or downgraded to read. */
  'tool_revoked',
  /** The run's user is no longer a full member of the workspace. */
  'membership_revoked',
] as const;
export type ExternalToolRevocation = (typeof EXTERNAL_TOOL_REVOCATIONS)[number];

export type ExternalCallOutcome =
  | { kind: 'answered'; isError: boolean; text: string }
  | { kind: 'revoked'; code: ExternalToolRevocation }
  | { kind: 'failed'; code: McpClientErrorCode | 'credential_unreadable' };

export interface ExternalToolSource {
  readonly tools: readonly ExternalToolBinding[];
  call(
    binding: ExternalToolBinding,
    args: Record<string, unknown>,
    options: { timeoutMs: number; maxTextChars: number; correlationId: string },
  ): Promise<ExternalCallOutcome>;
}

export type ExternalToolLoader = (input: {
  workspaceId: string;
  userId: string;
}) => Promise<ExternalToolSource | null>;

/**
 * Roles whose runs may use the workspace's external tools. A GUEST holds a
 * share of some pages (ADR-044), not the workspace, and the servers name where
 * the whole workspace's data may go.
 */
const FULL_MEMBER_ROLES: ReadonlySet<string> = new Set(['OWNER', 'ADMIN', 'MEMBER']);

const ACCESS_FROM_ROW: Readonly<Record<string, 'read' | 'write' | null>> = {
  BLOCKED: null,
  READ: 'read',
  WRITE: 'write',
};

const AUTH_KIND_FROM_ROW: Readonly<Record<string, ExternalMcpAuthKind>> = {
  NONE: 'none',
  BEARER: 'bearer',
  HEADER: 'header',
};

interface ToolRow {
  id: string;
  name: string;
  title: string | null;
  description: string;
  inputSchema: unknown;
  fingerprint: string;
  problem: string | null;
  available: boolean;
  access: string;
  approvedFingerprint: string | null;
}

interface ServerRow {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
}

/**
 * Whether a stored tool may be offered: approved for the fingerprint it has
 * now, listed at the last check, without a problem, on a server that is on,
 * and with a function name the providers accept. Pure, so the rule is tested
 * without a database.
 */
export function offerableTool(server: ServerRow, tool: ToolRow): ExternalToolBinding | null {
  const access = ACCESS_FROM_ROW[tool.access] ?? null;
  if (!server.enabled || access === null) return null;
  if (!tool.available || tool.problem !== null) return null;
  if (tool.approvedFingerprint !== tool.fingerprint) return null;
  const schema = tool.inputSchema;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const functionName = externalMcpFunctionName(server.key, tool.name);
  if (functionName.length > MODEL_FUNCTION_NAME_MAX) return null;
  return {
    functionName,
    toolId: tool.id,
    serverId: server.id,
    serverKey: server.key,
    serverName: server.name,
    toolName: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: schema as Record<string, unknown>,
    access,
    fingerprint: tool.fingerprint,
  };
}

/**
 * Whether the stored row still carries the approval the run was offered.
 * Upgrading a read tool to write keeps a read call valid; anything that
 * narrows or changes it stops the call.
 */
export function stillApproved(
  binding: ExternalToolBinding,
  server: ServerRow,
  tool: ToolRow,
): boolean {
  const now = offerableTool(server, tool);
  if (now === null || now.fingerprint !== binding.fingerprint) return false;
  return binding.access === 'read' || now.access === 'write';
}

export function createExternalToolLoader(input: {
  prisma: PrismaClient;
  env: WorkerEnv;
  logger: Logger;
  settings: (workspaceId?: string) => Promise<Settings>;
}): ExternalToolLoader {
  const { prisma, logger } = input;
  // Parsed once, like the provider key resolver: a malformed key must not
  // stop the worker, it only means no stored secret can be read.
  let encryptionKey: Buffer | null = null;
  try {
    encryptionKey = parseCredentialKey(input.env.CREDENTIAL_ENCRYPTION_KEY);
  } catch (error: unknown) {
    logger.error('Ignoring CREDENTIAL_ENCRYPTION_KEY for external MCP servers', error);
  }

  async function allowedFor(workspaceId: string, userId: string): Promise<boolean> {
    const settings = await input.settings(workspaceId);
    if (!settings['ai.externalMcpEnabled']) return false;
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    return member !== null && FULL_MEMBER_ROLES.has(member.role);
  }

  function secretOf(server: {
    workspaceId: string;
    key: string;
    secretCiphertext: string | null;
    secretIv: string | null;
    secretAuthTag: string | null;
    secretKeyVersion: number | null;
  }): string | null {
    if (
      server.secretCiphertext === null ||
      server.secretIv === null ||
      server.secretAuthTag === null ||
      server.secretKeyVersion === null
    ) {
      return null;
    }
    if (encryptionKey === null) throw new Error('No usable CREDENTIAL_ENCRYPTION_KEY');
    return decryptCredential({
      key: encryptionKey,
      purpose: externalMcpSecretPurpose(server.workspaceId, server.key),
      record: {
        ciphertext: server.secretCiphertext,
        iv: server.secretIv,
        authTag: server.secretAuthTag,
        keyVersion: server.secretKeyVersion,
      },
    });
  }

  return async ({ workspaceId, userId }) => {
    if (!(await allowedFor(workspaceId, userId))) return null;
    const servers = await prisma.externalMcpServer.findMany({
      where: { workspaceId, enabled: true },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        key: true,
        name: true,
        enabled: true,
        tools: { where: { access: { not: 'BLOCKED' } }, orderBy: { name: 'asc' } },
      },
    });
    const tools = servers.flatMap((server) =>
      server.tools
        .map((tool) => offerableTool(server, tool))
        .filter((binding): binding is ExternalToolBinding => binding !== null),
    );
    if (tools.length === 0) return null;

    return {
      tools,
      async call(binding, args, options) {
        if (!(await allowedFor(workspaceId, userId))) {
          const settings = await input.settings(workspaceId);
          return {
            kind: 'revoked',
            code: settings['ai.externalMcpEnabled']
              ? 'membership_revoked'
              : 'external_mcp_disabled',
          };
        }
        const row = await prisma.externalMcpTool.findUnique({
          where: { id: binding.toolId },
          include: { server: true },
        });
        if (row === null || row.server.workspaceId !== workspaceId || !row.server.enabled) {
          return { kind: 'revoked', code: 'server_disabled' };
        }
        if (!stillApproved(binding, row.server, row))
          return { kind: 'revoked', code: 'tool_revoked' };

        let secret: string | null;
        try {
          secret = secretOf(row.server);
        } catch {
          logger.warn('External MCP secret could not be decrypted for a tool call', {
            serverId: row.server.id,
            correlationId: options.correlationId,
          });
          return { kind: 'failed', code: 'credential_unreadable' };
        }

        const settings = await input.settings(workspaceId);
        const timeoutMs = Math.min(
          settings['ai.externalMcpTimeoutSeconds'] * 1_000,
          options.timeoutMs,
        );
        const started = performance.now();
        try {
          const result = await callMcpTool(
            {
              url: row.server.url,
              headers: externalMcpAuthHeaders({
                authKind: AUTH_KIND_FROM_ROW[row.server.authKind] ?? 'none',
                authHeaderName: row.server.authHeaderName,
                secret,
              }),
            },
            { name: row.name, arguments: args, maxTextChars: options.maxTextChars },
            { limits: { timeoutMs } },
          );
          logger.info('External MCP tool answered', {
            server: binding.serverKey,
            tool: binding.toolName,
            isError: result.isError,
            durationMs: Math.round(performance.now() - started),
            correlationId: options.correlationId,
          });
          return { kind: 'answered', isError: result.isError, text: resultText(result) };
        } catch (error) {
          const code = error instanceof McpClientError ? error.code : 'unreachable';
          logger.warn('External MCP tool call failed', {
            server: binding.serverKey,
            tool: binding.toolName,
            code,
            // The server's text, never shown to the model; the secret is cut out
            // in case the server quoted the request back.
            detail: error instanceof McpClientError ? redactSecret(error.detail, secret) : null,
            durationMs: Math.round(performance.now() - started),
            correlationId: options.correlationId,
          });
          return { kind: 'failed', code };
        }
      },
    };
  };
}

/**
 * What the model reads: the text parts, or the structured content when a
 * server sent only that. Both are the server's text and are fenced by the
 * caller.
 */
function resultText(result: {
  text: string;
  structuredContent: Record<string, unknown> | null;
}): string {
  if (result.text.trim() !== '') return result.text;
  if (result.structuredContent !== null) return JSON.stringify(result.structuredContent, null, 2);
  return '(leere Antwort)';
}
