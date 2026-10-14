import {
  type ExternalMcpAuthKind,
  type ExternalMcpErrorCode,
  externalMcpErrorCodeSchema,
  externalMcpFunctionName,
  type ExternalMcpServer,
  type ExternalMcpStatus,
  type ExternalMcpTool,
  type ExternalMcpToolAccess,
  externalMcpToolHintsSchema,
  type ExternalMcpToolProblem,
  externalMcpToolProblemSchema,
} from '@exocortex/contracts';
import { type Prisma } from '@exocortex/database';

/**
 * Rows to wire shapes for external MCP servers (issue #196, ADR-086).
 *
 * The one rule here: the four secret columns are read for `secretConfigured`
 * and `secretHint` and for nothing else. Nothing that holds ciphertext ever
 * reaches the response object.
 */

export const externalMcpServerInclude = {
  tools: { orderBy: { name: 'asc' } },
} satisfies Prisma.ExternalMcpServerInclude;

export type ExternalMcpServerRow = Prisma.ExternalMcpServerGetPayload<{
  include: typeof externalMcpServerInclude;
}>;
type ExternalMcpToolRow = ExternalMcpServerRow['tools'][number];

const AUTH_KIND: Record<ExternalMcpServerRow['authKind'], ExternalMcpAuthKind> = {
  NONE: 'none',
  BEARER: 'bearer',
  HEADER: 'header',
};
export const AUTH_KIND_ROW: Record<ExternalMcpAuthKind, ExternalMcpServerRow['authKind']> = {
  none: 'NONE',
  bearer: 'BEARER',
  header: 'HEADER',
};
const STATUS: Record<ExternalMcpServerRow['status'], ExternalMcpStatus> = {
  UNCHECKED: 'unchecked',
  OK: 'ok',
  ERROR: 'error',
};
const ACCESS: Record<ExternalMcpToolRow['access'], ExternalMcpToolAccess> = {
  BLOCKED: 'blocked',
  READ: 'read',
  WRITE: 'write',
};
export const ACCESS_ROW: Record<ExternalMcpToolAccess, ExternalMcpToolRow['access']> = {
  blocked: 'BLOCKED',
  read: 'READ',
  write: 'WRITE',
};

function errorCode(value: string | null): ExternalMcpErrorCode | null {
  const parsed = externalMcpErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function problem(value: string | null): ExternalMcpToolProblem | null {
  const parsed = externalMcpToolProblemSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function objectOf(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toTool(serverKey: string, row: ExternalMcpToolRow): ExternalMcpTool {
  const hints = externalMcpToolHintsSchema.safeParse(row.hints);
  return {
    id: row.id,
    name: row.name,
    functionName: externalMcpFunctionName(serverKey, row.name),
    title: row.title,
    description: row.description,
    inputSchema: objectOf(row.inputSchema),
    hints: hints.success ? hints.data : {},
    problem: problem(row.problem),
    available: row.available,
    access: ACCESS[row.access],
    changedSinceApproval:
      row.access === 'BLOCKED' &&
      row.approvedFingerprint !== null &&
      row.approvedFingerprint !== row.fingerprint,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

export function toExternalMcpServer(row: ExternalMcpServerRow): ExternalMcpServer {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    key: row.key,
    name: row.name,
    transport: 'streamable_http',
    url: row.url,
    enabled: row.enabled,
    authKind: AUTH_KIND[row.authKind],
    authHeaderName: row.authHeaderName,
    secretConfigured: row.secretCiphertext !== null,
    secretHint: row.secretHint ?? '',
    status: STATUS[row.status],
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastOkAt: row.lastOkAt?.toISOString() ?? null,
    lastErrorCode: errorCode(row.lastErrorCode),
    lastErrorDetail: row.lastErrorDetail,
    serverName: row.serverName,
    serverVersion: row.serverVersion,
    protocolVersion: row.protocolVersion,
    instructions: row.instructions,
    toolsTruncated: row.toolsTruncated,
    tools: row.tools.map((tool) => toTool(row.key, tool)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
