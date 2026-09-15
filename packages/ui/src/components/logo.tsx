import * as React from 'react';

import { cn } from '../lib/utils';
import { MARK_PATHS, MARK_TRANSFORM, MARK_WIDTH } from './logo-mark.generated';

/**
 * The eXocortex brand marks.
 *
 * The lockup is mark, rule, wordmark: a brain whose left half is cortex and
 * whose right half is a circuit, then a light rule, then the product name. The
 * mark and the wordmark are both the brand amber; only the rule between them is
 * the brand light. That is the whole logo: one colour for the thing itself, one
 * hairline to say that the name is a separate claim.
 *
 * The two brand colours are hardcoded here and nowhere else in the design
 * system. A logo keeps its colour when the surface underneath it changes;
 * taking it from a theme token would make the brand a side effect of the theme.
 * Everything else in the product uses the semantic tokens in tokens.css.
 *
 * The wordmark is outlines, not live text. It was set once in Neuropol (Ray
 * Larabie, 1996, released under CC0 in 2024; the typeface sits in
 * `src/assets/Neuropol.otf` so the wordmark can be reset) at 940 units with
 * 20/1000 em of extra tracking, then converted to a path. A logo that depends on
 * a webfont loading is a logo that is briefly wrong on every cold start, and it
 * cannot be kerned. Outlines also keep Neuropol out of the runtime bundle: it is
 * a display face, the product's UI type is Inter, and nothing but the name is
 * ever set in it.
 *
 * The mark is not written here. It comes from `logo-mark.generated.ts`, which
 * `scripts/generate-app-icons.mjs` writes from the same vector source as the
 * favicon and the launcher tiles, normalised to a 1000-unit height with its ink
 * starting at 0,0. Keeping one source is what stops the tab icon and the
 * wordmark from slowly becoming two different drawings of the same brain.
 *
 * Geometry: the mark is `MARK_WIDTH` by 1000 units, the wordmark's cap height
 * is 685, and the rule brackets that cap height rather than the full height of
 * the mark, so the three parts read as one line instead of as an icon with a
 * tall stick beside it. Both components are sized by height.
 *
 * No `fill-rule` is set: the mark's counters are wound against their outlines,
 * which is what the default non-zero rule expects. Switching it to `evenodd`
 * fills the brain solid.
 */
const BRAND_AMBER = '#F9AA33';
const BRAND_LIGHT = '#E7E9EB';

/** The mark centred in a square, for an avatar, a tab or a launcher tile. */
const MARK_VIEW_BOX = `${(MARK_WIDTH - 1000) / 2} 0 1000 1000`;

/* The lockup is spaced from the mark rather than from fixed coordinates, so a
   new mark of a different width does not push the wordmark out of true. The gap
   is used twice, once on each side of the rule, and the wordmark path was drawn
   starting at this x; it is slid by the difference. */
const LOCKUP_GAP = 287.8;
const RULE_X = MARK_WIDTH + LOCKUP_GAP;
const RULE_WIDTH = 58.2;
const WORDMARK_X = RULE_X + RULE_WIDTH + LOCKUP_GAP;
const WORDMARK_DRAWN_AT = 1565.5;
const WORDMARK_SHIFT = WORDMARK_X - WORDMARK_DRAWN_AT;
/** The full lockup, about 8.3:1. */
const LOCKUP_VIEW_BOX = `0 0 ${8320.4 + WORDMARK_SHIFT} 1000`;

const WORDMARK_PATH =
  'M2258.3 631.1C2306.2 631.1 2314.7 619.8 2314.7 583.2L2314.7 475.1C2314.7 365.1 2236.7 311.5 2048.7 311.5L1831.5 311.5C1654.8 311.5 1565.5 365.1 1565.5 475.1L1565.5 679C1565.5 788.1 1654.8 842.6 1831.5 842.6L1943.4 842.6C1971.6 842.6 1977.2 825.7 1977.2 794.7 1977.2 763.6 1971.6 747.7 1943.4 747.7L1835.3 747.7C1730 747.7 1684.9 716.6 1684.9 679L1684.9 631.1M1684.9 475.1C1684.9 436.5 1730 406.4 1835.3 406.4L2044.9 406.4C2150.2 406.4 2195.3 431.8 2195.3 475.1L2195.3 538 1684.9 538M2509.3 178C2494.2 164.9 2479.2 161.1 2450.1 161.1 2414.3 161.1 2389 166.7 2389 199.6 2389 216.6 2395.5 225 2420 245.7L2718.9 497.6 2409.6 761.8C2386.1 782.4 2379.6 790.9 2379.6 807.8 2379.6 842.6 2410.6 846.4 2441.6 846.4 2468.9 846.4 2485.8 843.5 2502.7 829.4L2805.4 570 3115.6 829.4C3132.5 843.5 3146.6 846.4 3173.9 846.4 3209.6 846.4 3235.9 841.7 3235.9 807.8 3235.9 790.9 3229.3 782.4 3204.9 761.8L2898.4 505.1 3202.1 245.7C3225.6 225 3232.1 216.6 3232.1 199.6 3232.1 164.9 3201.1 161.1 3172 161.1 3141.9 161.1 3125 164.9 3109 178L2812 432.8M3308.3 475.1L3308.3 679C3308.3 788.1 3397.6 842.6 3574.3 842.6L3779.2 842.6C3955.9 842.6 4045.2 788.1 4045.2 679L4045.2 475.1C4045.2 365.1 3955.9 311.5 3779.2 311.5L3574.3 311.5C3397.6 311.5 3308.3 365.1 3308.3 475.1M3925.9 679C3925.9 716.6 3880.7 747.7 3775.5 747.7L3578.1 747.7C3472.8 747.7 3427.7 716.6 3427.7 679L3427.7 475.1C3427.7 436.5 3472.8 406.4 3578.1 406.4L3775.5 406.4C3880.7 406.4 3925.9 436.5 3925.9 475.1M4874.3 842.6C4902.5 842.6 4908.2 825.7 4908.2 794.7 4908.2 763.6 4902.5 747.7 4874.3 747.7L4405.3 747.7C4300 747.7 4254.9 716.6 4254.9 679L4254.9 475.1C4254.9 436.5 4300 406.4 4405.3 406.4L4871.5 406.4C4899.7 406.4 4906.3 390.5 4906.3 359.4 4906.3 327.5 4899.7 311.5 4871.5 311.5L4401.5 311.5C4224.8 311.5 4135.5 365.1 4135.5 475.1L4135.5 679C4135.5 788.1 4224.8 842.6 4401.5 842.6M4993.7 475.1L4993.7 679C4993.7 788.1 5083 842.6 5259.7 842.6L5464.6 842.6C5641.4 842.6 5730.7 788.1 5730.7 679L5730.7 475.1C5730.7 365.1 5641.4 311.5 5464.6 311.5L5259.7 311.5C5083 311.5 4993.7 365.1 4993.7 475.1M5611.3 679C5611.3 716.6 5566.2 747.7 5460.9 747.7L5263.5 747.7C5158.2 747.7 5113.1 716.6 5113.1 679L5113.1 475.1C5113.1 436.5 5158.2 406.4 5263.5 406.4L5460.9 406.4C5566.2 406.4 5611.3 436.5 5611.3 475.1M6069.1 311.5C5912.1 311.5 5825.6 366 5825.6 474.1L5825.6 802.2C5825.6 837.9 5845.3 846.4 5884.8 846.4 5925.2 846.4 5945 837.9 5945 802.2L5945 474.1C5945 430.9 5976 406.4 6069.1 406.4L6142.4 406.4C6170.6 406.4 6176.2 390.5 6176.2 359.4 6176.2 328.4 6170.6 311.5 6142.4 311.5M6260.8 311.5C6232.6 311.5 6227 328.4 6227 359.4 6227 390.5 6232.6 406.4 6260.8 406.4L6314.4 406.4 6314.4 802.2C6314.4 837.9 6334.1 846.4 6373.6 846.4 6414 846.4 6433.8 837.9 6433.8 802.2L6433.8 406.4 6632.1 406.4C6660.3 406.4 6666 390.5 6666 359.4 6666 328.4 6660.3 311.5 6632.1 311.5L6433.8 311.5 6433.8 201.5C6433.8 165.8 6414 157.3 6373.6 157.3 6334.1 157.3 6314.4 165.8 6314.4 201.5L6314.4 311.5M7424.5 631.1C7472.5 631.1 7480.9 619.8 7480.9 583.2L7480.9 475.1C7480.9 365.1 7402.9 311.5 7214.9 311.5L6997.8 311.5C6821.1 311.5 6731.8 365.1 6731.8 475.1L6731.8 679C6731.8 788.1 6821.1 842.6 6997.8 842.6L7109.6 842.6C7137.8 842.6 7143.5 825.7 7143.5 794.7 7143.5 763.6 7137.8 747.7 7109.6 747.7L7001.5 747.7C6896.3 747.7 6851.1 716.6 6851.1 679L6851.1 631.1M6851.1 475.1C6851.1 436.5 6896.3 406.4 7001.5 406.4L7211.2 406.4C7316.4 406.4 7361.6 431.8 7361.6 475.1L7361.6 538 6851.1 538M7683 320.9C7669.9 310.6 7655.8 307.7 7621.9 307.7 7577.8 307.7 7556.1 312.4 7556.1 337.8 7556.1 349.1 7560.8 357.6 7582.5 374.5L7841.9 571.9 7574 779.6C7552.4 796.5 7547.7 803.1 7547.7 815.3 7547.7 843.5 7574 846.4 7615.4 846.4 7648.3 846.4 7662.4 844.5 7677.4 833.2L7926.5 636.7 8180.3 833.2C8194.4 843.5 8208.5 846.4 8244.2 846.4 8285.6 846.4 8308.1 842.6 8308.1 816.3 8308.1 803.1 8302.5 796.5 8280.9 779.6L8015.8 578.5 8278.1 374.5C8299.7 357.6 8305.3 351 8305.3 338.8 8305.3 311.5 8278.1 307.7 8239.5 307.7 8200 307.7 8187.8 310.6 8174.7 320.9L7931.2 513.6';

/** The mark on its own: square, for tight spots such as an avatar or a tab. */
export function ExocortexLogo({ className, ...props }: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg
      viewBox={MARK_VIEW_BOX}
      role="img"
      aria-label="eXocortex"
      className={cn('size-5', className)}
      {...props}
    >
      <g fill={BRAND_AMBER} transform={MARK_TRANSFORM}>
        {MARK_PATHS.map((d) => (
          <path key={d.slice(0, 32)} d={d} />
        ))}
      </g>
    </svg>
  );
}

/** The full lockup: mark, rule, wordmark. Size it by height. */
export function ExocortexWordmark({ className, ...props }: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg
      viewBox={LOCKUP_VIEW_BOX}
      role="img"
      aria-label="eXocortex"
      className={cn('h-8 w-auto', className)}
      {...props}
    >
      <g fill={BRAND_AMBER} transform={MARK_TRANSFORM}>
        {MARK_PATHS.map((d) => (
          <path key={d.slice(0, 32)} d={d} />
        ))}
      </g>
      <rect
        x={RULE_X}
        y={140.3}
        width={RULE_WIDTH}
        height={719.5}
        rx={RULE_WIDTH / 2}
        fill={BRAND_LIGHT}
      />
      <path fill={BRAND_AMBER} d={WORDMARK_PATH} transform={`translate(${WORDMARK_SHIFT} 0)`} />
    </svg>
  );
}
