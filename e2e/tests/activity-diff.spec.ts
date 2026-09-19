import { expect, type Page, test } from '@playwright/test';

import { createPage, presetPanelPreference, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/** Stable block identifiers, so a write can be recognized across two states. */
const CHANGED = 'e2eaaaaaaaa1';
const REMOVED = 'e2ebbbbbbbb1';
const MOVED = 'e2eccccccccc';
const ADDED = 'e2eddddddddd';

/**
 * Der Vergleich zweier Stände einer Seite und das Zurückholen einzelner Blöcke
 * (Issue #77), plus die Zeile, an der beides hängt.
 *
 * Die Aktivitätsliste ist bis auf 260 Pixel schmal ziehbar. Genau dort ist sie
 * einmal zerbrochen: zwei beschriftete Knöpfe pro Zeile ließen dem Text rund
 * sechzig Pixel. Deshalb setzt diese Suite die Panelbreite auf das Minimum,
 * bevor sie irgendetwas anderes prüft, statt in der bequemen Standardbreite zu
 * testen, in der der Fehler nicht zu sehen war.
 */
test.describe('activity diff', () => {
  /** Opens the workspace with the context panel pinned to its narrowest width. */
  async function openNarrow(page: Page): Promise<void> {
    await presetPanelPreference(page, 'exocortex.context', { open: true, width: 260 });
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  }

  async function writeContent(page: Page, documentId: string, markdown: string): Promise<void> {
    const response = await page.request.post(`/api/documents/${documentId}/content`, {
      data: { markdown, mode: 'replace' },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }

  /** Takes a manual snapshot, which is the one the list shows as "Manuell gesichert". */
  async function takeSnapshot(page: Page, documentId: string): Promise<void> {
    const response = await page.request.post(`/api/documents/${documentId}/snapshots`, {
      data: { reason: 'manual' },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }

  async function markdownOf(page: Page, documentId: string): Promise<string> {
    const response = await page.request.get(`/api/documents/${documentId}/export/markdown`);
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { markdown: string }).markdown;
  }

  /**
   * A page with one manual snapshot behind it and four kinds of change since:
   * a changed block, a removed one, an added one and a moved one.
   */
  async function pageWithHistory(page: Page): Promise<string> {
    const documentId = await createPage(page, `Vergleich ${Date.now().toString(36)}`);
    await writeContent(
      page,
      documentId,
      `Der Hund bellt ^${CHANGED}\n\nZweiter Absatz ^${REMOVED}\n\nDritter Absatz ^${MOVED}`,
    );
    await takeSnapshot(page, documentId);
    await writeContent(
      page,
      documentId,
      `Dritter Absatz ^${MOVED}\n\nDer Kater bellt ^${CHANGED}\n\nVierter Absatz ^${ADDED}`,
    );
    await page.reload();
    await page.getByTestId('context-tab-activity').click();
    await expect(page.getByTestId('activity-panel')).toBeVisible({ timeout: 15_000 });
    return documentId;
  }

  /** The row of the manual snapshot, the one this suite acts on. */
  function snapshotRow(page: Page) {
    return page
      .getByTestId('activity-panel')
      .getByTestId('activity-entry-open')
      .filter({ hasText: 'Manuell gesichert' })
      .first();
  }

  /** Opens the comparison and waits for the answer to be on screen. */
  async function openDiff(page: Page) {
    await snapshotRow(page).click();
    const dialog = page.getByTestId('snapshot-diff-dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByTestId('diff-summary')).toBeVisible({ timeout: 15_000 });
    return dialog;
  }

  test('a snapshot row stays usable at the panel’s narrowest width', async ({ page }) => {
    await openNarrow(page);
    await pageWithHistory(page);

    // The day heading carries the date, so the rows do not have to.
    await expect(page.getByTestId('activity-panel').getByText('Heute').first()).toBeVisible();

    const row = snapshotRow(page);
    await expect(row).toBeVisible();
    const menu = page.getByTestId('activity-entry-menu').first();
    await expect(menu).toBeVisible();

    /*
     * The regression this suite exists for: the actions must not eat the row.
     * At 260 pixels the text column has to keep the clear majority of the
     * width, and nothing may spill past the panel's right edge.
     */
    const panelBox = await page.getByTestId('context-panel').boundingBox();
    const rowBox = await row.boundingBox();
    const menuBox = await menu.boundingBox();
    if (panelBox === null || rowBox === null || menuBox === null) {
      throw new Error('The panel, the row and its menu all have to be laid out by now');
    }

    expect(rowBox.width).toBeGreaterThan(panelBox.width * 0.6);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
  });

  test('comparing a snapshot names what was added, removed, changed and moved', async ({
    page,
  }) => {
    await openNarrow(page);
    await pageWithHistory(page);
    const dialog = await openDiff(page);

    await expect(dialog.getByTestId('diff-summary')).toHaveText(
      '1 neu, 1 entfernt, 1 geändert, 1 verschoben',
    );

    // The word diff, not just the block: the old word and the new one stand
    // beside each other, each marked with its direction.
    await expect(dialog.locator('[data-segment="removed"]')).toHaveText('Hund');
    await expect(dialog.locator('[data-segment="inserted"]')).toHaveText('Kater');

    await expect(dialog.locator(`[data-block-id="${REMOVED}"]`)).toHaveAttribute(
      'data-block-kind',
      'removed',
    );
    await expect(dialog.locator(`[data-block-id="${REMOVED}"]`)).toContainText('Zweiter Absatz');
    await expect(dialog.locator(`[data-block-id="${ADDED}"]`)).toHaveAttribute(
      'data-block-kind',
      'added',
    );
    // A moved block is reported as moved, not as a deletion plus an insertion.
    await expect(dialog.locator(`[data-block-id="${MOVED}"]`)).toContainText('verschoben');
  });

  test('a single block goes back without touching the rest of the page', async ({ page }) => {
    await openNarrow(page);
    const documentId = await pageWithHistory(page);
    const dialog = await openDiff(page);

    await dialog.locator(`[data-block-id="${REMOVED}"]`).getByTestId('diff-block-checkbox').click();

    const restore = dialog.getByTestId('diff-restore-blocks');
    await expect(restore).toHaveText('1 Block zurückholen');
    await restore.click();
    // Taking a block back overwrites content, so it asks once before it writes.
    await expect(restore).toHaveText('Wirklich zurückholen?');
    await restore.click();

    await expect
      .poll(async () => markdownOf(page, documentId), { timeout: 30_000, intervals: [500] })
      .toContain('Zweiter Absatz');

    const markdown = await markdownOf(page, documentId);
    // Everything written after the snapshot survives the partial restore, and
    // the block that was not ticked keeps its newer version.
    expect(markdown).toContain('Vierter Absatz');
    expect(markdown).toContain('Der Kater bellt');
    expect(markdown).not.toContain('Der Hund bellt');
  });

  test('both actions live in the row’s menu rather than in the row', async ({ page }) => {
    await openNarrow(page);
    await pageWithHistory(page);

    await page.getByTestId('activity-entry-menu').first().click();
    await expect(page.getByTestId('activity-compare-item')).toBeVisible();
    await expect(page.getByTestId('activity-restore-item')).toBeVisible();

    await page.getByTestId('activity-compare-item').click();
    await expect(page.getByTestId('snapshot-diff-dialog')).toBeVisible({ timeout: 15_000 });
  });
});
