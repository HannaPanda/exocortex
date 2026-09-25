import { type Node as PmNode } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';

import { getExocortexSchema } from '@exocortex/editor';

import { describeBlockRemoval } from './block-removal';

const schema = getExocortexSchema();

/** Builds one node of the given type, and says so when the schema has none. */
function node(type: string, content?: PmNode | readonly PmNode[]): PmNode {
  const nodeType = schema.nodes[type];
  if (nodeType === undefined) throw new Error(`unknown node type: ${type}`);
  const built = nodeType.createAndFill(null, content === undefined ? null : [content].flat());
  if (built === null) throw new Error(`cannot build node: ${type}`);
  return built;
}

/** One block carrying plain text. */
function block(type: string, text: string): PmNode {
  return node(type, text.length === 0 ? undefined : schema.text(text));
}

/** A table of the given shape, filled with one word per cell. */
function table(rows: number, columns: number): PmNode {
  const cell = (): PmNode => node('tableCell', block('paragraph', 'Zelle'));
  const row = (): PmNode =>
    node(
      'tableRow',
      Array.from({ length: columns }, () => cell()),
    );
  return node(
    'table',
    Array.from({ length: rows }, () => row()),
  );
}

describe('describeBlockRemoval', () => {
  it('asks before a table goes, and says how big it was', () => {
    expect(describeBlockRemoval(table(3, 4))).toEqual({
      kind: 'table',
      block: 'table',
      rows: 3,
      columns: 4,
    });
  });

  it('asks before a compound block goes', () => {
    expect(describeBlockRemoval(block('codeBlock', 'const x = 1;'))).toEqual({
      kind: 'compound',
      block: 'codeBlock',
    });
    expect(describeBlockRemoval(block('blockquote', ''))).toEqual({
      kind: 'compound',
      block: 'blockquote',
    });
  });

  it('lets a short paragraph go without a question', () => {
    expect(describeBlockRemoval(block('paragraph', 'Kurz'))).toBeNull();
    expect(describeBlockRemoval(block('heading', 'Eine Überschrift'))).toBeNull();
  });

  it('asks before a long paragraph goes', () => {
    expect(describeBlockRemoval(block('paragraph', 'a'.repeat(300)))).toEqual({
      kind: 'text',
      block: 'paragraph',
      characters: 300,
    });
  });
});
