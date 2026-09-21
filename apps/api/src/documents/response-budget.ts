import { type DocumentMapDto } from '@exocortex/contracts';
import { buildDocumentMap, type ProseMirrorDocument } from '@exocortex/editor';

/**
 * One rule for "this answer is too big" (issue #118).
 *
 * Two routes answer with the text of a page: the Markdown export and the
 * fragment route. Both are read by agents whose context is finite and by a
 * browser whose is not, so the caller names the budget and the same decision is
 * made once here rather than twice with a difference nobody meant.
 *
 * The decision is deliberately binary. Over the budget the answer is the map
 * and no text at all, never a prefix: a prefix reads like the beginning of
 * something and invites reading on, which is exactly the loop that made this
 * necessary. A map invites choosing.
 *
 * And it recurses without a special case, because a part handed back in is
 * just a shorter document: `buildDocumentMap` cuts it at its own inner
 * headings, and at block ranges when it has none.
 */
export interface BudgetedView {
  view: 'content' | 'map';
  markdown: string;
  map: DocumentMapDto | null;
  chars: number;
}

export function applyResponseBudget(
  document: ProseMirrorDocument,
  markdown: string,
  budget: { maxChars?: number; maxEntries?: number; want?: 'auto' | 'map' },
): BudgetedView {
  const chars = markdown.length;
  const wantsMap = budget.want === 'map';
  if (!wantsMap && (budget.maxChars === undefined || chars <= budget.maxChars)) {
    return { view: 'content', markdown, map: null, chars };
  }
  return {
    view: 'map',
    markdown: '',
    map: buildDocumentMap(document, { maxEntries: budget.maxEntries, totalChars: chars }),
    chars,
  };
}
