import { describe, expect, it } from 'vitest';

import { type ProseMirrorDocument } from './contract';
import {
  DOCUMENT_LINK_CONTEXT_CHARS,
  documentLinkTitleKey,
  extractDocumentLinks,
  MAX_DOCUMENT_LINKS,
} from './document-links';

function doc(...content: ProseMirrorDocument['content']): ProseMirrorDocument {
  return { type: 'doc', content };
}

function wikiText(title: string, label = title) {
  return {
    type: 'text',
    text: label,
    marks: [{ type: 'link', attrs: { href: `wiki:${title}` } }],
  };
}

describe('extractDocumentLinks', () => {
  it('finds all three notations', () => {
    const links = extractDocumentLinks(
      doc(
        { type: 'pageLink', attrs: { title: 'Architektur', blockId: 'aaaaaaaaaaaa' } },
        {
          type: 'paragraph',
          attrs: { blockId: 'bbbbbbbbbbbb' },
          content: [
            { type: 'text', text: 'Siehe ' },
            { type: 'mention', attrs: { kind: 'page', label: 'Betrieb' } },
            { type: 'text', text: ' und ' },
            wikiText('Sicherheit'),
            { type: 'text', text: ' im Detail.' },
          ],
        },
      ),
    );

    expect(links.map((link) => [link.kind, link.targetTitle])).toEqual([
      ['pageLink', 'Architektur'],
      ['mention', 'Betrieb'],
      ['wikiMark', 'Sicherheit'],
    ]);
    expect(links.map((link) => link.position)).toEqual([0, 1, 2]);
    expect(links[0]?.blockId).toBe('aaaaaaaaaaaa');
    expect(links[1]?.blockId).toBe('bbbbbbbbbbbb');
    expect(links[2]?.blockId).toBe('bbbbbbbbbbbb');
  });

  it('reads a wiki mark through wiki:// and percent encoding', () => {
    const links = extractDocumentLinks(
      doc({
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Notizen',
            marks: [{ type: 'link', attrs: { href: 'wiki://Meine%20Seite' } }],
          },
        ],
      }),
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.targetTitle).toBe('Meine Seite');
    expect(links[0]?.targetTitleKey).toBe('meine seite');
  });

  it('ignores mentions that do not point at a page', () => {
    const links = extractDocumentLinks(
      doc({
        type: 'paragraph',
        content: [
          { type: 'mention', attrs: { kind: 'user', label: 'Johanna' } },
          { type: 'mention', attrs: { kind: 'date', label: '2026-08-07' } },
          { type: 'mention', attrs: { label: 'Ohne Art' } },
        ],
      }),
    );
    expect(links.map((link) => link.targetTitle)).toEqual(['Ohne Art']);
  });

  it('ignores links that are not internal', () => {
    const links = extractDocumentLinks(
      doc({
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'extern',
            marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
          },
          {
            type: 'text',
            text: 'gefährlich',
            marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
          },
        ],
      }),
    );
    expect(links).toEqual([]);
  });

  it('normalizes whitespace and drops empty titles', () => {
    const links = extractDocumentLinks(
      doc(
        { type: 'pageLink', attrs: { title: '  Zwei   Wörter ' } },
        { type: 'pageLink', attrs: { title: '   ' } },
        { type: 'pageLink', attrs: {} },
      ),
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.targetTitle).toBe('Zwei Wörter');
    expect(links[0]?.targetTitleKey).toBe('zwei wörter');
  });

  it('deduplicates repeats inside one block but keeps them across blocks', () => {
    const links = extractDocumentLinks(
      doc(
        {
          type: 'paragraph',
          attrs: { blockId: 'aaaaaaaaaaaa' },
          content: [wikiText('Ziel'), { type: 'text', text: ' und ' }, wikiText('Ziel')],
        },
        {
          type: 'paragraph',
          attrs: { blockId: 'bbbbbbbbbbbb' },
          content: [wikiText('Ziel')],
        },
      ),
    );
    expect(links.map((link) => link.blockId)).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  });

  it('keeps the same title once per kind', () => {
    const links = extractDocumentLinks(
      doc({
        type: 'paragraph',
        content: [
          { type: 'mention', attrs: { kind: 'page', label: 'Ziel' } },
          wikiText('ziel'),
        ],
      }),
    );
    expect(links.map((link) => link.kind)).toEqual(['mention', 'wikiMark']);
  });

  it('takes the deepest addressable ancestor as the preview block', () => {
    const links = extractDocumentLinks(
      doc({
        type: 'bulletList',
        attrs: { blockId: 'cccccccccccc' },
        content: [
          {
            type: 'listItem',
            attrs: { blockId: 'dddddddddddd' },
            content: [{ type: 'paragraph', content: [wikiText('Ziel')] }],
          },
        ],
      }),
    );
    expect(links[0]?.blockId).toBe('dddddddddddd');
  });

  it('stores the surrounding sentence as context', () => {
    const links = extractDocumentLinks(
      doc({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Der Betrieb steht in ' },
          wikiText('Deployment'),
          { type: 'text', text: ', dort liegen die Units.' },
        ],
      }),
    );
    expect(links[0]?.context).toBe('Der Betrieb steht in Deployment, dort liegen die Units.');
  });

  it('cuts a long paragraph down to a window around the reference', () => {
    const filler = 'Fülltext '.repeat(80);
    const links = extractDocumentLinks(
      doc({
        type: 'paragraph',
        content: [
          { type: 'text', text: filler },
          wikiText('Deployment'),
          { type: 'text', text: filler },
        ],
      }),
    );
    const context = links[0]?.context ?? '';
    expect(context).toContain('Deployment');
    expect(context.startsWith('…')).toBe(true);
    expect(context.endsWith('…')).toBe(true);
    expect(context.length).toBeLessThanOrEqual(DOCUMENT_LINK_CONTEXT_CHARS + 2);
  });

  it('stops at the per-document limit', () => {
    const paragraphs = Array.from({ length: MAX_DOCUMENT_LINKS + 20 }, (_, index) => ({
      type: 'paragraph',
      content: [wikiText(`Ziel ${index}`)],
    }));
    expect(extractDocumentLinks(doc(...paragraphs))).toHaveLength(MAX_DOCUMENT_LINKS);
  });

  it('returns nothing for a document without references', () => {
    expect(
      extractDocumentLinks(doc({ type: 'paragraph', content: [{ type: 'text', text: 'nur Text' }] })),
    ).toEqual([]);
    expect(extractDocumentLinks({ type: 'doc' })).toEqual([]);
  });
});

describe('documentLinkTitleKey', () => {
  it('collapses whitespace and lowercases', () => {
    expect(documentLinkTitleKey('  Meine   Seite ')).toBe('meine seite');
  });
});
