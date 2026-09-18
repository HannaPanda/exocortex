import { type APIRequestContext, expect, test } from '@playwright/test';

import { BASIC_AUTH_CREDENTIALS } from '../support/basic-auth';
import { recordWorkspace } from '../support/created-workspaces';
import { apiSignIn, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

/**
 * Page templates (issue #79, ADR-039).
 *
 * The API half proves the claim the design rests on: a page made from a
 * template is an ordinary page that keeps nothing, so editing it leaves the
 * template alone. The browser half proves the two entry points exist and reach
 * each other -- marking a page in the page menu and then finding it in the
 * sidebar's picker is the whole loop a person walks through.
 */

test.describe('templates over the API', () => {
  let api: APIRequestContext;
  let origin: string;
  let workspaceId: string;

  test.beforeAll(async ({ playwright, baseURL }) => {
    requireSeedCredentials();
    origin = baseURL as string;
    api = await playwright.request.newContext({ httpCredentials: BASIC_AUTH_CREDENTIALS });
    await apiSignIn(api, 'johanna', origin);

    const created = await api.post(`${origin}/api/workspaces`, {
      data: { name: `Vorlagen ${Date.now().toString(36)}` },
    });
    expect(created.ok(), await created.text()).toBe(true);
    workspaceId = ((await created.json()) as { id: string }).id;
    recordWorkspace(workspaceId);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('copies a template into an independent page', async () => {
    const page = await api.post(`${origin}/api/workspaces/${workspaceId}/documents`, {
      data: { title: 'Meeting-Notiz', type: 'PAGE' },
    });
    expect(page.status(), await page.text()).toBe(201);
    const templateId = ((await page.json()) as { id: string }).id;

    const written = await api.post(`${origin}/api/documents/${templateId}/content`, {
      data: { markdown: '## Teilnehmende\n\n## Beschlüsse\n', mode: 'replace' },
    });
    expect(written.ok(), await written.text()).toBe(true);

    const marked = await api.post(`${origin}/api/workspaces/${workspaceId}/templates`, {
      data: {
        documentId: templateId,
        description: 'Für jedes Wochenmeeting',
        titlePattern: 'Meeting {{datum}}',
      },
    });
    expect(marked.status(), await marked.text()).toBe(201);

    const listed = await api.get(`${origin}/api/workspaces/${workspaceId}/templates`);
    expect(listed.ok(), await listed.text()).toBe(true);
    const templates = (await listed.json()) as {
      templates: { document: { id: string }; description: string | null }[];
    };
    expect(templates.templates).toHaveLength(1);
    expect(templates.templates[0]?.description).toBe('Für jedes Wochenmeeting');

    const used = await api.post(`${origin}/api/templates/${templateId}/pages`, { data: {} });
    expect(used.status(), await used.text()).toBe(201);
    const copy = (await used.json()) as { document: { id: string; title: string } };
    expect(copy.document.title).toMatch(/^Meeting \d{4}-\d{2}-\d{2}$/);

    // The copy holds the content, with block ids of its own.
    const exported = await api.get(`${origin}/api/documents/${copy.document.id}/export/markdown`);
    expect(exported.ok(), await exported.text()).toBe(true);
    expect(((await exported.json()) as { markdown: string }).markdown).toContain('Teilnehmende');

    // Editing the copy leaves the template exactly as it was.
    const edited = await api.post(`${origin}/api/documents/${copy.document.id}/content`, {
      data: { markdown: 'Nur in der Kopie\n', mode: 'replace' },
    });
    expect(edited.ok(), await edited.text()).toBe(true);

    const template = await api.get(`${origin}/api/documents/${templateId}/export/markdown`);
    const markdown = ((await template.json()) as { markdown: string }).markdown;
    expect(markdown).toContain('Beschlüsse');
    expect(markdown).not.toContain('Nur in der Kopie');

    // Unmarking removes the template and keeps the page.
    const unmarked = await api.delete(`${origin}/api/templates/${templateId}`);
    expect(unmarked.ok(), await unmarked.text()).toBe(true);
    const afterUnmark = await api.get(`${origin}/api/workspaces/${workspaceId}/templates`);
    expect(((await afterUnmark.json()) as { templates: unknown[] }).templates).toHaveLength(0);
    const stillThere = await api.get(`${origin}/api/documents/${templateId}`);
    expect(stillThere.ok()).toBe(true);
  });
});

test.describe('templates in the browser', () => {
  test.use({ storageState: storageStatePath('johanna') });

  test.beforeAll(() => {
    requireSeedCredentials();
  });

  test('marks the open page and makes a new one from it', async ({ page }) => {
    const marker = `Vorlage-${Date.now().toString(36)}`;

    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });

    await page.getByTestId('create-root-page').click();
    await page.getByTestId('create-root-page-item').click();
    await page.waitForURL(/\/seite\/[a-z0-9]+/, { timeout: 60_000 });
    await page.getByTestId('document-title').fill(marker);
    await page.getByTestId('document-title').blur();

    await page.getByTestId('document-actions').click();
    await page.getByTestId('open-template-settings').click();
    await expect(page.getByTestId('template-settings')).toBeVisible();
    await page.getByTestId('template-description').fill('Aus dem Test');
    await page.getByTestId('template-save').click();
    await expect(page.getByTestId('template-settings')).toBeHidden({ timeout: 30_000 });

    await page.getByTestId('create-root-page').click();
    await page.getByTestId('create-root-from-template').click();
    await expect(page.getByTestId('template-picker')).toBeVisible();
    await page.getByTestId('template-option').filter({ hasText: marker }).first().click();

    // The new page opens, and it is not the template it came from.
    await expect(page.getByTestId('document-title')).toHaveValue(marker, { timeout: 30_000 });
    await expect(page.getByText('Aus dem Test')).toHaveCount(0);
  });
});
