import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

import { expect, test } from '@playwright/test';

import { createPage, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * A plain PNG of the given size, written here rather than checked in. Two
 * colours in halves, so a screenshot of a failure still shows which way up it
 * was; the content does not matter to the assertions, only the size.
 */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // truecolour
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    const [r, g, b] = y < height / 2 ? [40, 110, 160] : [220, 170, 60];
    for (let x = 0; x < width; x += 1) row.set([r, g, b], 1 + x * 3);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * That an embedded image opens larger (issue #134): in a page being written,
 * a second click on the selected image opens it, a double click does too, the
 * buttons zoom and fit, and the close button and Escape both close and hand
 * focus back to the page.
 */
test.describe('image lightbox', () => {
  test('opens an embedded image, zooms it and closes again', async ({ page }) => {
    const path = join(mkdtempSync(join(tmpdir(), 'exo-image-')), 'diagramm.png');
    writeFileSync(path, png(1600, 1000));

    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await createPage(page, `Bild ${Date.now().toString(36)}`);
    const surface = page.getByTestId('editor-surface');
    await expect(surface).toBeVisible();
    await surface.click();
    // A paragraph above the image, so the cursor has somewhere to go.
    await page.keyboard.type('Oben');
    await page.keyboard.press('Enter');

    await page.keyboard.type('/bild');
    await expect(page.getByTestId('slash-option-image')).toBeVisible();
    await page.getByTestId('slash-option-image').click();
    await page.setInputFiles('[data-testid="block-file-input"]', path);

    const embedded = surface.locator('img[data-zoomable]');
    await expect(embedded).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => embedded.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);

    const lightbox = page.getByTestId('image-lightbox');
    const shown = page.getByTestId('image-lightbox-image');

    // Inserting leaves the new image selected; move the cursor off it first,
    // so the next click is a first click on an unselected image.
    await surface.focus();
    await page.keyboard.press('ArrowUp');
    await expect(embedded).not.toHaveClass(/ProseMirror-selectednode/);

    // The first click selects the image, as it always did; it opens nothing.
    await embedded.click();
    await expect(embedded).toHaveClass(/ProseMirror-selectednode/);
    await expect(lightbox).toBeHidden();

    // The second click on the selected image opens it.
    await embedded.click();
    await expect(lightbox).toBeVisible();
    await expect(shown).toBeVisible();
    await expect(page.getByTestId('image-lightbox-zoom-level')).not.toHaveText('');

    // It starts fitted: the whole picture inside the viewport.
    const viewport = page.viewportSize();
    const fitted = await shown.boundingBox();
    expect(fitted).not.toBeNull();
    if (fitted !== null && viewport !== null) {
      expect(fitted.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(fitted.height).toBeLessThanOrEqual(viewport.height + 1);
    }
    const fitScale = Number(await shown.getAttribute('data-scale'));

    // Zooming in makes it larger than the fit, and larger on screen.
    await page.getByTestId('image-lightbox-zoom-in').click();
    await page.getByTestId('image-lightbox-zoom-in').click();
    await expect
      .poll(async () => Number(await shown.getAttribute('data-scale')))
      .toBeGreaterThan(fitScale * 2);
    await expect
      .poll(async () => (await shown.boundingBox())?.width ?? 0)
      .toBeGreaterThan((fitted?.width ?? 0) * 1.5);

    // The keyboard zooms too, and `Fit` goes back to where it started.
    await page.keyboard.press('-');
    await page.getByTestId('image-lightbox-fit').click();
    await expect
      .poll(async () => Number(await shown.getAttribute('data-scale')))
      .toBeCloseTo(fitScale, 3);

    // The close button closes.
    await page.getByTestId('image-lightbox-close').click();
    await expect(lightbox).toBeHidden();

    // A double click opens it again, and Escape closes it.
    await embedded.dblclick();
    await expect(lightbox).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(lightbox).toBeHidden();

    // And the page kept its content: the lightbox changed nothing in it.
    await expect(surface.locator('img[data-zoomable]')).toHaveCount(1);
  });
});
