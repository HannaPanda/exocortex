import { describe, expect, it } from 'vitest';

import { renderInputHash, shiftMarkdownHeadings } from './render-source';

/**
 * The two pure halves of "what goes into a render" (issue #44, ADR-026).
 *
 * Both are cheap to get subtly wrong and expensive to notice: a heading shifted
 * inside a code block corrupts a snippet nobody reads until the PDF is printed,
 * and a hash that is not stable turns the build cache into a machine that
 * rebuilds an unchanged page for ever.
 */

describe('shiftMarkdownHeadings', () => {
  it('moves headings deeper by the given number of levels', () => {
    expect(shiftMarkdownHeadings('# Titel\n\n## Abschnitt\n', 1)).toBe(
      '## Titel\n\n### Abschnitt\n',
    );
  });

  it('leaves the text alone when there is nothing to shift', () => {
    const markdown = '# Titel\n';
    expect(shiftMarkdownHeadings(markdown, 0)).toBe(markdown);
  });

  it('never goes past level six, the way Markdown itself does not', () => {
    expect(shiftMarkdownHeadings('###### Tief\n', 2)).toBe('###### Tief\n');
  });

  it('does not touch a comment inside a fenced code block', () => {
    const markdown = ['# Titel', '', '```sh', '# kein Titel, ein Kommentar', 'ls', '```', ''].join(
      '\n',
    );
    const shifted = shiftMarkdownHeadings(markdown, 1);
    expect(shifted).toContain('## Titel');
    expect(shifted).toContain('# kein Titel, ein Kommentar');
  });

  it('closes a tilde fence only with tildes', () => {
    const markdown = ['~~~', '# drin', '~~~', '', '# draußen', ''].join('\n');
    const shifted = shiftMarkdownHeadings(markdown, 1);
    expect(shifted).toContain('# drin');
    expect(shifted).toContain('## draußen');
  });

  it('leaves a line that only looks like a heading alone', () => {
    expect(shiftMarkdownHeadings('#kein Leerzeichen\n', 1)).toBe('#kein Leerzeichen\n');
  });
});

describe('renderInputHash', () => {
  const base = {
    renderer: 'LATEX_PDF',
    source: 'DOCUMENT',
    text: '# Titel\n',
    template: null,
    variables: { customer: 'Musterfirma', author: 'Johanna' },
  };

  it('is stable across calls and independent of variable order', () => {
    const reordered = { ...base, variables: { author: 'Johanna', customer: 'Musterfirma' } };
    expect(renderInputHash(base)).toBe(renderInputHash(reordered));
  });

  it('changes when the text changes', () => {
    expect(renderInputHash({ ...base, text: '# Anderer Titel\n' })).not.toBe(renderInputHash(base));
  });

  it('changes when the template changes', () => {
    expect(renderInputHash({ ...base, template: '\\documentclass{article}' })).not.toBe(
      renderInputHash(base),
    );
  });

  it('changes when a variable value changes', () => {
    expect(
      renderInputHash({ ...base, variables: { ...base.variables, customer: 'Andere' } }),
    ).not.toBe(renderInputHash(base));
  });

  it('does not confuse a value boundary with a value', () => {
    // Without a separator, `{a: 'b', c: 'd'}` and `{a: 'b=c', d: ''}` would
    // flatten to the same string, and two different letters would share a PDF.
    const first = renderInputHash({ ...base, variables: { a: 'b', c: 'd' } });
    const second = renderInputHash({ ...base, variables: { a: 'b=c=d' } });
    expect(first).not.toBe(second);
  });

  it('separates the source kind, so a page and its subtree never share a build', () => {
    expect(renderInputHash({ ...base, source: 'SUBTREE' })).not.toBe(renderInputHash(base));
  });
});
