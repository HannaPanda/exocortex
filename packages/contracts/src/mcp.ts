import { z } from 'zod';

import { isoDateTimeSchema } from './primitives';

/**
 * The MCP change feed (issue #48, ADR-035).
 *
 * `resources/subscribe` promises an agent that it will hear about a page it
 * has attached without asking again. The stdio transport runs in a subprocess
 * that reaches this deployment over HTTP and nothing else, so it needs one
 * server-sent channel to hear anything at all: `GET /api/mcp/changes`.
 *
 * What travels is a list of resource URIs and nothing else. Not a title, not a
 * body, not the workspace: a subscriber that may not read the page must learn
 * nothing from a message it was never meant to receive, and the surest way to
 * hold that line is to have nothing in the message to leak. The URIs
 * themselves are filtered by workspace membership before the message is
 * written, re-checked per event rather than per connection.
 */
export const mcpResourceChangeSchema = z.object({
  /** `exocortex://page/…` and `exocortex://workspace/…/tree`, never empty. */
  uris: z.array(z.string().min(1)).min(1),
  changedAt: isoDateTimeSchema,
});
export type McpResourceChange = z.infer<typeof mcpResourceChangeSchema>;

/**
 * The first message on the feed, before any change.
 *
 * A client that has just connected cannot otherwise tell "the stream is open
 * and quiet" from "the stream is still being set up", and the difference
 * decides whether a reconnect loop backs off or hammers.
 */
export const mcpChangeFeedReadySchema = z.object({
  ready: z.literal(true),
  /** Seconds between heartbeats, so a client can time out on a silent socket. */
  heartbeatSeconds: z.number().int().positive(),
});
export type McpChangeFeedReady = z.infer<typeof mcpChangeFeedReadySchema>;
