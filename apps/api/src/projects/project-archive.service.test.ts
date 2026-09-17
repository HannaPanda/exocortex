import { describe, expect, it } from 'vitest';

import { commonRoot } from './project-archive.service';

/**
 * The one decision an import makes about every path at once (issue #54).
 *
 * Worth its own tests because getting it wrong is silent: a wrongly detected
 * root strips a real folder out of every path, and the archive still imports,
 * still looks plausible in the file tree, and fails at the first `\input`.
 */

const entry = (name: string) => ({ name, content: Buffer.alloc(0) });

describe('commonRoot', () => {
  it('finds the folder every entry sits under', () => {
    expect(commonRoot([entry('arbeit/main.tex'), entry('arbeit/kapitel/intro.tex')])).toBe(
      'arbeit',
    );
  });

  it('has no answer when one entry sits at the top', () => {
    expect(commonRoot([entry('arbeit/main.tex'), entry('liesmich.txt')])).toBeNull();
  });

  it('has no answer when two folders disagree', () => {
    expect(commonRoot([entry('a/main.tex'), entry('b/main.tex')])).toBeNull();
  });

  it('is not fooled by a shared prefix that is not a folder', () => {
    // `arbeit` and `arbeit-alt` share five letters and nothing else.
    expect(commonRoot([entry('arbeit/main.tex'), entry('arbeit-alt/main.tex')])).toBeNull();
  });

  it('has no answer for an empty archive', () => {
    expect(commonRoot([])).toBeNull();
  });
});
