#!/usr/bin/env node
/* eslint-disable no-console -- the very first statement must shadow console.log/info/warn */
// Guard rail: stdout is reserved exclusively for JSON-RPC protocol traffic
// (see stdio.ts). This runs before any other import can log anything, so a
// stray `console.log` anywhere in the dependency graph can never corrupt the
// stream; it is redirected to stderr instead.
console.log = console.error;
console.info = console.error;
console.warn = console.error;
/* eslint-enable no-console */

import { randomUUID } from 'node:crypto';

import { createFetchApiClient, WriteConfirmationGate } from '@exocortex/mcp-tools';

import { mcpEnvSchema } from './env.js';
import { createDiagnosticsLogger } from './logger.js';
import { createRequestHandler } from './server.js';
import { createStdioServer } from './stdio.js';

function main(): void {
  const parsedEnv = mcpEnvSchema.safeParse(process.env);
  if (!parsedEnv.success) {
    // Never write validation errors to stdout: it would corrupt the JSON-RPC
    // stream before the first message is even sent.
    process.stderr.write(`Invalid MCP server environment: ${parsedEnv.error.message}\n`);
    process.exit(1);
  }
  const env = parsedEnv.data;

  const logger = createDiagnosticsLogger({ logFile: env.EXOCORTEX_LOG_FILE });

  const headers: Record<string, string> = {};
  if (env.EXOCORTEX_BASIC_AUTH !== undefined) {
    // See docs/mcp.md: this only matters for a remote deployment behind
    // nginx basic auth, since `Authorization` is already the bearer token.
    headers['x-forwarded-authorization'] =
      `Basic ${Buffer.from(env.EXOCORTEX_BASIC_AUTH).toString('base64')}`;
  }

  const client = createFetchApiClient({
    baseUrl: env.EXOCORTEX_API_URL,
    token: env.EXOCORTEX_API_TOKEN,
    timeoutMs: env.EXOCORTEX_TIMEOUT_MS,
    headers,
  });

  const gate = new WriteConfirmationGate();

  const agentSessionId = `stdio-${randomUUID()}`;
  const handler = createRequestHandler({ client, gate, env, logger, agentSessionId });
  const server = createStdioServer(handler);

  logger.info('eXocortex MCP server starting', {
    apiUrl: env.EXOCORTEX_API_URL,
    agentSessionId,
  });
  server.start();

  // Hermes kills MCP subprocesses by closing stdin; `stdio.ts` already exits
  // on 'end'. These handlers cover an explicit signal from any other client.
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

main();
