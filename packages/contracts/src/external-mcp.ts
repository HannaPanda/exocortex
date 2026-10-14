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

/** The secret's purpose, bound into the AES-GCM tag (ADR-086). */
export function externalMcpSecretPurpose(workspaceId: string, key: string): string {
  return `external-mcp:${workspaceId}:${key}`;
}

/** The headers a stored credential becomes. Never logged, never returned. */
export function externalMcpAuthHeaders(input: {
  authKind: ExternalMcpAuthKind;
  authHeaderName: string | null;
  secret: string | null;
}): Record<string, string> {
  if (input.authKind === 'none' || input.secret === null) return {};
  if (input.authKind === 'bearer') return { authorization: `Bearer ${input.secret}` };
  return input.authHeaderName === null ? {} : { [input.authHeaderName]: input.secret };
}

/**
 * Removes a secret from text a server sent back.
 *
 * A server answering 401 may quote the request, and an error detail is
 * stored and shown. Cheap insurance: the person reading it owns the secret,
 * but the audit trail and the logs are read by more people than that.
 */
export function redactSecret(text: string, secret: string | null): string {
  if (secret === null || secret.length < 4) return text;
  return text.split(secret).join('[redacted]');
}

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

/** Words in a tool name that say it changes something. Any of them wins. */
const WRITING_WORDS: ReadonlySet<string> = new Set([
  'add',
  'append',
  'apply',
  'approve',
  'archive',
  'assign',
  'book',
  'cancel',
  'change',
  'check',
  'clear',
  'close',
  'complete',
  'create',
  'delete',
  'destroy',
  'disable',
  'drop',
  'edit',
  'enable',
  'erase',
  'exec',
  'execute',
  'generate',
  'import',
  'insert',
  'invite',
  'log',
  'mark',
  'merge',
  'modify',
  'move',
  'patch',
  'post',
  'publish',
  'purge',
  'put',
  'record',
  'reject',
  'remove',
  'rename',
  'reset',
  'restore',
  'run',
  'save',
  'schedule',
  'send',
  'set',
  'start',
  'stop',
  'store',
  'submit',
  'sync',
  'toggle',
  'trigger',
  'uncheck',
  'update',
  'upload',
  'upsert',
  'wipe',
  'write',
]);

/** Words in a tool name that say it only looks. */
const READING_WORDS: ReadonlySet<string> = new Set([
  'analytics',
  'briefing',
  'compare',
  'count',
  'dashboard',
  'describe',
  'download',
  'explain',
  'export',
  'fetch',
  'find',
  'get',
  'guide',
  'history',
  'info',
  'inspect',
  'list',
  'lookup',
  'overview',
  'preview',
  'query',
  'read',
  'search',
  'show',
  'stats',
  'status',
  'summary',
  'view',
]);

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word !== '');
}

/**
 * What a tool probably is, so a person approving sixty tools confirms a list
 * instead of judging each one (issue #196).
 *
 * A suggestion and never a decision: nothing is approved until a person
 * applies it. It errs towards `write`, because a reading tool classed as
 * writing is only refused more often, while a writing tool classed as reading
 * escapes the write lock (ADR-030). So a single writing word in the name, or
 * a server that says the tool writes, makes it `write`; it is `read` only when
 * the server says so or the name says so, and anything unclear stays `write`.
 * The description is not consulted: it is the server's prose, and the name is
 * what the model calls.
 */
export function suggestExternalMcpToolAccess(tool: {
  name: string;
  hints: ExternalMcpToolHints;
}): 'read' | 'write' {
  if (tool.hints.readOnlyHint === false || tool.hints.destructiveHint === true) return 'write';
  const words = nameWords(tool.name);
  if (words.some((word) => WRITING_WORDS.has(word))) return 'write';
  if (tool.hints.readOnlyHint === true) return 'read';
  return words.some((word) => READING_WORDS.has(word)) ? 'read' : 'write';
}

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
  /** `suggestExternalMcpToolAccess`: what the screen offers to apply, never applied by itself. */
  suggestedAccess: z.enum(['read', 'write']),
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
  /**
   * A person declared the answers their own data: still fenced, but reading
   * them does not lock the run's writes (ADR-030). Off again when the address
   * changes.
   */
  trusted: z.boolean(),
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
    trusted: z.boolean().optional(),
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

/**
 * Several decisions at once, each the same as the single one: applying the
 * suggestions after a person has looked at the list. One transaction, so a
 * tool that cannot be approved refuses the whole set.
 */
export const setExternalMcpToolsAccessRequestSchema = z.object({
  changes: z
    .array(z.object({ toolId: idSchema, access: externalMcpToolAccessSchema }))
    .min(1)
    .max(EXTERNAL_MCP_LIMITS.toolsPerServer)
    .refine(
      (changes) => new Set(changes.map((change) => change.toolId)).size === changes.length,
      'Each tool once',
    ),
});
export type SetExternalMcpToolsAccessRequest = z.infer<
  typeof setExternalMcpToolsAccessRequestSchema
>;

export const deleteExternalMcpServerResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteExternalMcpServerResponse = z.infer<typeof deleteExternalMcpServerResponseSchema>;
