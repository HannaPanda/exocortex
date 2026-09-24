import { z } from 'zod';

import { aiRunPhaseSchema, aiRunStatusSchema, aiUsageSchema } from './ai';
import { automationFailureReasonSchema } from './automations';
import { commentSchema } from './comments';
import { documentSummarySchema } from './documents';
import { idSchema, isoDateTimeSchema } from './primitives';
import { projectBuildStatusSchema } from './projects';
import { renderJobStatusSchema } from './render';
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
  'document.deleted',
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
  'ai.run.phase',
  'document.content.replaced',
  'document.cover.generated',
  'document.overview.updated',
  'comment.created',
  'comment.updated',
  'comment.resolved',
  'comment.deleted',
  'render.job.updated',
  'project.files.changed',
  'project.build.updated',
  'saved-query.changed',
  'document.share.changed',
  'automation.disabled',
  'automation.run.failed',
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

/**
 * A row's property values changed (issue #50).
 *
 * Carries the row as well as the collection, because the two answer different
 * questions: a client invalidates its query for the collection, and an
 * automation scoped to that database has to know *which* row changed in order
 * to act on it.
 */
export const databaseRowUpdatedPayloadSchema = databaseChangedPayloadSchema.extend({
  rowId: idSchema,
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
  /**
   * The German diagnosis, so the panel can show it without waiting for the
   * next poll of the run (issue #118). Same text as `AiRun.errorDetail`;
   * `null` wherever the code alone is the whole story.
   */
  detail: z.string().nullable(),
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
  /**
   * `refused` is not a failure: the trust boundary declined the call and
   * nothing ran (issue #56, ADR-030). It is its own status because the two
   * mean opposite things to whoever is watching -- a failure is something that
   * went wrong, a refusal is something that worked.
   */
  status: z.enum(['started', 'succeeded', 'failed', 'refused']),
  /**
   * Compact identifier of what the call touches, e.g. `document:<id>` for
   * `exo_page_write` -- never the full argument payload. `null` when the tool
   * has no natural target (a read-only tool, or the arguments could not be
   * parsed) (issue #6).
   */
  target: z.string().nullable().default(null),
});

/**
 * A run entered a phase that produces no text of its own (issue #6).
 *
 * Deliberately carries nothing but the phase: reasoning tokens are the
 * model's private working-out and must not travel to a client or into a log,
 * and the compaction summary is not the user's answer either. The point is to
 * name the silence, not to fill it.
 */
export const aiRunPhasePayloadSchema = z.object({
  runId: idSchema,
  phase: aiRunPhaseSchema,
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

/**
 * An overview page's composition was rebuilt, or tried to be (issue #53).
 *
 * Carries no text. The page reads the composition through its own route, which
 * also carries the entries and the staleness the panel renders; an event that
 * repeated the paragraph would be a second copy able to disagree with it.
 *
 * `unchanged` is the common case and still travels: it is what turns the
 * "wird aktualisiert …" state off after a refresh that found nothing to do.
 */
export const documentOverviewUpdatedPayloadSchema = z.object({
  documentId: idSchema,
  status: z.enum(['ready', 'unchanged', 'failed']),
  /** German, user-facing. Null unless it failed. */
  error: z.string().nullable().default(null),
});

/**
 * A comment appeared, changed or was resolved (issue #18).
 *
 * The whole comment travels, not just its id: the panel would otherwise refetch
 * the page's threads for every keystroke somebody else finishes, and a comment
 * is small. `comment.deleted` carries no comment because there is none left, so
 * it names the thread instead.
 */
export const commentEventPayloadSchema = z.object({
  documentId: idSchema,
  comment: commentSchema,
});

export const commentDeletedPayloadSchema = z.object({
  documentId: idSchema,
  commentId: idSchema,
  /** Root of the thread it belonged to, or its own id when it *was* the root. */
  threadId: idSchema,
});

/**
 * Pages that no longer exist. Unlike `document.archived` this cannot carry a
 * summary: there is nothing left to summarize, so it names ids only. Every one
 * of them is gone, the first is the page the caller asked about.
 */
export const documentDeletedPayloadSchema = z.object({
  documentId: idSchema,
  documentIds: z.array(idSchema),
});

/**
 * A build changed state (issue #44, ADR-026).
 *
 * Carries the status rather than the whole job: the dialog that is watching
 * refetches the job when this lands, and a build's log can be tens of kilobytes
 * that nobody looking at a progress line has asked for.
 */
export const renderJobUpdatedPayloadSchema = z.object({
  jobId: idSchema,
  documentId: idSchema.nullable(),
  status: renderJobStatusSchema,
  /** German, user-facing. Null unless the build failed. */
  error: z.string().nullable().default(null),
});
export type RenderJobUpdatedPayload = z.infer<typeof renderJobUpdatedPayloadSchema>;

/**
 * A project's file tree was rebuilt from its Yjs state (issue #43, ADR-027).
 *
 * Carries the paths rather than the contents: what the file tree in the browser
 * needs is which paths exist now, and the open editor already has the text over
 * its own socket.
 */
export const projectFilesChangedPayloadSchema = z.object({
  projectId: idSchema,
  paths: z.array(z.string()),
});
export type ProjectFilesChangedPayload = z.infer<typeof projectFilesChangedPayloadSchema>;

/**
 * A project build changed state (issue #43, ADR-027).
 *
 * Same shape and same reason as `render.job.updated`: whoever is watching
 * refetches, because a TeX log is not something a progress line asked for.
 */
export const projectBuildUpdatedPayloadSchema = z.object({
  buildId: idSchema,
  projectId: idSchema.nullable(),
  status: projectBuildStatusSchema,
  /** German, user-facing. Null unless the build failed. */
  error: z.string().nullable().default(null),
});
export type ProjectBuildUpdatedPayload = z.infer<typeof projectBuildUpdatedPayloadSchema>;

/**
 * A saved query was created, edited, reordered or deleted (issue #74).
 *
 * Only the id and what happened travel: a smart view is an entry in everybody's
 * navigation, so the other browsers have to re-read the list, and the list is
 * the thing they have to re-read rather than one row of it. The definition
 * itself is deliberately not in the payload -- it would put a workspace's
 * stored questions on a socket every member is on, for no gain over the read
 * they are about to do anyway.
 */
export const savedQueryChangedPayloadSchema = z.object({
  savedQueryId: idSchema,
  action: z.enum(['created', 'updated', 'deleted']),
});
export type SavedQueryChangedPayload = z.infer<typeof savedQueryChangedPayloadSchema>;

/**
 * A grant on a page was handed out, altered or withdrawn (issue #103).
 *
 * The one event type in this list that never reaches a socket. It is written
 * to the outbox and read by the dispatcher, which turns it into the mail that
 * tells the recipient their access changed; broadcasting it to the workspace
 * room would tell every member who holds which page, which is a question the
 * share list already answers to the people allowed to ask it.
 *
 * It carries ids and what happened, never an address and never a title. Who
 * the grantee is by mail, and whether their account still exists, is looked up
 * when the mail is enqueued -- minutes later, and therefore from the state
 * that holds then rather than the state that held at the request.
 *
 * `PUBLIC_LINK` grants write no event at all: a link has nobody to tell.
 */
export const documentShareChangedPayloadSchema = z.object({
  shareId: idSchema,
  documentId: idSchema,
  granteeId: idSchema,
  /** Who did it, so the mail can name them. */
  actorId: idSchema,
  change: z.enum(['granted', 'changed', 'revoked']),
});
export type DocumentShareChangedPayload = z.infer<typeof documentShareChangedPayloadSchema>;

/**
 * An automation reached a final failure its owner has to hear about
 * (issue #107).
 *
 * Two event types share this payload, and neither ever reaches a socket: the
 * worker writes them to the outbox in the same transaction as the state change,
 * and the dispatcher turns them into the mail. `automation.disabled` is the
 * rule switching itself off after `automations.maxConsecutiveFailures`;
 * `automation.run.failed` is the first failure of a scheduled rule's streak,
 * because a scheduled run is the one nobody is watching when it breaks.
 *
 * Ids and a reason from a closed list, never the error text: the run log
 * keeps that, behind the deployment's own sign-in.
 */
export const automationFailurePayloadSchema = z.object({
  ruleId: idSchema,
  runId: idSchema,
  reason: automationFailureReasonSchema,
  /** The streak at the moment of the event, so the mail can say how many. */
  failures: z.number().int().min(1),
});
export type AutomationFailurePayload = z.infer<typeof automationFailurePayloadSchema>;

export const applicationEventSchema = z.discriminatedUnion('type', [
  envelope('workspace.updated', z.object({ workspace: workspaceSchema.partial() })),
  envelope('document.created', z.object({ document: documentSummarySchema })),
  envelope('document.updated', z.object({ document: documentSummarySchema })),
  envelope('document.moved', documentMovedPayloadSchema),
  envelope('document.archived', z.object({ document: documentSummarySchema })),
  envelope('document.restored', z.object({ document: documentSummarySchema })),
  envelope('document.deleted', documentDeletedPayloadSchema),
  envelope('document.materialized', documentMaterializedPayloadSchema),
  envelope('job.progress', jobProgressPayloadSchema),
  envelope('job.completed', jobResultPayloadSchema),
  envelope('job.failed', jobFailurePayloadSchema),
  envelope('ai.run.progress', aiRunProgressPayloadSchema),
  envelope('ai.run.completed', aiRunCompletedPayloadSchema),
  envelope('ai.run.failed', aiRunFailedPayloadSchema),
  envelope('database.property.changed', databaseChangedPayloadSchema),
  envelope('database.view.changed', databaseChangedPayloadSchema),
  envelope('database.row.updated', databaseRowUpdatedPayloadSchema),
  envelope('ai.conversation.compacted', aiConversationCompactedPayloadSchema),
  envelope('ai.run.tool_call', aiRunToolCallPayloadSchema),
  envelope('ai.run.phase', aiRunPhasePayloadSchema),
  envelope('document.content.replaced', documentContentReplacedPayloadSchema),
  envelope('document.cover.generated', documentCoverGeneratedPayloadSchema),
  envelope('document.overview.updated', documentOverviewUpdatedPayloadSchema),
  envelope('comment.created', commentEventPayloadSchema),
  envelope('comment.updated', commentEventPayloadSchema),
  envelope('comment.resolved', commentEventPayloadSchema),
  envelope('comment.deleted', commentDeletedPayloadSchema),
  envelope('render.job.updated', renderJobUpdatedPayloadSchema),
  envelope('project.files.changed', projectFilesChangedPayloadSchema),
  envelope('project.build.updated', projectBuildUpdatedPayloadSchema),
  envelope('saved-query.changed', savedQueryChangedPayloadSchema),
  envelope('document.share.changed', documentShareChangedPayloadSchema),
  envelope('automation.disabled', automationFailurePayloadSchema),
  envelope('automation.run.failed', automationFailurePayloadSchema),
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
