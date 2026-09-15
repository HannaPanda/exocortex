import { expect, test } from '@playwright/test';

import {
  createPage,
  requireSeedCredentials,
  waitForMaterialization,
  workspaceIdFrom,
} from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

// Reuse the session created by the global setup instead of logging in again:
// sign-in is rate limited by design.
test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

test.describe('markdown and search', () => {
  test('exports a page as Markdown and imports it again with the same content', async ({
    page,
  }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const marker = `Rundlauf-${Date.now().toString(36)}`;
    const documentId = await createPage(page, `Export ${marker}`);
    const workspaceId = workspaceIdFrom(page);

    await page.getByTestId('editor-surface').click();
    await page.keyboard.type(`# Überschrift ${marker}`);
    await page.keyboard.press('Enter');
    await page.keyboard.type(`Ein Absatz mit ${marker}.`);
    await page.keyboard.press('Enter');
    await page.keyboard.type('Zweiter Absatz.');

    // The collaboration server persists with a debounce and the worker derives
    // Markdown afterwards, so the pipeline has to finish before exporting.
    // The heading, not the bare marker: the marker is part of the title too, so
    // waiting for it would be satisfied by the frontmatter of a still-empty page.
    await waitForMaterialization(page, documentId, `# Überschrift ${marker}`);

    // Export: the download contains deterministic Markdown.
    await page.getByTestId('document-actions').click();
    const download = page.waitForEvent('download');
    await page.getByTestId('export-markdown').click();
    const file = await download;
    const stream = await file.createReadStream();
    const markdown = await new Promise<string>((resolve, reject) => {
      let content = '';
      stream.on('data', (chunk) => {
        content += String(chunk);
      });
      stream.on('end', () => resolve(content));
      stream.on('error', reject);
    });

    expect(markdown).toContain(`exocortexId: ${documentId}`);
    expect(markdown).toContain(`# Überschrift ${marker}`);
    expect(markdown).toContain(`Ein Absatz mit ${marker}.`);
    expect(markdown).toContain('Zweiter Absatz.');
    // Syntax-level fidelity (task lists, tables, callouts, wiki links, block ids)
    // is covered exhaustively by the round-trip unit tests in packages/editor.

    // Import the exported Markdown as a new page.
    await page.getByTestId('document-actions').click();
    await page.getByTestId('open-import').click();
    await page.getByTestId('import-textarea').fill(markdown);
    const beforeImportUrl = page.url();
    await page.getByTestId('import-submit').click();
    // The browser is already on a `/seite/...` URL, so wait for a *different* one.
    await page.waitForURL((url) => url.toString() !== beforeImportUrl, { timeout: 30_000 });

    const importedId = new URL(page.url()).pathname.split('/').pop() as string;
    expect(importedId).not.toBe(documentId);

    // The semantic content survived the round trip.
    const surface = page.getByTestId('editor-surface');
    await expect(surface).toContainText(`Überschrift ${marker}`, { timeout: 30_000 });
    await expect(surface).toContainText(`Ein Absatz mit ${marker}.`);
    await expect(surface).toContainText('Zweiter Absatz.');
    expect(workspaceId).toMatch(/^[a-z0-9]+$/);
  });

  /**
   * A page's title is metadata and is rendered above the page, so a heading
   * repeating it shows it twice. The exact repeat is removed on the way in; a
   * heading that only resembles the title is content nobody may delete on a
   * hunch, so it is reported on the workspace overview instead.
   */
  test('drops a heading that repeats the title and reports one that resembles it', async ({
    page,
  }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const workspaceId = workspaceIdFrom(page);
    const marker = `Titel-${Date.now().toString(36)}`;

    const identical = await page.request.post(`/api/workspaces/${workspaceId}/import/markdown`, {
      data: { markdown: `# Gleich ${marker}\n\nEin Absatz.\n`, title: `Gleich ${marker}` },
    });
    expect(identical.ok(), await identical.text()).toBe(true);
    const identicalId = ((await identical.json()) as { document: { id: string } }).document.id;

    const exported = await page.request.get(`/api/documents/${identicalId}/export/markdown`);
    const { markdown } = (await exported.json()) as { markdown: string };
    expect(markdown).toContain(`title: Gleich ${marker}`);
    expect(markdown).not.toContain(`# Gleich ${marker}`);
    expect(markdown).toContain('Ein Absatz.');

    const similar = await page.request.post(`/api/workspaces/${workspaceId}/import/markdown`, {
      data: {
        markdown: `# Ähnlich ${marker} und noch etwas\n\nEin Absatz.\n`,
        title: `Ähnlich ${marker}`,
      },
    });
    expect(similar.ok(), await similar.text()).toBe(true);

    const overview = await page.request.get(`/api/workspaces/${workspaceId}/overview`);
    const attention = (await overview.json()) as {
      attention: { duplicateTitleHeadings: { documents: { title: string }[] } };
    };
    expect(
      attention.attention.duplicateTitleHeadings.documents.map((entry) => entry.title),
    ).toContain(`Ähnlich ${marker}`);
  });

  test('search finds text from the materialized page', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const marker = `suchbegriff${Date.now().toString(36)}`;
    await createPage(page, `Suche ${marker}`);

    await page.getByTestId('editor-surface').click();
    await page.keyboard.type(`Dieser Satz enthält ${marker} als Volltext.`);

    // Materialization is debounced; the search index follows it.
    await page.getByTestId('open-search').click();
    const input = page.getByRole('combobox');
    await expect
      .poll(
        async () => {
          await input.fill('');
          await input.fill(marker);
          await page.waitForTimeout(1_500);
          return page.getByRole('option').count();
        },
        { timeout: 90_000, intervals: [2_000] },
      )
      .toBeGreaterThan(0);

    await expect(page.getByRole('listbox')).toContainText(marker);

    // Issue #29: a hit is a real anchor, so it can be middle-clicked, opened in
    // a new tab from the context menu, or have its address copied — none of
    // which an `onSelect` handler can offer.
    // By attribute rather than by role: a link inside a `role="option"` row is
    // pruned from the accessibility tree, so the anchor is only findable here.
    const hit = page.locator('[data-testid^="search-result-"]').first();
    await expect(hit).toHaveAttribute('href', /\/seite\/[a-z0-9]+$/);
  });
});
