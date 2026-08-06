import { z } from 'zod';

import { databasePropertySchema, databaseViewSchema, idSchema } from '@exocortex/contracts';

/**
 * Response shapes that exist on live `apps/api` routes but do not (yet) have a
 * named export in the frozen `@exocortex/contracts` package. `packages/contracts`
 * is frozen for this wave (D2 / plan-00 R11), so these are defined locally
 * instead of editing it; see `docs/mcp.md` for the follow-up note to fold them
 * back into contracts in a later wave.
 */

/** `POST /api/documents/:documentId/snapshots/:snapshotId/restore` response. */
export const restoreSnapshotResultSchema = z.object({
  documentId: idSchema,
  restoredFrom: idSchema,
});

/** `GET /api/documents/:documentId/properties` response. */
export const databasePropertyListResponseSchema = z.object({
  properties: z.array(databasePropertySchema),
});

/** `GET /api/documents/:documentId/views` response. */
export const databaseViewListResponseSchema = z.object({
  views: z.array(databaseViewSchema),
});

/** Shared shape of the `DELETE` responses on properties, options and views. */
export const deletedResultSchema = z.object({ deleted: z.literal(true) });
