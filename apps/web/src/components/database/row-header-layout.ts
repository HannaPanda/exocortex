import {
  type DatabaseProperty,
  type DatabaseRowPropertyValue,
  type DocumentDetail,
} from '@exocortex/contracts';

type CellValue = DatabaseRowPropertyValue['value'];

/**
 * Which of a row's properties its page header shows before "N weitere
 * Eigenschaften" is opened (issue #254).
 *
 * Three rules, in this order, and all of them keep the database's column order,
 * because a header that reorders the columns by content would put the same
 * field in a different line on every page of the database:
 *
 * - A schema short enough to read at a glance is shown whole to somebody who
 *   can edit it. An empty field is an invitation to fill it, the way a new row
 *   in Notion shows every property.
 * - Past that, the first `ROW_HEADER_LEADING` columns are always shown to an
 *   editor, and every column with a value is shown to everybody. What folds
 *   away is the empty tail, which is what makes a long schema long.
 * - Somebody who can only read sees the filled ones: an empty field they cannot
 *   fill says nothing. They stay one click away, so "this row has no due date"
 *   is still something a reader can find out.
 *
 * However much is filled, the folded header never shows more than
 * `ROW_HEADER_MAX` lines, so a fifty-column database cannot push the page body
 * off the screen. A fold that would hide a single line shows it instead: a
 * button costs the same line as the field it hides.
 */
export const ROW_HEADER_LEADING = 6;
export const ROW_HEADER_SHOW_ALL_UP_TO = 8;
export const ROW_HEADER_MAX = 12;

export interface RowHeaderLayout {
  shown: DatabaseProperty[];
  folded: DatabaseProperty[];
}

/** No value at all: nothing written, an empty text, an empty list. */
export function isEmptyCellValue(value: CellValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function layoutRowHeader(input: {
  properties: readonly DatabaseProperty[];
  valueOf: (propertyId: string) => CellValue | undefined;
  readOnly: boolean;
}): RowHeaderLayout {
  const { properties, valueOf, readOnly } = input;
  if (!readOnly && properties.length <= ROW_HEADER_SHOW_ALL_UP_TO) {
    return { shown: [...properties], folded: [] };
  }

  const shown: DatabaseProperty[] = [];
  const folded: DatabaseProperty[] = [];
  properties.forEach((property, index) => {
    const wanted =
      !isEmptyCellValue(valueOf(property.id)) || (!readOnly && index < ROW_HEADER_LEADING);
    if (wanted && shown.length < ROW_HEADER_MAX) shown.push(property);
    else folded.push(property);
  });

  if (folded.length === 1) {
    // Put it back where the schema has it, not at the end.
    return { shown: [...properties], folded: [] };
  }
  return { shown, folded };
}

/**
 * The database a page may be a row of, or `null` when it certainly is not one.
 *
 * A member reads it off `parentType`. Somebody a single page was shared with
 * is told nothing about the page above it (`parentType` is null when the
 * parent lies outside the grant, issue #83), so for them the row read itself
 * answers: `GET /api/documents/:id/row` says `row: null` for a page that is not
 * a row, and the header then renders nothing (issue #254).
 */
export function rowCollectionIdOf(
  detail: Pick<DocumentDetail, 'type' | 'parentId' | 'parentType' | 'viaShare'>,
): string | null {
  if (detail.type !== 'PAGE' || detail.parentId === null) return null;
  if (detail.parentType === 'COLLECTION') return detail.parentId;
  if (detail.parentType === null && detail.viaShare) return detail.parentId;
  return null;
}
