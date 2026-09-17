import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

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
    await expect
      .poll(
        () =>
          first
            .locator('canvas')
            .evaluate((canvas) => (canvas as HTMLCanvasElement).width)
            .catch(() => 0),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
  });
});
