import { describe, expect, it } from 'vitest';

import { BLOCK_ID_ATTRIBUTE } from './block-id';
import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { serializeMarkdown } from './markdown';
import { resolveSectionExtraction, titleForSection } from './section-extract';

function heading(level: number, text: string, blockId: string): ProseMirrorNode {
  return {
    type: 'heading',
    attrs: { level, [BLOCK_ID_ATTRIBUTE]: blockId },
    content: [{ type: 'text', text }],
  };
}

function paragraph(text: string, blockId: string): ProseMirrorNode {
  return {
    type: 'paragraph',
    attrs: { [BLOCK_ID_ATTRIBUTE]: blockId },
    content: [{ type: 'text', text }],
  };
}

function doc(...content: ProseMirrorNode[]): ProseMirrorDocument {
  return { type: 'doc', content };
}

const page = doc(
  heading(2, 'Erstens', 'headingaaa1'),
  paragraph('eins', 'parapara001'),
  heading(3, 'Darunter', 'headingaaa2'),
  paragraph('zwei', 'parapara002'),
  heading(2, 'Zweitens', 'headingaaa3'),
  paragraph('drei', 'parapara003'),
);

function ok(result: ReturnType<typeof resolveSectionExtraction>) {
  if (!result.ok) throw new Error(`expected a section, got ${result.reason}`);
  return result.value;
}

describe('resolveSectionExtraction', () => {
  it('takes a heading to mean everything under it, subsections included', () => {
    const section = ok(resolveSectionExtraction(page, 'headingaaa1', null));

    expect(section.blocks).toBe(4);
    expect(section.heading).toMatchObject({ level: 2, text: 'Erstens' });
    // The whole span, for a move that takes the heading with it.
    expect(section.range).toEqual({
      fromBlockId: 'headingaaa1',
      toBlockId: 'parapara002',
      placement: 'replace',
    });
    // The body alone, for a move that leaves the heading standing.
    expect(section.bodyRange).toEqual({
      fromBlockId: 'parapara001',
      toBlockId: 'parapara002',
      placement: 'replace',
    });
    expect(serializeMarkdown(section.body as ProseMirrorDocument)).not.toContain('Erstens');
    expect(serializeMarkdown(section.body as ProseMirrorDocument)).toContain('Darunter');
  });

  it('moves exactly the window two identifiers name', () => {
    const section = ok(resolveSectionExtraction(page, 'parapara001', 'headingaaa2'));

    expect(section.heading).toBeNull();
    expect(section.blocks).toBe(2);
    expect(section.range.toBlockId).toBe('headingaaa2');
    // No heading of its own, so nothing is left out of what moves.
    expect(section.body).toBeNull();
  });

  it('refuses a window whose ends are not beside each other', () => {
    const nested = doc(paragraph('oben', 'parapara001'), {
      type: 'callout',
      attrs: { [BLOCK_ID_ATTRIBUTE]: 'calloutaaa1' },
      content: [paragraph('drin', 'parapara002')],
    });

    const result = resolveSectionExtraction(nested, 'parapara001', 'parapara002');

    expect(result).toMatchObject({ ok: false, reason: 'block_range_not_siblings' });
  });

  it('refuses an inverted window and a dead address', () => {
    expect(resolveSectionExtraction(page, 'parapara003', 'headingaaa1')).toMatchObject({
      ok: false,
      reason: 'block_range_inverted',
    });
    expect(resolveSectionExtraction(page, 'parapara999', null)).toMatchObject({
      ok: false,
      reason: 'block_not_found',
    });
  });

  it('says when a section is the whole page, because removing it would empty it', () => {
    const single = doc(heading(1, 'Alles', 'headingaaa1'), paragraph('Inhalt', 'parapara001'));

    expect(ok(resolveSectionExtraction(single, 'headingaaa1', null)).wholePage).toBe(true);
    expect(ok(resolveSectionExtraction(page, 'headingaaa1', null)).wholePage).toBe(false);
  });

  it('reads a heading with nothing under it as having no body to move', () => {
    const empty = doc(heading(2, 'Leer', 'headingaaa1'), heading(2, 'Danach', 'headingaaa2'));

    const section = ok(resolveSectionExtraction(empty, 'headingaaa1', null));

    expect(section.body).toBeNull();
    expect(section.bodyRange).toBeNull();
    expect(section.range.toBlockId).toBeNull();
  });
});

describe('titleForSection', () => {
  it('names the new page after the heading it moved', () => {
    expect(titleForSection(ok(resolveSectionExtraction(page, 'headingaaa1', null)))).toBe(
      'Erstens',
    );
  });

  it('falls back to the first words when there is no heading', () => {
    const flat = doc(paragraph('Ein Absatz ohne Überschrift', 'parapara001'));

    expect(titleForSection(ok(resolveSectionExtraction(flat, 'parapara001', null)))).toBe(
      'Ein Absatz ohne Überschrift',
    );
  });
});
