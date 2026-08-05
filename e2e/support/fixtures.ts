import { type APIRequestContext, type Browser, type BrowserContext, expect, type Page } from '@playwright/test';

import { storageStatePath } from './global-setup';

/**
 * Shared helpers for the end-to-end suite.
 *
 * Credentials come from the environment: the seed script prints them, and
 * `pnpm db:seed` writes them nowhere else. Never hardcode a password here.
 */
export const SEED_USERS = {
  johanna: {
    email: 'johanna@exocortex.app',
    name: 'Johanna',
    password: process.env.SEED_JOHANNA_PASSWORD ?? '',
  },
  stefan: {
    email: 'stefan@exocortex.app',
    name: 'Stefan',
    password: process.env.SEED_STEFAN_PASSWORD ?? '',
  },
} as const;

export type SeedUserKey = keyof typeof SEED_USERS;

export function requireSeedCredentials(): void {
  for (const [key, user] of Object.entries(SEED_USERS)) {
    if (user.password.length === 0) {
      throw new Error(
        `Missing password for seed user "${key}". Run \`pnpm db:seed\` and export ` +
          `SEED_JOHANNA_PASSWORD / SEED_STEFAN_PASSWORD (see docs/local-development.md).`,
      );
    }
  }
}

/** Signs in through the real login form. */
export async function signIn(page: Page, user: SeedUserKey = 'johanna'): Promise<void> {
  const credentials = SEED_USERS[user];
  await page.goto('/anmelden');
  await page.getByLabel('E-Mail-Adresse').fill(credentials.email);
  await page.getByLabel('Passwort').fill(credentials.password);
  await page.getByTestId('signin-submit').click();
  await page.waitForURL(/\/arbeitsbereich/, { timeout: 30_000 });
}

/**
 * Opens a browser context that is already signed in, using the session stored by
 * the global setup. This keeps the suite off the sign-in rate limiter.
 */
export async function createSignedInContext(
  browser: Browser,
  user: SeedUserKey,
  baseURL: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL,
    storageState: storageStatePath(user),
    httpCredentials: {
      username: process.env.E2E_BASIC_USER ?? 'johanna',
      password: process.env.E2E_BASIC_PASSWORD ?? 'test123',
    },
  });
  const page = await context.newPage();
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  return { context, page };
}

/** Waits until the page tree contains a node with the given title. */
export async function expectTreeContains(page: Page, title: string): Promise<void> {
  await expect(page.getByTestId('page-tree').getByText(title, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

/** Creates a page from the sidebar and returns its document id. */
export async function createPage(page: Page, title: string): Promise<string> {
  await page.getByTestId('create-root-page').click();
  await page.waitForURL(/\/seite\/[a-z0-9]+/, { timeout: 30_000 });
  const documentId = new URL(page.url()).pathname.split('/').pop() as string;
  const titleInput = page.getByTestId('document-title');
  await titleInput.fill(title);
  await titleInput.blur();
  await expectTreeContains(page, title);
  return documentId;
}

/** Reads the active workspace id from the URL. */
export function workspaceIdFrom(page: Page): string {
  const match = /\/arbeitsbereich\/([a-z0-9]+)/.exec(new URL(page.url()).pathname);
  if (match === null) throw new Error(`No workspace id in URL: ${page.url()}`);
  return match[1] as string;
}

/** Signs in through the API and returns an authenticated request context. */
export async function apiSignIn(
  request: APIRequestContext,
  user: SeedUserKey,
  baseURL: string,
): Promise<void> {
  const credentials = SEED_USERS[user];
  const response = await request.post(`${baseURL}/api/auth/sign-in/email`, {
    data: { email: credentials.email, password: credentials.password },
    headers: { origin: baseURL },
  });
  expect(response.status(), await response.text()).toBe(200);
}

/**
 * Waits until the collaboration server has persisted the document and the
 * materialization job has run.
 *
 * Persistence is debounced on purpose (see ADR-005), so a test that reads derived
 * data right after typing would race the pipeline. The job progress indicator is
 * the observable signal that the worker finished.
 */
export async function waitForMaterialization(page: Page): Promise<void> {
  const indicator = page.getByTestId('job-progress');
  await expect(indicator).toBeVisible({ timeout: 60_000 });
  await expect(indicator).toBeHidden({ timeout: 60_000 });
}
