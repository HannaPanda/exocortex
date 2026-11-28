import { z } from 'zod';

/**
 * Response shapes that exist on live `apps/api` routes but have no named export
 * in `@exocortex/contracts` yet.
 *
 * The database property and view list schemas used to live here too, from when
 * contracts was frozen for a wave. They moved into
 * `packages/contracts/src/database-views.ts` once the calendar sync needed them
 * as well: a response shape two packages read is a contract, not a local detail.
 * Re-exported below so existing imports keep working.
 */

export {
  databasePropertyListResponseSchema,
  databaseViewListResponseSchema,
} from '@exocortex/contracts';

/** Shared shape of the `DELETE` responses on properties, options and views. */
export const deletedResultSchema = z.object({ deleted: z.literal(true) });
