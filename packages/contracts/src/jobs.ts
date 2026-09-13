import { z } from 'zod';

import { automationTriggerSchema } from './automations';
import { idSchema } from './primitives';

/**
 * Queue names. Kept in the contracts package so producers (API, collaboration
 * server) and consumers (worker) cannot drift apart.
 */
export const QUEUE_NAMES = {
  documentMaterialization: 'document-materialization',
  searchIndexing: 'search-indexing',
  ai: 'ai',
  maintenance: 'maintenance',
  attachmentText: 'attachment-text',
  documentCover: 'document-cover',
  calendarSync: 'calendar-sync',
  memoryCapture: 'memory-capture',
  memoryConsolidate: 'memory-consolidate',
  entityRescan: 'entity-rescan',
  automation: 'automation',
  render: 'render',
  projectBuild: 'project-build',
} as const;

export const queueNameSchema = z.enum([
  QUEUE_NAMES.documentMaterialization,
  QUEUE_NAMES.searchIndexing,
  QUEUE_NAMES.ai,
  QUEUE_NAMES.maintenance,
  QUEUE_NAMES.attachmentText,
  QUEUE_NAMES.documentCover,
  QUEUE_NAMES.calendarSync,
  QUEUE_NAMES.memoryCapture,
  QUEUE_NAMES.memoryConsolidate,
  QUEUE_NAMES.entityRescan,
  QUEUE_NAMES.automation,
  QUEUE_NAMES.render,
  QUEUE_NAMES.projectBuild,
]);
export type QueueName = z.infer<typeof queueNameSchema>;

/** Every job payload carries a correlation identifier for traceability. */
const jobBase = z.object({
  correlationId: z.string().min(1),
});

export const materializeDocumentJobSchema = jobBase.extend({
  documentId: idSchema,
  workspaceId: idSchema,
  /**
   * Yjs state vector clock captured when the job was enqueued. The handler skips
   * work when the stored content is already at least this fresh, which makes
   * repeated jobs idempotent.
   */
  yjsUpdatedAt: z.number().int().nonnegative(),
  reason: z.enum(['collaboration_store', 'import', 'restore', 'manual']),
});
export type MaterializeDocumentJob = z.infer<typeof materializeDocumentJobSchema>;

export const indexDocumentJobSchema = jobBase.extend({
  documentId: idSchema,
  workspaceId: idSchema,
  reason: z.enum(['materialized', 'title_changed', 'archived', 'restored', 'deleted', 'manual']),
});
export type IndexDocumentJob = z.infer<typeof indexDocumentJobSchema>;

export const aiRunJobSchema = jobBase.extend({
  runId: idSchema,
  workspaceId: idSchema,
  userId: idSchema,
});
export type AiRunJob = z.infer<typeof aiRunJobSchema>;

export const maintenanceJobSchema = jobBase.extend({
  task: z.enum([
    'prune-snapshots',
    'dispatch-outbox',
    'vacuum-search-index',
    'collect-orphaned-covers',
    'reap-stale-ai-runs',
    /**
     * Re-points the reference index after a page appeared, was renamed or
     * changed workspace. Needs `documentId`; without one it does nothing,
     * because there is no title to resolve against (issue #19).
     */
    'resolve-document-links',
    /**
     * Extracts references from content rows the index has never seen, in small
     * batches. Repeatable, and a no-op once every row is marked.
     */
    'backfill-document-links',
    /**
     * Re-points references that are stored as unresolved although the page
     * they name exists.
     *
     * `resolve-document-links` reacts to an event and can only see the state
     * at the moment it runs: during a bulk import, a target page appears
     * before the pages referencing it have been materialized, so its event
     * finds nothing to attach, and no later event ever revisits those rows.
     * This is the sweep underneath, and a no-op once every reference that can
     * resolve has.
     */
    'repair-document-links',
    /**
     * Takes a `SCHEDULED` `DocumentSnapshot` of every page that changed since
     * its last snapshot, gated by `activity.editSessionSnapshotsEnabled`
     * (issue #20). What lets the Aktivität tab show a real session range
     * ("14:20-14:45") instead of the single point `Document.updatedAt` alone
     * carries.
     */
    'snapshot-active-documents',
    /**
     * Embeds documents the semantic index has never seen under the configured
     * model, in small batches. Repeatable, a no-op while `search.semanticEnabled`
     * is off, and how a deployment that switches semantic search on catches up
     * with the pages it already has (issue #34, AP4).
     */
    'backfill-embeddings',
    /**
     * Deletes session notes in the memory workspace that are older than
     * `memory.retentionDays`. Off while that is zero. Never touches the project
     * pages the notes hang under, and never another workspace (ADR-019).
     */
    'prune-memories',
    /**
     * Deletes invitations that are long past their expiry and were never
     * redeemed (issue #3). Accepted ones stay: they are the record of where an
     * account came from, and that is worth keeping.
     */
    'prune-invitations',
    /**
     * Finds the projects whose memory holds notes nobody has consolidated yet
     * and hands each one to the `memory-consolidate` queue (issue #46). The
     * fan-out only: the model call and the writing happen there, because this
     * sweep has neither an AI provider nor an API client.
     */
    'consolidate-memories',
    /**
     * Lowers the confidence of facts nobody has confirmed lately and archives
     * the ones that fall through `memory.factConfidenceFloor` (issue #46).
     * A fact does not expire on a birthday, it gets quieter; this is the sweep
     * that turns the volume down.
     */
    'decay-memory-facts',
    /**
     * Empties `messages` and `resultText` on AI runs older than
     * `ai.runPayloadRetentionDays` and marks them `payloadsPrunedAt`
     * (issue #10). Off while that setting is zero. The usage columns are left
     * alone: the point is to keep the statistics affordable, not to forget
     * that the run happened.
     */
    'prune-ai-run-payloads',
    /**
     * Removes agent write journal rows, and the sessions left holding none,
     * once they are older than `agents.journalRetentionDays` (issue #49).
     * Off while that setting is zero. The snapshots the rows point at are not
     * touched: they age out on the snapshot schedule, and a page's own history
     * must not shorten because the agent bookkeeping around it did.
     */
    'prune-agent-journal',
    /**
     * Deletes automation runs older than `automations.runRetentionDays`
     * (issue #50). Off while that is zero. The rules themselves are never
     * touched: what ages out is the record of what they did, and a rule with
     * no recent runs is a rule that had nothing to do.
     */
    'prune-automation-runs',
    /**
     * Closes builds whose worker never came back and deletes finished ones
     * older than `render.jobRetentionDays` (issue #44, ADR-026). The PDFs they
     * produced are ordinary attachments and are never touched.
     */
    'reap-render-jobs',
    /**
     * The same two jobs for project builds (issue #43, ADR-027): closes builds
     * whose worker never came back, and deletes finished ones older than
     * `projects.buildRetentionDays`. The PDFs and SyncTeX maps they produced
     * are ordinary attachments and are never touched.
     */
    'reap-project-builds',
  ]),
  /** Optional scope; `null` means all workspaces. */
  workspaceId: idSchema.nullable().default(null),
  /** Optional scope for tasks that act on a single page. */
  documentId: idSchema.nullable().default(null),
});
export type MaintenanceJob = z.infer<typeof maintenanceJobSchema>;

export const attachmentTextJobSchema = jobBase.extend({
  attachmentId: idSchema,
  workspaceId: idSchema,
  /**
   * `forced` is the one reason that is allowed to skip the `READY` idempotency
   * guard in the worker (issue #2): every other reason leaves an already
   * extracted attachment alone.
   */
  reason: z.enum(['upload', 'requested', 'retry', 'forced']),
});
export type AttachmentTextJob = z.infer<typeof attachmentTextJobSchema>;

/**
 * Drawing a page cover from a prompt.
 *
 * Carries the requesting user because the worker acts strictly as that human:
 * it mints a service token for them and uploads the finished image through the
 * ordinary cover route, so a generated cover passes exactly the permission
 * checks an uploaded one does (ADR-014).
 */
export const documentCoverJobSchema = jobBase.extend({
  documentId: idSchema,
  workspaceId: idSchema,
  userId: idSchema,
  prompt: z.string().trim().min(1).max(1_000),
});
export type DocumentCoverJob = z.infer<typeof documentCoverJobSchema>;

/**
 * One pass over the calendar links of one account, or of every account.
 *
 * Deliberately carries no user: which human the sync acts as is a property of
 * the account (`CalendarAccount.userId`), because this job runs from a
 * repeatable schedule that has no user context. Rows are still written through
 * the REST API with a service token minted for that human, so a mirrored
 * appointment passes exactly the permission checks a hand-typed one does
 * (ADR-014). There is no privileged path into the domain, not even for a
 * background sync.
 */
export const calendarSyncJobSchema = jobBase.extend({
  /** Null means every enabled account. */
  accountId: idSchema.nullable().default(null),
  /**
   * `discover` refreshes the collection list and provisions missing mirror
   * databases; `pull` only reads objects into existing links. Kept apart because
   * discovery creates documents and should not run every five minutes.
   *
   * `remind` touches no calendar server at all: it reads the mirrored state and
   * sends what is due. Its own mode because it runs on a much tighter cadence
   * than a sync does -- a reminder that is five minutes late is a reminder that
   * failed.
   */
  mode: z.enum(['discover', 'pull', 'remind']).default('pull'),
  /**
   * Ignores the stored sync token and re-reads everything. The recovery path
   * after the server forgets a token, and the manual escape hatch when a mirror
   * has drifted.
   */
  full: z.boolean().default(false),
});
export type CalendarSyncJob = z.infer<typeof calendarSyncJobSchema>;

/**
 * Turning one finished working session into one memory note.
 *
 * Carries the whole transcript because the distillation happens here and
 * nowhere else: the API refuses to store raw conversation, and a job payload
 * in Redis is the only place it rests, for as long as the job runs. Carries
 * the acting user for the same reason `documentCoverJobSchema` does -- the
 * page is written back through the REST API with a service token minted for
 * that human, so an automatically written memory passes exactly the permission
 * checks a hand-typed page does (ADR-014).
 */
export const memoryCaptureJobSchema = jobBase.extend({
  workspaceId: idSchema,
  userId: idSchema,
  /** Readable project label, already derived from the caller's path. */
  project: z.string().min(1).max(300),
  /** Stable key for the project page, so two spellings of one path share a page. */
  projectKey: z.string().min(1).max(300),
  client: z.string().min(1).max(40),
  sessionId: z.string().max(200).nullable().default(null),
  transcript: z.string().min(1),
  hint: z.string().max(500).nullable().default(null),
  /** When the session ended, so a replayed transcript is dated by the session. */
  endedAt: z.string().nullable().default(null),
});
export type MemoryCaptureJob = z.infer<typeof memoryCaptureJobSchema>;

/**
 * A nightly consolidation run (issue #46).
 *
 * Carries no content at all, unlike capture: the notes it works on are already
 * pages, and reading them is the job's own first step. One job is one project,
 * fanned out by the `consolidate-memories` maintenance sweep, which is also
 * where `projectDocumentId` is resolved: matching a project page by title in
 * two places is how two places end up disagreeing about which page it is.
 *
 * `userId` is the account the writes are made as, exactly as in capture: the
 * facts are ordinary pages and must pass the checks a hand-typed page passes.
 */
export const memoryConsolidateJobSchema = jobBase.extend({
  workspaceId: idSchema,
  userId: idSchema,
  /** Stable key of the project, as `remember` files its notes under. */
  projectKey: z.string().min(1).max(300),
  /** The project's page in the memory workspace. Its children are the notes. */
  projectDocumentId: idSchema,
});
export type MemoryConsolidateJob = z.infer<typeof memoryConsolidateJobSchema>;

/**
 * Looks for one entity's names in pages that already exist (issue #47).
 *
 * The materialization pass only ever sees the page being saved, so an entity
 * created today would be invisible on every page written before it, which is
 * most of them. This is the other direction: one name, every page.
 *
 * Enqueued when an entity is created and when its aliases change, never on a
 * schedule. A rescan is a full-text scan of the deployment; it is cheap enough
 * to run on a deliberate act and far too expensive to run nightly for nothing.
 */
export const entityRescanJobSchema = jobBase.extend({
  entityDocumentId: idSchema,
  /** The user whose readable workspaces bound the scan. */
  userId: idSchema,
  /** Why it ran, for the log. */
  reason: z.enum(['created', 'aliases_changed', 'candidate_confirmed']),
});
export type EntityRescanJob = z.infer<typeof entityRescanJobSchema>;

/**
 * One firing of one automation rule (issue #50, ADR-024).
 *
 * Carries the rule and the page rather than the event: by the time the job
 * runs, the debounce window has swallowed every event after the first, and
 * re-reading the page is the only way to act on what it says *now* instead of
 * on what it said when the first keystroke landed.
 *
 * `runId` is optional, and which producer sets it is the whole design of the run
 * log. A manual firing creates the row first, because a caller is waiting for a
 * handle to it. The event-driven path does not, because a debounce window
 * collapses many events into one job: creating a row per event would fill the
 * log with entries that never get a result, so the worker creates exactly one
 * when it starts, and one job is one run.
 */
export const automationJobSchema = jobBase.extend({
  ruleId: idSchema,
  runId: idSchema.nullable().default(null),
  workspaceId: idSchema,
  documentId: idSchema,
  trigger: automationTriggerSchema,
  /** How many automations deep the change that caused this was. */
  depth: z.number().int().min(0).max(10).default(0),
});
export type AutomationJob = z.infer<typeof automationJobSchema>;

/**
 * One build of one document into one file (issue #44, ADR-026).
 *
 * Carries only the job id: everything the build needs -- template, source,
 * resolved variables -- was written onto the `RenderJob` row when the API
 * accepted the request, and the row is what the status route reads. A payload
 * that repeated any of it would be a second copy able to disagree with the one
 * a human is looking at.
 */
export const renderJobPayloadSchema = jobBase.extend({
  jobId: idSchema,
  workspaceId: idSchema,
  userId: idSchema,
});
export type RenderJobPayload = z.infer<typeof renderJobPayloadSchema>;

/**
 * One build of one project (issue #43, ADR-027).
 *
 * Carries only the build id, for the same reason the render payload does:
 * everything the build needs was written onto the `ProjectBuild` row when the
 * API accepted the request, and that row is what the status route reads. A
 * payload repeating any of it could disagree with what a person is looking at.
 */
export const projectBuildJobSchema = jobBase.extend({
  buildId: idSchema,
  workspaceId: idSchema,
  userId: idSchema,
});
export type ProjectBuildJob = z.infer<typeof projectBuildJobSchema>;

export const JOB_SCHEMAS = {
  [QUEUE_NAMES.documentMaterialization]: materializeDocumentJobSchema,
  [QUEUE_NAMES.searchIndexing]: indexDocumentJobSchema,
  [QUEUE_NAMES.ai]: aiRunJobSchema,
  [QUEUE_NAMES.maintenance]: maintenanceJobSchema,
  [QUEUE_NAMES.attachmentText]: attachmentTextJobSchema,
  [QUEUE_NAMES.documentCover]: documentCoverJobSchema,
  [QUEUE_NAMES.calendarSync]: calendarSyncJobSchema,
  [QUEUE_NAMES.memoryCapture]: memoryCaptureJobSchema,
  [QUEUE_NAMES.memoryConsolidate]: memoryConsolidateJobSchema,
  [QUEUE_NAMES.entityRescan]: entityRescanJobSchema,
  [QUEUE_NAMES.automation]: automationJobSchema,
  [QUEUE_NAMES.render]: renderJobPayloadSchema,
  [QUEUE_NAMES.projectBuild]: projectBuildJobSchema,
} as const;

export type JobPayloadMap = {
  [QUEUE_NAMES.documentMaterialization]: MaterializeDocumentJob;
  [QUEUE_NAMES.searchIndexing]: IndexDocumentJob;
  [QUEUE_NAMES.ai]: AiRunJob;
  [QUEUE_NAMES.maintenance]: MaintenanceJob;
  [QUEUE_NAMES.attachmentText]: AttachmentTextJob;
  [QUEUE_NAMES.documentCover]: DocumentCoverJob;
  [QUEUE_NAMES.calendarSync]: CalendarSyncJob;
  [QUEUE_NAMES.memoryCapture]: MemoryCaptureJob;
  [QUEUE_NAMES.memoryConsolidate]: MemoryConsolidateJob;
  [QUEUE_NAMES.entityRescan]: EntityRescanJob;
  [QUEUE_NAMES.automation]: AutomationJob;
  [QUEUE_NAMES.render]: RenderJobPayload;
  [QUEUE_NAMES.projectBuild]: ProjectBuildJob;
};
