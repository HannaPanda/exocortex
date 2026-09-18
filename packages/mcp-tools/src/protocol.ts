import { announceAgentSession, clientLabelFrom } from './agent-session.js';
import { type ExocortexApiClient, ExocortexApiError } from './client.js';
import { type WriteConfirmationGate } from './confirm.js';
import { buildServerInstructions } from './instructions.js';
import { getMcpPrompt, listMcpPrompts } from './prompts.js';
import { listMcpResources, listMcpResourceTemplates, readMcpResource } from './resources.js';
import { type AnyToolDefinition, ToolInputValidationError } from './tool.js';

/**
 * The MCP method dispatch, with no transport in it.
 *
 * There are two transports now: the stdio bin in `apps/mcp`, which a client
 * starts as a subprocess, and the Streamable HTTP endpoint in `apps/api`,
 * which a remote client such as ChatGPT talks to over the network. They frame
 * messages very differently and share every line of what a message *means*, so
 * the meaning lives here and each transport only carries bytes.
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** MCP's own code for `resources/read` on a URI this caller cannot have. */
  resourceNotFound: -32002,
} as const;

/**
 * Protocol revisions this server implements. The newest is offered when a
 * client asks for something we do not know; `initialize` echoes the client's
 * own version when we do know it, which is what the specification asks for.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const DEFAULT_SERVER_INFO = { name: 'exocortex', version: '0.1.0' } as const;

/**
 * Just enough of `@exocortex/logger` to report an unknown method. The tool
 * catalogue is a leaf package and must not depend on the logger package
 * (`scripts/dependency-graph.mjs`), so the shape is declared structurally and
 * every caller passes its own logger in.
 */
export interface McpProtocolLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface McpRequestHandlerOptions {
  client: ExocortexApiClient;
  /**
   * The tools this connection may list *and* call. Restricting the list is the
   * only thing that restricts calling: `tools/call` resolves names against this
   * array, not against the full catalogue, so a connection served a subset
   * cannot reach the rest of it by guessing a name.
   */
  tools: readonly AnyToolDefinition[];
  /** Two-step confirmation. Omit to run without one, whatever `confirm` says. */
  gate?: WriteConfirmationGate;
  /**
   * How much of the catalogue the gate covers.
   *
   * `irreversible` (the default) spends it on the handful of calls no snapshot
   * undoes. `all` puts it in front of every mutating tool, which is what this
   * used to do unconditionally; it is a deployment's choice, not a default,
   * because the cost lands on every ordinary write and the benefit is thin.
   * See `ToolDefinition.irreversible`.
   */
  confirm?: 'irreversible' | 'all';
  /**
   * Mixed into the gate's key so two callers can never confirm each other's
   * pending write. Irrelevant for stdio, where the gate lives in a subprocess
   * that serves exactly one client; essential for the HTTP endpoint, where one
   * gate instance serves every user of the deployment.
   */
  principal?: string;
  /**
   * Whether this connection also serves resources and prompts, the two halves
   * of the protocol a *person* drives rather than the model.
   *
   * Off unless asked for, and asked for only on the full catalogue: the
   * research and memory surfaces exist because a client handed everything
   * reaches for the wrong thing, and an attach menu full of pages would undo
   * exactly that. A surface that offers neither still answers both list calls
   * truthfully with an empty array, so no handshake breaks.
   */
  context?: boolean;
  /**
   * The working session every write of this connection belongs to (ADR-022).
   *
   * Announced at `initialize` and carried on every REST call after it, which
   * is what lets an administrator later ask what one agent touched and take
   * all of it back at once. Omit it and the connection writes exactly as
   * before, unjournalled: the transport that has no stable identity to offer
   * should not invent one.
   */
  agentSession?: { externalId: string; transport: 'stdio' | 'http' };
  serverInfo?: { name: string; version: string };
  logger?: McpProtocolLogger;
}

export type McpRequestHandler = (request: JsonRpcRequest) => Promise<JsonRpcResponse | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toMcpResult(result: {
  text: string;
  data?: unknown;
  isError?: boolean;
}): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: result.text }],
    structuredContent: result.data,
    isError: result.isError ?? false,
  };
}

/**
 * Builds the MCP method dispatcher. Returns `null` for notifications (a
 * request without an `id`), which get no response at all — writing nothing is
 * the correct behaviour there, not an omission.
 */
export function createMcpRequestHandler(options: McpRequestHandlerOptions): McpRequestHandler {
  const { client, tools, gate, principal, logger } = options;
  const context = options.context ?? false;
  const confirm = options.confirm ?? 'irreversible';
  const serverInfo = options.serverInfo ?? DEFAULT_SERVER_INFO;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  // Stamped here rather than only at `initialize`, because over HTTP every
  // message arrives as its own request with its own handler and its own
  // client: the handshake happened, but not in this process's memory. The
  // label is refined below when an `initialize` does pass through.
  if (options.agentSession !== undefined) {
    client.setAgentSession?.({ externalId: options.agentSession.externalId });
  }

  async function callTool(
    tool: AnyToolDefinition,
    rawInput: unknown,
  ): Promise<{ text: string; data?: unknown; isError?: boolean }> {
    const gated = tool.mutating && (confirm === 'all' || tool.irreversible);
    if (gated && gate !== undefined) {
      const target = tool.targetOf(rawInput);
      if (target !== null) {
        const check = gate.check({ toolName: tool.name, target, payload: rawInput, principal });
        if (check.state === 'pending') {
          // What the call would do goes *before* the prompt that asks about it.
          // A model that reads the first line and repeats the call has then
          // read the consequence; a footer after ten lines of gate wording has
          // no such guarantee.
          const preview = await tool.previewOf(client, rawInput);
          // A confirmation prompt is not a protocol failure: the model must
          // be able to read it and call the tool again to confirm.
          return {
            text: preview === null ? check.message : `${preview}\n\n${check.message}`,
            isError: false,
          };
        }
      }
    }

    try {
      return await tool.run(client, rawInput);
    } catch (error) {
      if (error instanceof ExocortexApiError) {
        return { text: `Fehler (${error.code}): ${error.message}`, isError: true };
      }
      if (error instanceof ToolInputValidationError) {
        const paths = error.issues.map(
          (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        );
        return { text: `Ungültige Eingabe:\n${paths.join('\n')}`, isError: true };
      }
      throw error;
    }
  }

  return async function handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const hasId = typeof request.id === 'string' || typeof request.id === 'number';
    const id = hasId ? (request.id as string | number) : null;

    // Notifications (no id) never get a response, per JSON-RPC 2.0.
    const respond = (result: unknown): JsonRpcResponse | null =>
      hasId ? { jsonrpc: '2.0', id, result } : null;
    const respondError = (code: number, message: string, data?: unknown): JsonRpcResponse | null =>
      hasId
        ? {
            jsonrpc: '2.0',
            id,
            error: data === undefined ? { code, message } : { code, message, data },
          }
        : null;

    switch (request.method) {
      case 'initialize': {
        const params = isRecord(request.params) ? request.params : {};
        if (options.agentSession !== undefined) {
          await announceAgentSession({
            client,
            externalId: options.agentSession.externalId,
            transport: options.agentSession.transport,
            label: clientLabelFrom(params),
            onError: (reason) => {
              logger?.warn('Agent session could not be announced', { reason });
            },
          });
        }
        // The deployment's own filing and writing rules, for the clients that
        // can act on them. A catalogue without `exo_page_create` is one of the
        // two tiny surfaces shaped for a foreign client (research, memory);
        // instructions about where a page belongs would be noise there.
        const instructions = byName.has('exo_page_create')
          ? await buildServerInstructions(client)
          : null;
        return respond(buildInitializeResult(params, context, serverInfo, instructions));
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;

      case 'ping':
        return respond({});

      case 'tools/list':
        return respond({ tools: toMcpToolList(tools) });

      case 'tools/call': {
        const params = isRecord(request.params) ? request.params : {};
        const name = typeof params.name === 'string' ? params.name : '';
        const tool = byName.get(name);
        if (tool === undefined) {
          return respondError(JSON_RPC_ERROR_CODES.invalidParams, `Unknown tool: ${name}`);
        }
        const result = await callTool(tool, params.arguments ?? {});
        return respond(toMcpResult(result));
      }

      default:
        // Answered rather than refused even where this connection offers none:
        // a client that advertises no capability for resources or prompts
        // still probes them on connect, and an empty list keeps the handshake
        // from failing.
        if (CONTEXT_METHODS.has(request.method)) {
          const outcome = await dispatchContextMethod({
            client,
            context,
            method: request.method,
            params: isRecord(request.params) ? request.params : {},
          });
          return 'result' in outcome
            ? respond(outcome.result)
            : respondError(outcome.code, outcome.message);
        }
        logger?.warn('Unknown MCP method', { method: request.method });
        return respondError(
          JSON_RPC_ERROR_CODES.methodNotFound,
          `Method not found: ${request.method}`,
        );
    }
  };
}

/**
 * What `initialize` answers.
 *
 * A client asks for nothing it was not offered here, so an unannounced
 * capability is an unreachable one however well it works.
 */
function buildInitializeResult(
  params: Record<string, unknown>,
  context: boolean,
  serverInfo: { name: string; version: string },
  instructions: string | null,
): Record<string, unknown> {
  const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
  const known = SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === asked);
  return {
    protocolVersion: known ?? LATEST_PROTOCOL_VERSION,
    capabilities: {
      tools: { listChanged: false },
      ...(context
        ? {
            // `subscribe: false`: change notifications are the third part of
            // issue #48 and need a server-initiated channel neither transport
            // opens today.
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
          }
        : {}),
    },
    serverInfo,
    // Read by every client that has a system prompt to put it in. Omitted
    // rather than sent empty: a key with nothing behind it is a claim that
    // there is nothing to say.
    ...(instructions === null || instructions.length === 0 ? {} : { instructions }),
  };
}

/** The methods `dispatchContextMethod` below answers. */
const CONTEXT_METHODS = new Set([
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
]);

type ContextOutcome = { result: unknown } | { code: number; message: string };

/**
 * The five methods that serve resources and prompts.
 *
 * Their own function rather than five more arms of the dispatcher's switch:
 * they share a precondition (this connection serves them at all) and none of
 * them touches the tool catalogue or the confirmation gate around it.
 */
async function dispatchContextMethod(input: {
  client: ExocortexApiClient;
  context: boolean;
  method: string;
  params: Record<string, unknown>;
}): Promise<ContextOutcome> {
  const { client, context, params } = input;

  switch (input.method) {
    case 'resources/list':
      return { result: { resources: context ? await listMcpResources(client) : [] } };

    case 'resources/templates/list':
      return { result: { resourceTemplates: context ? listMcpResourceTemplates() : [] } };

    case 'resources/read': {
      const uri = typeof params.uri === 'string' ? params.uri : '';
      const contents = context ? await readMcpResource(client, uri) : null;
      return contents === null
        ? { code: JSON_RPC_ERROR_CODES.resourceNotFound, message: `Resource not found: ${uri}` }
        : { result: contents };
    }

    case 'prompts/list':
      return { result: { prompts: context ? await listMcpPrompts(client) : [] } };

    default: {
      const name = typeof params.name === 'string' ? params.name : '';
      const prompt = context ? await getMcpPrompt(client, name) : null;
      return prompt === null
        ? { code: JSON_RPC_ERROR_CODES.invalidParams, message: `Unknown prompt: ${name}` }
        : { result: prompt };
    }
  }
}

/** MCP tool behaviour hints, as the specification defines them. */
export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
}

/** MCP `tools/list` shape. */
export function toMcpToolList(tools: readonly AnyToolDefinition[]): {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations: McpToolAnnotations;
}[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.jsonSchema,
    // Without these a client cannot tell a search from a deletion, so it has
    // to treat the whole catalogue as one risk class. Clients that gate write
    // access behind a separate opt-in -- ChatGPT's connectors do -- read
    // `readOnlyHint` to decide which side of that line a tool falls on, which
    // makes the annotation the difference between a usable catalogue and a
    // read-only one.
    annotations: {
      readOnlyHint: !tool.mutating,
      destructiveHint: tool.destructive,
      // Almost every tool acts on this deployment's own workspaces and nothing
      // else. The web-research pair (issue #26) is the exception, and the
      // specification's word for it is exactly this hint: the result comes
      // from an open-ended set of entities we do not run. Derived from
      // `untrustedOutput` rather than a flag of its own, because "the text
      // came from out there" and "this reached out there" are the same fact
      // said twice, and two flags would eventually disagree.
      openWorldHint: tool.untrustedOutput === 'web',
    },
  }));
}
