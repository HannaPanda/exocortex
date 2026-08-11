import { type ExocortexApiClient, ExocortexApiError } from './client.js';
import { type WriteConfirmationGate } from './confirm.js';
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
  /** Two-step confirmation for mutating tools. Omit to run without one. */
  gate?: WriteConfirmationGate;
  /**
   * Mixed into the gate's key so two callers can never confirm each other's
   * pending write. Irrelevant for stdio, where the gate lives in a subprocess
   * that serves exactly one client; essential for the HTTP endpoint, where one
   * gate instance serves every user of the deployment.
   */
  principal?: string;
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
  const serverInfo = options.serverInfo ?? DEFAULT_SERVER_INFO;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  async function callTool(
    tool: AnyToolDefinition,
    rawInput: unknown,
  ): Promise<{ text: string; data?: unknown; isError?: boolean }> {
    if (tool.mutating && gate !== undefined) {
      const target = tool.targetOf(rawInput);
      if (target !== null) {
        const check = gate.check({ toolName: tool.name, target, payload: rawInput, principal });
        if (check.state === 'pending') {
          // A confirmation prompt is not a protocol failure: the model must
          // be able to read it and call the tool again to confirm.
          return { text: check.message, isError: false };
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
        ? { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } }
        : null;

    switch (request.method) {
      case 'initialize': {
        const params = isRecord(request.params) ? request.params : {};
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
        const known = SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === asked);
        return respond({
          protocolVersion: known ?? LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
        });
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

      // Answered rather than refused: a client that advertises no capability
      // for these still probes them on connect, and an empty list is a truthful
      // answer that keeps the handshake from failing.
      case 'resources/list':
        return respond({ resources: [] });

      case 'resources/templates/list':
        return respond({ resourceTemplates: [] });

      case 'prompts/list':
        return respond({ prompts: [] });

      default:
        logger?.warn('Unknown MCP method', { method: request.method });
        return respondError(
          JSON_RPC_ERROR_CODES.methodNotFound,
          `Method not found: ${request.method}`,
        );
    }
  };
}

/** MCP `tools/list` shape. */
export function toMcpToolList(
  tools: readonly AnyToolDefinition[],
): { name: string; description: string; inputSchema: unknown }[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.jsonSchema,
  }));
}
