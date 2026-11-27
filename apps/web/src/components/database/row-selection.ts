/**
 * Which rows of a table are selected (issue #244), as plain data.
 *
 * The rows on screen are the order a range is measured in. A selected row
 * that disappears (another tab put it in the trash, a filter hides it) simply
 * stops counting: `selectedInOrder` only ever answers with rows that are
 * still shown, so an action can never reach one the reader cannot see.
 */
export interface RowSelection {
  ids: ReadonlySet<string>;
  /** The row a Shift+click measures its range from: the last one clicked alone. */
  anchor: string | null;
}

export const EMPTY_ROW_SELECTION: RowSelection = { ids: new Set(), anchor: null };

/**
 * One click on a row's checkbox. Alone it flips that row and makes it the
 * anchor; with Shift it gives every row between the anchor and this one the
 * state this row is about to get, the way a file manager does, and keeps the
 * anchor so the range can be stretched again.
 */
export function clickRow(
  selection: RowSelection,
  order: readonly string[],
  rowId: string,
  range: boolean,
): RowSelection {
  const select = !selection.ids.has(rowId);
  const from = selection.anchor === null ? -1 : order.indexOf(selection.anchor);
  const to = order.indexOf(rowId);
  if (!range || from === -1 || to === -1) {
    const ids = new Set(selection.ids);
    if (select) ids.add(rowId);
    else ids.delete(rowId);
    return { ids, anchor: rowId };
  }
  const ids = new Set(selection.ids);
  for (const id of order.slice(Math.min(from, to), Math.max(from, to) + 1)) {
    if (select) ids.add(id);
    else ids.delete(id);
  }
  return { ids, anchor: selection.anchor };
}

/** The header checkbox: every row shown, or none when every row shown already is. */
export function toggleAllRows(selection: RowSelection, order: readonly string[]): RowSelection {
  const all = order.length > 0 && order.every((id) => selection.ids.has(id));
  return all ? EMPTY_ROW_SELECTION : { ids: new Set(order), anchor: selection.anchor };
}

/** The selected rows that are still shown, in the order they are shown. */
export function selectedInOrder(selection: RowSelection, order: readonly string[]): string[] {
  return order.filter((id) => selection.ids.has(id));
}
