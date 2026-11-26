import { describe, expect, it } from 'vitest';

import {
  BLOCK_ID_ATTRIBUTE,
  type ProseMirrorDocument,
  type ProseMirrorNode,
  serializeMarkdown,
} from '@exocortex/editor';

import { applyResponseBudget } from './response-budget';

function point(text: string, blockId: string): ProseMirrorNode {
  return {
    type: 'listItem',
    attrs: { [BLOCK_ID_ATTRIBUTE]: blockId },
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

function oneList(points: ProseMirrorNode[]): ProseMirrorDocument {
  return {
    type: 'doc',
    content: [
      { type: 'bulletList', attrs: { [BLOCK_ID_ATTRIBUTE]: 'listaaaaaaa1' }, content: points },
    ],
  };
}

describe('applyResponseBudget (issue #274)', () => {
  it('answers a list over the budget with windows of its points, not with a cut', () => {
    const document = oneList(
      Array.from({ length: 30 }, (_, index) =>
        point(`Punkt ${index + 1}: ${'x'.repeat(400)}`, `item${String(index).padStart(8, '0')}`),
      ),
    );

    const view = applyResponseBudget(document, serializeMarkdown(document), {
      maxChars: 10_000,
      maxEntries: 40,
    });

    expect(view.view).toBe('map');
    expect(view.markdown).toBe('');
    expect(view.map?.entries.length).toBeGreaterThan(1);
    expect(view.map?.entries.reduce((total, entry) => total + entry.blocks, 0)).toBe(30);
  });

  it('still answers a single point that cannot be divided with its content', () => {
    const document = oneList([point('x'.repeat(20_000), 'itemaaaaaaa1')]);

    const view = applyResponseBudget(document, serializeMarkdown(document), {
      maxChars: 10_000,
    });

    expect(view.view).toBe('content');
    expect(view.markdown.length).toBeGreaterThan(20_000);
  });
});
