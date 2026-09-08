import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from './primitives';

/**
 * Provenance per agent session (issue #49, ADR-022).
 *
 * A snapshot answers "what did this page look like before"; these shapes answer
 * "what did this agent touch, and take all of it back". The two questions need
 * different keys, which is why the session id exists at all: a correlation id
 * covers one request by design and can never group a working session.
 */

/**
 * The session id as its client knows it. Chosen by the client, so it is
 * validated as an opaque label and trusted only inside one account.
 */
export const agentSessionExternalIdSchema = z
  .string()
  .min(6)
  .max(100)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Only letters, digits and . _ : - are allowed');

export const agentSessionTransportSchema = z.enum(['stdio', 'http']);
export type AgentSessionTransport = z.infer<typeof agentSessionTransportSchema>;

/** What an MCP connection announces about itself at `initialize`. */
export const registerAgentSessionRequestSchema = z.object({
  externalId: agentSessionExternalIdSchema,
  /**
   * `clientInfo` from the handshake, verbatim and unverified. It is shown so a
   * person recognises the agent that wrote, and is never read for a decision.
   */
  clientLabel: z.string().min(1).max(200).optional(),
  transport: agentSessionTransportSchema.optional(),
});
export type RegisterAgentSessionRequest = z.infer<typeof registerAgentSessionRequestSchema>;

export const agentSessionSchema = z.object({
  id: idSchema,
  externalId: z.string(),
  clientLabel: z.string().nullable(),
  transport: z.string().nullable(),
  userId: idSchema,
  userName: z.string().nullable(),
  startedAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
  /** Journalled mutations, and how many distinct pages they touched. */
  writeCount: z.number().int().nonnegative(),
  documentCount: z.number().int().nonnegative(),
  /** False once every write of the session has been taken back or superseded. */
  revertable: z.boolean(),
});
export type AgentSession = z.infer<typeof agentSessionSchema>;

export const agentSessionListResponseSchema = z.object({ sessions: z.array(agentSessionSchema) });
export type AgentSessionListResponse = z.infer<typeof agentSessionListResponseSchema>;

export const agentWriteSchema = z.object({
  id: idSchema,
  documentId: idSchema,
  documentTitle: z.string().nullable(),
  /** The application event that produced the row, e.g. `document.updated`. */
  action: z.string(),
  /** The state before this write, when the write made one. See `AgentWriteJournal`. */
  snapshotBeforeId: idSchema.nullable(),
  correlationId: z.string(),
  createdAt: isoDateTimeSchema,
});
export type AgentWrite = z.infer<typeof agentWriteSchema>;

export const agentSessionDetailResponseSchema = z.object({
  session: agentSessionSchema,
  writes: z.array(agentWriteSchema),
});
export type AgentSessionDetailResponse = z.infer<typeof agentSessionDetailResponseSchema>;

/** Why a page was left alone by a bulk revert. */
export const agentRevertSkipReasonSchema = z.enum([
  /** Somebody who is not this session wrote the page afterwards. */
  'changed_since',
  /** The mutation left no snapshot to go back to: a rename, a move, a deletion. */
  'no_snapshot',
  /** The page is gone, or the caller may not edit it. */
  'unavailable',
]);
export type AgentRevertSkipReason = z.infer<typeof agentRevertSkipReasonSchema>;

export const agentSessionRevertResponseSchema = z.object({
  reverted: z.array(
    z.object({
      documentId: idSchema,
      documentTitle: z.string().nullable(),
      snapshotId: idSchema,
    }),
  ),
  /**
   * Named, not silently dropped. A bulk revert is not atomic and cannot be:
   * the honest answer is which pages went back and which did not, page by page.
   */
  skipped: z.array(
    z.object({
      documentId: idSchema,
      documentTitle: z.string().nullable(),
      reason: agentRevertSkipReasonSchema,
    }),
  ),
});
export type AgentSessionRevertResponse = z.infer<typeof agentSessionRevertResponseSchema>;
