// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { type ProseMirrorDocument } from './contract';
import { extractDocumentLinks } from './document-links';
import { buildEditorExtensions } from './extensions';
import { parseMarkdown } from './markdown/parse';
import { serializeMarkdown } from './markdown/serialize';
import { migrateDocument } from './migrations';
import { pageLinkBlocks, parsePageLinkPromptValue } from './page-link';
import {
  bindPageLinkIdentities,
  collectPageReferences,
  resolvePageLinkTarget,
  resolvePageLinkTitles,
} from './page-link-identity';
import { SCHEMA_V4_MIGRATION } from './schema-v4';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function doc(...content: NonNullable<ProseMirrorDocument['content']>): ProseMirrorDocument {
  return { type: 'doc', content };
}

function pageLink(title: string, documentId: string | null = null) {
  return { type: 'pageLink', attrs: { title, documentId } };
}

function pageMention(label: string, id: string | null = null) {
  return {
    type: 'paragraph',
    content: [{ type: 'mention', attrs: { kind: 'page', label, id } }],
  };
}

describe('page link node', () => {
  it('stores the identity next to the displayed title', () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: '<p></p>' });
    editor.commands.insertPageLink({ title: 'Architektur', documentId: 'doc123' });

    const node = editor.getJSON().content?.find((entry) => entry.type === 'pageLink');
    expect(node?.attrs).toMatchObject({ title: 'Architektur', documentId: 'doc123' });
  });

  it('accepts a link without an identity, for a page that does not exist yet', () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: '<p></p>' });
    editor.commands.insertPageLink({ title: 'Noch keine Seite' });

    const node = editor.getJSON().content?.find((entry) => entry.type === 'pageLink');
    expect(node?.attrs).toMatchObject({ title: 'Noch keine Seite', documentId: null });
  });

  it('renders the identity and the wiki address as a static fallback', () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: '<p></p>' });
    editor.commands.insertPageLink({ title: 'Architektur', documentId: 'doc123' });

    const anchor = editor.view.dom.querySelector('[data-page-link]');
    expect(anchor?.getAttribute('data-document-id')).toBe('doc123');
    expect(anchor?.getAttribute('data-page-title')).toBe('Architektur');
    // Exported HTML stays readable without the application resolving anything.
    expect(anchor?.getAttribute('href')).toBe('wiki:Architektur');
  });

  it('omits the identity attribute entirely when there is none', () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: '<p></p>' });
    editor.commands.insertPageLink({ title: 'Ohne Ziel' });

    const anchor = editor.view.dom.querySelector('[data-page-link]');
    expect(anchor?.hasAttribute('data-document-id')).toBe(false);
  });
});

describe('parsePageLinkPromptValue', () => {
  it("reads the picker's JSON answer", () => {
    expect(parsePageLinkPromptValue('{"documentId":"doc1","title":"Ziel"}')).toEqual({
      title: 'Ziel',
      documentId: 'doc1',
    });
  });

  it('reads a plain title as a link without an identity', () => {
    expect(parsePageLinkPromptValue('  Neue Seite  ')).toEqual({
      title: 'Neue Seite',
      documentId: null,
    });
  });

  it('rejects an empty answer', () => {
    expect(parsePageLinkPromptValue('   ')).toBeNull();
    expect(parsePageLinkPromptValue('{"title":""}')).toBeNull();
  });

  it('is what the catalog entry runs', () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: '<p></p>' });
    const entry = pageLinkBlocks[0];
    expect(entry?.run(editor, '{"documentId":"doc9","title":"Ziel"}')).toBe(true);

    const node = editor.getJSON().content?.find((item) => item.type === 'pageLink');
    expect(node?.attrs).toMatchObject({ title: 'Ziel', documentId: 'doc9' });
  });
});

describe('Markdown stays an interchange format', () => {
  it('writes no identifier, only the title', () => {
    const markdown = serializeMarkdown(doc(pageLink('Andere Seite', 'doc123')));
    expect(markdown).toBe(':::page Andere Seite\n:::\n');
    expect(markdown).not.toContain('doc123');
  });

  it('resolves the title from the identity before serializing', () => {
    const titles = new Map([['doc123', 'Neuer Name']]);
    const resolved = resolvePageLinkTitles(doc(pageLink('Alter Name', 'doc123')), (id) =>
      titles.get(id),
    );

    expect(serializeMarkdown(resolved)).toBe(':::page Neuer Name\n:::\n');
  });

  it('keeps the stored title when the identity is unknown', () => {
    const resolved = resolvePageLinkTitles(doc(pageLink('Verwaist', 'gone')), () => null);
    expect(serializeMarkdown(resolved)).toBe(':::page Verwaist\n:::\n');
  });

  it("refreshes a page mention's label from its identity too", () => {
    const resolved = resolvePageLinkTitles(doc(pageMention('Alter Name', 'doc7')), () =>
      'Neuer Name',
    );
    expect(serializeMarkdown(resolved)).toBe('@[[Neuer Name]]\n');
  });

  it('imports a page link without an identity', () => {
    const parsed = parseMarkdown(':::page Andere Seite\n:::\n');
    const node = parsed.document.content?.find((entry) => entry.type === 'pageLink');
    expect(node?.attrs).toMatchObject({ title: 'Andere Seite', documentId: null });
  });

  it('binds an imported title to an identity', () => {
    const parsed = parseMarkdown(':::page Andere Seite\n:::\n\nSiehe @[[Andere Seite]].\n');
    const bound = bindPageLinkIdentities(parsed.document, (title) =>
      title === 'Andere Seite' ? 'doc123' : null,
    );

    expect(collectPageReferences(bound)).toEqual([
      { kind: 'pageLink', documentId: 'doc123', title: 'Andere Seite' },
      { kind: 'mention', documentId: 'doc123', title: 'Andere Seite' },
    ]);
    // Still exactly the file it came from.
    expect(serializeMarkdown(bound)).toBe(':::page Andere Seite\n:::\n\nSiehe @[[Andere Seite]].\n');
  });

  it('leaves an unknown title unbound rather than dropping the reference', () => {
    const bound = bindPageLinkIdentities(doc(pageLink('Gibt es nicht')), () => null);
    expect(collectPageReferences(bound)).toEqual([
      { kind: 'pageLink', documentId: null, title: 'Gibt es nicht' },
    ]);
  });

  it('never overwrites an identity a reference already has', () => {
    const bound = bindPageLinkIdentities(doc(pageLink('Ziel', 'doc1')), () => 'doc2');
    expect(collectPageReferences(bound)[0]?.documentId).toBe('doc1');
  });
});

describe('resolvePageLinkTarget', () => {
  const target = { id: 'doc1', title: 'Architektur' };

  it('prefers the identity, so a rename changes nothing', () => {
    const resolution = resolvePageLinkTarget(
      { documentId: 'doc1', title: 'Alter Name' },
      { byId: target, byTitle: [] },
    );
    expect(resolution).toEqual({ state: 'resolved', via: 'id', target, ambiguous: false });
  });

  it('falls back to the title when there is no identity', () => {
    const resolution = resolvePageLinkTarget(
      { documentId: null, title: 'Architektur' },
      { byId: null, byTitle: [target] },
    );
    expect(resolution).toEqual({ state: 'resolved', via: 'title', target, ambiguous: false });
  });

  it('reports ambiguity when several pages carry the title', () => {
    const resolution = resolvePageLinkTarget(
      { documentId: null, title: 'Architektur' },
      { byId: null, byTitle: [target, { id: 'doc2', title: 'Architektur' }] },
    );
    expect(resolution).toMatchObject({ state: 'resolved', via: 'title', ambiguous: true });
  });

  it('falls back to the title when the identity is gone but the title still exists', () => {
    const resolution = resolvePageLinkTarget(
      { documentId: 'deleted', title: 'Architektur' },
      { byId: null, byTitle: [target] },
    );
    expect(resolution).toEqual({ state: 'resolved', via: 'title', target, ambiguous: false });
  });

  it('reports a deleted target instead of letting the reference vanish', () => {
    const resolution = resolvePageLinkTarget(
      { documentId: 'deleted', title: 'Architektur' },
      { byId: null, byTitle: [] },
    );
    expect(resolution).toEqual({ state: 'unresolved', reason: 'deleted', title: 'Architektur' });
  });

  it('reports a title no page carries', () => {
    const resolution = resolvePageLinkTarget(
      { documentId: null, title: 'Gibt es nicht' },
      { byId: null, byTitle: [] },
    );
    expect(resolution).toEqual({ state: 'unresolved', reason: 'missing', title: 'Gibt es nicht' });
  });

  it('reports a reference that names nothing at all', () => {
    const resolution = resolvePageLinkTarget(
      { documentId: null, title: '  ' },
      { byId: null, byTitle: [] },
    );
    expect(resolution).toEqual({ state: 'unresolved', reason: 'empty', title: '' });
  });
});

describe('schema 4 migration', () => {
  it('gives an old page link an explicit, empty identity', () => {
    const before = doc({ type: 'pageLink', attrs: { title: 'Andere Seite' } });
    const after = SCHEMA_V4_MIGRATION.migrate(before);

    expect(after.content?.[0]?.attrs).toEqual({ title: 'Andere Seite', documentId: null });
    // Pure: the input is never mutated.
    expect(before.content?.[0]?.attrs).toEqual({ title: 'Andere Seite' });
  });

  it('reaches page links nested inside other blocks', () => {
    const before = doc({
      type: 'columnList',
      content: [{ type: 'column', content: [{ type: 'pageLink', attrs: { title: 'Tief' } }] }],
    });
    const after = SCHEMA_V4_MIGRATION.migrate(before);

    const nested = after.content?.[0]?.content?.[0]?.content?.[0];
    expect(nested?.attrs).toEqual({ title: 'Tief', documentId: null });
  });

  it('leaves an identity that is already there alone', () => {
    const before = doc(pageLink('Ziel', 'doc1'));
    expect(SCHEMA_V4_MIGRATION.migrate(before)).toBe(before);
  });

  it('is part of the registered upgrade path', () => {
    const result = migrateDocument(doc({ type: 'pageLink', attrs: { title: 'Alt' } }), 3);
    expect(result.toVersion).toBe(4);
    expect(result.applied).toEqual(['schema 4: page links carry the identity of their target']);
    expect(result.document.content?.[0]?.attrs).toEqual({ title: 'Alt', documentId: null });
  });
});

describe('the reference index carries the identity', () => {
  it('reads it from both notations and from neither for a wiki mark', () => {
    const links = extractDocumentLinks(
      doc(
        pageLink('Architektur', 'doc1'),
        {
          type: 'paragraph',
          content: [{ type: 'mention', attrs: { kind: 'page', label: 'Betrieb', id: 'doc2' } }],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Sicherheit',
              marks: [{ type: 'link', attrs: { href: 'wiki:Sicherheit' } }],
            },
          ],
        },
      ),
    );

    expect(links.map((link) => [link.kind, link.targetDocumentId])).toEqual([
      ['pageLink', 'doc1'],
      ['mention', 'doc2'],
      ['wikiMark', null],
    ]);
  });

  it('reports no identity for a reference that has none', () => {
    const links = extractDocumentLinks(doc(pageLink('Ohne Ziel')));
    expect(links[0]?.targetDocumentId).toBeNull();
  });
});
