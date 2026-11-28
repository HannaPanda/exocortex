import * as Y from 'yjs';

import {
  BLOCKS_OUTSIDE_TABLE_CELLS,
  pageLinkAttributesForEmbed,
  TABLE_CELL_TYPES,
} from './table-cell-blocks';
import { YJS_DOCUMENT_FIELD } from './yjs';

/*
 * Schema version 7 (issue #312) applied to the canonical Yjs state itself.
 * Kept apart from `schema-v7.ts` for the reason `callout-yjs.ts` is: the
 * registry imports that file, and this one needs the Yjs bridge, which
 * imports the registry.
 */

/** Every element below `parent` that stands in a cell and never may. */
function collectMisplaced(
  parent: Y.XmlFragment | Y.XmlElement,
  inCell: boolean,
  into: Y.XmlElement[],
): void {
  for (const child of parent.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (inCell && BLOCKS_OUTSIDE_TABLE_CELLS.has(child.nodeName)) {
      into.push(child);
      continue;
    }
    collectMisplaced(child, inCell || TABLE_CELL_TYPES.has(child.nodeName), into);
  }
}

/**
 * Turns every database standing in a table cell of a live Yjs document into a
 * page link to that database, in place, and returns how many there were.
 *
 * One transaction: the link takes the embed's place at the same index, with
 * the embed's title, database and block identifier, and nothing else in the
 * cell or the page is touched. Idempotent: a page without one writes nothing,
 * so a second run, or the collaboration server and the script meeting on the
 * same page, changes nothing more.
 */
export function migrateTableCellBlocksInYjsDoc(doc: Y.Doc, origin: unknown = null): number {
  const misplaced: Y.XmlElement[] = [];
  collectMisplaced(doc.getXmlFragment(YJS_DOCUMENT_FIELD), false, misplaced);
  if (misplaced.length === 0) return 0;

  doc.transact(() => {
    for (const element of misplaced) {
      const parent: unknown = element.parent;
      if (!(parent instanceof Y.XmlElement || parent instanceof Y.XmlFragment)) continue;
      const index = parent.toArray().indexOf(element);
      if (index < 0) continue;
      const link = new Y.XmlElement('pageLink');
      const attributes = pageLinkAttributesForEmbed(element.getAttributes(), true);
      for (const [name, value] of Object.entries(attributes)) {
        // y-prosemirror stores no attribute for `null`; neither does this.
        if (typeof value === 'string') link.setAttribute(name, value);
      }
      parent.insert(index, [link]);
      parent.delete(index + 1, 1);
    }
  }, origin);
  return misplaced.length;
}
