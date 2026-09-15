import { describe, expect, it } from 'vitest';

import {
  leadingTitleHeading,
  normalizeTitleForComparison,
  stripRedundantTitleHeading,
} from './title-heading';

describe('normalizeTitleForComparison', () => {
  it('ignores case, punctuation and repeated whitespace', () => {
    expect(normalizeTitleForComparison('Schritt 1: Setup')).toBe(
      normalizeTitleForComparison('schritt 1  setup'),
    );
  });

  it('ignores emoji and inline markup', () => {
    expect(normalizeTitleForComparison('**Plan** 🚀')).toBe(normalizeTitleForComparison('Plan'));
  });

  it('keeps umlauts, because they are letters', () => {
    expect(normalizeTitleForComparison('Übersicht')).toBe('übersicht');
  });
});

describe('stripRedundantTitleHeading', () => {
  it('removes an ATX heading that repeats the title', () => {
    const result = stripRedundantTitleHeading('# Mein Plan\n\nErster Absatz.\n', 'Mein Plan');
    expect(result.removed).toBe('Mein Plan');
    expect(result.markdown).toBe('Erster Absatz.\n');
  });

  it('removes a setext heading that repeats the title', () => {
    const result = stripRedundantTitleHeading('Mein Plan\n=========\n\nText.\n', 'Mein Plan');
    expect(result.removed).toBe('Mein Plan');
    expect(result.markdown).toBe('Text.\n');
  });

  it('keeps the frontmatter it found the heading behind', () => {
    const result = stripRedundantTitleHeading(
      '---\ntitle: Mein Plan\n---\n\n# Mein Plan\n\nText.\n',
      'Mein Plan',
    );
    expect(result.markdown).toBe('---\ntitle: Mein Plan\n---\nText.\n');
  });

  it('matches through punctuation and case', () => {
    expect(stripRedundantTitleHeading('# mein plan!\n\nText.\n', 'Mein Plan').removed).toBe(
      'mein plan!',
    );
  });

  it('ignores a block id on the heading', () => {
    expect(
      stripRedundantTitleHeading('# Mein Plan ^abcd1234\n\nText.\n', 'Mein Plan').removed,
    ).toBe('Mein Plan');
  });

  it('leaves a heading that only resembles the title', () => {
    const markdown = '# Mein Plan für 2026\n\nText.\n';
    expect(stripRedundantTitleHeading(markdown, 'Mein Plan')).toEqual({ markdown, removed: null });
  });

  it('leaves a second-level heading alone', () => {
    const markdown = '## Mein Plan\n\nText.\n';
    expect(stripRedundantTitleHeading(markdown, 'Mein Plan')).toEqual({ markdown, removed: null });
  });

  it('leaves a heading that is not the first block', () => {
    const markdown = 'Ein Satz.\n\n# Mein Plan\n\nText.\n';
    expect(stripRedundantTitleHeading(markdown, 'Mein Plan')).toEqual({ markdown, removed: null });
  });

  it('leaves the heading when it is the whole page', () => {
    const markdown = '# Mein Plan\n';
    expect(stripRedundantTitleHeading(markdown, 'Mein Plan')).toEqual({ markdown, removed: null });
  });

  it('leaves a heading inside an opening code fence alone', () => {
    const markdown = '```md\n# Mein Plan\n```\n';
    expect(stripRedundantTitleHeading(markdown, 'Mein Plan')).toEqual({ markdown, removed: null });
  });

  it('does nothing without a title to compare against', () => {
    const markdown = '# Mein Plan\n\nText.\n';
    expect(stripRedundantTitleHeading(markdown, '   ')).toEqual({ markdown, removed: null });
  });
});

describe('leadingTitleHeading', () => {
  it('reads the opening heading', () => {
    expect(leadingTitleHeading('---\ntitle: X\n---\n\n# Mein Plan\n\nText.\n')).toBe('Mein Plan');
  });

  it('is null when the page does not open with one', () => {
    expect(leadingTitleHeading('Text.\n\n# Mein Plan\n')).toBeNull();
  });
});
