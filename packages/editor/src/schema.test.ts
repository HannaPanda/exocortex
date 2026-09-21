import { Node, type NodeViewRenderer } from '@tiptap/core';
import { describe, expect, it } from 'vitest';

import { BLOCK_ICON_NAMES, filterBlockCatalog, groupBlockCatalog } from './block-catalog';
import { ADDRESSABLE_BLOCK_TYPES } from './block-id';
import { EXOCORTEX_SCHEMA_VERSION } from './contract';
import { isEmbeddableUrl, toEmbedUrl } from './embed';
import {
  buildBlockCatalog,
  buildEditorExtensions,
  EXOCORTEX_EDITOR_EXTENSIONS,
  registrySchemaVersion,
} from './extensions';
import { migrateDocument } from './migrations';
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
  // Schema version 2: the full block set.
  'details',
  'detailsSummary',
  'detailsContent',
  'columnList',
  'column',
  'inlineMath',
  'blockMath',
  'tableOfContents',
  'pageLink',
  'breadcrumb',
  'mention',
  'fileAttachment',
  'video',
  'audio',
  'pdf',
  'embed',
  'bookmark',
  'databaseEmbed',
];

const REQUIRED_MARKS = [
  'bold',
  'italic',
  'strike',
  'code',
  'link',
  'underline',
  'superscript',
  'subscript',
  'textColor',
];

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

  it('migrates a version 1 document up to the current schema version without a gap', () => {
    const result = migrateDocument(createEmptyDocument(), 1);
    expect(result.toVersion).toBe(EXOCORTEX_SCHEMA_VERSION);
    expect(result.applied.length).toBe(EXOCORTEX_SCHEMA_VERSION - 1);
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

describe('block catalog', () => {
  const catalog = buildBlockCatalog();

  it('offers every Notion-equivalent block', () => {
    const ids = catalog.map((entry) => entry.id);
    for (const id of [
      'paragraph',
      'heading-1',
      'heading-2',
      'heading-3',
      'bullet-list',
      'ordered-list',
      'task-list',
      'toggle',
      'blockquote',
      'code-block',
      'horizontal-rule',
      'callout-info',
      'table',
      'columns',
      'block-math',
      'table-of-contents',
      'page-link',
      'breadcrumb',
      'image',
      'file',
      'video',
      'audio',
      'pdf',
      'embed',
      'bookmark',
      'database-embed',
    ]) {
      expect(ids, `catalog is missing ${id}`).toContain(id);
    }
  });

  it('gives every entry a unique id', () => {
    const ids = catalog.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names an icon that exists', () => {
    for (const entry of catalog) {
      expect(BLOCK_ICON_NAMES, `unknown icon on ${entry.id}`).toContain(entry.icon);
    }
  });

  it('describes every entry in German', () => {
    for (const entry of catalog) {
      expect(entry.label.length, `${entry.id} has no label`).toBeGreaterThan(0);
      expect(entry.description.length, `${entry.id} has no description`).toBeGreaterThan(0);
      expect(entry.keywords.length, `${entry.id} has no keywords`).toBeGreaterThan(0);
    }
  });

  it('finds entries by label and by keyword', () => {
    expect(filterBlockCatalog(catalog, 'über').map((entry) => entry.id)).toContain('heading-1');
    expect(filterBlockCatalog(catalog, 'todo').map((entry) => entry.id)).toContain('task-list');
    expect(filterBlockCatalog(catalog, 'youtube').map((entry) => entry.id)).toContain('embed');
    expect(filterBlockCatalog(catalog, 'zzzzz')).toEqual([]);
  });

  it('groups entries without losing any', () => {
    const grouped = groupBlockCatalog(catalog).flatMap((section) => section.entries);
    expect(grouped).toHaveLength(catalog.length);
  });
});

describe('embed allow list', () => {
  it('accepts only https hosts from the allow list', () => {
    expect(isEmbeddableUrl('https://www.youtube-nocookie.com/embed/abc')).toBe(true);
    expect(isEmbeddableUrl('https://player.vimeo.com/video/1')).toBe(true);
    // Not on the list, plain http, and a lookalike host.
    expect(isEmbeddableUrl('https://evil.example/embed')).toBe(false);
    expect(isEmbeddableUrl('http://www.youtube-nocookie.com/embed/abc')).toBe(false);
    expect(isEmbeddableUrl('https://youtube.com.evil.example/x')).toBe(false);
    expect(isEmbeddableUrl('nonsense')).toBe(false);
  });

  it('rewrites watch pages into embed endpoints', () => {
    expect(toEmbedUrl('https://www.youtube.com/watch?v=abc123')).toBe(
      'https://www.youtube-nocookie.com/embed/abc123',
    );
    expect(toEmbedUrl('https://youtu.be/abc123')).toBe(
      'https://www.youtube-nocookie.com/embed/abc123',
    );
    expect(toEmbedUrl('https://vimeo.com/76979871')).toBe(
      'https://player.vimeo.com/video/76979871',
    );
    // Anything already embeddable is left alone.
    expect(toEmbedUrl('https://codepen.io/x/embed/y')).toBe('https://codepen.io/x/embed/y');
  });
});

describe('buildEditorExtensions', () => {
  it('registers no name twice', () => {
    // Tiptap does not deduplicate: a second extension of the same name warns,
    // gives the schema to whichever copy came last, and runs both copies'
    // input rules, keyboard shortcuts and plugins (issue #114).
    const names = buildEditorExtensions().map((extension) => extension.name);
    expect([...new Set(names)]).toHaveLength(names.length);
  });

  it('attaches a node view to the canonical extension rather than a second one', () => {
    const renderer = (() => ({})) as unknown as NodeViewRenderer;
    const built = buildEditorExtensions({ nodeViews: { pageLink: renderer } });

    const pageLinks = built.filter((extension) => extension.name === 'pageLink');
    expect(pageLinks).toHaveLength(1);

    const pageLink = pageLinks[0];
    expect(pageLink).toBeInstanceOf(Node);
    if (!(pageLink instanceof Node)) return;
    expect(pageLink.config.addNodeView?.call(undefined as never)).toBe(renderer);
  });
});
