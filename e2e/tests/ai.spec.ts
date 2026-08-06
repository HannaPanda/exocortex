import { expect, test } from '@playwright/test';

import { createPage, requireSeedCredentials, waitForCollaboration } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

// Reuse the session created by the global setup instead of logging in again:
// sign-in is rate limited by design.
test.use({ storageState: storageStatePath('johanna') });

/**
 * Which provider the deployment under test actually runs.
 *
 * The mock provider echoes the question back in a fixed German sentence, which
 * is a much stronger assertion than "some text arrived" — but it is only true
 * for a deployment configured with `AI_PROVIDER=mock`. Against a real provider
 * the answer is a real answer, so the echo assertions have to stand down while
 * everything provider-independent still runs.
 */
const aiProvider = process.env.AI_PROVIDER ?? 'mock';

test.beforeAll(() => {
  requireSeedCredentials();
});

test.describe('AI side panel', () => {
  test('streams a response through the realtime channel', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await createPage(page, `KI ${Date.now().toString(36)}`);

    await page.getByTestId('context-tab-ai').click();
    await page.getByTestId('ai-input').fill('Was ist Exocortex?');
    await page.getByTestId('ai-send').click();

    const answer = page.getByTestId('ai-answer').first();
    await expect(answer).toBeVisible({ timeout: 60_000 });
    // Text arrives at all: the run reached the worker, the provider and the
    // socket back into this browser.
    await expect
      .poll(async () => (await answer.innerText()).trim().length, { timeout: 60_000 })
      .toBeGreaterThan(0);

    if (aiProvider === 'mock') {
      // The mock provider echoes the question, which proves the payload arrived.
      await expect(answer).toContainText('Was ist Exocortex?', { timeout: 60_000 });
      await expect(answer).toContainText('Mock-Anbieters', { timeout: 60_000 });
    }

    // The answer grows over time: streaming, not a single response.
    const firstLength = (await answer.innerText()).length;
    await expect
      .poll(async () => (await answer.innerText()).length, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(firstLength);
  });

  test('shows background job progress while a page is materialized', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await createPage(page, `Fortschritt ${Date.now().toString(36)}`);
    // Without this the keystrokes below can land before the Yjs provider is
    // connected, in which case nothing is persisted and no job is ever enqueued.
    await waitForCollaboration(page);
    await page.getByTestId('editor-surface').click();
    await page.keyboard.type('Diese Änderung löst einen Hintergrundjob aus.');

    // `job.progress` / `job.completed` events reach the browser.
    await expect(page.getByTestId('job-progress')).toBeVisible({ timeout: 60_000 });
  });
});
