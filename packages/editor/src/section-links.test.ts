import { describe, expect, it } from 'vitest';

import { extractDocumentLinks } from './document-links';
import { parseLinkHref } from './link-target';
import { parseMarkdown } from './markdown/parse';
import { serializeMarkdown } from './markdown/serialize';
import { findSectionWikiLinks, sectionLinkHeading } from './section-links';

const PAGE = [
  '## Ziel und Planung ^41hgouvxdtqs',
  '',
  'Text.',
  '',
  '## Begleitbeobachtungen ^bst3dk3x6te2',
  '',
  'Mehr Text.',
  '',
].join('\n');

describe('section links (issue #197)', () => {
  it('keeps a block anchor through Markdown and back, and out of the reference index', () => {
    const markdown = `${PAGE}Siehe [Ziel und Planung](#41hgouvxdtqs).\n`;
    const { document } = parseMarkdown(markdown);

    const out = serializeMarkdown(document, { includeBlockIds: true });
    expect(out).toContain('## Ziel und Planung ^41hgouvxdtqs');
    expect(out).toContain('[Ziel und Planung](#41hgouvxdtqs)');
    expect(parseLinkHref('#41hgouvxdtqs')).toEqual({ kind: 'anchor', blockId: '41hgouvxdtqs' });

    // An anchor is not a page reference: no backlink, and nothing unresolved.
    expect(extractDocumentLinks(document)).toEqual([]);
    expect(findSectionWikiLinks(document)).toEqual([]);
  });

  it('names the block id a [[#…]] link would have meant', () => {
    const { document } = parseMarkdown(
      `${PAGE}Siehe [[#ziel und  planung]] und [[#Begleitbeobachtungen|dort]] und [[#Ziel und Planung]].\n`,
    );
    expect(findSectionWikiLinks(document)).toEqual([
      { heading: 'ziel und planung', blockId: '41hgouvxdtqs' },
      { heading: 'Begleitbeobachtungen', blockId: 'bst3dk3x6te2' },
    ]);
  });

  it('matches a fragment against the headings of the whole page', () => {
    const page = parseMarkdown(PAGE).document;
    const fragment = parseMarkdown('Siehe [[#Begleitbeobachtungen]].\n').document;
    expect(findSectionWikiLinks(fragment, page)).toEqual([
      { heading: 'Begleitbeobachtungen', blockId: 'bst3dk3x6te2' },
    ]);
  });

  it('answers no block id for a heading that is missing or ambiguous', () => {
    const { document } = parseMarkdown(
      '## Notizen ^aaaaaaaaaaa1\n\n## Notizen ^aaaaaaaaaaa2\n\n[[#Notizen]] [[#Fehlt]]\n',
    );
    expect(findSectionWikiLinks(document)).toEqual([
      { heading: 'Notizen', blockId: null },
      { heading: 'Fehlt', blockId: null },
    ]);
  });

  it('leaves ordinary page references alone', () => {
    const { document } = parseMarkdown('[[Seite]] und [[C#]]\n');
    expect(findSectionWikiLinks(document)).toEqual([]);
    expect(sectionLinkHeading('#')).toBeNull();
    expect(sectionLinkHeading('#  Ziel ')).toBe('Ziel');
  });
});
