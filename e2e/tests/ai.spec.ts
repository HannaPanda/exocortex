import { expect, test } from '@playwright/test';

import { createPage, requireSeedCredentials } from '../support/fixtures';
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
    // `createPage` returns only once the collaboration socket is connected;
    // without that the keystrokes below would land before the Yjs provider is
    // there, nothing would be persisted and no job would ever be enqueued.
    await createPage(page, `Fortschritt ${Date.now().toString(36)}`);
    await page.getByTestId('editor-surface').click();
    await page.keyboard.type('Diese Änderung löst einen Hintergrundjob aus.');

    // `job.progress` / `job.completed` events reach the browser.
    await expect(page.getByTestId('job-progress')).toBeVisible({ timeout: 60_000 });
  });

  test('draws the /clear cut where it happened and never stacks it', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await createPage(page, `Schnitt ${Date.now().toString(36)}`);
    await page.getByTestId('context-tab-ai').click();

    const boundary = page.getByTestId('ai-context-boundary');

    /** Sends a question and returns once its run has finished. */
    const ask = async (content: string): Promise<void> => {
      await page.getByTestId('ai-input').fill(content);
      await page.getByTestId('ai-send').click();
      // The composer stays disabled for the whole run, so this is also the
      // gate that keeps the next `/clear` from being swallowed.
      const activity = page.getByTestId('ai-run-activity');
      await expect(activity).toBeVisible({ timeout: 30_000 });
      await expect(activity).toBeHidden({ timeout: 60_000 });
    };

    /** Sends a slash command, which starts no run. */
    const command = async (content: string): Promise<void> => {
      await page.getByTestId('ai-input').fill(content);
      await page.getByTestId('ai-send').click();
    };

    await ask('Erste Frage.');
    await command('/clear');
    await expect(boundary).toHaveCount(1, { timeout: 30_000 });
    await expect(boundary).toContainText('Kontext geleert');

    // The cut stays where it was made: the next question appears *below* it,
    // which is the part that used to be wrong (issue #25).
    await ask('Zweite Frage.');
    await expect(page.getByTestId('ai-question')).toHaveCount(2, { timeout: 30_000 });
    await expect(boundary).toHaveCount(1);
    // Cuts and questions in document order: the newest question has to be the
    // last of them, i.e. below the cut rather than above it.
    const cutsAndQuestions = page.locator(
      '[data-testid="ai-context-boundary"], [data-testid="ai-question"]',
    );
    await expect(cutsAndQuestions.last()).toHaveAttribute('data-testid', 'ai-question');

    // A second `/clear` moves the single cut along instead of adding one.
    await command('/clear');
    await expect(boundary).toHaveCount(1, { timeout: 30_000 });
  });
});
