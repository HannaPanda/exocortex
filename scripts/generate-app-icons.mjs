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

/** A pixel counts as part of the mark once it is more than faintly opaque. */
const ALPHA_THRESHOLD = 10;

/**
 * Renders a mark on its own and returns the box it really occupies, expressed
 * as a fraction of the rendered square. Measuring beats trusting the viewBox:
 * an exported mark almost always carries whitespace of its own, and that
 * whitespace is exactly the "too much bacon on the left" that centring by
 * viewBox leaves behind.
 */
async function measure(svg) {
  const probe = 1000;
  const { data, info } = await sharp(Buffer.from(svg), { density: 72 })
    .resize(probe, probe, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
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
  if (maxX < 0) throw new Error(`${path.relative(ROOT, SOURCE)} renders nothing`);

  return {
    x: minX / probe,
    y: minY / probe,
    width: (maxX - minX + 1) / probe,
    height: (maxY - minY + 1) / probe,
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
  const viewBox = /viewBox="([^"]+)"/.exec(source)?.[1];
  if (!viewBox) throw new Error(`${path.relative(ROOT, SOURCE)} has no viewBox`);

  const inner = source.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const target = PLATE_SIZE * share;
  const scale = target / Math.max(box.width, box.height);
  const width = scale;
  const height = scale;
  const x = (PLATE_SIZE - box.width * scale) / 2 - box.x * scale;
  const y = (PLATE_SIZE - box.height * scale) / 2 - box.y * scale;

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
  const viewBox = /viewBox="([^"]+)"/.exec(source)?.[1].trim().split(/\s+/).map(Number);
  if (viewBox?.length !== 4 || viewBox[0] !== 0 || viewBox[1] !== 0) {
    throw new Error('the source viewBox is not "0 0 w h"');
  }
  const artboard = viewBox[3];

  const inner = /<g\s+transform="([^"]+)"/.exec(source)?.[1] ?? '';
  const flip = /translate\(([\d.]+),([\d.]+)\)\s*scale\(([-\d.]+),([-\d.]+)\)/.exec(inner);

  const scale = 1000 / (box.height * artboard);
  const left = box.x * artboard;
  const top = box.y * artboard;

  /* Composing `translate(-left -top) scale(scale)` with the source's own
     `translate(tx ty) scale(sx sy)` keeps it to a single attribute. */
  const [tx, ty, sx, sy] = flip
    ? [Number(flip[1]), Number(flip[2]), Number(flip[3]), Number(flip[4])]
    : [0, 0, 1, 1];
  const transform =
    `translate(${(tx * scale - left).toFixed(4)} ${(ty * scale - top).toFixed(4)}) ` +
    `scale(${(sx * scale).toFixed(6)} ${(sy * scale).toFixed(6)})`;

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

/** Puts those paths on a ${PLATE_SIZE}-unit height with their ink starting at 0,0. */
export const MARK_TRANSFORM = '${transform}';

/** How wide the mark is once transformed. The lockup spaces itself from this. */
export const MARK_WIDTH = ${((box.width / box.height) * 1000).toFixed(1)};
`;
}

async function render(svg, size, target) {
  await sharp(Buffer.from(svg), { density: 600 }).resize(size, size).png().toFile(target);
  console.log(`  ${path.relative(ROOT, target)}  ${size}x${size}`);
}

const source = await readFile(SOURCE, 'utf8');
const box = await measure(source);
console.log(
  `${path.relative(ROOT, SOURCE)}: ink covers ` +
    `${(box.width * 100).toFixed(0)}% x ${(box.height * 100).toFixed(0)}% of its artboard.`,
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
await writeFile(logoModule, toLogoModule(source, box), 'utf8');
console.log(`  ${path.relative(ROOT, logoModule)}`);

/* The whole point of generating these is that nobody has to eyeball them, so
   the last word is a measurement of what was actually written. */
const check = await measure(icon.replace(/<rect\b[^>]*\/>/, ''));
const offX = Math.abs(check.x + check.width / 2 - 0.5) * PLATE_SIZE;
const offY = Math.abs(check.y + check.height / 2 - 0.5) * PLATE_SIZE;
if (offX > 2 || offY > 2) {
  console.error(`icon.svg is off centre by ${offX.toFixed(0)}x${offY.toFixed(0)} units`);
  process.exit(1);
}
console.log(
  `icon.svg: mark ${(check.width * PLATE_SIZE).toFixed(0)}x${(check.height * PLATE_SIZE).toFixed(0)} of ${PLATE_SIZE}, centred.`,
);
