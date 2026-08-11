import { expect, test } from '@playwright/test';

import { recordWorkspace } from '../support/created-workspaces';
import { requireSeedCredentials, signIn, workspaceIdFrom } from '../support/fixtures';

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

  test('opens the workspace switcher and switches to another workspace', async ({ page }) => {
    await signIn(page, 'johanna');
    const current = workspaceIdFrom(page);

    // Opening the menu must render its group label without throwing; a bare
    // `Menu.GroupLabel` outside `Menu.Group` used to take the whole route down.
    await page.getByTestId('workspace-switcher').click();
    await expect(page.getByText('Arbeitsbereiche')).toBeVisible();
    await expect(page.getByTestId(`workspace-option-${current}`)).toBeVisible();

    // Create a second workspace from the menu and switch into it.
    await page.getByTestId('workspace-create').click();
    const name = `Wechsel ${Date.now().toString(36)}`;
    // Typed key by key on purpose: `fill` sets the value through the DOM and
    // would still pass while an open menu swallows every character key for its
    // typeahead, which is exactly how that bug reached production once.
    await page.getByTestId('workspace-name-input').pressSequentially(name);
    await expect(page.getByTestId('workspace-name-input')).toHaveValue(name);
    await page.getByTestId('workspace-create-submit').click();
    await page.waitForURL(/\/arbeitsbereich\/(?!$)/, { timeout: 30_000 });
    await expect(page.getByTestId('workspace-switcher')).toContainText(name);
    // Noted for the teardown; the application cannot delete a workspace.
    recordWorkspace(workspaceIdFrom(page));

    await page.getByTestId('workspace-switcher').click();
    await page.getByTestId(`workspace-option-${current}`).click();
    await page.waitForURL(new RegExp(`/arbeitsbereich/${current}`), { timeout: 30_000 });
  });

  test('the realtime socket recovers from connecting before the session exists', async ({
    page,
  }) => {
    // `RealtimeProvider` lives in the root layout, so the socket opens on the
    // login page -- before anyone is signed in. The gateway rejects it and
    // Socket.IO does not reconnect after a server-initiated disconnect, so the
    // connection pill used to stay red for the entire visit and only a reload
    // fixed it. A first sign-in in a fresh browser hit this every time.
    await signIn(page, 'johanna');

    const status = page.getByTestId('connection-status');
    await expect(status).toHaveAttribute('data-app-socket', 'connected', { timeout: 30_000 });
  });

  test('refuses to register a new account', async ({ page, request }) => {
    // Self-registration is closed (`emailAndPassword.disableSignUp`). The route
    // is gone from the frontend and the endpoint rejects the call, so neither
    // half can quietly come back without this test noticing.
    const response = await page.goto('/registrieren');
    expect(response?.status()).toBe(404);

    const suffix = Date.now().toString(36);
    const api = await request.post('/api/auth/sign-up/email', {
      data: {
        name: `Testnutzer ${suffix}`,
        email: `test-${suffix}@exocortex.test`,
        password: `sicheres-passwort-${suffix}`,
      },
      failOnStatusCode: false,
    });
    expect(api.status()).toBe(400);
  });
});
