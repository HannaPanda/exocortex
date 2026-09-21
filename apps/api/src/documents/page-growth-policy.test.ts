import { describe, expect, it } from 'vitest';

import { BLOCK_ID_ATTRIBUTE, type ProseMirrorDocument } from '@exocortex/editor';

import {
  judgePageGrowth,
  largePageWarning,
  oversizedPageRefusal,
  pageGrowthLimits,
} from './page-growth-policy';

const limits = { largeChars: 15_000, oversizedChars: 50_000 };

function page(...sections: { heading: string; blockId: string; chars: number }[]) {
  const content = sections.flatMap((section) => [
    {
      type: 'heading',
      attrs: { level: 2, [BLOCK_ID_ATTRIBUTE]: section.blockId },
      content: [{ type: 'text', text: section.heading }],
    },
    {
      type: 'paragraph',
      attrs: { [BLOCK_ID_ATTRIBUTE]: `${section.blockId}body` },
      content: [{ type: 'text', text: 'x'.repeat(section.chars) }],
    },
  ]);
  return { type: 'doc', content } as ProseMirrorDocument;
}

describe('judgePageGrowth', () => {
  it('leaves a page below the warning threshold alone', () => {
    expect(judgePageGrowth({ before: 100, after: 900, limits })).toMatchObject({
      level: 'normal',
      grew: true,
    });
  });

  it('calls a page large above the first threshold and oversized above the second', () => {
    expect(judgePageGrowth({ before: 14_000, after: 16_000, limits }).level).toBe('large');
    expect(judgePageGrowth({ before: 49_000, after: 51_000, limits }).level).toBe('oversized');
  });

  it('separates being over the limit from growing, so an oversized page stays repairable', () => {
    // Rewriting an oversized page smaller, which a refusal by size alone would
    // make impossible -- and then nothing could ever bring the page back down.
    const shrinking = judgePageGrowth({ before: 80_000, after: 60_000, limits });

    expect(shrinking.level).toBe('oversized');
    expect(shrinking.grew).toBe(false);
  });
});

describe('pageGrowthLimits', () => {
  it('keeps the warning at or below the refusal, however the two are configured', () => {
    // Each key is written on its own and the workspace clamp can lower either
    // one, so a deployment can end up warning above the point it refuses at.
    const resolved = pageGrowthLimits({
      'agents.largePageChars': 90_000,
      'agents.oversizedPageChars': 50_000,
    });

    expect(resolved).toEqual({ largeChars: 50_000, oversizedChars: 50_000 });
  });
});

describe('what a writer is told', () => {
  const document = page(
    { heading: 'Befunde', blockId: 'befundeaaa1', chars: 12_000 },
    { heading: 'Termine', blockId: 'termineaa01', chars: 6_000 },
    { heading: 'Kurz', blockId: 'kurzaaaaa01', chars: 40 },
  );
  const size = 18_100;

  it('names the biggest sections with their addresses, largest first', () => {
    const warning = largePageWarning(document, size);

    expect(warning).toContain('18.100 Zeichen');
    expect(warning.indexOf('Befunde')).toBeLessThan(warning.indexOf('Termine'));
    expect(warning).toContain('^befundeaaa1');
    // A fortieth of a percent of the page; moving it away changes nothing, so
    // offering it as a way out would be advice that does not help.
    expect(warning).not.toContain('Kurz');
  });

  it('answers a refusal with the way out rather than only with the limit', () => {
    const refusal = oversizedPageRefusal(document, {
      current: size,
      after: size + 1_000,
      limit: 15_000,
    });

    expect(refusal).toContain('exo_page_extract_section');
    expect(refusal).toContain('^befundeaaa1');
    expect(refusal).toContain('Nichts wurde geschrieben.');
  });

  it('offers no section on a page that has none, rather than offering block windows', () => {
    // A map of a page without headings is cut into block windows (ADR-056).
    // They are addressable, but "move blocks 41 to 80 away" says nothing about
    // what the new page would be for.
    const flat: ProseMirrorDocument = {
      type: 'doc',
      content: Array.from({ length: 30 }, (_unused, index) => ({
        type: 'paragraph',
        attrs: { [BLOCK_ID_ATTRIBUTE]: `absatzaaa${String(index).padStart(2, '0')}` },
        content: [{ type: 'text', text: 'wort '.repeat(200) }],
      })),
    };

    expect(largePageWarning(flat, 30_000)).toContain('Unterseite');
    expect(largePageWarning(flat, 30_000)).not.toContain('Die größten Abschnitte');
    expect(oversizedPageRefusal(flat, { current: 30_000, after: 31_000, limit: 15_000 })).toContain(
      'exo_page_create',
    );
  });
});
