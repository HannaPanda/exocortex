import { describe, expect, it } from 'vitest';

import {
  checkProjectPath,
  isProjectTextPath,
  latexScaffold,
  projectPathDirectory,
  rewriteProjectPath,
} from './projects';

/**
 * The path rules of a project (issue #43, ADR-027).
 *
 * These run in three places -- the browser while somebody types a filename, the
 * API before a write, and the tool layer before a tool call -- so they are the
 * one piece of this feature that has to behave identically everywhere. Each
 * refusal below is a way a path could otherwise leave the build directory, or
 * split into two arguments inside the container script.
 */

describe('checkProjectPath', () => {
  it('accepts an ordinary relative path', () => {
    expect(checkProjectPath('kapitel/einleitung.tex')).toBeNull();
  });

  it('accepts a path with spaces and umlauts', () => {
    expect(checkProjectPath('Mein Kapitel/Größe.tex')).toBeNull();
  });

  it.each([
    ['', 'empty'],
    ['/main.tex', 'absolute'],
    ['../geheim.tex', 'traversal'],
    ['kapitel/../../weg.tex', 'traversal'],
    ['kapitel/', 'trailing_slash'],
    ['kapitel//intro.tex', 'empty_segment'],
    ['kapitel\\intro.tex', 'invalid_character'],
    ['.git/config', 'reserved_name'],
    ['.exocortex/out.pdf', 'reserved_name'],
  ])('refuses %s as %s', (path, problem) => {
    expect(checkProjectPath(path)).toBe(problem);
  });

  it('refuses a control character', () => {
    expect(checkProjectPath(`main${String.fromCharCode(0)}.tex`)).toBe('invalid_character');
  });

  it('refuses a path past the length limit', () => {
    expect(checkProjectPath(`${'a'.repeat(401)}.tex`)).toBe('too_long');
  });
});

describe('isProjectTextPath', () => {
  it.each(['main.tex', 'a/b.sty', 'lit.bib', 'notes.md', 'latexmkrc', '.latexmkrc'])(
    'treats %s as text',
    (path) => {
      expect(isProjectTextPath(path)).toBe(true);
    },
  );

  it.each(['bild.png', 'schrift.otf', 'anhang.pdf', 'ohneendung'])(
    'treats %s as binary',
    (path) => {
      expect(isProjectTextPath(path)).toBe(false);
    },
  );
});

describe('rewriteProjectPath', () => {
  it('moves the named path itself', () => {
    expect(rewriteProjectPath('kapitel', 'kapitel', 'teile')).toBe('teile');
  });

  it('moves what is under it', () => {
    expect(rewriteProjectPath('kapitel/intro.tex', 'kapitel', 'teile')).toBe('teile/intro.tex');
  });

  it('leaves a path that only starts with the same letters alone', () => {
    expect(rewriteProjectPath('kapitel-alt/intro.tex', 'kapitel', 'teile')).toBeNull();
  });
});

describe('projectPathDirectory', () => {
  it('is empty at the root', () => {
    expect(projectPathDirectory('main.tex')).toBe('');
  });

  it('is everything before the last slash', () => {
    expect(projectPathDirectory('a/b/c.tex')).toBe('a/b');
  });
});

describe('latexScaffold', () => {
  it('escapes what LaTeX would otherwise read as a command', () => {
    expect(latexScaffold('Kosten & Nutzen_2026')).toContain('\\title{Kosten \\& Nutzen\\_2026}');
  });

  it('produces a document that has a beginning and an end', () => {
    const source = latexScaffold('Titel');
    expect(source).toContain('\\begin{document}');
    expect(source).toContain('\\end{document}');
  });
});
