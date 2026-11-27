import { expect, type Page, test } from '@playwright/test';

import { AI_RUN_FINISH_TIMEOUT_MS, AI_TEST_TIMEOUT_MS } from '../support/ai-run';
import { createPage, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

/**
 * Pictures and documents on a chat message (issue #223): pasted, dropped or
 * chosen in the composer, shown as a chip that can be taken away, and on the
 * sent question after a reload, with what the assistant was given.
 *
 * The first test asks no model: it only uploads and removes. The others each
 * send one message and wait for one real run, because the description and
 * the reading are done by the worker. Every conversation is deleted for good afterwards, which
 * takes its pictures out of the bucket too.
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

/**
 * The e2e project is typed against Node alone, so the browser globals the
 * callbacks below touch are named explicitly, and only as much as they use.
 */
interface Canvas2d {
  fillStyle: string;
  font: string;
  textBaseline: string;
  fillRect: (x: number, y: number, width: number, height: number) => void;
  fillText: (text: string, x: number, y: number) => void;
}
interface BrowserTarget {
  dispatchEvent: (event: unknown) => boolean;
}
interface Browser {
  document: {
    createElement: (tag: 'canvas') => {
      width: number;
      height: number;
      getContext: (kind: '2d') => Canvas2d | null;
      toDataURL: (type: string) => string;
    };
    querySelector: (selector: string) => BrowserTarget | null;
  };
  DataTransfer: new () => { items: { add: (file: unknown) => void } };
  File: new (parts: unknown[], name: string, init: { type: string }) => unknown;
  ClipboardEvent: new (type: string, init: Record<string, unknown>) => unknown;
  DragEvent: new (type: string, init: Record<string, unknown>) => unknown;
  atob: (data: string) => string;
}

/** A picture with one word on it, drawn by the browser, as PNG bytes in base64. */
async function drawWord(page: Page, word: string): Promise<string> {
  return page.evaluate((text) => {
    const browser = globalThis as unknown as Browser;
    const canvas = browser.document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 200;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no 2d context');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000000';
    context.font = 'bold 96px sans-serif';
    context.textBaseline = 'middle';
    context.fillText(text, 24, 100);
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  }, word);
}

/** Hands a file to the composer the way a clipboard or a drop would. */
async function deliver(
  page: Page,
  how: 'paste' | 'drop',
  file: { name: string; base64: string; type: string },
): Promise<void> {
  const selector = how === 'paste' ? '[data-testid="ai-input"]' : '[data-testid="ai-panel"]';
  await page.evaluate(
    ({ selector: target, how: kind, file: picture }) => {
      const browser = globalThis as unknown as Browser;
      const element = browser.document.querySelector(target);
      if (element === null) throw new Error(`no ${target}`);
      const bytes = Uint8Array.from(browser.atob(picture.base64), (char) => char.charCodeAt(0));
      const transfer = new browser.DataTransfer();
      transfer.items.add(new browser.File([bytes], picture.name, { type: picture.type }));
      if (kind === 'paste') {
        element.dispatchEvent(
          new browser.ClipboardEvent('paste', {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
        return;
      }
      for (const type of ['dragenter', 'dragover', 'drop']) {
        element.dispatchEvent(
          new browser.DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }),
        );
      }
    },
    { selector, how, file },
  );
}

/** Opens the AI panel on a fresh page and remembers the chat the first picture creates. */
async function openPanelOnNewPage(page: Page, title: string): Promise<void> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  await createPage(page, title);
  await page.getByTestId('context-tab-ai').click();
  await expect(page.getByTestId('ai-input')).toBeVisible({ timeout: 30_000 });
  page.on('response', (response) => {
    if (response.request().method() !== 'POST') return;
    if (!new URL(response.url()).pathname.endsWith('/api/ai/conversations')) return;
    void response
      .json()
      .then((body: { conversation?: { id: string } }) => {
        if (body.conversation !== undefined) created.push(body.conversation.id);
      })
      .catch(() => undefined);
  });
}

test('takes pictures and documents by picker, paste and drop, refuses others, lets a chip go', async ({
  page,
}) => {
  await openPanelOnNewPage(page, `Chatbilder ${Date.now().toString(36)}`);
  const base64 = await drawWord(page, 'EINS');
  const chips = page.getByTestId('ai-file-chip');

  await page.getByTestId('ai-attach-input').setInputFiles({
    name: 'gewaehlt.png',
    mimeType: 'image/png',
    buffer: Buffer.from(base64, 'base64'),
  });
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });

  await deliver(page, 'paste', { name: 'eingefuegt.png', base64, type: 'image/png' });
  await deliver(page, 'drop', { name: 'gezogen.png', base64, type: 'image/png' });
  await expect(chips).toHaveCount(3);
  await expect(page.locator('[data-testid="ai-file-chip"][data-status="ready"]')).toHaveCount(3, {
    timeout: 30_000,
  });
  // Pictures alone are a message.
  await expect(page.getByTestId('ai-send')).toBeEnabled();

  // An archive is neither a picture nor a document, and the composer says so
  // instead of uploading it.
  await deliver(page, 'drop', {
    name: 'paket.zip',
    base64: Buffer.from('PK\u0005\u0006' + '\u0000'.repeat(18)).toString('base64'),
    type: 'application/zip',
  });
  await expect(page.getByText('paket.zip', { exact: false })).toBeVisible();
  await expect(chips).toHaveCount(3);

  const deleted = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      /\/api\/attachments\/[a-z0-9]+$/.test(new URL(response.url()).pathname),
  );
  await chips.filter({ hasText: 'gezogen.png' }).getByTestId('ai-file-remove').click();
  expect((await deleted).ok()).toBe(true);
  await expect(chips).toHaveCount(2);

  // A text file is a document: it goes with the message as a file chip, even
  // dropped with no type, which is how a browser often hands over Markdown.
  await deliver(page, 'drop', {
    name: 'notiz.md',
    base64: Buffer.from('# Notiz\n\nNur ein Test.\n').toString('base64'),
    type: '',
  });
  const document = page.locator('[data-testid="ai-file-chip"][data-kind="document"]');
  await expect(document).toHaveCount(1);
  await expect(document).toHaveAttribute('data-status', 'ready', { timeout: 30_000 });
});

test('sends a picture with the question, shows it after a reload and describes it once', async ({
  page,
  baseURL,
}) => {
  // Waits for one real provider call and one picture description.
  test.setTimeout(AI_TEST_TIMEOUT_MS);
  await openPanelOnNewPage(page, `Chatbild gesendet ${Date.now().toString(36)}`);
  const base64 = await drawWord(page, 'BANANE');

  await page.getByTestId('ai-attach-input').setInputFiles({
    name: 'wort.png',
    mimeType: 'image/png',
    buffer: Buffer.from(base64, 'base64'),
  });
  await expect(page.locator('[data-testid="ai-file-chip"][data-status="ready"]')).toHaveCount(1, {
    timeout: 30_000,
  });
  await page
    .getByTestId('ai-input')
    .fill('Welches Wort steht auf dem Bild? Antworte mit dem Wort.');
  await page.getByTestId('ai-send').click();

  // The chip went with the message, and the question shows the picture.
  await expect(page.getByTestId('ai-file-chip')).toHaveCount(0);
  await expect(page.getByTestId('ai-question-picture')).toHaveCount(1);
  await expect(page.getByTestId('ai-answer').last()).toContainText(/banane/i, {
    timeout: AI_RUN_FINISH_TIMEOUT_MS,
  });
  await expect(page.getByTestId('ai-run-activity')).toBeHidden({
    timeout: AI_RUN_FINISH_TIMEOUT_MS,
  });

  // The description is on the message, for the browser and for agents alike.
  const conversationId = created.at(-1);
  expect(conversationId).toBeDefined();
  const detail = await page.request.get(`/api/ai/conversations/${conversationId ?? ''}`, {
    headers: { origin: baseURL as string },
  });
  const body = (await detail.json()) as {
    messages: { role: string; attachments: { filename: string; description: string | null }[] }[];
  };
  const question = body.messages.find((message) => message.role === 'user');
  expect(question?.attachments).toHaveLength(1);
  expect(question?.attachments[0]?.description ?? '').toMatch(/banane/i);

  // After a reload the picture is still on its question.
  await page.reload();
  await page.getByTestId('context-tab-ai').click();
  await expect(page.getByTestId('ai-question-picture')).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('ai-question-picture').click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('reads a picture and a text file sent from the start page', async ({ page }) => {
  // Waits for one real provider call and one picture description.
  test.setTimeout(AI_TEST_TIMEOUT_MS);
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+$/, { timeout: 60_000 });
  const field = page.getByTestId('chat-start-input');
  await expect(field).toBeVisible({ timeout: 30_000 });
  const base64 = await drawWord(page, 'BANANE');
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

  const starter = page.getByTestId('chat-starter');
  await starter.getByTestId('ai-attach-input').setInputFiles([
    { name: 'wort.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') },
    {
      name: 'zettel.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Das gesuchte Wort lautet KIWANO.\n'),
    },
  ]);
  // Nothing is uploaded yet: there is no conversation to hold the files.
  await expect(starter.getByTestId('ai-file-chip')).toHaveCount(2);
  await field.fill(
    'Welches Wort steht auf dem Bild, und welches in der Datei? Antworte nur mit den zwei Wörtern.',
  );
  await field.press('Enter');

  await expect(page.getByTestId('ai-question-picture')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('ai-question-document')).toHaveCount(1);
  const answer = page.getByTestId('ai-answer').last();
  await expect(answer).toContainText(/banane/i, { timeout: AI_RUN_FINISH_TIMEOUT_MS });
  await expect(answer).toContainText(/kiwano/i);
  await expect(page.getByTestId('ai-question-document')).toHaveAttribute(
    'data-text-state',
    'ready',
  );
});
