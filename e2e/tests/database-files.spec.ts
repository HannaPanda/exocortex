import { expect, type Locator, type Page, test } from '@playwright/test';

import { addRowAndClosePeek, createDatabase, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

// Reuse the session created by the global setup instead of logging in again:
// sign-in is rate limited by design.
test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/** A 1x1 PNG: the server reads the type from these bytes, not from the name. */
const PNG_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

async function addFilesProperty(page: Page, name: string): Promise<void> {
  await page.getByTestId('add-property').click();
  await page.getByPlaceholder('Name der Eigenschaft').fill(name);
  await page.getByTestId('property-type-select').click();
  await page.getByRole('option', { name: 'Dateien', exact: true }).click();
  await page.getByRole('button', { name: 'Hinzufügen', exact: true }).click();
  await expect(page.locator('th', { hasText: name })).toBeVisible({ timeout: 15_000 });
}

/** The few browser globals these tests touch; the e2e project compiles without the DOM lib. */
interface Browser {
  DataTransfer: new () => { items: { add: (file: unknown) => void } };
  File: new (parts: unknown[], name: string, init: { type: string }) => unknown;
  ClipboardEvent: new (type: string, init: Record<string, unknown>) => unknown;
}

interface BrowserElement {
  querySelector: (selector: string) => BrowserElement | null;
  dispatchEvent: (event: unknown) => boolean;
}

/** Drags a text file over `target` and drops it, the way a browser would. */
async function dropFile(target: Locator, name: string, content: string): Promise<void> {
  const transfer = await target.page().evaluateHandle(
    ({ fileName, text }) => {
      const browser = globalThis as unknown as Browser;
      const data = new browser.DataTransfer();
      data.items.add(new browser.File([text], fileName, { type: 'text/plain' }));
      return data;
    },
    { fileName: name, text: content },
  );
  await target.dispatchEvent('dragenter', { dataTransfer: transfer });
  await target.dispatchEvent('dragover', { dataTransfer: transfer });
  await expect(target).toHaveAttribute('data-drop-active', 'true');
  await expect(target).toContainText('Hier ablegen');
  await target.dispatchEvent('drop', { dataTransfer: transfer });
}

test.describe('files in a database cell (issue #245)', () => {
  test('uploads by picker, drop and paste, names the target, refuses a bad type and removes', async ({
    page,
  }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });

    await createDatabase(page, `Belege ${Date.now().toString(36)}`);
    await expect(page.getByTestId('add-property')).toBeVisible({ timeout: 15_000 });
    await addFilesProperty(page, 'Belege');
    await addRowAndClosePeek(page);
    const tableRow = page.locator('[data-testid^="database-row-"]').first();
    await expect(tableRow).toBeVisible({ timeout: 15_000 });

    // The empty cell says what it takes.
    const tableCell = tableRow.getByTestId('files-cell');
    await expect(tableCell.getByTestId('files-cell-add')).toHaveText('Datei hinzufügen');

    // Two files at once through the picker; both arrive.
    await tableCell.getByTestId('files-cell-input').setInputFiles([
      { name: 'beleg.txt', mimeType: 'text/plain', buffer: Buffer.from('Rechnung 42') },
      { name: 'pixel.png', mimeType: 'image/png', buffer: PNG_PIXEL },
    ]);
    await expect(tableCell.getByTestId('files-cell-file')).toHaveCount(2, { timeout: 20_000 });
    await expect(tableCell.getByTestId('files-cell-download').first()).toHaveAttribute(
      'href',
      /\/api\/attachments\/[a-z0-9]+\/download/,
    );

    // A type the server refuses is said at the cell, by name.
    await tableCell.getByTestId('files-cell-input').setInputFiles({
      name: 'programm.exe',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]),
    });
    await expect(tableCell.getByTestId('files-cell-error')).toContainText('programm.exe', {
      timeout: 20_000,
    });
    await expect(tableCell.getByTestId('files-cell-error')).toContainText('nicht unterstützt');

    // On the row's page the header holds the same cell.
    await tableRow.getByRole('link').first().click();
    const header = page.getByTestId('row-properties-header');
    await expect(header).toBeVisible({ timeout: 15_000 });
    const headerCell = header.getByTestId('files-cell');
    await expect(headerCell.getByTestId('files-cell-file')).toHaveCount(2, { timeout: 15_000 });

    // A drop on the cell goes into the cell and names it while dragging; the
    // page's text below stays without it.
    await dropFile(headerCell, 'abgelegt.txt', 'per Ziehen');
    await expect(headerCell.getByTestId('files-cell-file')).toHaveCount(3, { timeout: 20_000 });
    await expect(headerCell).toContainText('abgelegt.txt');
    await expect(page.getByTestId('editor-surface')).not.toContainText('abgelegt.txt');

    // A paste while the cell has focus goes into the cell too.
    await headerCell.getByTestId('files-cell-add').focus();
    await headerCell.evaluate((node) => {
      const browser = globalThis as unknown as Browser;
      const element = node as unknown as BrowserElement;
      const data = new browser.DataTransfer();
      data.items.add(
        new browser.File(['aus der Zwischenablage'], 'eingefuegt.txt', { type: 'text/plain' }),
      );
      const target = element.querySelector('[data-testid="files-cell-add"]') ?? element;
      target.dispatchEvent(
        new browser.ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(headerCell.getByTestId('files-cell-file')).toHaveCount(4, { timeout: 20_000 });

    // Removing takes it out of the cell.
    await headerCell
      .getByTestId('files-cell-file')
      .filter({ hasText: 'beleg.txt' })
      .getByTestId('files-cell-remove')
      .click();
    await expect(headerCell.getByTestId('files-cell-file')).toHaveCount(3, { timeout: 15_000 });
    await expect(headerCell).not.toContainText('beleg.txt');
  });
});
