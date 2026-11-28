import { expect, type Page, test } from '@playwright/test';

import { requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

async function openWorkspace(page: Page): Promise<string> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+$/, { timeout: 60_000 });
  await expect(page.getByTestId('workspace-switcher')).toBeVisible({ timeout: 30_000 });
  return new URL(page.url()).pathname;
}

/**
 * Every setting in one dialog over the page being read (issue #279): opened
 * from the account menu, addressed by `?einstellungen=<group>`, closed by
 * Escape and by the browser's Back, and reached from the old settings pages.
 */
test.describe('Einstellungsdialog', () => {
  test('opens over the page from the account menu and Back closes it', async ({ page }) => {
    const workspacePath = await openWorkspace(page);

    await page.getByTestId('open-global-menu').click();
    await page.getByTestId('menu-open-settings').click();

    const dialog = page.getByTestId('settings-dialog');
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\?einstellungen=$/);
    // The page underneath stays where it was: the dialog lies over it.
    expect(new URL(page.url()).pathname).toBe(workspacePath);
    await expect(dialog.getByRole('heading', { name: 'Sprache und Uhrzeit' })).toBeVisible();

    // Another group replaces the address instead of adding a step.
    await dialog.getByTestId('settings-nav-editor').click();
    await expect(page).toHaveURL(/\?einstellungen=editor$/);
    await expect(dialog.getByTestId('outline-pinned')).toBeVisible();

    await page.goBack();
    await expect(dialog).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(workspacePath);
    expect(new URL(page.url()).search).toBe('');
  });

  test('Escape closes it and an address opens a group directly', async ({ page }) => {
    const workspacePath = await openWorkspace(page);
    await page.goto(`${workspacePath}?einstellungen=chat`);

    const dialog = page.getByTestId('settings-dialog');
    await expect(dialog.getByTestId('chat-scroll')).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByTestId('settings-nav-chat')).toHaveAttribute('aria-current', 'page');

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${workspacePath}$`));
  });

  test('the old settings pages open the dialog at their group', async ({ page }) => {
    for (const [route, group] of [
      ['/einstellungen/benachrichtigungen', 'notifications'],
      ['/einstellungen/tokens', 'connections'],
    ] as const) {
      await page.goto(route);
      await page.waitForURL(new RegExp(`/arbeitsbereich/[a-z0-9]+\\?einstellungen=${group}$`), {
        timeout: 60_000,
      });
      await expect(page.getByTestId(`settings-section-${group}`)).toBeVisible();
    }
  });

  test('the gear on the workspace opens its own group over the workspace', async ({ page }) => {
    const workspacePath = await openWorkspace(page);
    await page.getByTestId('open-workspace-settings').click();

    const dialog = page.getByTestId('settings-dialog');
    await expect(page).toHaveURL(/\?einstellungen=workspace$/);
    expect(new URL(page.url()).pathname).toBe(workspacePath);
    await expect(dialog.getByTestId('settings-nav-workspace')).toHaveAttribute(
      'aria-current',
      'page',
      { timeout: 30_000 },
    );
    // The seed account owns this workspace, so it sees every group of it,
    // the owner-only foreign tools included.
    for (const group of ['members', 'ai', 'tools', 'overrides']) {
      await expect(dialog.getByTestId(`settings-nav-${group}`)).toBeVisible();
    }
    // What stays a page is linked from here rather than gone.
    await expect(dialog.getByTestId('open-workspace-shares')).toBeVisible();

    await page.goBack();
    await expect(dialog).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(workspacePath);
  });

  test('the old workspace settings open the group their tab became', async ({ page }) => {
    const workspacePath = await openWorkspace(page);
    for (const [tab, group] of [
      ['', 'workspace'],
      ['?tab=members', 'members'],
      ['?tab=overrides', 'overrides'],
    ] as const) {
      await page.goto(`${workspacePath}/einstellungen${tab}`);
      await page.waitForURL(new RegExp(`${workspacePath}\\?einstellungen=${group}$`), {
        timeout: 60_000,
      });
      await expect(page.getByTestId(`settings-section-${group}`)).toBeVisible({ timeout: 30_000 });
    }
  });

  test('a group of the workspace waits for it instead of showing another', async ({ page }) => {
    const workspacePath = await openWorkspace(page);
    await page.goto(`${workspacePath}?einstellungen=members`);
    // Straight to the members, never by way of the first account group.
    await expect(page.getByTestId('open-workspace-invite')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('settings-nav-members')).toHaveAttribute('aria-current', 'page');
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('shows the list first, then the group, and back to the list', async ({ page }) => {
      const workspacePath = await openWorkspace(page);
      await page.goto(`${workspacePath}?einstellungen=`);

      const dialog = page.getByTestId('settings-dialog');
      const nav = dialog.getByRole('navigation', { name: 'Bereiche der Einstellungen' });
      await expect(nav).toBeVisible({ timeout: 30_000 });
      const box = await dialog.boundingBox();
      expect(box?.width).toBe(390);

      await nav.getByTestId('settings-nav-language').click();
      await expect(dialog.getByTestId('time-format')).toBeVisible();
      await expect(nav).toBeHidden();

      await dialog.getByTestId('settings-back-to-list').click();
      await expect(nav).toBeVisible();
      await expect(page).toHaveURL(/\?einstellungen=$/);
    });
  });
});
