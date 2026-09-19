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

const SIGN_IN_ENDPOINT = '/api/auth/sign-in/email';

/**
 * Says why the sign-in did not arrive anywhere.
 *
 * The form reports every failure as "E-Mail-Adresse oder Passwort ist falsch",
 * so the page cannot be asked -- and without the status the setup simply waits
 * a minute for a navigation that is never coming and reports a timeout, which
 * names the symptom and hides all three causes.
 */
function describeSignInFailure(user: SeedUserKey, status: number | null): string {
  if (status === null) {
    return (
      `Signing ${user} in never reached ${SIGN_IN_ENDPOINT}. The deployment under test is ` +
      `probably not answering, or it is answering something other than this application.`
    );
  }
  if (status === 429) {
    return (
      `Signing ${user} in was refused with HTTP 429: the deployment allows ten sign-ins per ` +
      `minute and client address, and this run used them up. Starting the suite several times ` +
      `in quick succession is enough. Wait a minute and run it again.`
    );
  }
  if (status === 401 || status === 403) {
    return (
      `Signing ${user} in was refused with HTTP ${status}: the password in the repository's ` +
      `.env is not the one this deployment has. docs/local-development.md says how to reissue it.`
    );
  }
  return `Signing ${user} in was answered with HTTP ${status} instead of a session.`;
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
      // A box rather than a plain variable, because what the listener writes has
      // to be readable from the catch below.
      const signIn: { status: number | null } = { status: null };
      page.on('response', (response) => {
        if (response.url().includes(SIGN_IN_ENDPOINT)) signIn.status = response.status();
      });

      await page.goto('/anmelden');
      await page.getByLabel('E-Mail-Adresse').fill(SEED_USERS[user].email);
      await page.getByLabel('Passwort').fill(SEED_USERS[user].password);
      await page.getByTestId('signin-submit').click();
      try {
        // Not a bare `/arbeitsbereich`: the landing page resolves the workspace
        // and replaces itself, and the id is the whole point of waiting here.
        await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
      } catch (cause) {
        throw new Error(describeSignInFailure(user, signIn.status), { cause });
      }
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
