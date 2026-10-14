import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

import { BASIC_AUTH_CREDENTIALS } from '../support/basic-auth';
import { recordWorkspace } from '../support/created-workspaces';
import { apiSignIn, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

/**
 * The work item detail page (issue #182): a long item with criteria, a
 * result, parts and a history reads top-down, the result is read before it
 * is edited, and nothing overflows at phone width.
 */

let api: APIRequestContext;
let origin: string;
let workspaceId: string;
let workItemId: string;

test.use({ storageState: storageStatePath('johanna') });

const RESULT = [
  'Die drei Quellen widersprechen sich nur in einem Punkt.',
  '',
  '## Befund',
  '',
  '- Archiv und Protokoll nennen denselben Termin.',
  '- Die Mail vom März nennt einen anderen und ist **älter**.',
  '',
  'Empfehlung: das Protokoll als maßgeblich behandeln.',
].join('\n');

test.beforeAll(async ({ playwright, baseURL }) => {
  requireSeedCredentials();
  origin = baseURL as string;
  api = await playwright.request.newContext({ httpCredentials: BASIC_AUTH_CREDENTIALS });
  await apiSignIn(api, 'johanna', origin);
  const created = await api.post(`${origin}/api/workspaces`, {
    data: { name: `Aufträge ${Date.now().toString(36)}` },
  });
  expect(created.ok(), await created.text()).toBe(true);
  workspaceId = ((await created.json()) as { id: string }).id;
  recordWorkspace(workspaceId);

  const item = await api.post(`${origin}/api/workspaces/${workspaceId}/work-items`, {
    data: {
      title: 'Widersprüche zwischen Archiv, Protokoll und Mailverlauf klären',
      goal: 'Finde heraus, welcher Termin für die Abnahme gilt, und begründe es mit den Quellen.\n\nDie Mail vom März ist **nicht** die einzige Quelle.',
      priority: 'high',
      acceptanceCriteria: [
        { text: 'Alle drei Quellen sind gelesen', met: true },
        { text: 'Der Widerspruch ist benannt', met: true },
        { text: 'Eine Empfehlung mit Begründung liegt vor', met: false },
      ],
    },
  });
  expect(item.ok(), await item.text()).toBe(true);
  workItemId = ((await item.json()) as { workItem: { id: string } }).workItem.id;

  for (const title of ['Archiv durchsehen', 'Protokoll gegenlesen']) {
    const child = await api.post(`${origin}/api/workspaces/${workspaceId}/work-items`, {
      data: { title, goal: `${title} und den Termin notieren.`, parentId: workItemId },
    });
    expect(child.ok(), await child.text()).toBe(true);
  }
  const updated = await api.patch(`${origin}/api/work-items/${workItemId}`, {
    data: { status: 'working', result: RESULT },
  });
  expect(updated.ok(), await updated.text()).toBe(true);
  for (const note of ['Archiv ist vollständig.', 'Protokoll liegt als PDF vor.']) {
    const added = await api.post(`${origin}/api/work-items/${workItemId}/notes`, {
      data: { note },
    });
    expect(added.ok(), await added.text()).toBe(true);
  }
});

test.afterAll(async () => {
  await api.dispose();
});

test.describe.configure({ mode: 'serial' });

test('reads the brief and the result as text, not as fields', async ({ page }) => {
  await page.goto(`/arbeitsbereich/${workspaceId}/auftraege/${workItemId}`);
  await expect(page.getByTestId('work-item-title-heading')).toBeVisible();

  // Markdown is rendered: the emphasis is a <strong>, the heading a heading.
  await expect(page.getByTestId('work-item-goal-text').locator('strong')).toHaveText('nicht');
  const result = page.getByTestId('work-item-result-text');
  await expect(result.getByRole('heading', { name: 'Befund' })).toBeVisible();
  await expect(page.getByTestId('work-item-result')).toHaveCount(0);

  // Editing is a mode with a way back: Escape leaves the stored text alone.
  await page.getByTestId('work-item-result-edit').click();
  const field = page.getByTestId('work-item-result');
  await expect(field).toBeFocused();
  await expect(page.getByTestId('work-item-result-save')).toBeDisabled();
  await field.fill('Verworfen');
  await field.press('Escape');
  await expect(result).toContainText('Empfehlung');

  await page.getByTestId('work-item-result-edit').click();
  await field.fill(`${RESULT}\n\nNachtrag: geprüft.`);
  await page.getByTestId('work-item-result-save').click();
  await expect(field).toHaveCount(0);
  await expect(result).toContainText('Nachtrag: geprüft.');

  // Rarely changed settings are folded, and say what they are set to.
  await expect(page.getByTestId('work-item-write-mode')).toHaveCount(0);
  await expect(page.getByTestId('work-item-ai-settings-summary')).toContainText('Schreibmodus');
  await page.getByTestId('work-item-ai-settings-toggle').click();
  await expect(page.getByTestId('work-item-write-mode')).toBeVisible();
  await expect(page.getByTestId('work-item-agent-profile')).toBeVisible();

  // The history shows the latest entries and opens on request.
  const history = page.getByTestId('work-item-history').locator('li');
  await expect(history).toHaveCount(3);
  await page.getByTestId('work-item-history-toggle').click();
  expect(await history.count()).toBeGreaterThan(3);
});

test('changes the status from its badge and asks why when it has to', async ({ page }) => {
  await page.goto(`/arbeitsbereich/${workspaceId}/auftraege/${workItemId}`);
  const badge = page.getByTestId('work-item-status-badge');
  await expect(badge).toHaveText('In Arbeit');

  await page.getByTestId('work-item-status').click();
  await page.getByTestId('work-item-status-blocked').click();
  // Nothing is set until the reason is given.
  await expect(page.getByTestId('work-item-reason')).toBeFocused();
  await expect(badge).toHaveText('In Arbeit');
  await page.getByTestId('work-item-reason').fill('Zugang zum Archiv fehlt');
  await page.getByTestId('work-item-reason').press('Enter');
  await expect(badge).toHaveText('Blockiert');
  await expect(page.getByTestId('work-item-status-reason')).toHaveText('Zugang zum Archiv fehlt');

  // A status without a reason applies at once and clears the old one.
  await page.getByTestId('work-item-status').click();
  await page.getByTestId('work-item-status-working').click();
  await expect(badge).toHaveText('In Arbeit');
  await expect(page.getByTestId('work-item-status-reason')).toHaveCount(0);
});

test('fits a phone without scrolling sideways', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/arbeitsbereich/${workspaceId}/auftraege/${workItemId}`);
  await expect(page.getByTestId('work-item-title-heading')).toBeVisible();
  await shoot(page, 'desktop');

  await page.setViewportSize({ width: 390, height: 844 });
  const scroller = page.locator('[data-slot="app-page"]');
  const overflow = await scroller.evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // The actions wrap under the title instead of squeezing it.
  const title = await page.getByTestId('work-item-title-heading').boundingBox();
  const start = await page.getByTestId('work-item-start-run').boundingBox();
  expect(title).not.toBeNull();
  expect(start).not.toBeNull();
  expect(start!.y).toBeGreaterThan(title!.y + title!.height - 1);
  await shoot(page, 'phone');
});

/**
 * The page scrolls inside its own container, so a full-page screenshot would
 * stop at the viewport: the container is stretched to its content first.
 */
async function shoot(page: Page, name: string): Promise<void> {
  await page.addStyleTag({
    content:
      '[data-slot="app-page"] { overflow: visible !important; flex: none !important; }' +
      ' *:has([data-slot="app-page"]) { overflow: visible !important; height: auto !important; }',
  });
  await page.screenshot({ path: `test-results/work-item-detail/${name}.png`, fullPage: true });
}
