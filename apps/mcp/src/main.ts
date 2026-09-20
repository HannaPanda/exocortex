#!/usr/bin/env node
/* oxlint-disable no-console -- the very first statement must shadow console.log/info/warn */
// Guard rail: stdout is reserved exclusively for JSON-RPC protocol traffic
// (see stdio.ts). This runs before any other import can log anything, so a
// stray `console.log` anywhere in the dependency graph can never corrupt the
// stream; it is redirected to stderr instead.
console.log = console.error;
console.info = console.error;
console.warn = console.error;
/* oxlint-enable no-console */

import { randomUUID } from 'node:crypto';

import {
  createFetchApiClient,
  ResourceSubscriptions,
  resourceUpdatedNotification,
  WriteConfirmationGate,
} from '@exocortex/mcp-tools';

import { type ChangeFeed, createChangeFeed } from './changes.js';
import { mcpEnvSchema } from './env.js';
import { createDiagnosticsLogger } from './logger.js';
import { createRequestHandler } from './server.js';
import { createStdioServer, writeMessage } from './stdio.js';

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

  // The change feed is opened by the first `resources/subscribe` and not
  // before: a client that only calls tools should cost this deployment one
  // HTTP request per call and no standing connection at all. It is assigned
  // below, before anything can be read from stdin.
  let feed: ChangeFeed | null = null;
  const subscriptions = new ResourceSubscriptions(() => feed?.ensureStarted());

  const handler = createRequestHandler({
    client,
    gate,
    env,
    logger,
    agentSessionId,
    subscriptions,
  });
  const server = createStdioServer(handler, {
    input: process.stdin,
    write: writeMessage,
    onEnd: () => {
      // Closing stdin is how a client says it is done. The feed is a second
      // socket this process owns; leaving it open would keep a connection on
      // the deployment for a client that has already gone.
      feed?.stop();
      process.exit(0);
    },
  });

  feed = createChangeFeed({
    baseUrl: env.EXOCORTEX_API_URL,
    token: env.EXOCORTEX_API_TOKEN,
    headers,
    logger,
    onChange: (uris) => {
      for (const uri of subscriptions.matching(uris)) {
        server.notify(resourceUpdatedNotification(uri));
      }
    },
  });

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
