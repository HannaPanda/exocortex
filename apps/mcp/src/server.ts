import { type Logger } from '@exocortex/logger';
import {
  type AnyToolDefinition,
  type ExocortexApiClient,
  ExocortexApiError,
  findTool,
  toMcpToolList,
  ToolInputValidationError,
  toolsFor,
  type WriteConfirmationGate,
} from '@exocortex/mcp-tools';

import { type McpEnv } from './env.js';
import { JSON_RPC_ERROR_CODES, type JsonRpcRequest, type JsonRpcResponse } from './stdio.js';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'exocortex', version: '0.1.0' } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toMcpResult(
  result: { text: string; data?: unknown; isError?: boolean },
): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: result.text }],
    structuredContent: result.data,
    isError: result.isError ?? false,
  };
}

/**
 * Builds the `handler` passed to `createStdioServer`. All MCP method
 * dispatch and the mutating-tool confirmation gate live here; the transport
 * concerns (stdout discipline, JSON-RPC framing) stay in `stdio.ts`.
 */
export function createRequestHandler(options: {
  client: ExocortexApiClient;
  gate: WriteConfirmationGate;
  env: McpEnv;
  logger: Logger;
}): (request: JsonRpcRequest) => Promise<JsonRpcResponse | null> {
  const { client, gate, env, logger } = options;

  async function callTool(
    tool: AnyToolDefinition,
    rawInput: unknown,
  ): Promise<{ text: string; data?: unknown; isError?: boolean }> {
    if (tool.mutating && env.EXOCORTEX_REQUIRE_WRITE_CONFIRMATION) {
      const target = tool.targetOf(rawInput);
      if (target !== null) {
        const check = gate.check({ toolName: tool.name, target, payload: rawInput });
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
        const paths = error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
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
      hasId ? { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } } : null;

    switch (request.method) {
      case 'initialize': {
        const params = isRecord(request.params) ? request.params : {};
        const clientProtocolVersion =
          typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
        return respond({
          protocolVersion: clientProtocolVersion === PROTOCOL_VERSION ? clientProtocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      }

      case 'notifications/initialized':
        return null;

      case 'ping':
        return respond({});

      case 'tools/list':
        return respond({ tools: toMcpToolList(toolsFor('mcp')) });

      case 'tools/call': {
        const params = isRecord(request.params) ? request.params : {};
        const name = typeof params.name === 'string' ? params.name : '';
        const tool = findTool(name);
        if (tool === null) {
          return respondError(JSON_RPC_ERROR_CODES.invalidParams, `Unknown tool: ${name}`);
        }
        const result = await callTool(tool, params.arguments ?? {});
        return respond(toMcpResult(result));
      }

      default:
        logger.warn('Unknown MCP method', { method: request.method });
        return respondError(JSON_RPC_ERROR_CODES.methodNotFound, `Method not found: ${request.method}`);
    }
  };
}
