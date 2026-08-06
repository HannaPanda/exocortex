import { z } from 'zod';

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
} as const;

export const queueNameSchema = z.enum([
  QUEUE_NAMES.documentMaterialization,
  QUEUE_NAMES.searchIndexing,
  QUEUE_NAMES.ai,
  QUEUE_NAMES.maintenance,
  QUEUE_NAMES.attachmentText,
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
  ]),
  /** Optional scope; `null` means all workspaces. */
  workspaceId: idSchema.nullable().default(null),
});
export type MaintenanceJob = z.infer<typeof maintenanceJobSchema>;

export const attachmentTextJobSchema = jobBase.extend({
  attachmentId: idSchema,
  workspaceId: idSchema,
  reason: z.enum(['upload', 'requested', 'retry']),
});
export type AttachmentTextJob = z.infer<typeof attachmentTextJobSchema>;

export const JOB_SCHEMAS = {
  [QUEUE_NAMES.documentMaterialization]: materializeDocumentJobSchema,
  [QUEUE_NAMES.searchIndexing]: indexDocumentJobSchema,
  [QUEUE_NAMES.ai]: aiRunJobSchema,
  [QUEUE_NAMES.maintenance]: maintenanceJobSchema,
  [QUEUE_NAMES.attachmentText]: attachmentTextJobSchema,
} as const;

export type JobPayloadMap = {
  [QUEUE_NAMES.documentMaterialization]: MaterializeDocumentJob;
  [QUEUE_NAMES.searchIndexing]: IndexDocumentJob;
  [QUEUE_NAMES.ai]: AiRunJob;
  [QUEUE_NAMES.maintenance]: MaintenanceJob;
  [QUEUE_NAMES.attachmentText]: AttachmentTextJob;
};
