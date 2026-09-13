import { describe, expect, it } from 'vitest';

import { parseLatexLog } from './diagnostics';

/**
 * The parser that decides whether the build-fix-build loop works (issue #43).
 *
 * Every case below is a line a real TeX run produces. The two that matter most
 * are the ones about *not* reporting something: a location inside TeX Live is
 * not a place anybody can fix, and the same warning repeated once per latexmk
 * pass is one warning.
 */

const PATHS = ['main.tex', 'chapters/intro.tex'];

describe('parseLatexLog', () => {
  it('reads file, line and message out of a -file-line-error line', () => {
    const log = './chapters/intro.tex:42: Undefined control sequence.';

    expect(parseLatexLog(log, PATHS)).toEqual([
      {
        severity: 'ERROR',
        file: 'chapters/intro.tex',
        line: 42,
        message: 'Undefined control sequence.',
      },
    ]);
  });

  it('drops the location when the file is not part of the project', () => {
    const log = '/usr/local/texlive/2026/texmf-dist/tex/latex/base/size11.clo:5: Something.';

    expect(parseLatexLog(log, PATHS)).toEqual([
      { severity: 'ERROR', file: null, line: 5, message: 'Something.' },
    ]);
  });

  it('separates a warning from an error even in the file:line shape', () => {
    const log = 'main.tex:7: Package hyperref Warning: Difference detected.';

    expect(parseLatexLog(log, PATHS)[0]?.severity).toBe('WARNING');
  });

  it('keeps a bare error that carries no location', () => {
    const log = "! LaTeX Error: File `fehlt.sty' not found.";

    expect(parseLatexLog(log, PATHS)).toEqual([
      {
        severity: 'ERROR',
        file: null,
        line: null,
        message: "LaTeX Error: File `fehlt.sty' not found.",
      },
    ]);
  });

  it('reads the input line out of a LaTeX warning', () => {
    const log = "LaTeX Warning: Reference `fig:1' on page 3 undefined on input line 42.";

    expect(parseLatexLog(log, PATHS)[0]).toMatchObject({ severity: 'WARNING', line: 42 });
  });

  it('reports an overfull box with the line it started at', () => {
    const log = '\nOverfull \\hbox (12.3pt too wide) in paragraph at lines 41--43\n';

    expect(parseLatexLog(log, PATHS)[0]).toMatchObject({
      severity: 'WARNING',
      line: 41,
      message: 'Overfull box (12.3pt too wide)',
    });
  });

  it('reports a repeated warning once, however many passes latexmk made', () => {
    const line = 'main.tex:7: Package foo Warning: Immer wieder.';
    const log = [line, 'etwas anderes', line, line].join('\n');

    expect(parseLatexLog(log, PATHS)).toHaveLength(1);
  });

  it('leaves font substitution notes out', () => {
    const log = "LaTeX Font Warning: Font shape `T1/cmr/m/scit' undefined on input line 3.";

    expect(parseLatexLog(log, PATHS)).toEqual([]);
  });

  it('reads a whole log without inventing anything', () => {
    const log = [
      'This is pdfTeX, Version 3.141592653',
      'entering extended mode',
      './main.tex:12: Missing $ inserted.',
      'Overfull \\hbox (3.0pt too wide) in paragraph at lines 20--21',
      'LaTeX Font Warning: Some font.',
      '! Emergency stop.',
    ].join('\n');

    const diagnostics = parseLatexLog(log, PATHS);
    expect(diagnostics.map((entry) => entry.severity)).toEqual(['ERROR', 'WARNING', 'ERROR']);
    expect(diagnostics[0]?.file).toBe('main.tex');
  });
});
