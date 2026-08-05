import { describe, expect, it } from 'vitest';

import { ADDRESSABLE_BLOCK_TYPES } from './block-id';
import { EXOCORTEX_SCHEMA_VERSION } from './contract';
import { EXOCORTEX_EDITOR_EXTENSIONS, registrySchemaVersion } from './extensions';
import {
  createEmptyDocument,
  getSchemaMarkNames,
  getSchemaNodeNames,
  validateProseMirrorDocument,
} from './schema';

const REQUIRED_NODES = [
  'doc',
  'paragraph',
  'heading',
  'text',
  'codeBlock',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'blockquote',
  'horizontalRule',
  'hardBreak',
  'image',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'callout',
];

const REQUIRED_MARKS = ['bold', 'italic', 'strike', 'code', 'link'];

describe('canonical schema', () => {
  it('contains every required node type', () => {
    const nodes = getSchemaNodeNames();
    for (const node of REQUIRED_NODES) {
      expect(nodes, `missing node ${node}`).toContain(node);
    }
  });

  it('contains every required mark type', () => {
    const marks = getSchemaMarkNames();
    for (const mark of REQUIRED_MARKS) {
      expect(marks, `missing mark ${mark}`).toContain(mark);
    }
  });

  it('accepts an empty document', () => {
    expect(validateProseMirrorDocument(createEmptyDocument()).valid).toBe(true);
  });

  it('rejects an unknown node type', () => {
    const result = validateProseMirrorDocument({
      type: 'doc',
      content: [{ type: 'kanbanBoard' }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBeTypeOf('string');
  });

  it('reports the registry schema version', () => {
    expect(registrySchemaVersion()).toBe(EXOCORTEX_SCHEMA_VERSION);
  });

  it('registers every addressable block type in the schema', () => {
    const nodes = new Set(getSchemaNodeNames());
    for (const type of ADDRESSABLE_BLOCK_TYPES) {
      expect(nodes.has(type), `addressable type ${type} is not in the schema`).toBe(true);
    }
  });

  it('gives every extension a unique name', () => {
    const names = EXOCORTEX_EDITOR_EXTENSIONS.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
