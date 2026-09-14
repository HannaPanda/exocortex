import { expect, test } from '@playwright/test';

import { requireSeedCredentials, workspaceIdFrom } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * That a LaTeX project can be created, edited and built from the browser
 * (issue #43, ADR-027).
 *
 * Written after the whole write half of the feature turned out to be dead on
 * arrival: `project-queries.ts` handed `JSON.stringify(request)` to a wrapper
 * that stringifies its body itself, so every project mutation left the browser
 * as a JSON *string* and came back `validation_failed`. Nothing in the
 * repository noticed -- the types are identical on both sides of the wrapper
 * (`body` is `unknown`), the tools reach the same routes through their own
 * client, and there was no browser test at all.
 *
 * So this test is deliberately the whole loop rather than one click: create,
 * write a file, build, and see a PDF. Each step is a different mutation, and
 * the bug was in all of them at once.
 */
test.describe('LaTeX-Projekt im Browser', () => {
  // A container build with latexmk at the end of it; the 90 s default is for a
  // test that only clicks.
  test.setTimeout(240_000);

  test('legt ein Projekt an, schreibt eine Datei und baut ein PDF', async ({ page }) => {
    const stamp = Date.now().toString(36);

    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const workspaceId = workspaceIdFrom(page);

    await page.getByTestId('create-root-page').click();
    await page.getByTestId('create-root-project').click();

    // The project route, not the page route: a PROJECT opens its own workspace
    // rather than the editor.
    await page.waitForURL(/\/projekt\/[a-z0-9]+/, { timeout: 60_000 });
    expect(workspaceIdFrom(page)).toBe(workspaceId);
    await expect(page.getByTestId('project-view')).toBeVisible();
    await expect(page.getByTestId('project-editor')).toBeVisible();

    const path = `kapitel/probe-${stamp}.tex`;
    await page.getByTestId('project-file-create').click();
    await page.getByTestId('project-new-path').fill(path);
    await page.getByRole('button', { name: 'Anlegen', exact: true }).click();

    // The tree is a projection rebuilt by a debounced job, so the row appears a
    // second or two after the write reaches the collaboration server.
    await expect(page.getByText(`probe-${stamp}.tex`)).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('project-build').click();

    // The first build of a project pulls the image's format files into place;
    // every one after that is cached.
    await expect(page.getByText('fertig', { exact: true })).toBeVisible({ timeout: 180_000 });
    await expect(page.getByLabel('Gebautes PDF')).toBeVisible();
  });
});
