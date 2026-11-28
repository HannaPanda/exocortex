import { expect, type Page, test } from '@playwright/test';

import { AI_RUN_FINISH_TIMEOUT_MS, AI_TEST_TIMEOUT_MS } from '../support/ai-run';
import { createPage, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

/**
 * The cursor stays in the chat's field after a message is sent (issue #301),
 * so the next question can be typed straight away: after Enter and after the
 * send button, in the panel and from the start page, and while the answer is
 * still being written.
 *
 * Most of it sends `/help`, which the API answers itself and no model is
 * asked for; one test waits for one real run, because "while the answer is
 * running" needs a run. Every conversation is deleted for good afterwards.
 */
test.beforeAll(() => {
  requireSeedCredentials();
});

const created: string[] = [];

test.afterEach(async ({ request, baseURL }) => {
  for (const id of created.splice(0)) {
    await request.delete(`/api/ai/conversations/${id}/permanent`, {
      headers: { origin: baseURL as string },
    });
  }
});

/** Remembers every conversation the page creates, so `afterEach` can delete it. */
function recordConversations(page: Page): void {
  page.on('response', (response) => {
    if (response.request().method() !== 'POST') return;
    if (new URL(response.url()).pathname !== '/api/ai/conversations') return;
    void response
      .json()
      .then((body: { conversation?: { id: string } }) => {
        if (body.conversation !== undefined) created.push(body.conversation.id);
      })
      .catch(() => undefined);
  });
}

/** The answer to a message posted into a conversation, whichever conversation it is. */
function messagePosted(page: Page): Promise<unknown> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /^\/api\/ai\/conversations\/[^/]+\/messages$/u.test(new URL(response.url()).pathname),
  );
}

/**
 * Types `/help` with a space after it, which opens no command hint, so Enter
 * sends instead of choosing. (Escape closes the hint too, and since #269 only
 * the hint, also in the sheet the chat sits in on a phone.)
 */
async function typeHelp(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).fill('/help ');
}

async function openPanelOnNewPage(page: Page, title: string): Promise<void> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  await createPage(page, `${title} ${Date.now().toString(36)}`);
  await page.getByTestId('context-tab-ai').click();
  await expect(page.getByTestId('ai-input')).toBeVisible({ timeout: 30_000 });
}

test('keeps the cursor in the panel after Enter and after the send button', async ({ page }) => {
  recordConversations(page);
  await openPanelOnNewPage(page, 'Fokus');
  const field = page.getByTestId('ai-input');

  // Enter.
  await typeHelp(page, 'ai-input');
  let posted = messagePosted(page);
  await field.press('Enter');
  await posted;
  await expect(page.getByTestId('ai-command-answer')).toBeVisible({ timeout: 30_000 });
  await expect(field).toBeFocused();
  await page.keyboard.type('weiter');
  await expect(field).toHaveValue('weiter');

  // The button, clicked with the mouse.
  await typeHelp(page, 'ai-input');
  posted = messagePosted(page);
  await page.getByTestId('ai-send').click();
  await posted;
  await expect(field).toBeFocused();
  await page.keyboard.type('noch eine Frage');
  await expect(field).toHaveValue('noch eine Frage');
});

test('hands the cursor to the chat when a question starts on the start page', async ({ page }) => {
  recordConversations(page);
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+$/, { timeout: 60_000 });
  await expect(page.getByTestId('chat-start-input')).toBeVisible({ timeout: 30_000 });

  await typeHelp(page, 'chat-start-input');
  const posted = messagePosted(page);
  await page.getByTestId('chat-start-input').press('Enter');
  await posted;
  await expect(page.getByTestId('ai-panel')).toHaveAttribute('data-expanded', 'true');
  const field = page.getByTestId('ai-input');
  await expect(field).toBeFocused();
  await page.keyboard.type('weiter');
  await expect(field).toHaveValue('weiter');
});

test('lets the next question be typed while the answer is still running', async ({ page }) => {
  // Waits for one real provider call.
  test.setTimeout(AI_TEST_TIMEOUT_MS);
  recordConversations(page);
  await openPanelOnNewPage(page, 'Fokus-Lauf');
  const field = page.getByTestId('ai-input');
  const send = page.getByTestId('ai-send');

  await field.fill('Zähle langsam von eins bis zwanzig, jede Zahl in einer eigenen Zeile.');
  await field.press('Enter');
  const activity = page.getByTestId('ai-run-activity');
  await expect(activity).toBeVisible({ timeout: 60_000 });
  await expect(field).toBeFocused();
  await page.keyboard.type('Und rückwärts?');
  await expect(field).toHaveValue('Und rückwärts?');
  // The message waits for the answer: Enter keeps it in the field.
  await field.press('Enter');
  await expect(field).toHaveValue('Und rückwärts?');
  await expect(send).toBeDisabled();

  await expect(activity).toBeHidden({ timeout: AI_RUN_FINISH_TIMEOUT_MS });
  await expect(send).toBeEnabled();
  await expect(field).toHaveValue('Und rückwärts?');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('lets the keyboard go when the send button is tapped', async ({ page }) => {
    recordConversations(page);
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+$/, { timeout: 60_000 });
    await expect(page.getByTestId('chat-start-input')).toBeVisible({ timeout: 30_000 });
    await typeHelp(page, 'chat-start-input');
    let posted = messagePosted(page);
    await page.getByTestId('chat-start-send').tap();
    await posted;
    await expect(page.getByTestId('ai-panel')).toHaveAttribute('data-expanded', 'true');
    const field = page.getByTestId('ai-input');
    await expect(field).not.toBeFocused();

    // In the chat itself, the same: a tap on send gives the answer the screen.
    await field.tap();
    await typeHelp(page, 'ai-input');
    posted = messagePosted(page);
    await page.getByTestId('ai-send').tap();
    await posted;
    await expect(page.getByTestId('ai-command-answer')).toBeVisible({ timeout: 30_000 });
    await expect(field).not.toBeFocused();
  });
});
