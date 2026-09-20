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
    const warning = describeBlockRemoval(table(3, 4));
    expect(warning?.title).toBe('Tabelle löschen?');
    expect(warning?.description).toContain('3 Zeilen');
    expect(warning?.description).toContain('4 Spalten');
    expect(warning?.description).toContain('Strg+Z');
  });

  it('asks before a compound block goes', () => {
    expect(describeBlockRemoval(block('codeBlock', 'const x = 1;'))?.title).toBe(
      'Codeblock löschen?',
    );
    expect(describeBlockRemoval(block('blockquote', ''))?.title).toBe('Zitat löschen?');
  });

  it('lets a short paragraph go without a question', () => {
    expect(describeBlockRemoval(block('paragraph', 'Kurz'))).toBeNull();
    expect(describeBlockRemoval(block('heading', 'Eine Überschrift'))).toBeNull();
  });

  it('asks before a long paragraph goes', () => {
    const warning = describeBlockRemoval(block('paragraph', 'a'.repeat(300)));
    expect(warning?.title).toBe('Absatz löschen?');
    expect(warning?.description).toContain('300 Zeichen');
  });
});
