import { describe, expect, it } from 'vitest';

import { BLOCK_ID_ATTRIBUTE } from './block-id';
import { type ProseMirrorDocument } from './contract';
import { parseMarkdown, serializeMarkdown } from './markdown';
import { bindPageLinkIdentities, resolvePageLinkTitles } from './page-link-identity';
import { serializePlainText } from './plain-text';
import { validateProseMirrorDocument } from './schema';
import { parseTransclusionParams, parseTransclusionPromptValue } from './transclusion';
import {
  collectTransclusions,
  extractBlockFragment,
  materializeTransclusions,
  outlineBlocks,
} from './transclusion-fragment';

/** A page with two sections, each carrying block identifiers. */
const SOURCE: ProseMirrorDocument = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 2, [BLOCK_ID_ATTRIBUTE]: 'headingaaaa' },
      content: [{ type: 'text', text: 'Stand' }],
    },
    {
      type: 'paragraph',
      attrs: { [BLOCK_ID_ATTRIBUTE]: 'parastatus1' },
      content: [{ type: 'text', text: 'Läuft seit gestern.' }],
    },
    {
      type: 'paragraph',
      attrs: { [BLOCK_ID_ATTRIBUTE]: 'parastatus2' },
      content: [{ type: 'text', text: 'Nächster Schritt: ausrollen.' }],
    },
    {
      type: 'heading',
      attrs: { level: 2, [BLOCK_ID_ATTRIBUTE]: 'headingbbbb' },
      content: [{ type: 'text', text: 'Offen' }],
    },
    {
      type: 'paragraph',
      attrs: { [BLOCK_ID_ATTRIBUTE]: 'paraoffen11' },
      content: [{ type: 'text', text: 'Nichts.' }],
    },
  ],
};

describe('transclusion node', () => {
  it('is part of the canonical schema', () => {
    const document: ProseMirrorDocument = {
      type: 'doc',
      content: [
        {
          type: 'transclusion',
          attrs: { documentId: 'doc1', label: 'Quelle', sourceBlockId: null },
        },
      ],
    };
    expect(validateProseMirrorDocument(document).valid).toBe(true);
  });

  it('round-trips through Markdown, block address included', () => {
    const markdown = ':::transclusion Technische Daten^headingaaaa\n:::\n';
    const parsed = parseMarkdown(markdown).document;
    const node = parsed.content?.[0];
    expect(node?.type).toBe('transclusion');
    expect(node?.attrs?.label).toBe('Technische Daten');
    expect(node?.attrs?.sourceBlockId).toBe('headingaaaa');
    // No identity in the file, the rule `pageLink` follows.
    expect(node?.attrs?.documentId).toBeNull();

    const exported = serializeMarkdown(parsed);
    expect(exported).toContain(':::transclusion Technische Daten^headingaaaa');
    expect(parseMarkdown(exported).document.content?.[0]?.attrs?.sourceBlockId).toBe('headingaaaa');
  });

  it('reads a whole-page reference without a block address', () => {
    const parsed = parseMarkdown(':::transclusion Checkliste\n:::\n').document;
    expect(parsed.content?.[0]?.attrs?.label).toBe('Checkliste');
    expect(parsed.content?.[0]?.attrs?.sourceBlockId).toBeNull();
  });

  it('keeps a caret that is not a block address as part of the title', () => {
    expect(parseTransclusionParams('Rechenregel a^2')).toEqual({
      label: 'Rechenregel a^2',
      blockId: null,
    });
  });

  it('contributes the label to the plain text, never the source content', () => {
    const document: ProseMirrorDocument = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Eigener Text.' }] },
        {
          type: 'transclusion',
          attrs: { documentId: 'doc1', label: 'Stammdaten', sourceBlockId: null },
        },
      ],
    };
    const text = serializePlainText(document);
    expect(text).toContain('Eigener Text.');
    expect(text).toContain('Stammdaten');
  });

  it('reads the picker answer, with and without a block', () => {
    expect(
      parseTransclusionPromptValue(JSON.stringify({ documentId: 'doc1', title: 'Quelle' })),
    ).toEqual({ label: 'Quelle', documentId: 'doc1', sourceBlockId: null });
    expect(parseTransclusionPromptValue('Noch nicht angelegt')).toEqual({
      label: 'Noch nicht angelegt',
      documentId: null,
      sourceBlockId: null,
    });
    expect(parseTransclusionPromptValue('   ')).toBeNull();
  });
});

describe('extractBlockFragment', () => {
  it('gives a heading its whole section', () => {
    const fragment = extractBlockFragment(SOURCE, 'headingaaaa');
    expect(fragment?.content?.map((node) => node.type)).toEqual([
      'heading',
      'paragraph',
      'paragraph',
    ]);
  });

  it('stops the section at the next heading of the same level', () => {
    const fragment = extractBlockFragment(SOURCE, 'headingaaaa');
    expect(serializePlainText(fragment as ProseMirrorDocument)).not.toContain('Nichts.');
  });

  it('gives an ordinary block only itself', () => {
    const fragment = extractBlockFragment(SOURCE, 'parastatus1');
    expect(fragment?.content).toHaveLength(1);
    expect(serializePlainText(fragment as ProseMirrorDocument)).toBe('Läuft seit gestern.');
  });

  it('finds a block nested inside another one', () => {
    const nested: ProseMirrorDocument = {
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          attrs: { [BLOCK_ID_ATTRIBUTE]: 'quoteaaaaaa' },
          content: [
            {
              type: 'paragraph',
              attrs: { [BLOCK_ID_ATTRIBUTE]: 'innerbbbbbb' },
              content: [{ type: 'text', text: 'Drinnen.' }],
            },
          ],
        },
      ],
    };
    expect(serializePlainText(extractBlockFragment(nested, 'innerbbbbbb') as ProseMirrorDocument)) //
      .toBe('Drinnen.');
  });

  it('answers null for a block that is gone', () => {
    expect(extractBlockFragment(SOURCE, 'verschwunden')).toBeNull();
  });
});

describe('outlineBlocks', () => {
  it('lists the addressable blocks with a preview', () => {
    const outline = outlineBlocks(SOURCE);
    expect(outline.map((entry) => entry.blockId)).toEqual([
      'headingaaaa',
      'parastatus1',
      'parastatus2',
      'headingbbbb',
      'paraoffen11',
    ]);
    expect(outline[0]).toMatchObject({ type: 'heading', level: 2, preview: 'Stand' });
  });

  it('skips a block that has not been assigned an identifier yet', () => {
    const document: ProseMirrorDocument = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Frisch getippt.' }] }],
    };
    expect(outlineBlocks(document)).toEqual([]);
  });
});

describe('materializeTransclusions', () => {
  const embedding: ProseMirrorDocument = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Davor.' }] },
      {
        type: 'transclusion',
        attrs: { documentId: 'doc1', label: 'Stand', sourceBlockId: 'aaaabbbbcccc' },
      },
    ],
  };

  it('collects what a document points at', () => {
    expect(collectTransclusions(embedding)).toEqual([
      { documentId: 'doc1', blockId: 'aaaabbbbcccc', label: 'Stand' },
    ]);
  });

  it('puts the content in place of the reference', () => {
    const result = materializeTransclusions(embedding, () => [
      { type: 'paragraph', content: [{ type: 'text', text: 'Eingesetzt.' }] },
    ]);
    expect(serializePlainText(result)).toBe('Davor.\nEingesetzt.');
  });

  it('keeps the reference when it cannot be resolved', () => {
    const result = materializeTransclusions(embedding, () => null);
    expect(result.content?.[1]?.type).toBe('transclusion');
  });

  it('does not follow a transclusion inside what it inserted', () => {
    const result = materializeTransclusions(embedding, () => [
      { type: 'transclusion', attrs: { documentId: 'doc2', label: 'Weiter', sourceBlockId: null } },
    ]);
    // One level: the inserted reference is left standing, so two pages that
    // embed each other cannot send the exporter around a loop.
    expect(result.content?.[1]?.type).toBe('transclusion');
    expect(result.content?.[1]?.attrs?.label).toBe('Weiter');
  });
});

describe('transclusion identities', () => {
  const byTitle: ProseMirrorDocument = {
    type: 'doc',
    content: [
      {
        type: 'transclusion',
        attrs: { documentId: null, label: 'Technische Daten', sourceBlockId: 'headingaaaa' },
      },
    ],
  };

  it('binds the title an import carries to the page that has it', () => {
    // Without this, `:::transclusion Titel^block` written by an agent or by the
    // REST endpoint would arrive pointing at nothing.
    const bound = bindPageLinkIdentities(byTitle, (title) =>
      title === 'Technische Daten' ? 'doc1' : null,
    );
    expect(bound.content?.[0]?.attrs?.documentId).toBe('doc1');
    expect(bound.content?.[0]?.attrs?.sourceBlockId).toBe('headingaaaa');
  });

  it('leaves a title no page carries alone instead of dropping the reference', () => {
    const bound = bindPageLinkIdentities(byTitle, () => null);
    expect(bound.content?.[0]?.attrs?.documentId).toBeNull();
    expect(bound.content?.[0]?.attrs?.label).toBe('Technische Daten');
  });

  it('writes the title the source carries now, so a rename survives the export', () => {
    const stored: ProseMirrorDocument = {
      type: 'doc',
      content: [
        {
          type: 'transclusion',
          attrs: { documentId: 'doc1', label: 'Alter Name', sourceBlockId: null },
        },
      ],
    };
    const refreshed = resolvePageLinkTitles(stored, () => 'Neuer Name');
    expect(refreshed.content?.[0]?.attrs?.label).toBe('Neuer Name');
  });
});
