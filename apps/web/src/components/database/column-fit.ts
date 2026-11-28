import { clampColumnWidth } from './table-columns';

/**
 * Fitting a table column to its content (issue #277): the width the widest
 * cell of the column needs, its header included, within the column limits.
 *
 * Every header and body cell of a table view carries the column's key in this
 * attribute, which is how the cells of one column are found again without the
 * table having to hold a ref per cell.
 */
export const COLUMN_KEY_ATTRIBUTE = 'data-column-key';

/**
 * Marks a corner button drawn over a cell's content (the AI mark, issue #237).
 * Being absolutely positioned it takes no room of its own, so a fitted width
 * adds its room, or the longest line would end underneath it. The mark that
 * only shows on hover (`data-state="offer"`) is left out: it covers nothing
 * while nobody points at the cell.
 */
export const CELL_MARK_ATTRIBUTE = 'data-cell-mark';

/** The widest of the measured cells, rounded up, within the column limits. */
export function fittedColumnWidth(cellWidths: readonly number[]): number {
  return clampColumnWidth(Math.ceil(Math.max(0, ...cellWidths)));
}

/**
 * How wide each cell of one column would like to be.
 *
 * What is measured is what the table has rendered: the header and the rows it
 * has loaded (the first page of the view, issue #277). A row the table has not
 * fetched has no cell to measure, so it does not count -- the same answer a
 * spreadsheet gives for what it shows. Rows scrolled out of sight are still in
 * the DOM and do count.
 *
 * A cell's content is laid out once more at `max-content` inside the cell
 * itself, so it inherits the cell's font and every class keeps its meaning:
 * a wrapping title is measured as one line, a list of chips (selection, people,
 * files) as one row, a clamped text by its longest line. The copy is
 * invisible and removed before the browser paints.
 */
export function measureColumnCells(table: HTMLTableElement, columnKey: string): number[] {
  const selector = `[${COLUMN_KEY_ATTRIBUTE}="${CSS.escape(columnKey)}"]`;
  // Only this table's own rows: a cell never holds a table, but the selector
  // should not depend on that.
  const cells = [
    ...table.querySelectorAll<HTMLElement>(
      `:scope > thead > tr > ${selector}, :scope > tbody > tr > ${selector}`,
    ),
  ];
  return cells.map(measureCell);
}

function measureCell(cell: HTMLElement): number {
  const style = getComputedStyle(cell);
  const chrome =
    parseFloat(style.paddingLeft) +
    parseFloat(style.paddingRight) +
    parseFloat(style.borderLeftWidth) +
    parseFloat(style.borderRightWidth);

  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:absolute;left:0;top:0;width:max-content;visibility:hidden;pointer-events:none;';
  for (const child of cell.childNodes) probe.append(child.cloneNode(true));
  showInputsAsText(cell, probe);
  cell.append(probe);
  const content = probe.getBoundingClientRect().width;
  probe.remove();

  const mark = cell.querySelector<HTMLElement>(
    `[${CELL_MARK_ATTRIBUTE}]:not([data-state="offer"])`,
  );
  const markRoom = mark === null ? 0 : mark.getBoundingClientRect().width;
  return content + chrome + markRoom;
}

const TEXT_FIELDS =
  'input:not([type]), input[type="text"], input[type="number"], input[type="email"], ' +
  'input[type="url"], input[type="tel"], input[type="search"], textarea';

/**
 * A text field's width says nothing about what it holds: at `max-content` it
 * is as wide as its default size, whatever its value (the number cell is an
 * input all the time). So each field in the copy becomes its value -- or its
 * placeholder while it is empty -- set in the field's own font and padding.
 * The value is read from the original, because a copied field keeps only its
 * attribute, not what was typed into it.
 */
function showInputsAsText(cell: HTMLElement, probe: HTMLElement): void {
  const originals = [...cell.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(TEXT_FIELDS)];
  const copies = [...probe.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(TEXT_FIELDS)];
  originals.forEach((original, index) => {
    const copy = copies[index];
    if (copy === undefined) return;
    const look = getComputedStyle(original);
    const text = document.createElement('span');
    text.textContent = original.value.length > 0 ? original.value : original.placeholder;
    text.style.cssText = [
      'display:inline-block',
      // `pre`: a textarea's lines stay lines, and the widest one counts.
      'white-space:pre',
      `font:${look.font}`,
      `letter-spacing:${look.letterSpacing}`,
      `padding:0 ${look.paddingRight} 0 ${look.paddingLeft}`,
      `border-left:${look.borderLeftWidth} solid transparent`,
      `border-right:${look.borderRightWidth} solid transparent`,
    ].join(';');
    copy.replaceWith(text);
  });
}
