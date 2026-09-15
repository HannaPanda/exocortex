#!/usr/bin/env node
/**
 * Regenerates every raster app icon from the one vector source,
 * `apps/web/src/app/icon.svg`.
 *
 *   apps/web/src/app/apple-icon.png          180x180, iOS home screen
 *   apps/web/public/icons/icon-192.png       192x192, web app manifest
 *   apps/web/public/icons/icon-512.png       512x512, web app manifest
 *   apps/web/public/icons/icon-maskable-512.png
 *                                            512x512, `purpose: 'maskable'`
 *
 * They were traced by hand once and drifted away from the SVG the moment it
 * moved: the mark sat 129px right of centre in all five files at the same time,
 * and nothing noticed. So there is one source and a command now.
 *
 * The maskable variant is not just a resize. Android crops an icon to whatever
 * shape the launcher uses, so the plate fills the whole square (no rounded
 * corners of our own, they would be cropped into something lopsided) and the
 * mark is scaled down to sit well inside the safe circle.
 *
 * The script also refuses to run when the mark in `icon.svg` is off centre,
 * because a favicon is looked at a hundred times a day and measured never.
 *
 * Run after any change to `icon.svg`: `pnpm icons:generate`.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* sharp is a dependency of `@exocortex/storage` and pnpm does not hoist it to
   the root, so it is resolved from the package that declares it. */
const sharp = createRequire(path.join(ROOT, 'packages/storage/package.json'))('sharp');
const SOURCE = path.join(ROOT, 'apps/web/src/app/icon.svg');

/** The plate colour, kept in step with the `<rect>` in the source. */
const PLATE = '#182933';

/** How wide the mark may be inside a maskable icon, as a share of the square. */
const MASKABLE_MARK_SHARE = 0.52;

/** A pixel counts as part of the mark once it is more than faintly opaque. */
const ALPHA_THRESHOLD = 10;

/**
 * Renders the mark on its own (the plate removed) and returns the box it
 * occupies, in the source's own 1000x1000 user units.
 */
async function measureMark(svg) {
  const markOnly = svg.replace(/<rect\b[^>]*\/>/, '');
  const { data, info } = await sharp(Buffer.from(markOnly), { density: 600 })
    .resize(1000, 1000)
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
  if (maxX < 0) throw new Error('icon.svg renders nothing but the plate');
  return { minX, maxX, minY, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Rebuilds the source with a square plate and the mark scaled into the safe
 * zone, which is what a maskable icon has to be.
 */
function toMaskable(svg, box) {
  const factor = (MASKABLE_MARK_SHARE * 1000) / box.width;
  const [, x, y, scale] =
    /translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)/.exec(svg) ??
    (() => {
      throw new Error('icon.svg no longer places the mark with translate()+scale()');
    })();

  /* The existing transform maps path space onto the plate; multiplying the
     scale and re-deriving the offset from the measured box keeps the mark
     centred whatever the source does. */
  const nextScale = Number(scale) * factor;
  const nextX = Number(x) * factor + (1000 - box.width * factor) / 2 - box.minX * factor;
  const nextY = Number(y) * factor + (1000 - box.height * factor) / 2 - box.minY * factor;

  return svg
    .replace(/<rect\b[^>]*\/>/, `<rect width="1000" height="1000" fill="${PLATE}"/>`)
    .replace(
      /translate\([-\d.]+ [-\d.]+\) scale\([\d.]+\)/,
      `translate(${nextX.toFixed(1)} ${nextY.toFixed(1)}) scale(${nextScale.toFixed(4)})`,
    );
}

async function render(svg, size, target) {
  await sharp(Buffer.from(svg), { density: 600 }).resize(size, size).png().toFile(target);
  console.log(`  ${path.relative(ROOT, target)}  ${size}x${size}`);
}

const svg = await readFile(SOURCE, 'utf8');
const box = await measureMark(svg);

const offCentreX = Math.abs((box.minX + box.maxX + 1) / 2 - 500);
const offCentreY = Math.abs((box.minY + box.maxY + 1) / 2 - 500);
if (offCentreX > 6 || offCentreY > 6) {
  console.error(
    `icon.svg is off centre by ${offCentreX.toFixed(0)}px horizontally and ` +
      `${offCentreY.toFixed(0)}px vertically. Adjust the translate() on the ` +
      `<g> before regenerating: the margins are left ${box.minX}, right ` +
      `${999 - box.maxX}, top ${box.minY}, bottom ${999 - box.maxY}.`,
  );
  process.exit(1);
}

console.log(`icon.svg: mark ${box.width}x${box.height}, centred.`);

await render(svg, 180, path.join(ROOT, 'apps/web/src/app/apple-icon.png'));
await render(svg, 192, path.join(ROOT, 'apps/web/public/icons/icon-192.png'));
await render(svg, 512, path.join(ROOT, 'apps/web/public/icons/icon-512.png'));
await render(
  toMaskable(svg, box),
  512,
  path.join(ROOT, 'apps/web/public/icons/icon-maskable-512.png'),
);
