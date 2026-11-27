import { expect, type Page, test } from '@playwright/test';

import { requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

/**
 * A chat begun on a workspace's start page, without a page (issue #288).
 *
 * The question is `/help`, which the API answers itself: a new conversation
 * is created and written to like any other, and no model is asked, so the
 * test costs nothing and waits for no provider. The conversation is deleted
 * again however the test ended.
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

/** Types `/help` into the start page's field and returns the conversation it began. */
async function startFromHome(page: Page): Promise<{ id: string; documentId: string | null }> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+$/, { timeout: 60_000 });
  const field = page.getByTestId('chat-start-input');
  await expect(field).toBeVisible({ timeout: 30_000 });

  const createdConversation = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/ai/conversations',
  );
  await field.fill('/help');
  // The command hint opens on a leading slash; Escape closes it so Enter sends.
  await field.press('Escape');
  await field.press('Enter');
  const response = await createdConversation;
  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as {
    conversation: { id: string; documentId: string | null };
  };
  created.push(body.conversation.id);
  return body.conversation;
}

test('begins a chat without a page from the start page and gives it the screen', async ({
  page,
}) => {
  const conversation = await startFromHome(page);
  expect(conversation.documentId).toBeNull();

  const panel = page.getByTestId('ai-panel');
  await expect(panel).toHaveAttribute('data-expanded', 'true');
  // The command's answer stands in the new chat.
  await expect(page.getByTestId('ai-transcript')).toContainText('/clear', { timeout: 30_000 });
  // The start page is folded away, not gone.
  await expect(page.locator('#exocortex-main')).toBeHidden();
  await expect(page.locator('#exocortex-main')).toBeAttached();

  // The same button gives the start page back, the chat beside it.
  await page.getByTestId('ai-expand').click();
  await expect(panel).toHaveAttribute('data-expanded', 'false');
  await expect(page.getByTestId('chat-starter')).toBeVisible();
  await expect(page.getByTestId('ai-transcript')).toContainText('/clear');
});

test('shows the answer to /help as a list, one command per item (issue #300)', async ({ page }) => {
  await startFromHome(page);
  const answer = page.getByTestId('ai-command-answer');
  await expect(answer).toBeVisible({ timeout: 30_000 });
  const items = answer.getByRole('listitem');
  expect(await items.count()).toBeGreaterThan(5);
  // The name is set apart from its description, not run into it.
  await expect(answer.locator('li code').filter({ hasText: /^\/help$/u })).toHaveCount(1);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('opens the chat across the whole width', async ({ page }) => {
    await startFromHome(page);
    const sheet = page.getByTestId('context-panel');
    await expect(page.getByTestId('ai-panel')).toHaveAttribute('data-expanded', 'true');
    await expect(page.getByTestId('ai-transcript')).toContainText('/clear', { timeout: 30_000 });
    const box = await sheet.boundingBox();
    expect(box?.width).toBe(390);

    // The sheet's close button does not cover the panel's own controls.
    await page.getByTestId('ai-panel-menu').click();
    await expect(page.getByTestId('ai-stay-at-answer-start')).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
