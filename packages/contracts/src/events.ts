import { z } from 'zod';

import { aiRunStatusSchema, aiUsageSchema } from './ai';
import { documentSummarySchema } from './documents';
import { idSchema, isoDateTimeSchema } from './primitives';
import { workspaceSchema } from './workspaces';

/**
 * Application realtime events.
 *
 * These travel over the dedicated Socket.IO channel served by the NestJS API
 * (`/realtime`). They are intentionally kept out of the Yjs/Hocuspocus protocol
 * (ADR-008).
 */
export const APPLICATION_EVENT_TYPES = [
  'workspace.updated',
  'document.created',
  'document.updated',
  'document.moved',
  'document.archived',
  'document.restored',
  'document.materialized',
  'job.progress',
  'job.completed',
  'job.failed',
  'ai.run.progress',
  'ai.run.completed',
  'ai.run.failed',
  'database.property.changed',
  'database.view.changed',
  'database.row.updated',
  'ai.conversation.compacted',
  'ai.run.tool_call',
  'document.content.replaced',
  'document.cover.generated',
] as const;

export const applicationEventTypeSchema = z.enum(APPLICATION_EVENT_TYPES);
export type ApplicationEventType = z.infer<typeof applicationEventTypeSchema>;

const envelope = <TType extends ApplicationEventType, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) =>
  z.object({
    type: z.literal(type),
    workspaceId: idSchema,
    emittedAt: isoDateTimeSchema,
    correlationId: z.string(),
    payload,
  });

export const jobProgressPayloadSchema = z.object({
  jobId: z.string(),
  queue: z.enum(['document-materialization', 'search-indexing', 'ai', 'maintenance']),
  /** 0..100 */
  progress: z.number().min(0).max(100),
  /** Short German label shown in the UI. */
  label: z.string(),
  documentId: idSchema.nullable().optional(),
});
export type JobProgressPayload = z.infer<typeof jobProgressPayloadSchema>;

export const jobResultPayloadSchema = jobProgressPayloadSchema.extend({
  durationMs: z.number().int().nonnegative(),
});

export const jobFailurePayloadSchema = jobProgressPayloadSchema.extend({
  /** Developer-facing English reason. The UI shows a generic German message. */
  reason: z.string(),
  attemptsMade: z.number().int().nonnegative(),
  willRetry: z.boolean(),
});

export const documentMaterializedPayloadSchema = z.object({
  documentId: idSchema,
  schemaVersion: z.number().int().nonnegative(),
  materializedAt: isoDateTimeSchema,
  plainTextLength: z.number().int().nonnegative(),
});

export const documentMovedPayloadSchema = z.object({
  document: documentSummarySchema,
  previousParentId: idSchema.nullable(),
});

/**
 * Minimal payload for all three database events: just the collection
 * document id, never row content. Clients invalidate their React Query keys
 * for that collection and refetch, matching how `document.moved` stays
 * intentionally thin.
 */
export const databaseChangedPayloadSchema = z.object({
  documentId: idSchema,
});

export const aiRunProgressPayloadSchema = z.object({
  runId: idSchema,
  status: aiRunStatusSchema,
  /** Incremental text delta produced by the provider. */
  delta: z.string().default(''),
  /** Monotonic sequence number so clients can detect gaps. */
  sequence: z.number().int().nonnegative(),
});

export const aiRunCompletedPayloadSchema = z.object({
  runId: idSchema,
  status: aiRunStatusSchema,
  text: z.string(),
  usage: aiUsageSchema.nullable(),
});

export const aiRunFailedPayloadSchema = z.object({
  runId: idSchema,
  status: aiRunStatusSchema,
  errorCode: z.string(),
  reason: z.string(),
});

export const aiConversationCompactedPayloadSchema = z.object({
  conversationId: idSchema,
  summarizedMessages: z.number().int().nonnegative(),
  estimatedTokensBefore: z.number().int().nonnegative(),
  estimatedTokensAfter: z.number().int().nonnegative(),
});

export const aiRunToolCallPayloadSchema = z.object({
  runId: idSchema,
  iteration: z.number().int().nonnegative(),
  toolName: z.string(),
  status: z.enum(['started', 'succeeded', 'failed']),
});

export const documentContentReplacedPayloadSchema = z.object({
  documentId: idSchema,
  snapshotId: idSchema,
  source: z.enum(['api', 'ai', 'import']),
});

/**
 * The end of a cover generation, either way.
 *
 * The picture itself arrives as an ordinary `document.updated`, because the
 * worker sets it through the same route a human upload takes. This event
 * exists for the other half: the page that has been showing "wird erzeugt …"
 * has to learn that it is over, and *why* when it failed.
 */
export const documentCoverGeneratedPayloadSchema = z.object({
  documentId: idSchema,
  status: z.enum(['ready', 'failed']),
  /** German, user-facing. Null on success. */
  error: z.string().nullable().default(null),
});

export const applicationEventSchema = z.discriminatedUnion('type', [
  envelope('workspace.updated', z.object({ workspace: workspaceSchema.partial() })),
  envelope('document.created', z.object({ document: documentSummarySchema })),
  envelope('document.updated', z.object({ document: documentSummarySchema })),
  envelope('document.moved', documentMovedPayloadSchema),
  envelope('document.archived', z.object({ document: documentSummarySchema })),
  envelope('document.restored', z.object({ document: documentSummarySchema })),
  envelope('document.materialized', documentMaterializedPayloadSchema),
  envelope('job.progress', jobProgressPayloadSchema),
  envelope('job.completed', jobResultPayloadSchema),
  envelope('job.failed', jobFailurePayloadSchema),
  envelope('ai.run.progress', aiRunProgressPayloadSchema),
  envelope('ai.run.completed', aiRunCompletedPayloadSchema),
  envelope('ai.run.failed', aiRunFailedPayloadSchema),
  envelope('database.property.changed', databaseChangedPayloadSchema),
  envelope('database.view.changed', databaseChangedPayloadSchema),
  envelope('database.row.updated', databaseChangedPayloadSchema),
  envelope('ai.conversation.compacted', aiConversationCompactedPayloadSchema),
  envelope('ai.run.tool_call', aiRunToolCallPayloadSchema),
  envelope('document.content.replaced', documentContentReplacedPayloadSchema),
  envelope('document.cover.generated', documentCoverGeneratedPayloadSchema),
]);
export type ApplicationEvent = z.infer<typeof applicationEventSchema>;

/** Narrowed helper type for a single event kind. */
export type ApplicationEventOf<TType extends ApplicationEventType> = Extract<
  ApplicationEvent,
  { type: TType }
>;

// --------------------------------------------------------------------------
// Client -> server messages
// --------------------------------------------------------------------------

export const REALTIME_SOCKET_PATH = '/realtime';
export const REALTIME_EVENT_NAME = 'exocortex.event';

export const subscribeWorkspaceMessageSchema = z.object({
  workspaceId: idSchema,
});
export type SubscribeWorkspaceMessage = z.infer<typeof subscribeWorkspaceMessageSchema>;

export const unsubscribeWorkspaceMessageSchema = subscribeWorkspaceMessageSchema;
export type UnsubscribeWorkspaceMessage = z.infer<typeof unsubscribeWorkspaceMessageSchema>;

export const subscriptionAckSchema = z.object({
  ok: z.literal(true),
  room: z.string(),
});

export const subscriptionErrorSchema = z.object({
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
});

export const subscriptionResultSchema = z.union([subscriptionAckSchema, subscriptionErrorSchema]);
export type SubscriptionResult = z.infer<typeof subscriptionResultSchema>;

/** Room naming is server-owned; clients never send raw room names. */
export function workspaceRoom(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

export function userRoom(userId: string): string {
  return `user:${userId}`;
}
