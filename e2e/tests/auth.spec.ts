import { expect, test } from '@playwright/test';

import { requireSeedCredentials, signIn } from '../support/fixtures';

test.beforeAll(() => {
  requireSeedCredentials();
});

test.describe('authentication', () => {
  test('rejects wrong credentials with a German message', async ({ page }) => {
    await page.goto('/anmelden');
    await page.getByLabel('E-Mail-Adresse').fill('johanna@exocortex.app');
    await page.getByLabel('Passwort').fill('definitely-not-the-password');
    await page.getByTestId('signin-submit').click();
    await expect(page.getByTestId('signin-error')).toContainText('falsch');
  });

  test('signs in, keeps the session across reloads and signs out again', async ({ page }) => {
    await signIn(page, 'johanna');
    await expect(page.getByTestId('workspace-switcher')).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('workspace-switcher')).toBeVisible();

    await page.getByTestId('sign-out').click();
    await page.waitForURL(/\/anmelden/, { timeout: 30_000 });

    // Protected routes bounce back to the login form.
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/anmelden/, { timeout: 30_000 });
  });

  test('registers a new account and lands in the application', async ({ page }) => {
    const suffix = Date.now().toString(36);
    await page.goto('/registrieren');
    await page.getByLabel('Name').fill(`Testnutzer ${suffix}`);
    await page.getByLabel('E-Mail-Adresse').fill(`test-${suffix}@exocortex.test`);
    await page.getByLabel('Passwort').fill(`sicheres-passwort-${suffix}`);
    await page.getByTestId('signup-submit').click();

    await page.waitForURL(/\/arbeitsbereich/, { timeout: 30_000 });
    // A brand-new user has no workspace yet and is offered to create one.
    await expect(page.getByTestId('create-first-workspace')).toBeVisible({ timeout: 30_000 });
  });

  test('enforces the minimum password length in the form', async ({ page }) => {
    await page.goto('/registrieren');
    await page.getByLabel('Name').fill('Kurz');
    await page.getByLabel('E-Mail-Adresse').fill(`short-${Date.now().toString(36)}@exocortex.test`);
    await page.getByLabel('Passwort').fill('kurz');
    await page.getByTestId('signup-submit').click({ force: true });
    await expect(page).toHaveURL(/\/registrieren/);
  });
});
