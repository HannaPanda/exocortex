import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, type FullConfig } from '@playwright/test';

import { BASIC_AUTH_CREDENTIALS } from './basic-auth';
import { requireSeedCredentials, SEED_USERS, type SeedUserKey } from './fixtures';
import { recordRunScope } from './run-scope';

/**
 * Signs the seed users in once and stores their session cookies.
 *
 * Sign-in is deliberately rate limited in the application, so repeating it in
 * every test would exercise the limiter instead of the feature under test. Only
 * `auth.spec.ts` drives the login form itself.
 */
export const AUTH_STATE_DIRECTORY = join(__dirname, '.auth');

export function storageStatePath(user: SeedUserKey): string {
  return join(AUTH_STATE_DIRECTORY, `${user}.json`);
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  requireSeedCredentials();
  mkdirSync(AUTH_STATE_DIRECTORY, { recursive: true });

  const baseURL = config.projects[0]?.use.baseURL ?? 'https://exocortex.app';
  const httpCredentials = BASIC_AUTH_CREDENTIALS;
  // Taken before the first sign-in, so nothing the run creates falls outside the
  // window the teardown cleans up.
  const startedAt = new Date().toISOString();
  const workspaceIds = new Set<string>();

  const browser = await chromium.launch();
  try {
    for (const user of Object.keys(SEED_USERS) as SeedUserKey[]) {
      const context = await browser.newContext({ baseURL, httpCredentials });
      const page = await context.newPage();
      await page.goto('/anmelden');
      await page.getByLabel('E-Mail-Adresse').fill(SEED_USERS[user].email);
      await page.getByLabel('Passwort').fill(SEED_USERS[user].password);
      await page.getByTestId('signin-submit').click();
      // Not a bare `/arbeitsbereich`: the landing page resolves the workspace and
      // replaces itself, and the id is the whole point of waiting here.
      await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
      const workspaceId = /\/arbeitsbereich\/([a-z0-9]+)/.exec(page.url())?.[1];
      if (workspaceId !== undefined) workspaceIds.add(workspaceId);
      await context.storageState({ path: storageStatePath(user) });
      await context.close();
    }
  } finally {
    await browser.close();
  }

  recordRunScope({ startedAt, workspaceIds: [...workspaceIds] });
}
