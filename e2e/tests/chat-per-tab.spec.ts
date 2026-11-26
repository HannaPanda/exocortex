import { expect, type Page, test } from '@playwright/test';

import { createPage, requireSeedCredentials, workspaceIdFrom } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

/**
 * One chat per browser tab and per page (issue #231).
 *
 * Two tabs of one browser share `localStorage` and nothing else, which is
 * exactly the situation the issue describes: choosing a chat in one tab used
 * to switch the other along. The conversations are created through the API
 * without a single message, so no model is asked and nothing has to be paid
 * for; they are deleted again at the end, and the pages go with the run's
 * cleanup.
 */
test.beforeAll(() => {
  requireSeedCredentials();
});

async function choose(page: Page, title: string): Promise<void> {
  await page.getByTestId('ai-conversation-switcher').click();
  await page.getByRole('menuitem').filter({ hasText: title }).first().click();
  await expect(page.getByTestId('ai-conversation-switcher')).toContainText(title);
}

async function openPanel(page: Page): Promise<void> {
  await page.getByTestId('context-tab-ai').click();
  await expect(page.getByTestId('ai-conversation-switcher')).toBeVisible({ timeout: 30_000 });
}

test('keeps a chat chosen in one tab out of the other, and each page keeps its own', async ({
  page,
  baseURL,
}) => {
  const origin = baseURL as string;
  const suffix = Date.now().toString(36);

  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  const pageA = await createPage(page, `Chat je Tab A ${suffix}`);
  const workspaceId = workspaceIdFrom(page);
  const urlA = page.url();

  const titles = { first: `Tabchat eins ${suffix}`, second: `Tabchat zwei ${suffix}` };
  const ids: string[] = [];
  for (const title of [titles.first, titles.second]) {
    const created = await page.request.post('/api/ai/conversations', {
      data: { workspaceId, documentId: pageA, title },
      headers: { origin },
    });
    expect(created.ok(), await created.text()).toBe(true);
    ids.push(((await created.json()) as { conversation: { id: string } }).conversation.id);
  }

  try {
    await openPanel(page);
    await choose(page, titles.first);

    // A second tab of the same browser starts from the latest choice ...
    const other = await page.context().newPage();
    await other.goto(urlA);
    await openPanel(other);
    await expect(other.getByTestId('ai-conversation-switcher')).toContainText(titles.first);

    // ... and goes its own way from then on.
    await choose(other, titles.second);
    await page.bringToFront();
    await expect(page.getByTestId('ai-conversation-switcher')).toContainText(titles.first);
    await page.reload();
    await openPanel(page);
    await expect(page.getByTestId('ai-conversation-switcher')).toContainText(titles.first);
    await other.reload();
    await openPanel(other);
    await expect(other.getByTestId('ai-conversation-switcher')).toContainText(titles.second);

    // Inside one tab the chat walks along to a page that has none yet, and a
    // page that had one gets it back.
    await createPage(other, `Chat je Tab B ${suffix}`);
    await openPanel(other);
    await expect(other.getByTestId('ai-conversation-switcher')).toContainText(titles.second);
    await choose(other, titles.first);
    await other.goto(urlA);
    await openPanel(other);
    await expect(other.getByTestId('ai-conversation-switcher')).toContainText(titles.second);
    await other.goBack();
    await openPanel(other);
    await expect(other.getByTestId('ai-conversation-switcher')).toContainText(titles.first);
    await other.close();
  } finally {
    for (const id of ids) {
      await page.request.delete(`/api/ai/conversations/${id}/permanent`, { headers: { origin } });
    }
  }
});
