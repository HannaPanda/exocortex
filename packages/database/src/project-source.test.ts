import { describe, expect, it } from 'vitest';

import { projectInputHash } from './project-source';

/**
 * The fingerprint the build cache turns on (issue #43, ADR-027).
 *
 * Cheap to get subtly wrong and expensive to notice: a hash that is not stable
 * rebuilds an unchanged project for ever, and one that collides hands back
 * yesterday's PDF for today's text. The separator cases below are the ones a
 * naive concatenation gets wrong.
 */

const base = {
  engine: 'PDFLATEX',
  bibliography: 'AUTO',
  rootFile: 'main.tex',
  texts: [
    { path: 'main.tex', content: '\\documentclass{article}' },
    { path: 'kapitel/intro.tex', content: 'Hallo' },
  ],
  assets: [{ path: 'bild.png', attachmentId: 'att1', checksum: 'abc', byteSize: 10 }],
};

describe('projectInputHash', () => {
  it('is stable across calls', () => {
    expect(projectInputHash(base)).toBe(projectInputHash(base));
  });

  it('does not depend on the order the files arrive in', () => {
    const reordered = { ...base, texts: [...base.texts].reverse() };
    expect(projectInputHash(reordered)).toBe(projectInputHash(base));
  });

  it('changes when the content of a file changes', () => {
    const changed = {
      ...base,
      texts: [
        base.texts[0] as { path: string; content: string },
        { path: 'kapitel/intro.tex', content: 'Servus' },
      ],
    };
    expect(projectInputHash(changed)).not.toBe(projectInputHash(base));
  });

  it('changes when the engine changes', () => {
    expect(projectInputHash({ ...base, engine: 'XELATEX' })).not.toBe(projectInputHash(base));
  });

  it('changes when the root file changes', () => {
    expect(projectInputHash({ ...base, rootFile: 'anderes.tex' })).not.toBe(projectInputHash(base));
  });

  it('changes when an asset is replaced by a different file', () => {
    const swapped = {
      ...base,
      assets: [{ path: 'bild.png', attachmentId: 'att2', checksum: 'xyz', byteSize: 10 }],
    };
    expect(projectInputHash(swapped)).not.toBe(projectInputHash(base));
  });

  it('tells two projects apart that a plain concatenation would confuse', () => {
    const first = {
      ...base,
      assets: [],
      texts: [{ path: 'a.tex', content: 'bc' }],
    };
    const second = {
      ...base,
      assets: [],
      texts: [{ path: 'ab.tex', content: 'c' }],
    };
    expect(projectInputHash(first)).not.toBe(projectInputHash(second));
  });

  it('falls back to the size when an attachment recorded no checksum', () => {
    const withoutChecksum = {
      ...base,
      assets: [{ path: 'bild.png', attachmentId: 'att1', checksum: null, byteSize: 10 }],
    };
    const differentSize = {
      ...base,
      assets: [{ path: 'bild.png', attachmentId: 'att1', checksum: null, byteSize: 11 }],
    };
    expect(projectInputHash(withoutChecksum)).not.toBe(projectInputHash(differentSize));
  });
});
