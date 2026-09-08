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
    // This bin serves the full catalogue, so it also serves the half of the
    // protocol a person drives: pages to attach and rule pages as prompts.
    context: true,
    gate: options.gate,
    // The variable widens the gate rather than switching it on: the calls no
    // snapshot undoes are confirmed either way, and a deployment that wants the
    // old behaviour -- ask twice before every write -- sets it to true.
    confirm: options.env.EXOCORTEX_REQUIRE_WRITE_CONFIRMATION ? 'all' : 'irreversible',
    logger: options.logger,
  });
}
