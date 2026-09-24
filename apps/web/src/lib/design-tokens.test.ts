import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TOKEN_GROUPS } from '@/components/design-system/foundations/token-catalog';

import { parseCustomProperties, typeLadder } from './design-tokens';

const uiSource = join(__dirname, '../../../../packages/ui/src');
const tokensCss = readFileSync(join(uiSource, 'tokens.css'), 'utf8');
const stylesCss = readFileSync(join(uiSource, 'styles.css'), 'utf8');

describe('parseCustomProperties', () => {
  it('reads multi-line values and ignores comments', () => {
    const css = `:root {
      /* --commented: red; */
      --a: 1px;
      --shadow:
        0 1px 2px red,
        0 2px 4px blue;
    }`;
    expect(parseCustomProperties(css, ':root').properties).toEqual([
      { name: '--a', value: '1px' },
      { name: '--shadow', value: '0 1px 2px red, 0 2px 4px blue' },
    ]);
  });

  it('reports a name declared twice, which CSS would resolve silently', () => {
    const parsed = parseCustomProperties(':root { --x: 1; --x: 2; }', ':root');
    expect(parsed.duplicates).toEqual(['--x']);
    expect(parsed.properties).toEqual([{ name: '--x', value: '2' }]);
  });

  it('returns nothing for a block that does not exist', () => {
    expect(parseCustomProperties('body { --a: 1; }', ':root').properties).toEqual([]);
  });
});

describe('the real stylesheets', () => {
  const tokens = parseCustomProperties(tokensCss, ':root');
  const theme = parseCustomProperties(stylesCss, '@theme inline');

  it('declare every token once', () => {
    // 0ebed50: `--shadow-md` twice and `--shadow-lg` never, in both files.
    expect(tokens.duplicates).toEqual([]);
    expect(theme.duplicates).toEqual([]);
  });

  it('carry the whole type ladder', () => {
    expect(typeLadder(theme).map((rung) => rung.name)).toEqual([
      'title',
      'section',
      'subsection',
      'body',
      'ui',
      'meta',
      'micro',
      'nano',
    ]);
  });
});

describe('the token catalogue', () => {
  const declared = parseCustomProperties(tokensCss, ':root').properties.map((p) => p.name);
  const catalogued = TOKEN_GROUPS.flatMap((group) => Object.keys(group.tokens));

  it('names only tokens the stylesheet declares', () => {
    expect(catalogued.filter((name) => !declared.includes(name))).toEqual([]);
  });

  it('places every declared token in exactly one group', () => {
    expect(declared.filter((name) => !catalogued.includes(name))).toEqual([]);
    expect(catalogued.filter((name, index) => catalogued.indexOf(name) !== index)).toEqual([]);
  });
});
