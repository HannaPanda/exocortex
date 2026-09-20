import { expect, test } from '@playwright/test';

import { AI_TEST_TIMEOUT_MS, waitForAiRun } from '../support/ai-run';
import { createPage, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

/**
 * Finding a chat again (issue #69).
 *
 * The loop the issue promises, end to end and in one test on purpose: a chat
 * written in the panel, found in `/chats` by a word out of its transcript
 * rather than its title, read there, continued in the panel, archived, and
 * finally deleted for good. Split into six tests they would each need the same
 * minute of setup and would still only prove the loop if they ran in order.
 *
 * The suite clears up after itself: the conversation is deleted at the end,
 * which is also the last step under test.
 */
test.beforeAll(() => {
  requireSeedCredentials();
});

test.describe('Chats area', () => {
  // The test waits for a real provider call; the suite's ordinary budget is
  // not meant for one (issue #90).
  test.describe.configure({ timeout: AI_TEST_TIMEOUT_MS });

  test('writes a chat, finds it by a word from the transcript, continues and deletes it', async ({
    page,
  }) => {
    // A nonsense word, so the search cannot match anything else on this
    // deployment and the test is not sensitive to what else is stored.
    const marker = `zwirbelkraut${Date.now().toString(36)}`;

    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await createPage(page, `Chatsuche ${Date.now().toString(36)}`);

    await page.getByTestId('context-tab-ai').click();
    await page.getByTestId('ai-input').fill(`Was bedeutet ${marker}?`);
    await page.getByTestId('ai-send').click();
    await waitForAiRun(page, 'chats:first-question');

    // The dropdown is short now and offers the way out of it.
    await page.getByTestId('ai-conversation-switcher').click();
    await page.getByTestId('ai-all-conversations').click();
    await page.waitForURL(/\/chats/, { timeout: 30_000 });

    // Found by a word out of the message, not out of the title: the title is
    // derived from the same first line, so the query deliberately uses the
    // question mark-free middle of it.
    await page.getByTestId('chat-search').fill(marker);
    const rows = page.getByTestId('chat-row');
    await expect(rows).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId('chat-snippet').first()).toContainText(marker);

    // Reading the transcript in place.
    await page.getByTestId('chat-row-open').first().click();
    await expect(page.getByTestId('chat-transcript')).toContainText(marker, { timeout: 30_000 });

    // Continuing hands the conversation back to the panel, which opens on the
    // page the chat was standing on with the same transcript in it.
    await page.getByTestId('chat-continue').click();
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 30_000 });
    await expect(page.getByTestId('ai-question').first()).toContainText(marker, {
      timeout: 30_000,
    });

    // Archiving hides it from the open list without losing it.
    await page.goto('/chats');
    await page.getByTestId('chat-search').fill(marker);
    await expect(page.getByTestId('chat-row')).toHaveCount(1, { timeout: 30_000 });
    await page.getByTestId('chat-archive').first().click();
    await expect(page.getByTestId('chat-row').first()).toContainText('archiviert', {
      timeout: 30_000,
    });

    // And deleting it for good asks first, then really removes it.
    await page.getByTestId('chat-row-open').first().click();
    await page.getByTestId('chat-delete').click();
    await page.getByTestId('chat-delete-confirm').click();
    await expect(page.getByTestId('chat-row')).toHaveCount(0, { timeout: 30_000 });
  });
});
