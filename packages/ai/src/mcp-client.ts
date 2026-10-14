import { createHash } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

import {
  createGuardedFetch,
  type GuardedFetchOptions,
  RefusedAddressError,
  ResponseTooLargeError,
} from './guarded-fetch';

/**
 * A client for somebody else's MCP server (issue #196, ADR-086).
 *
 * eXocortex has been an MCP *server* since ADR-014; this is the other
 * direction, and it is deliberately the official SDK rather than a second
 * hand-written protocol. What this file adds around the SDK is the part the
 * SDK cannot know: every request goes through `createGuardedFetch`, every
 * operation has a deadline, every answer is cut to a size, and every failure
 * comes out as one of a closed set of codes that a status line and a run
 * timeline can name without quoting the server.
 *
 * One connection per operation. A discovery or a tool call connects,
 * initializes, does its one thing and closes, so nothing outlives the request
 * that needed it: no pooled session carrying a credential that was revoked a
 * minute ago, and no socket a worker has to remember to tear down. The cost is
 * one `initialize` round trip per call, which is cheap next to a model turn.
 *
 * Everything that comes back -- names, descriptions, schemas, `instructions`,
 * results -- is the server's text, not ours. Nothing here interprets it as an
 * instruction or a permission; `readOnlyHint` and friends are carried along as
 * what the server *says*, for a person to read, never as a decision.
 */

/** Where one server is reached and what it is sent. */
export interface McpEndpoint {
  url: string;
  /** Sent on every request, credentials included. Never logged. */
  headers: Record<string, string>;
}

export interface McpClientLimits {
  /** Deadline for one whole operation, connect included. */
  timeoutMs: number;
  /** Tools beyond this many are dropped and the discovery says so. */
  maxTools: number;
  /** A tool whose input schema serializes larger than this is not offered. */
  maxSchemaBytes: number;
  /** Upper bound for one HTTP response body. */
  maxResponseBytes: number;
}

export const DEFAULT_MCP_CLIENT_LIMITS: McpClientLimits = {
  timeoutMs: 20_000,
  maxTools: 64,
  maxSchemaBytes: 16_384,
  maxResponseBytes: 2_000_000,
};

const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_TITLE_CHARS = 200;
const MAX_INSTRUCTIONS_CHARS = 4_000;
const MAX_ERROR_CHARS = 300;
/** Pages of `tools/list` before a server that keeps paginating is cut off. */
const MAX_LIST_PAGES = 10;

/**
 * Why an operation failed, as a closed set.
 *
 * A code rather than the server's message, because the message is the
 * server's text and ends up on a settings screen and in a run timeline; the
 * code is ours. `detail` carries a cut, single-line version for a person.
 */
export const MCP_CLIENT_ERROR_CODES = [
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
] as const;
export type McpClientErrorCode = (typeof MCP_CLIENT_ERROR_CODES)[number];

export class McpClientError extends Error {
  constructor(
    readonly code: McpClientErrorCode,
    readonly detail: string,
    readonly status?: number,
  ) {
    super(`MCP ${code}: ${detail}`);
    this.name = 'McpClientError';
  }
}

/** Why a listed tool cannot be offered, decided before anybody approves it. */
export type McpToolProblem = 'invalid_name' | 'schema_too_large' | 'schema_invalid';

/** What the server says about a tool. Hints, not permissions. */
export interface McpToolHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface DiscoveredMcpTool {
  name: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  hints: McpToolHints;
  /**
   * sha256 over everything a person approves when they approve this tool:
   * name, title, description, schema and hints. A change to any of them is a
   * different tool, and an approval bound to the old hash does not carry over.
   */
  fingerprint: string;
  problem: McpToolProblem | null;
}

export interface McpDiscovery {
  protocolVersion: string | null;
  serverName: string | null;
  serverVersion: string | null;
  /** The server's `instructions`, cut. Foreign text, shown to people only. */
  instructions: string | null;
  tools: DiscoveredMcpTool[];
  /** More tools were listed than `maxTools` allows. */
  truncated: boolean;
  /** Whether the server announced `tools.listChanged`. */
  listChanged: boolean;
}

export interface McpToolCallResult {
  isError: boolean;
  /** The text parts of the result, joined. Non-text parts are named, not inlined. */
  text: string;
  structuredContent: Record<string, unknown> | null;
  /** Whether `text` was cut to the limit. */
  truncated: boolean;
}

export interface McpOperationOptions {
  limits?: Partial<McpClientLimits>;
  signal?: AbortSignal;
  /** Only for tests; see `GuardedFetchOptions.insecureForTests`. */
  insecureForTests?: GuardedFetchOptions['insecureForTests'];
}

/** Characters a tool name may use so it can become part of a model's function name. */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** JSON with sorted keys, so the fingerprint does not depend on key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function mcpToolFingerprint(tool: {
  name: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  hints: McpToolHints;
}): string {
  return createHash('sha256').update(canonicalJson(tool)).digest('hex');
}

function pickHints(annotations: unknown): McpToolHints {
  if (annotations === null || typeof annotations !== 'object') return {};
  const source = annotations as Record<string, unknown>;
  const hints: McpToolHints = {};
  for (const key of [
    'readOnlyHint',
    'destructiveHint',
    'idempotentHint',
    'openWorldHint',
  ] as const) {
    const value = source[key];
    if (typeof value === 'boolean') hints[key] = value;
  }
  return hints;
}

function toDiscoveredTool(
  raw: {
    name: string;
    title?: string | undefined;
    description?: string | undefined;
    inputSchema: unknown;
    annotations?: unknown;
  },
  limits: McpClientLimits,
): DiscoveredMcpTool {
  const title =
    typeof raw.title === 'string' && raw.title.trim() !== ''
      ? oneLine(raw.title, MAX_TITLE_CHARS)
      : null;
  const description = cut((raw.description ?? '').trim(), MAX_DESCRIPTION_CHARS);
  const hints = pickHints(raw.annotations);

  let problem: McpToolProblem | null = null;
  let inputSchema: Record<string, unknown> = {};
  const schema = raw.inputSchema;
  if (
    schema === null ||
    typeof schema !== 'object' ||
    Array.isArray(schema) ||
    (schema as Record<string, unknown>)['type'] !== 'object'
  ) {
    problem = 'schema_invalid';
  } else if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > limits.maxSchemaBytes) {
    problem = 'schema_too_large';
  } else {
    inputSchema = schema as Record<string, unknown>;
  }
  if (problem === null && !TOOL_NAME_PATTERN.test(raw.name)) problem = 'invalid_name';

  const name = cut(raw.name, 128);
  return {
    name,
    title,
    description,
    inputSchema,
    hints,
    fingerprint: mcpToolFingerprint({ name, title, description, inputSchema, hints }),
    problem,
  };
}

/** Maps whatever the SDK, the guard or the socket threw onto one code. */
export function classifyMcpError(error: unknown, signal?: AbortSignal): McpClientError {
  if (error instanceof McpClientError) return error;
  if (error instanceof RefusedAddressError) {
    return new McpClientError('address_refused', `${error.reason}: ${error.detail}`);
  }
  if (error instanceof ResponseTooLargeError) {
    return new McpClientError('response_too_large', `over ${String(error.limit)} bytes`);
  }
  // The guard's refusal arrives wrapped when the SDK caught it first.
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof RefusedAddressError || cause instanceof ResponseTooLargeError) {
    return classifyMcpError(cause, signal);
  }
  if (signal?.aborted === true) {
    return new McpClientError('timeout', 'the operation did not finish in time');
  }
  if (error instanceof StreamableHTTPError) {
    const status = error.code;
    const detail = oneLine(error.message, MAX_ERROR_CHARS);
    if (status === 401) return new McpClientError('unauthorized', detail, status);
    if (status === 403) return new McpClientError('forbidden', detail, status);
    if (status === 404) return new McpClientError('not_found', detail, status);
    return new McpClientError('http_error', detail, status);
  }
  if (error instanceof McpError) {
    if (error.code === -32001) {
      return new McpClientError('timeout', 'the server did not answer in time');
    }
    return new McpClientError('protocol_error', oneLine(error.message, MAX_ERROR_CHARS));
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/\b401\b|unauthori[sz]ed/i.test(message)) {
    return new McpClientError('unauthorized', oneLine(message, MAX_ERROR_CHARS), 401);
  }
  return new McpClientError('unreachable', oneLine(message, MAX_ERROR_CHARS));
}

/**
 * Connects, runs `work`, closes -- whatever happens in between.
 *
 * The deadline is one `AbortSignal` for the whole operation: it aborts the
 * fetches underneath (so no socket outlives it) and is handed to every SDK
 * request as well, so the SDK's own per-request timer is never the only one.
 */
async function withClient<T>(
  endpoint: McpEndpoint,
  options: McpOperationOptions,
  work: (client: Client, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const limits = { ...DEFAULT_MCP_CLIENT_LIMITS, ...options.limits };
  const deadline = AbortSignal.timeout(limits.timeoutMs);
  // Aborted by the guard when a body goes over the limit, so the operation
  // ends there instead of at the deadline (the SDK reads SSE bodies in the
  // background and would otherwise wait for an answer that never comes).
  const overflow = new AbortController();
  let fatal: ResponseTooLargeError | undefined;
  const signal = AbortSignal.any(
    options.signal ? [deadline, overflow.signal, options.signal] : [deadline, overflow.signal],
  );

  const guarded = createGuardedFetch({
    maxResponseBytes: limits.maxResponseBytes,
    onResponseTooLarge: (error) => {
      fatal = error;
      overflow.abort(error);
    },
    ...(options.insecureForTests ? { insecureForTests: options.insecureForTests } : {}),
  });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    fetch: (url, init) => guarded(url, { ...init, signal }),
    requestInit: { headers: endpoint.headers },
    // A dropped stream is reported, not retried behind the caller's back: the
    // caller decides whether a tool call may run twice.
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const client = new Client(
    { name: 'eXocortex', version: '1.0.0' },
    // No sampling, no roots, no elicitation: a foreign server gets to answer
    // our requests and nothing else, so it can never ask our model a question
    // or read a file list through us.
    { capabilities: {} },
  );

  try {
    await client.connect(transport, { signal, timeout: limits.timeoutMs });
    return await work(client, signal);
  } catch (error) {
    throw classifyMcpError(fatal ?? error, signal);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Handshake plus `tools/list`: what a server is and what it offers. */
export async function discoverMcpServer(
  endpoint: McpEndpoint,
  options: McpOperationOptions = {},
): Promise<McpDiscovery> {
  const limits = { ...DEFAULT_MCP_CLIENT_LIMITS, ...options.limits };
  return withClient(endpoint, options, async (client, signal) => {
    const version = client.getServerVersion();
    const capabilities = client.getServerCapabilities();
    const instructions = client.getInstructions();

    const tools: DiscoveredMcpTool[] = [];
    let truncated = false;
    if (capabilities?.tools !== undefined) {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const listed = await client.listTools(cursor === undefined ? {} : { cursor }, {
          signal,
          timeout: limits.timeoutMs,
        });
        for (const raw of listed.tools) {
          if (tools.length >= limits.maxTools) {
            truncated = true;
            break;
          }
          tools.push(toDiscoveredTool(raw, limits));
        }
        cursor = listed.nextCursor;
        if (truncated || cursor === undefined) break;
        if (page === MAX_LIST_PAGES - 1) truncated = true;
      }
    }

    return {
      protocolVersion: transportProtocolVersion(client),
      serverName: version?.name ? oneLine(version.name, MAX_TITLE_CHARS) : null,
      serverVersion: version?.version ? oneLine(version.version, 60) : null,
      instructions:
        typeof instructions === 'string' && instructions.trim() !== ''
          ? cut(instructions.trim(), MAX_INSTRUCTIONS_CHARS)
          : null,
      tools,
      truncated,
      listChanged: capabilities?.tools?.listChanged === true,
    };
  });
}

function transportProtocolVersion(client: Client): string | null {
  const transport = client.transport;
  if (transport instanceof StreamableHTTPClientTransport) {
    return transport.protocolVersion ?? null;
  }
  return null;
}

/**
 * One `tools/call`.
 *
 * `maxTextChars` bounds what the caller receives, separately from the byte
 * limit on the wire: the wire limit protects the process, this one protects
 * a model's context. Image, audio and resource parts are named rather than
 * inlined, because a tool result is text for a model here and an embedded
 * blob would only spend its budget.
 */
export async function callMcpTool(
  endpoint: McpEndpoint,
  input: { name: string; arguments: Record<string, unknown>; maxTextChars: number },
  options: McpOperationOptions = {},
): Promise<McpToolCallResult> {
  const limits = { ...DEFAULT_MCP_CLIENT_LIMITS, ...options.limits };
  return withClient(endpoint, options, async (client, signal) => {
    const result = await client.callTool(
      { name: input.name, arguments: input.arguments },
      undefined,
      { signal, timeout: limits.timeoutMs },
    );

    const parts: string[] = [];
    const content = Array.isArray(result.content) ? result.content : [];
    for (const part of content as { type?: unknown; text?: unknown }[]) {
      if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
      else parts.push(`[${typeof part.type === 'string' ? part.type : 'unknown'} content omitted]`);
    }
    const joined = parts.join('\n\n');
    const structured = result.structuredContent;
    return {
      isError: result.isError === true,
      text: cut(joined, input.maxTextChars),
      structuredContent:
        structured !== null && typeof structured === 'object' && !Array.isArray(structured)
          ? (structured as Record<string, unknown>)
          : null,
      truncated: joined.length > input.maxTextChars,
    };
  });
}
