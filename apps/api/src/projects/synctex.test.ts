import { describe, expect, it } from 'vitest';

import { lookupAreas, lookupSource, parseSyncTex, resolveInputPath } from './synctex';

/**
 * The parser against a map `xelatex` actually wrote (issue #53).
 *
 * The fixture is the whole output for a two-file document, kept verbatim rather
 * than trimmed, because the parts that are easy to get wrong are the parts a
 * hand-written sample would leave out: the `!` anchors, the `Input:` line that
 * arrives *after* the sheet closed, and above all the last paragraph -- one
 * horizontal box carrying line 4 of `main.tex`, holding glyphs from `main.tex`
 * on the left and from `teil.tex` on the right. That one box is the reason a
 * reverse lookup cannot stop at the box it landed in.
 */
const FIXTURE = [
  'SyncTeX Version:1',
  'Input:1:/w/./main.tex',
  'Input:2:/opt/texlive/texdir/texmf-dist/tex/latex/base/article.cls',
  'Input:5:/w/./main.aux',
  'Input:6:/w/./teil.tex',
  'Output:xdv',
  'Magnification:1000',
  'Unit:1',
  'X Offset:4736287',
  'Y Offset:4736287',
  'Content:',
  '!374',
  '{1',
  '[1,6:0,41484288:26673152,41484288,0',
  '[1,6:4063232,41484288:22609920,40435712,0',
  '[1,6:4063232,39518208:22609920,36044800,0',
  '(1,6:4063232,4128768:22609920,454820,135003',
  'h1,4:4063232,4128768:983040,0,0',
  'g1,4:6771835,4128768',
  'g1,4:8591770,4128768',
  'g6,1:10684335,4128768',
  'g6,1:12249335,4128768',
  'g6,1:21020674,4128768',
  'k1,6:26673152,4128768:5652478',
  ')',
  ']',
  ']',
  ']',
  '!621',
  '}1',
  'Input:7:/w/./main.aux',
  '!30',
  'Postamble:',
  'Count:32',
  '!24',
  'Post scriptum:',
  '',
].join('\n');

const map = parseSyncTex(FIXTURE);

describe('parseSyncTex', () => {
  it('reads the inputs, including the one written after the sheet', () => {
    expect(map.inputs.get(1)).toBe('/w/./main.tex');
    expect(map.inputs.get(6)).toBe('/w/./teil.tex');
    expect(map.inputs.get(7)).toBe('/w/./main.aux');
  });

  it('puts every record on the sheet it belongs to', () => {
    expect(map.records).not.toHaveLength(0);
    expect(map.records.every((record) => record.page === 1)).toBe(true);
    expect(map.truncated).toBe(false);
  });

  it('converts scaled points into PDF points from the top left', () => {
    // The sheet box: TeX's origin is one inch above and left of the paper, so
    // the shipout box has to land exactly on the inch mark.
    const sheet = map.records.find((record) => record.width > 400) as {
      left: number;
      top: number;
    };
    expect(sheet.left).toBeCloseTo(72, 2);
    expect(sheet.top).toBeCloseTo(72, 2);
  });

  it('gives a box its height upwards from the baseline and its depth below', () => {
    const paragraph = map.records.find((record) => record.height > 8 && record.height < 10) as {
      top: number;
      height: number;
    };
    // Baseline at 4128768 sp, height 454820, depth 135003, plus the one-inch
    // offset: the top is above the baseline and the box is deeper than it is tall.
    expect(paragraph.top).toBeCloseTo(127.85, 1);
    expect(paragraph.height).toBeCloseTo(8.97, 1);
  });

  it('ignores anchors, the postamble and records with no sheet', () => {
    expect(map.records.some((record) => Number.isNaN(record.line))).toBe(false);
  });
});

describe('lookupSource', () => {
  it('names the file the glyphs under the point came from, not the box around them', () => {
    // Both halves of one paragraph. The box says main.tex:4; only the glyphs
    // say that the right-hand half is teil.tex:1.
    expect(lookupSource(map, { page: 1, x: 140, y: 131 })).toMatchObject({ tag: 1, line: 4 });
    expect(lookupSource(map, { page: 1, x: 300, y: 131 })).toMatchObject({ tag: 6, line: 1 });
  });

  it('answers the nearest record when the point is in the margin', () => {
    const found = lookupSource(map, { page: 1, x: 40, y: 780 });
    expect(found).not.toBeNull();
  });

  it('has no answer for a page the build never produced', () => {
    expect(lookupSource(map, { page: 9, x: 100, y: 100 })).toBeNull();
  });
});

describe('lookupAreas', () => {
  it('merges the marks of one line into the run of text a reader sees', () => {
    const found = lookupAreas(map, { tag: 1, line: 4 }, 16);
    expect(found?.line).toBe(4);
    expect(found?.areas).toHaveLength(1);
    const area = found?.areas[0] as { page: number; top: number; height: number; width: number };
    expect(area.page).toBe(1);
    // Glue records carry no extent of their own; the height is the line box's.
    expect(area.height).toBeCloseTo(8.97, 1);
    expect(area.width).toBeGreaterThan(50);
  });

  it('keeps the two files of one paragraph apart', () => {
    const first = lookupAreas(map, { tag: 1, line: 4 }, 16)?.areas[0] as { left: number };
    const second = lookupAreas(map, { tag: 6, line: 1 }, 16)?.areas[0] as { left: number };
    expect(second.left).toBeGreaterThan(first.left);
  });

  it('falls forward to the next line that produced something', () => {
    // Line 2 is `\pagestyle{empty}`: it prints nothing, and answering nothing
    // would make forward sync fail on every line somebody edits between runs.
    expect(lookupAreas(map, { tag: 1, line: 2 }, 16)?.line).toBe(4);
  });

  it('has no answer for a file that produced nothing', () => {
    expect(lookupAreas(map, { tag: 99, line: 1 }, 16)).toBeNull();
  });
});

describe('resolveInputPath', () => {
  const known = ['main.tex', 'teil.tex', 'kapitel/eins.tex'];

  it('finds the project file behind the container path', () => {
    expect(resolveInputPath('/w/./teil.tex', known)).toBe('teil.tex');
    expect(resolveInputPath('/tmp/exocortex-build/./kapitel/eins.tex', known)).toBe(
      'kapitel/eins.tex',
    );
  });

  it('refuses a path that is not in the project', () => {
    // TeX Live's own files are named the same way and are not a place anybody
    // can go and fix something.
    expect(
      resolveInputPath('/opt/texlive/texdir/texmf-dist/tex/latex/base/article.cls', known),
    ).toBeNull();
    expect(resolveInputPath('/w/./main.aux', known)).toBeNull();
  });

  it('does not mistake a suffix for a path', () => {
    expect(resolveInputPath('/w/./notmain.tex', known)).toBeNull();
  });
});
