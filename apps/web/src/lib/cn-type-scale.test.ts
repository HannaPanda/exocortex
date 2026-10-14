import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cn, TYPE_SCALE_SIZES } from '@exocortex/ui';

const stylesCss = readFileSync(join(__dirname, '../../../../packages/ui/src/styles.css'), 'utf8');

/**
 * `cn` used to read the type scale's own sizes as colours: `text-micro` next to
 * `text-muted-foreground` was merged away and the label fell back to 16 px
 * (issue #195).
 */
describe('cn and the type scale', () => {
  it('keeps a size of the scale beside a text colour', () => {
    for (const size of TYPE_SCALE_SIZES) {
      expect(cn(`text-${size}`, 'text-muted-foreground')).toBe(
        `text-${size} text-muted-foreground`,
      );
    }
  });

  it('still lets a later size replace an earlier one', () => {
    expect(cn('text-micro', 'text-meta')).toBe('text-meta');
    expect(cn('text-sm', 'text-micro')).toBe('text-micro');
  });

  it('knows every size styles.css defines, and nothing else', () => {
    const defined = [...stylesCss.matchAll(/^\s*--text-([a-z]+):/gm)].map((match) => match[1]);
    expect([...TYPE_SCALE_SIZES].sort()).toEqual([...new Set(defined)].sort());
  });
});
