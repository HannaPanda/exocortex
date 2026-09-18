import { type APIRequestContext, expect, test } from '@playwright/test';

import { BASIC_AUTH_CREDENTIALS } from '../support/basic-auth';
import { recordWorkspace } from '../support/created-workspaces';
import { apiSignIn, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

/**
 * The web clipper and the share target (issue #72, ADR-037).
 *
 * The browser half is the whole user-visible feature: `/teilen` is where an
 * operating system drops somebody who pressed "share", and a route that lands
 * on an empty form has lost what they shared. The API half pins down what a
 * clip is made of, which is the part a later refactor can quietly change: the
 * provenance in the first line, the selection as a quote, and a refusal for an
 * address that is not a web address.
 */

const SHARED = {
  url: 'https://www.example.com/artikel',
  title: 'Ein geteilter Artikel',
  text: 'Der markierte Satz.',
};

test.describe('the share target in the browser', () => {
  test.use({ storageState: storageStatePath('johanna') });

  test.beforeAll(() => {
    requireSeedCredentials();
  });

  test('keeps what was shared and saves it as a page', async ({ page }) => {
    const marker = `Geteilt-${Date.now().toString(36)}`;
    const query = new URLSearchParams({ ...SHARED, title: marker });

    await page.goto(`/teilen?${query.toString()}`);
    await expect(page.getByTestId('clip-form')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('clip-title')).toHaveValue(marker);
    await expect(page.getByTestId('clip-text')).toHaveValue(SHARED.text);
    await expect(page.getByTestId('clip-url')).toContainText('example.com/artikel');

    // Left unchecked on purpose: this must save without anything reaching out
    // to the web, which is what makes a share from a phone cheap.
    await page.getByTestId('clip-submit').click();
    await expect(page.getByTestId('clip-saved')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('clip-open').click();
    await expect(page.getByTestId('document-title')).toHaveValue(marker, { timeout: 30_000 });
  });

  test('hands out a bookmarklet when it is opened with nothing to save', async ({ page }) => {
    await page.goto('/teilen');
    const bookmarklet = page.getByTestId('clip-bookmarklet');
    await expect(bookmarklet).toBeVisible({ timeout: 60_000 });
    // Set through the DOM after mount, because React will not render it.
    await expect(bookmarklet).toHaveAttribute('href', /^javascript:/);
  });
});

test.describe('clipping over the API', () => {
  let api: APIRequestContext;
  let origin: string;
  let workspaceId: string;

  test.beforeAll(async ({ playwright, baseURL }) => {
    requireSeedCredentials();
    origin = baseURL as string;
    api = await playwright.request.newContext({ httpCredentials: BASIC_AUTH_CREDENTIALS });
    await apiSignIn(api, 'johanna', origin);

    const created = await api.post(`${origin}/api/workspaces`, {
      data: { name: `Clip ${Date.now().toString(36)}` },
    });
    expect(created.ok(), await created.text()).toBe(true);
    workspaceId = ((await created.json()) as { id: string }).id;
    recordWorkspace(workspaceId);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('writes provenance, selection and nothing else it was not given', async () => {
    const response = await api.post(`${origin}/api/workspaces/${workspaceId}/clip`, {
      data: { url: SHARED.url, title: SHARED.title, selection: SHARED.text },
    });
    expect(response.status(), await response.text()).toBe(201);
    const body = (await response.json()) as {
      document: { id: string; title: string };
      inboxCreated: boolean;
      fetched: boolean;
      truncated: boolean;
    };
    expect(body.document.title).toBe(SHARED.title);
    expect(body.inboxCreated).toBe(true);
    expect(body.fetched).toBe(false);
    expect(body.truncated).toBe(false);

    const markdown = await exportedMarkdown(api, origin, body.document.id);
    expect(markdown).toContain(`Quelle: [example.com/artikel](${SHARED.url})`);
    expect(markdown).toContain(`> ${SHARED.text}`);
  });

  test('refuses an address that is not a web address', async () => {
    const response = await api.post(`${origin}/api/workspaces/${workspaceId}/clip`, {
      data: { url: 'javascript:alert(1)' },
    });
    expect(response.status(), await response.text()).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe('web_address_refused');
  });
});

/** The body is materialized by a job, so it is waited for rather than read. */
async function exportedMarkdown(
  api: APIRequestContext,
  origin: string,
  documentId: string,
): Promise<string> {
  let markdown = '';
  await expect
    .poll(
      async () => {
        const response = await api.get(`${origin}/api/documents/${documentId}/export/markdown`);
        if (!response.ok()) return '';
        markdown = ((await response.json()) as { markdown: string }).markdown;
        return markdown;
      },
      { timeout: 60_000, intervals: [500] },
    )
    .toContain('Quelle:');
  return markdown;
}
