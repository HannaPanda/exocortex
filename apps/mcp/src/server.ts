import { type Logger } from '@exocortex/logger';
import {
  createMcpRequestHandler,
  type ExocortexApiClient,
  type JsonRpcRequest,
  type JsonRpcResponse,
  toolsFor,
  type WriteConfirmationGate,
} from '@exocortex/mcp-tools';

import { type McpEnv } from './env.js';

/**
 * Builds the `handler` passed to `createStdioServer`.
 *
 * Method dispatch itself lives in `@exocortex/mcp-tools`, shared with the
 * Streamable HTTP endpoint in `apps/api`. What stays here is the wiring that
 * is specific to running as a subprocess: which tools this bin offers, and
 * that the confirmation gate is driven by an environment variable rather than
 * by a credential.
 */
export function createRequestHandler(options: {
  client: ExocortexApiClient;
  gate: WriteConfirmationGate;
  env: McpEnv;
  logger: Logger;
}): (request: JsonRpcRequest) => Promise<JsonRpcResponse | null> {
  return createMcpRequestHandler({
    client: options.client,
    tools: toolsFor('mcp'),
    gate: options.env.EXOCORTEX_REQUIRE_WRITE_CONFIRMATION ? options.gate : undefined,
    logger: options.logger,
  });
}
