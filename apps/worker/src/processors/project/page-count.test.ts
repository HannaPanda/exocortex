import { describe, expect, it } from 'vitest';

import { readPageCount } from '../project-build';

/**
 * Reading the page count out of the log (issue #43).
 *
 * Its own test because the obvious implementation is wrong in a way no example
 * document reveals: counting `/Type /Page` in the PDF bytes returns zero for
 * every current TeX engine, because the page objects sit in a compressed object
 * stream. The log states the number outright.
 */
describe('readPageCount', () => {
  it('reads the number the engine printed', () => {
    const log = 'Output written on .exocortex-out/main.pdf (12 pages, 340991 bytes).';

    expect(readPageCount(log)).toBe(12);
  });

  it('handles the singular', () => {
    const log = 'Output written on .exocortex-out/main.pdf (1 page, 33993 bytes).';

    expect(readPageCount(log)).toBe(1);
  });

  it('takes the last run, because latexmk makes several', () => {
    const log = [
      'Output written on .exocortex-out/main.pdf (3 pages, 1000 bytes).',
      'Latexmk: Rerun to get cross-references right',
      'Output written on .exocortex-out/main.pdf (4 pages, 1200 bytes).',
    ].join('\n');

    expect(readPageCount(log)).toBe(4);
  });

  it('says nothing rather than zero when the build produced no file', () => {
    expect(readPageCount("! LaTeX Error: File `fehlt.sty' not found.")).toBeNull();
  });

  it('says nothing for an empty log', () => {
    expect(readPageCount('')).toBeNull();
  });
});
