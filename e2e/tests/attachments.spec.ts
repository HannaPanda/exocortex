import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, type Locator, type Page, test } from '@playwright/test';

import { createPage, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * A one-page PDF carrying all five `/Info` entries, written by hand so the
 * fixture *is* the assertion: the trailer points `/Info` at object 6, whose
 * Title, Author and CreationDate are the values expected in the block below.
 *
 * Small enough to live here rather than as a checked-in binary, and it needs no
 * OCR, so the test does not depend on how fast the Docling container is.
 */
const PDF_WITH_INFO_DICTIONARY = Buffer.from(
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoK' +
    'PDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUg' +
    'L1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8' +
    'IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1MSA+' +
    'PgpzdHJlYW0KQlQgL0YxIDEyIFRmIDIwIDEwMCBUZCAoSGFsbG8gTWV0YWRhdGVuIFRlc3QpIFRqIEVUCmVuZHN0' +
    'cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2' +
    'ZXRpY2EgPj4KZW5kb2JqCjYgMCBvYmoKPDwgL1RpdGxlIChRdWFydGFsc2JlcmljaHQgUTMpIC9BdXRob3IgKEpv' +
    'aGFubmEgUGFuZGEpIC9DcmVhdG9yIChIYW5kbWFkZSkgL1Byb2R1Y2VyIChUZXN0ZmFsbCkgL0NyZWF0aW9uRGF0' +
    'ZSAoRDoyMDI2MDQwMTEyMDAwMFopID4+CmVuZG9iagp4cmVmCjAgNwowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAw' +
    'MDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEg' +
    'MDAwMDAgbiAKMDAwMDAwMDM0MiAwMDAwMCBuIAowMDAwMDAwNDEyIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUg' +
    'NyAvUm9vdCAxIDAgUiAvSW5mbyA2IDAgUiA+PgpzdGFydHhyZWYKNTYwCiUlRU9GCg==',
  'base64',
);

/**
 * That an uploaded PDF describes itself in the page.
 *
 * The extraction chain and the merge are covered by unit and integration tests;
 * what only a browser can prove is that the facts arrive where a reader is, and
 * that they arrive *after* a background job finishes without the reader having
 * to reload. The block polls for that, which is the part under test here.
 */
test.describe('PDF block metadata', () => {
  test('shows what the uploaded document turned out to be', async ({ page }) => {
    const path = join(mkdtempSync(join(tmpdir(), 'exo-pdf-')), 'quartalsbericht.pdf');
    writeFileSync(path, PDF_WITH_INFO_DICTIONARY);

    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await createPage(page, `PDF ${Date.now().toString(36)}`);
    await expect(page.getByTestId('editor-surface')).toBeVisible();
    await page.getByTestId('editor-surface').click();

    await page.keyboard.type('/pdf');
    await expect(page.getByTestId('slash-option-pdf')).toBeVisible();
    await page.getByTestId('slash-option-pdf').click();
    // The option opens the hidden input the picker is wired to.
    await page.setInputFiles('[data-testid="block-file-input"]', path);

    const details = page.locator('.exocortex-media-meta');
    await expect(details).toBeVisible({ timeout: 60_000 });

    // Title, author and creation date come from the file's own dictionary,
    // read locally; the page count is confirmed by the engine. None of it
    // required the paid extractor.
    await expect(details).toContainText('Quartalsbericht Q3', { timeout: 60_000 });
    await expect(details).toContainText('Johanna Panda');
    await expect(details).toContainText('1 Seite');
    await expect(details).toContainText('01.04.2026');

    // And that the document itself is on the page (issue #70). This block used
    // to embed an `<object>`, which the application's own `object-src 'none'`
    // refused on every load, silently, falling back to the download link inside
    // it. A visible slot is not enough to catch that again -- the canvas has to
    // have been drawn into.
    const first = page.locator('.exocortex-pdf-viewport [data-testid="pdf-page"]').first();
    await expect(first).toBeVisible({ timeout: 60_000 });
    // `width` is a reflected attribute, so the drawn size is readable from the
    // outside without a DOM lib in this package's tsconfig.
    await expect
      .poll(async () => Number((await first.locator('canvas').getAttribute('width')) ?? 0), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
  });
});

/** A new page holding the PDF above, and the first drawn page of its viewer. */
async function pageWithPdf(page: Page): Promise<Locator> {
  const path = join(mkdtempSync(join(tmpdir(), 'exo-pdf-')), 'breite.pdf');
  writeFileSync(path, PDF_WITH_INFO_DICTIONARY);

  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  await createPage(page, `PDF-Breite ${Date.now().toString(36)}`);
  await expect(page.getByTestId('editor-surface')).toBeVisible();
  await page.getByTestId('editor-surface').click();
  await page.keyboard.type('/pdf');
  await expect(page.getByTestId('slash-option-pdf')).toBeVisible();
  await page.getByTestId('slash-option-pdf').click();
  await page.setInputFiles('[data-testid="block-file-input"]', path);

  const first = page.locator('.exocortex-pdf-viewport [data-testid="pdf-page"]').first();
  await expect(first).toBeVisible({ timeout: 60_000 });
  return first;
}

/** The drawn page's width, the width it has to fit into, and the bitmap's width. */
async function measure(first: Locator) {
  return first.evaluate((element) => {
    const scroller = element.closest('[data-testid="pdf-scroll"]');
    const canvas = element.querySelector('canvas');
    return {
      page: element.getBoundingClientRect().width,
      room: scroller?.clientWidth ?? 0,
      bitmap:
        (canvas?.width ?? 0) /
        (globalThis as unknown as { devicePixelRatio: number }).devicePixelRatio,
    };
  });
}

/**
 * That a PDF follows the width it is given (issue #241).
 *
 * The viewer measured its column once, before the pages were known, and the
 * measurement never arrived: every PDF was drawn at its own size, 200 points
 * here, in a box that grew and shrank with the page around it. So this asserts
 * the drawn page against the room it has, after every change of that room --
 * the page width, and a window as narrow as a phone.
 */
test.describe('PDF block width', () => {
  test('fits its pages to the page width, and again after it changes', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const first = await pageWithPdf(page);

    // Fitted means as wide as the column less its padding, never the file's
    // own 200 points; the bitmap is redrawn for that width, not stretched.
    await expect
      .poll(async () => {
        const { page: width, room } = await measure(first);
        return room - width;
      })
      .toBeLessThan(40);
    await expect.poll(async () => (await measure(first)).page).toBeGreaterThan(300);
    const narrow = await measure(first);

    await page.getByTestId('document-actions').click();
    await page.getByTestId('open-page-properties').click();
    await page.getByTestId('layout-wide').click();
    await page.getByTestId('save-page-properties').click();
    await expect(page.locator('.exocortex-page')).toHaveAttribute('data-layout', 'wide', {
      timeout: 15_000,
    });

    await expect.poll(async () => (await measure(first)).page).toBeGreaterThan(narrow.page + 100);
    await expect
      .poll(async () => {
        const { page: width, room, bitmap } = await measure(first);
        return room - width >= 0 && room - width < 40 && Math.abs(bitmap - width) <= 2;
      })
      .toBe(true);

    // A phone: the page shrinks with the column and nothing is cut off.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(async () => {
        const { page: width, room, bitmap } = await measure(first);
        return width > 0 && width <= room && Math.abs(bitmap - width) <= 2;
      })
      .toBe(true);
  });
});
