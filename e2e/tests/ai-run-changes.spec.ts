import { expect, test } from '@playwright/test';

import { AI_TEST_TIMEOUT_MS, waitForAiRun } from '../support/ai-run';
import { createPage, requireSeedCredentials, waitForMaterialization } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * Issue #248, ADR-094: what the built-in AI changed is visible after the run
 * and can be taken back from the chat, without overwriting what somebody
 * typed into the page afterwards.
 *
 * The model is real, so nothing here depends on which tool it picks or how
 * many calls it takes: only on what the page says before and after.
 */
test.describe('AI run changes', () => {
  test('names the page it changed and takes back only what nobody touched since', async ({
    page,
  }) => {
    test.setTimeout(AI_TEST_TIMEOUT_MS);
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const title = `Lauf ${Date.now().toString(36)}`;
    const documentId = await createPage(page, title);

    const editor = page.locator('.ProseMirror').first();
    await editor.click();
    await page.keyboard.type('Erster Absatz mit Apfel.');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Zweiter Absatz bleibt.');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Dritter Absatz mit Pflaume.');
    await waitForMaterialization(page, documentId, 'Pflaume');

    await page.getByTestId('context-tab-ai').click();
    await page
      .getByTestId('ai-input')
      .fill(
        'Ersetze auf dieser Seite im ersten Absatz „Apfel“ durch „Kirsche“ und im dritten ' +
          'Absatz „Pflaume“ durch „Zwetschge“. Den zweiten Absatz nicht anfassen.',
      );
    await page.getByTestId('ai-send').click();
    await waitForAiRun(page, 'ai:run-changes');

    await expect(editor).toContainText('Kirsche', { timeout: 30_000 });
    await expect(editor).toContainText('Zwetschge');

    // The line under the answer names the page, by its title.
    const line = page.getByTestId('ai-run-changes');
    await expect(line).toBeVisible({ timeout: 30_000 });
    await expect(line.getByTestId('ai-run-changes-page')).toContainText(title);

    // Somebody changes the third paragraph after the run.
    await editor.getByText('Zwetschge').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Von Hand ergänzt.');
    await waitForMaterialization(page, documentId, 'Von Hand ergänzt');

    await line.getByTestId('ai-run-undo').click();
    const dialog = page.getByTestId('ai-run-revert-dialog');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.locator('[data-testid="ai-run-change"][data-state="changed_since"]'),
    ).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(
      dialog.locator('[data-testid="ai-run-change"][data-state="revertible"]'),
    ).not.toHaveCount(0);

    await dialog.getByTestId('ai-run-revert-confirm').click();
    await expect(dialog.getByTestId('ai-run-revert-result')).toBeVisible({ timeout: 30_000 });

    // What nobody touched is back; the hand-made change stands.
    await expect(editor).toContainText('Apfel', { timeout: 30_000 });
    await expect(editor).not.toContainText('Kirsche');
    await expect(editor).toContainText('Von Hand ergänzt');
    await expect(editor).toContainText('Zweiter Absatz bleibt.');
    await expect(dialog.getByTestId('ai-run-revert-confirm')).toHaveCount(0);
  });
});
