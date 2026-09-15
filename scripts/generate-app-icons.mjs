#!/usr/bin/env node
/**
 * Builds every app icon, and the mark the product itself draws, from one vector
 * source in `apps/web/icon-sources/`.
 *
 *   apps/web/src/app/icon.svg                the favicon, plate + mark
 *   apps/web/src/app/apple-icon.png          180x180, iOS home screen
 *   apps/web/public/icons/icon-192.png       192x192, web app manifest
 *   apps/web/public/icons/icon-512.png       512x512, web app manifest
 *   apps/web/public/icons/icon-maskable-512.png
 *                                            512x512, `purpose: 'maskable'`
 *   packages/ui/src/components/logo-mark.generated.ts
 *                                            the same mark for `<ExocortexLogo>`
 *                                            and the lockup, normalised to a
 *                                            1000-unit height starting at 0,0
 *
 * All seven are generated, none is edited by hand. They used to be traced
 * separately and drifted the moment one of them moved: the mark sat 129px right
 * of centre in every file at once and nothing noticed, because a favicon is
 * looked at a hundred times a day and measured never. So the source is a mark
 * on its own, and this script measures where it actually lands and centres it.
 *
 * To go back to an earlier mark, point `SOURCE` at another file in
 * `icon-sources/` and run `pnpm icons:generate`. Nothing else has to change.
 *
 *   brain-v1.svg  the first mark: more gyri, more circuit nodes, and too much
 *                 detail to survive 16px.
 *   brain-v2.svg  the current one, drawn with fewer strokes for small sizes.
 *
 * The maskable variant is not just a resize. Android crops an icon to whatever
 * shape the launcher uses, so its plate fills the whole square (rounded corners
 * of our own would be cropped into something lopsided) and the mark is scaled
 * further down to sit well inside the safe circle.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* sharp is a dependency of `@exocortex/storage` and pnpm does not hoist it to
   the root, so it is resolved from the package that declares it. */
const sharp = createRequire(path.join(ROOT, 'packages/storage/package.json'))('sharp');

/** The mark the icons are currently built from. */
const SOURCE = path.join(ROOT, 'apps/web/icon-sources/brain-v2.svg');

/** The side of the square the icons are composed in, in SVG user units. */
const PLATE_SIZE = 1000;

/** The plate colour: the deepest slate of the surface ramp, `sunken`. */
const PLATE_COLOUR = '#182933';

/** The plate's corner radius, matching an app icon's usual squircle. */
const PLATE_RADIUS = 220;

/** How much of the square the mark's longer side takes up. */
const MARK_SHARE = 0.72;

/** The same, for a maskable icon, where a launcher crops towards the centre. */
const MASKABLE_MARK_SHARE = 0.52;

/** The height the mark is normalised to for `packages/ui`. */
const MARK_HEIGHT = 1000;

/** A pixel is part of the mark as soon as it is not fully transparent. */
const ALPHA_THRESHOLD = 0;

/** How many device pixels one side of a measuring render gets. */
const PROBE = 2400;

/** Reads "x y w h" off a viewBox attribute. */
function viewBoxOf(svg) {
  const parts = /viewBox="([^"]+)"/
    .exec(svg)?.[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts?.length !== 4 || parts.some(Number.isNaN)) {
    throw new Error('the source has no usable viewBox');
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

/**
 * Renders a mark on its own and returns the box its ink really occupies, in the
 * mark's own viewBox units. Measuring beats trusting the viewBox: an exported
 * mark almost always carries whitespace of its own, and that whitespace is
 * exactly the "too much bacon on the left" that centring by viewBox leaves.
 *
 * The probe is given explicit pixel dimensions matching the viewBox's own
 * proportions. An SVG with nothing but a viewBox has no intrinsic size, and
 * letting the renderer guess one and then fitting the result into a square adds
 * padding that is indistinguishable from the mark's own whitespace -- which is
 * a quiet way to move a logo a few units off and only find out when someone
 * notices its chin is clipped.
 */
async function measure(svg) {
  const view = viewBoxOf(svg);
  const scale = PROBE / Math.max(view.width, view.height);
  const sized = svg.replace(
    /<svg\b/,
    `<svg width="${Math.round(view.width * scale)}" height="${Math.round(view.height * scale)}"`,
  );

  const { data, info } = await sharp(Buffer.from(sized), { density: 72 })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let minX = info.width;
  let maxX = -1;
  let minY = info.height;
  let maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * info.channels + 3] <= ALPHA_THRESHOLD) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error('the mark renders nothing');

  const unitsX = view.width / info.width;
  const unitsY = view.height / info.height;
  return {
    view,
    x: view.x + minX * unitsX,
    y: view.y + minY * unitsY,
    width: (maxX - minX + 1) * unitsX,
    height: (maxY - minY + 1) * unitsY,
  };
}

/**
 * Composes plate and mark. The mark is placed through a nested `<svg>`, so the
 * source keeps its own coordinate system and only its viewBox has to be known;
 * the viewport it is given is the source blown up by exactly as much as its
 * own whitespace demands, which lands the *ink* in the middle rather than the
 * artboard.
 */
function compose(source, box, { share, radius }) {
  const { view } = box;
  const inner = source.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

  /* `scale` is plate units per source unit: enough that the mark's longer side
     fills its share of the plate. The nested viewport is the whole artboard at
     that scale, whitespace included, and it is then slid so the ink -- not the
     artboard -- ends up in the middle. */
  const scale = (PLATE_SIZE * share) / Math.max(box.width, box.height);
  const width = view.width * scale;
  const height = view.height * scale;
  const x = (PLATE_SIZE - box.width * scale) / 2 - (box.x - view.x) * scale;
  const y = (PLATE_SIZE - box.height * scale) / 2 - (box.y - view.y) * scale;
  const viewBox = `${view.x} ${view.y} ${view.width} ${view.height}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PLATE_SIZE} ${PLATE_SIZE}" role="img" aria-label="eXocortex">
  <title>eXocortex</title>
  <!-- Generated by scripts/generate-app-icons.mjs from
       ${path.relative(ROOT, SOURCE)}. Do not edit: run \`pnpm icons:generate\`.
       A comment here must never contain two hyphens in a row. That is invalid
       XML, SVG is parsed as XML, and a browser drops the whole favicon rather
       than ignoring the comment. -->
  <rect width="${PLATE_SIZE}" height="${PLATE_SIZE}"${radius ? ` rx="${radius}"` : ''} fill="${PLATE_COLOUR}"/>
  <svg x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" viewBox="${viewBox}" overflow="visible">${inner}</svg>
</svg>
`;
}

/**
 * Emits the mark as a module `packages/ui` can draw: the source's own paths,
 * plus one transform that lands their ink on a 1000-unit height at the origin.
 *
 * The transform is composed rather than baked into the coordinates on purpose.
 * An exported mark carries a transform of its own -- a traced one is usually
 * flipped and scaled by a tenth -- and rewriting every number of a path through
 * a mirrored matrix is a lot of arithmetic to get subtly wrong for no gain,
 * when nesting is exactly what the attribute is for.
 */
function toLogoModule(source, box) {
  const inner = /<g\s+transform="([^"]+)"/.exec(source)?.[1] ?? '';
  const own = /translate\(([-\d.]+),\s*([-\d.]+)\)\s*scale\(([-\d.]+),\s*([-\d.]+)\)/.exec(inner);
  const [tx, ty, sx, sy] = own
    ? [Number(own[1]), Number(own[2]), Number(own[3]), Number(own[4])]
    : [0, 0, 1, 1];

  /* The wanted mapping is `scale(k)` about the ink's top left corner, that is
     `p -> (p - box) * k`. Composing it with the source's own
     `p -> (t + s * p)` gives `p -> (t - box) * k + (s * k) * p`, which is one
     translate and one scale. The `- box` belongs inside the scaling: leaving it
     outside is what once pushed the mark 52 units down and clipped its chin. */
  const k = MARK_HEIGHT / box.height;
  const transform =
    `translate(${((tx - box.x) * k).toFixed(4)} ${((ty - box.y) * k).toFixed(4)}) ` +
    `scale(${(sx * k).toFixed(6)} ${(sy * k).toFixed(6)})`;

  /* A traced export wraps its `d` across lines. A newline inside a JavaScript
     string literal is a syntax error, so the whitespace is flattened. */
  const paths = [...source.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((m) =>
    m[1].replace(/\s+/g, ' ').trim(),
  );
  if (paths.length === 0) throw new Error('the source has no <path>');

  return `/* Generated by scripts/generate-app-icons.mjs from
   ${path.relative(ROOT, SOURCE)}. Do not edit: run \`pnpm icons:generate\`. */

/** The mark's paths, in the coordinate system the source was drawn in. */
export const MARK_PATHS = [
${paths.map((d) => `  '${d}',`).join('\n')}
] as const;

/** Puts those paths on a ${MARK_HEIGHT}-unit height with their ink at 0,0. */
export const MARK_TRANSFORM = '${transform}';

/** How wide the mark is once transformed. The lockup spaces itself from this. */
export const MARK_WIDTH = ${((box.width / box.height) * MARK_HEIGHT).toFixed(1)};
`;
}

/* The checks below read the emitted module back rather than recomputing it, so
   what is verified is what `packages/ui` will actually draw. */
const logoTransform = (module) => /MARK_TRANSFORM = '([^']+)'/.exec(module)[1];
const logoWidth = (module) => Number(/MARK_WIDTH = ([\d.]+)/.exec(module)[1]);
const markPaths = (module) =>
  [...module.matchAll(/^ {2}'([^']+)',$/gm)].map((m) => `<path d="${m[1]}"/>`).join('');

async function render(svg, size, target) {
  await sharp(Buffer.from(svg), { density: 600 }).resize(size, size).png().toFile(target);
  console.log(`  ${path.relative(ROOT, target)}  ${size}x${size}`);
}

const source = await readFile(SOURCE, 'utf8');
const box = await measure(source);
console.log(
  `${path.relative(ROOT, SOURCE)}: ink is ${box.width.toFixed(1)}x${box.height.toFixed(1)} ` +
    `at ${box.x.toFixed(1)},${box.y.toFixed(1)} in a ${box.view.width}x${box.view.height} artboard.`,
);

const icon = compose(source, box, { share: MARK_SHARE, radius: PLATE_RADIUS });
const maskable = compose(source, box, { share: MASKABLE_MARK_SHARE, radius: 0 });

await writeFile(path.join(ROOT, 'apps/web/src/app/icon.svg'), icon, 'utf8');
console.log('  apps/web/src/app/icon.svg');

await render(icon, 180, path.join(ROOT, 'apps/web/src/app/apple-icon.png'));
await render(icon, 192, path.join(ROOT, 'apps/web/public/icons/icon-192.png'));
await render(icon, 512, path.join(ROOT, 'apps/web/public/icons/icon-512.png'));
await render(maskable, 512, path.join(ROOT, 'apps/web/public/icons/icon-maskable-512.png'));

const logoModule = path.join(ROOT, 'packages/ui/src/components/logo-mark.generated.ts');
const logo = toLogoModule(source, box);
await writeFile(logoModule, logo, 'utf8');
console.log(`  ${path.relative(ROOT, logoModule)}`);

/* The whole point of generating these is that nobody has to eyeball them, so
   the last word is a measurement of what was actually written. */
const centred = await measure(icon.replace(/<rect\b[^>]*\/>/, ''));
const offX = Math.abs(centred.x + centred.width / 2 - PLATE_SIZE / 2);
const offY = Math.abs(centred.y + centred.height / 2 - PLATE_SIZE / 2);
if (offX > 2 || offY > 2) {
  console.error(`icon.svg is off centre by ${offX.toFixed(1)}x${offY.toFixed(1)} units`);
  process.exit(1);
}
console.log(
  `icon.svg: mark ${centred.width.toFixed(0)}x${centred.height.toFixed(0)} of ${PLATE_SIZE}, centred.`,
);

/* And the same for the logo mark, which is checked against a generous frame so
   that ink spilling past its own box shows up as a number rather than as a
   clipped chin in the corner of the application. */
const framed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-200 -200 ${MARK_HEIGHT + 400} ${MARK_HEIGHT + 400}"><g transform="${logoTransform(logo)}">${markPaths(logo)}</g></svg>`;
const placed = await measure(framed);
const spill = Math.max(
  -placed.x,
  -placed.y,
  placed.x + placed.width - logoWidth(logo),
  placed.y + placed.height - MARK_HEIGHT,
);
if (spill > 1) {
  console.error(
    `the logo mark spills ${spill.toFixed(1)} units out of its box: ` +
      `ink runs ${placed.x.toFixed(1)}..${(placed.x + placed.width).toFixed(1)} by ` +
      `${placed.y.toFixed(1)}..${(placed.y + placed.height).toFixed(1)}, ` +
      `box is 0..${logoWidth(logo)} by 0..${MARK_HEIGHT}.`,
  );
  process.exit(1);
}
console.log(
  `logo mark: ink ${placed.width.toFixed(1)}x${placed.height.toFixed(1)} at ` +
    `${placed.x.toFixed(1)},${placed.y.toFixed(1)}, inside its box.`,
);
