import { expect, test } from '@playwright/test';

import { createPage, requireSeedCredentials, waitForMaterialization } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

// Reuse the session created by the global setup instead of logging in again:
// sign-in is rate limited by design.
test.use({ storageState: storageStatePath('johanna') });

/**
 * What the runner *declared* the deployment's provider to be, if anything.
 *
 * `AI_PROVIDER` is read by the worker, out of the server's `.env`. The
 * Playwright process does not load that file, so this used to default to
 * `'mock'` and then assert the mock's echo against a deployment happily
 * running OpenRouter: a green pipeline's worth of nothing, and a red test for
 * an answer that was entirely correct.
 *
 * Absent now means "read it off the answer" instead of guessing, and a
 * declared `mock` is enforced rather than assumed.
 */
const declaredProvider = process.env.AI_PROVIDER ?? null;

/** The mock names itself in every answer it writes; no real provider does. */
const MOCK_MARKER = 'Mock-Anbieters';

test.beforeAll(() => {
  requireSeedCredentials();
});

test.describe('AI side panel', () => {
  test('streams a response through the realtime channel', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await createPage(page, `KI ${Date.now().toString(36)}`);

    await page.getByTestId('context-tab-ai').click();
    await page.getByTestId('ai-input').fill('Was ist eXocortex?');
    await page.getByTestId('ai-send').click();

    const answer = page.getByTestId('ai-answer').first();
    await expect(answer).toBeVisible({ timeout: 60_000 });
    // Text arrives at all: the run reached the worker, the provider and the
    // socket back into this browser.
    await expect
      .poll(async () => (await answer.innerText()).trim().length, { timeout: 60_000 })
      .toBeGreaterThan(0);

    // The visible text only ever grows while the run is live: a re-render that
    // fell back to an earlier buffer would show up here. It cannot demand
    // strict growth, because a short answer may already be complete when it is
    // first read.
    const firstLength = (await answer.innerText()).length;
    await expect
      .poll(async () => (await answer.innerText()).length, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(firstLength);

    // Judge who answered only once the run is over, so a marker that has
    // merely not streamed in yet is never read as "a real provider".
    await expect(page.getByTestId('ai-run-activity')).toBeHidden({ timeout: 60_000 });
    const servedByMock =
      declaredProvider === 'mock' ||
      (declaredProvider === null && (await answer.innerText()).includes(MOCK_MARKER));

    if (servedByMock) {
      // The mock echoes the question back, which proves the payload reached it
      // intact. A declared mock that stops echoing fails here rather than
      // quietly dropping to the weaker assertions above.
      await expect(answer).toContainText('Was ist eXocortex?', { timeout: 60_000 });
      await expect(answer).toContainText(MOCK_MARKER, { timeout: 60_000 });
    }
  });

  test('keeps quiet while a fast background job is materialized', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    // `createPage` returns only once the collaboration socket is connected;
    // without that the keystrokes below would land before the Yjs provider is
    // there, nothing would be persisted and no job would ever be enqueued.
    const documentId = await createPage(page, `Fortschritt ${Date.now().toString(36)}`);
    const marker = `hintergrundjob${Date.now().toString(36)}`;
    await page.getByTestId('editor-surface').click();
    await page.keyboard.type(`Diese Änderung löst einen Hintergrundjob aus: ${marker}.`);

    // The indicator is deliberately silent for a job that succeeds quickly:
    // `job-progress.tsx` waits `SHOW_DELAY_MS` (1s) before revealing anything
    // and cancels that reveal on `job.completed`, so a materialization that
    // takes tens of milliseconds must never flash a card. This used to assert
    // the opposite and had been failing ever since that rule was introduced.
    //
    // A window several times the reveal delay: if the card were coming, it
    // would be here.
    const appeared = await page
      .waitForSelector('[data-testid="job-progress"]', { state: 'attached', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    expect(appeared).toBe(false);

    // Without this the assertion above would also pass for a pipeline that did
    // nothing at all. The derived Markdown is the job's own output, so it
    // proves the job really ran and really finished.
    await waitForMaterialization(page, documentId, marker);
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
