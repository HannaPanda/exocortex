import { expect, test } from '@playwright/test';

import {
  createPage,
  requireSeedCredentials,
  waitForMaterialization,
  workspaceIdFrom,
} from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * The smallest Pandoc template that produces a PDF, so the build is about the
 * dialog rather than about typography. No fonts, no title page, no variables:
 * a template that asks a question would make this test about the form.
 */
const MINIMAL_TEMPLATE = [
  '\\documentclass{article}',
  '\\usepackage{fontspec}',
  '\\begin{document}',
  '$body$',
  '\\end{document}',
].join('\n');

/**
 * That a finished PDF is still reachable after the dialog was closed.
 *
 * This is the one thing about publishing that only a browser can prove. The
 * artifact itself is an ordinary attachment behind a stable download path, and
 * the job list has always been an endpoint -- but the dialog kept the job it
 * had just built in React state, so closing it left the file with no route
 * back to it in the UI at all, while `exo_render_jobs` handed an agent the
 * same list. ADR-025 counts that as a missing capability, and a regression
 * here would be silent: the build still succeeds, the PDF still exists, and
 * only the way to it is gone.
 */
test.describe('PDF-Verlauf einer Seite', () => {
  test('bietet ein fertiges PDF nach dem Schließen wieder an', async ({ page }) => {
    const stamp = Date.now().toString(36);
    const marker = `Verlaufsprobe ${stamp}`;

    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const workspaceId = workspaceIdFrom(page);

    const templateName = `Verlaufsvorlage ${stamp}`;
    const created = await page.request.post(`/api/workspaces/${workspaceId}/render/templates`, {
      data: { name: templateName, source: MINIMAL_TEMPLATE },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const templateId = ((await created.json()) as { template: { id: string } }).template.id;

    try {
      const documentId = await createPage(page, `Render ${stamp}`);
      await expect(page.getByTestId('editor-surface')).toBeVisible();
      await page.getByTestId('editor-surface').click();
      await page.keyboard.type(marker);
      // The build reads the derived Markdown, not the Yjs state (ADR-007), so
      // starting one before materialization has run would publish an empty page.
      await waitForMaterialization(page, documentId, marker);

      await page.getByTestId('document-actions').click();
      await page.getByTestId('open-render').click();

      // Explicitly, rather than trusting the preselection: the workspace may
      // already carry templates from another run, and the newest job decides
      // which one the dialog offers first.
      await page.getByTestId('render-template').click();
      await page.getByRole('option', { name: templateName, exact: true }).click();

      await page.getByTestId('render-start').click();
      await expect(page.getByTestId('render-job')).toContainText('fertig', { timeout: 180_000 });

      await page.getByRole('button', { name: 'Schließen' }).click();
      await expect(page.getByTestId('render-job')).toBeHidden();

      await page.getByTestId('document-actions').click();
      await page.getByTestId('open-render').click();

      const entry = page.getByTestId('render-history-entry').first();
      await expect(entry).toBeVisible();
      await expect(entry).toContainText(templateName);
      await expect(entry.getByTestId('render-history-open')).toHaveAttribute(
        'href',
        /^\/api\/attachments\/[a-z0-9]+\/download$/,
      );

      // Selecting the row brings the build back into the panel above, which is
      // where the log and the staleness badge live.
      await entry.getByTestId('render-history-select').click();
      await expect(page.getByTestId('render-job')).toContainText('fertig');
      await expect(page.getByTestId('render-open')).toBeVisible();
    } finally {
      await page.request.delete(`/api/render/templates/${templateId}`);
    }
  });
});
