import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from './primitives';

/**
 * External MCP servers for the built-in AI (issue #196, ADR-086).
 *
 * eXocortex is an MCP server for other clients (ADR-014, ADR-018); this is
 * the other direction: a workspace connects somebody else's server so that
 * the built-in AI can use its tools. Three decisions shape everything here:
 *
 * - **A person decides, at the browser.** Adding a server, changing where it
 *   points or what it is sent, and approving a tool are refused to every
 *   token and to every agent, because each of them widens what the agent may
 *   do or where this workspace's data may go.
 * - **A tool starts blocked, and an approval is bound to what was approved.**
 *   The server's own hints (`readOnlyHint` and friends) are shown, never
 *   trusted: a person classifies a tool as reading or writing. The approval
 *   records the tool's fingerprint, and a server that later changes the
 *   description or the schema has offered a different tool, which starts
 *   blocked again.
 * - **The secret never comes back out.** A response says whether one is
 *   stored and what it ends in, like `workspace-credentials.ts`.
 */

/**
 * The server's short name inside function names.
 *
 * Lowercase letters and digits only, no underscore, so the tool name a model
 * sees (`mcp_<key>__<tool>`) splits back unambiguously at the first `__`, and
 * short enough to leave most of the 64 characters a function name may have
 * to the tool itself. Fixed once created: changing it would rename every
 * tool under it.
 */
export const EXTERNAL_MCP_KEY_PATTERN = /^[a-z][a-z0-9]{1,11}$/u;
export const externalMcpKeySchema = z.string().regex(EXTERNAL_MCP_KEY_PATTERN);

/** The longest function name the model providers accept. */
export const MODEL_FUNCTION_NAME_MAX = 64;

/** The function name an external tool is offered to the model under. */
export function externalMcpFunctionName(serverKey: string, toolName: string): string {
  return `mcp_${serverKey}__${toolName}`;
}

/** The reverse of `externalMcpFunctionName`, or `null` for any other name. */
export function parseExternalMcpFunctionName(
  name: string,
): { serverKey: string; toolName: string } | null {
  if (!name.startsWith('mcp_')) return null;
  const rest = name.slice(4);
  const split = rest.indexOf('__');
  if (split <= 0) return null;
  const serverKey = rest.slice(0, split);
  const toolName = rest.slice(split + 2);
  if (!EXTERNAL_MCP_KEY_PATTERN.test(serverKey) || toolName === '') return null;
  return { serverKey, toolName };
}

export const EXTERNAL_MCP_LIMITS = {
  nameMaxChars: 80,
  urlMaxChars: 2_000,
  secretMinChars: 8,
  secretMaxChars: 4_000,
  serversPerWorkspace: 20,
  toolsPerServer: 64,
} as const;

/** Only Streamable HTTP so far; stdio is a later, separately gated stage. */
export const EXTERNAL_MCP_TRANSPORTS = ['streamable_http'] as const;
export const externalMcpTransportSchema = z.enum(EXTERNAL_MCP_TRANSPORTS);
export type ExternalMcpTransport = z.infer<typeof externalMcpTransportSchema>;

/**
 * How the secret is sent: not at all, as `Authorization: Bearer <secret>`, or
 * as the whole value of a header the person names (`X-API-Key`).
 */
export const EXTERNAL_MCP_AUTH_KINDS = ['none', 'bearer', 'header'] as const;
export const externalMcpAuthKindSchema = z.enum(EXTERNAL_MCP_AUTH_KINDS);
export type ExternalMcpAuthKind = z.infer<typeof externalMcpAuthKindSchema>;

export const EXTERNAL_MCP_STATUSES = ['unchecked', 'ok', 'error'] as const;
export const externalMcpStatusSchema = z.enum(EXTERNAL_MCP_STATUSES);
export type ExternalMcpStatus = z.infer<typeof externalMcpStatusSchema>;

/**
 * What a person decided a tool is. `blocked` is the default and the state a
 * changed tool falls back to; `read` and `write` are the person's word, not
 * the server's, and the run policy (ADR-030, ADR-070) treats them accordingly.
 */
export const EXTERNAL_MCP_TOOL_ACCESS = ['blocked', 'read', 'write'] as const;
export const externalMcpToolAccessSchema = z.enum(EXTERNAL_MCP_TOOL_ACCESS);
export type ExternalMcpToolAccess = z.infer<typeof externalMcpToolAccessSchema>;

/** Why a connection check failed, as a closed set (see `@exocortex/ai`'s client). */
export const EXTERNAL_MCP_ERROR_CODES = [
  'address_refused',
  'unauthorized',
  'forbidden',
  'not_found',
  'http_error',
  'timeout',
  'response_too_large',
  'protocol_error',
  'tool_not_found',
  'unreachable',
  'credential_unreadable',
] as const;
export const externalMcpErrorCodeSchema = z.enum(EXTERNAL_MCP_ERROR_CODES);
export type ExternalMcpErrorCode = z.infer<typeof externalMcpErrorCodeSchema>;

/** Why a listed tool cannot be approved, decided before anybody looks at it. */
export const EXTERNAL_MCP_TOOL_PROBLEMS = [
  'invalid_name',
  'name_too_long',
  'schema_too_large',
  'schema_invalid',
] as const;
export const externalMcpToolProblemSchema = z.enum(EXTERNAL_MCP_TOOL_PROBLEMS);
export type ExternalMcpToolProblem = z.infer<typeof externalMcpToolProblemSchema>;

export const externalMcpToolHintsSchema = z.object({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export type ExternalMcpToolHints = z.infer<typeof externalMcpToolHintsSchema>;

export const externalMcpToolSchema = z.object({
  id: idSchema,
  name: z.string(),
  /** What the model would see it as, once approved. */
  functionName: z.string(),
  title: z.string().nullable(),
  /** The server's text. Foreign content: shown to a person, never obeyed. */
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  /** What the server says about the tool. Shown, never used as a decision. */
  hints: externalMcpToolHintsSchema,
  problem: externalMcpToolProblemSchema.nullable(),
  /** Listed by the server at the last successful check. */
  available: z.boolean(),
  access: externalMcpToolAccessSchema,
  /**
   * The tool was approved once and has changed since, so it fell back to
   * `blocked`. Said separately so the screen can explain why.
   */
  changedSinceApproval: z.boolean(),
  approvedAt: isoDateTimeSchema.nullable(),
  firstSeenAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
});
export type ExternalMcpTool = z.infer<typeof externalMcpToolSchema>;

export const externalMcpServerSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  key: z.string(),
  name: z.string(),
  transport: externalMcpTransportSchema,
  url: z.string(),
  enabled: z.boolean(),
  authKind: externalMcpAuthKindSchema,
  authHeaderName: z.string().nullable(),
  /** Whether a secret is stored. Never the secret. */
  secretConfigured: z.boolean(),
  /** The last four characters, or empty for a secret too short to show any of. */
  secretHint: z.string(),
  status: externalMcpStatusSchema,
  lastCheckedAt: isoDateTimeSchema.nullable(),
  lastOkAt: isoDateTimeSchema.nullable(),
  lastErrorCode: externalMcpErrorCodeSchema.nullable(),
  /** A cut, single-line description of the last failure. Never a secret. */
  lastErrorDetail: z.string().nullable(),
  serverName: z.string().nullable(),
  serverVersion: z.string().nullable(),
  protocolVersion: z.string().nullable(),
  /** The server's `instructions`, cut. Foreign text, never handed to a model as ours. */
  instructions: z.string().nullable(),
  /** The server listed more tools than are kept. */
  toolsTruncated: z.boolean(),
  tools: z.array(externalMcpToolSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type ExternalMcpServer = z.infer<typeof externalMcpServerSchema>;

export const externalMcpServerListResponseSchema = z.object({
  servers: z.array(externalMcpServerSchema),
  /** Whether the deployment allows external MCP servers (`ai.externalMcpEnabled`). */
  enabled: z.boolean(),
  /** Whether a secret can be stored (`CREDENTIAL_ENCRYPTION_KEY`). */
  credentialsAvailable: z.boolean(),
});
export type ExternalMcpServerListResponse = z.infer<typeof externalMcpServerListResponseSchema>;

export const externalMcpServerResponseSchema = z.object({ server: externalMcpServerSchema });
export type ExternalMcpServerResponse = z.infer<typeof externalMcpServerResponseSchema>;

const nameSchema = z.string().trim().min(1).max(EXTERNAL_MCP_LIMITS.nameMaxChars);
const urlSchema = z
  .string()
  .trim()
  .max(EXTERNAL_MCP_LIMITS.urlMaxChars)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.username === '' && url.password === '';
    } catch {
      return false;
    }
  }, 'An https address without credentials in it');
/** A header name in the RFC 9110 token alphabet, and never one HTTP itself owns. */
const headerNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/u)
  .refine(
    (value) =>
      !['host', 'content-length', 'content-type', 'accept', 'connection', 'cookie'].includes(
        value.toLowerCase(),
      ) && !value.toLowerCase().startsWith('mcp-'),
    'A header the transport sets itself',
  );
const secretSchema = z
  .string()
  .trim()
  .min(EXTERNAL_MCP_LIMITS.secretMinChars)
  .max(EXTERNAL_MCP_LIMITS.secretMaxChars)
  .refine((value) => !/[\r\n]/u.test(value), 'One line');

export const createExternalMcpServerRequestSchema = z
  .object({
    key: externalMcpKeySchema,
    name: nameSchema,
    url: urlSchema,
    authKind: externalMcpAuthKindSchema.default('none'),
    authHeaderName: headerNameSchema.nullable().optional(),
    secret: secretSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.authKind !== 'none' && value.secret === undefined) {
      ctx.addIssue({ code: 'custom', path: ['secret'], message: 'A secret for this auth kind' });
    }
    if (value.authKind === 'none' && value.secret !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['secret'], message: 'No secret without an auth kind' });
    }
    if (value.authKind === 'header' && (value.authHeaderName ?? null) === null) {
      ctx.addIssue({ code: 'custom', path: ['authHeaderName'], message: 'A header name' });
    }
  });
export type CreateExternalMcpServerRequest = z.infer<typeof createExternalMcpServerRequestSchema>;

/**
 * A change. Absent fields stay as they are. Changing `url` sends every tool
 * back to `blocked`, because a different address may be a different server;
 * a new `secret` does not, because it is the same server asked differently.
 */
export const updateExternalMcpServerRequestSchema = z
  .object({
    name: nameSchema.optional(),
    url: urlSchema.optional(),
    enabled: z.boolean().optional(),
    authKind: externalMcpAuthKindSchema.optional(),
    authHeaderName: headerNameSchema.nullable().optional(),
    /** A new secret. `null` removes the stored one. */
    secret: secretSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field');
export type UpdateExternalMcpServerRequest = z.infer<typeof updateExternalMcpServerRequestSchema>;

export const setExternalMcpToolAccessRequestSchema = z.object({
  access: externalMcpToolAccessSchema,
});
export type SetExternalMcpToolAccessRequest = z.infer<typeof setExternalMcpToolAccessRequestSchema>;

export const deleteExternalMcpServerResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteExternalMcpServerResponse = z.infer<typeof deleteExternalMcpServerResponseSchema>;
