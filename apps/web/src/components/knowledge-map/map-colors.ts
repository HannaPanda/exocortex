import { Color } from 'three';

import {
  KNOWLEDGE_MAP_POINT_COLOURS,
  type KnowledgeMapAppearance,
  type KnowledgeMapPulseColour,
} from '@exocortex/contracts';

/**
 * The map's palette, read from the design tokens at runtime (issue #189).
 *
 * WebGL knows no CSS variable, so every colour the canvas draws is resolved
 * from `tokens.css` through the browser: the token is painted onto a one-pixel
 * canvas and the pixel is read back. That keeps rule 9 intact (no literal
 * colour anywhere in this code) and lets the map follow a token that changes.
 */

/**
 * The content colours, in the order branches receive them. Biggest branch
 * first; the same order as `KNOWLEDGE_MAP_POINT_COLOURS`, whose names are the
 * tokens' and under which the person tunes each one.
 */
const BRANCH_TOKENS = [
  '--content-blue',
  '--content-green',
  '--content-purple',
  '--content-orange',
  '--content-pink',
  '--content-yellow',
  '--content-red',
  '--content-brown',
  '--content-gray',
] as const;

export interface MapPalette {
  space: Color;
  foreground: Color;
  muted: Color;
  /** A run is touching this page right now. The one signal, as everywhere. */
  signal: Color;
  /** A run is reading this page. */
  read: Color;
  created: Color;
  removed: Color;
  entity: Color;
  /** What a search found, while the tour visits it. */
  found: Color;
  /** The similarity lines: the content colour as it is, quieter than the points. */
  similar: Color;
  /** The branch tokens as they are; `pointColours` turns them into light. */
  branchTokens: Color[];
  /** The entity token as it is. */
  entityToken: Color;
}

/** The colours the points are drawn in, after the person's look is applied. */
export interface PointColours {
  branches: Color[];
  entity: Color;
  pulses: Record<KnowledgeMapPulseColour, Color>;
}

function resolver(): (token: string) => Color {
  const probe = document.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  const context = probe.getContext('2d', { willReadFrequently: true });
  const style = getComputedStyle(document.documentElement);
  return (token) => {
    const value = style.getPropertyValue(token).trim();
    const color = new Color();
    if (context === null || value === '') return color;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
    // The pixel is sRGB; the renderer works in linear light, and `setRGB`
    // with the sRGB colour space converts on the way in.
    return color.setRGB(red / 255, green / 255, blue / 255, 'srgb');
  };
}

/**
 * A content colour turned into a point colour: the same hue, more saturated
 * and darker. The content tokens are pastel because they are made for text on
 * a dark page; as points under the glow they all bloomed to white and the
 * branches could not be told apart. Derived, not written down, so the map
 * still follows the token's hue.
 */
function asPoint(colour: Color, saturation = 2.2, lightness = 0.55): Color {
  const hsl = { h: 0, s: 0, l: 0 };
  // In sRGB, so 0.55 is a lightness a person sees rather than linear light.
  colour.getHSL(hsl, 'srgb');
  return colour.clone().setHSL(hsl.h, Math.min(1, hsl.s * saturation), lightness, 'srgb');
}

/**
 * The points' colours under a look: each token's hue at the chosen saturation
 * and lightness, then multiplied by its glow. A glow above 1 lifts the colour
 * past white in linear light, which the bloom pass picks up; that is the
 * whole difference between a colour that glows and one that does not.
 */
export function pointColours(palette: MapPalette, look: KnowledgeMapAppearance): PointColours {
  const point = (token: Color, key: (typeof KNOWLEDGE_MAP_POINT_COLOURS)[number]): Color => {
    const tuning = look.points[key];
    return asPoint(token, look.saturation, tuning.lightness).multiplyScalar(tuning.glow);
  };
  return {
    branches: palette.branchTokens.map((token, index) =>
      point(token, KNOWLEDGE_MAP_POINT_COLOURS[index] ?? 'gray'),
    ),
    entity: point(palette.entityToken, 'entity'),
    pulses: {
      read: palette.read.clone().multiplyScalar(look.pulses.read.glow),
      write: palette.signal.clone().multiplyScalar(look.pulses.write.glow),
      created: palette.created.clone().multiplyScalar(look.pulses.created.glow),
      removed: palette.removed.clone().multiplyScalar(look.pulses.removed.glow),
    },
  };
}

export function readMapPalette(): MapPalette {
  const resolve = resolver();
  return {
    space: resolve('--map-space'),
    foreground: resolve('--foreground'),
    muted: resolve('--muted-foreground'),
    signal: resolve('--primary'),
    read: resolve('--info'),
    created: resolve('--success'),
    removed: resolve('--destructive'),
    entity: asPoint(resolve('--warning')),
    entityToken: resolve('--warning'),
    found: resolve('--primary-text'),
    similar: resolve('--content-purple'),
    branchTokens: BRANCH_TOKENS.map((token) => resolve(token)),
  };
}

/** `#rrggbb` for the accessors of the graph library, which take CSS strings. */
export function cssOf(color: Color): string {
  return `#${color.getHexString('srgb')}`;
}
