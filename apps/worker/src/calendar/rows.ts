import {
  type DatabaseRow,
  type DatabaseRowPropertyValue,
  queryDatabaseRowsResponseSchema,
} from '@exocortex/contracts';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';

/**
 * Reading a mirror database back out through the API.
 *
 * Shared by the write-back direction and the reminder sweep, because both need
 * the same thing: what a row *currently* says, as a human left it. Reading it
 * twice with two slightly different interpretations of an empty cell is how the
 * two would start disagreeing about whether anything changed.
 */

/** One page of rows. The API caps a page at 100. */
const ROW_PAGE_SIZE = 100;

/**
 * Every row of a mirror database, one page at a time.
 *
 * The whole listing is collected before a caller acts on it. That ordering
 * carries real weight for the write-back: a row with no known state is treated as
 * new and created on the server, so a listing that failed halfway through would
 * create a second copy of every appointment it did not manage to list.
 */
export async function readAllRows(
  client: ExocortexApiClient,
  documentId: string,
): Promise<DatabaseRow[]> {
  const rows: DatabaseRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.request({
      method: 'POST',
      path: `/api/documents/${documentId}/rows/query`,
      body: { limit: ROW_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
      responseSchema: queryDatabaseRowsResponseSchema,
    });
    rows.push(...page.rows);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return rows;
}

export function valueOf(
  row: DatabaseRow,
  propertyId: string | null,
): DatabaseRowPropertyValue['value'] {
  if (propertyId === null) return null;
  return row.values.find((entry) => entry.propertyId === propertyId)?.value ?? null;
}

/**
 * A DATE cell as a span. Both shapes the contract allows are accepted: a range
 * object from a property with `isRange`, and a bare instant from one without.
 */
export function readSpan(
  value: DatabaseRowPropertyValue['value'],
): { start: string; end: string | null; allDay: boolean } | null {
  if (typeof value === 'string') {
    return value.trim().length === 0 ? null : { start: value, end: null, allDay: false };
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return { start: value.start, end: value.end, allDay: value.allDay };
  }
  return null;
}

/** An empty cell and an absent one are the same thing. */
export function readText(value: DatabaseRowPropertyValue['value']): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
