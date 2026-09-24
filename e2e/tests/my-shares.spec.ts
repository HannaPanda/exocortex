import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

import { BASIC_AUTH_CREDENTIALS } from '../support/basic-auth';
import { recordWorkspace } from '../support/created-workspaces';
import { apiSignIn, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

/**
 * „Von mir geteilt“: jede eigene Freigabe, über alle Arbeitsbereiche.
 *
 * Die Frage dahinter ist „welche Seite habe ich eigentlich geteilt?“, und die
 * Antwort muss ohne Wissen um den Arbeitsbereich zu finden sein. Deshalb liegen
 * die beiden Seiten hier in zwei verschiedenen Arbeitsbereichen, und der Test
 * sucht sie nur über die eine Liste.
 */

test.use({ storageState: storageStatePath('johanna') });

let api: APIRequestContext;
let origin: string;
const workspaceIds: string[] = [];
const suffix = Date.now().toString(36);

test.beforeAll(async ({ playwright, baseURL }) => {
  requireSeedCredentials();
  origin = baseURL as string;
  api = await playwright.request.newContext({ httpCredentials: BASIC_AUTH_CREDENTIALS });
  await apiSignIn(api, 'johanna', origin);

  for (const name of [`Von mir A ${suffix}`, `Von mir B ${suffix}`]) {
    const created = await api.post(`${origin}/api/workspaces`, { data: { name } });
    expect(created.ok(), await created.text()).toBe(true);
    const id = ((await created.json()) as { id: string }).id;
    recordWorkspace(id);
    workspaceIds.push(id);
  }
});

test.afterAll(async () => {
  await api.dispose();
});

async function sharedPage(
  workspaceId: string,
  title: string,
): Promise<{ documentId: string; token: string }> {
  const created = await api.post(`${origin}/api/workspaces/${workspaceId}/documents`, {
    data: { title, type: 'PAGE' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const documentId = ((await created.json()) as { id: string }).id;
  const granted = await api.post(`${origin}/api/documents/${documentId}/shares`, {
    data: { kind: 'PUBLIC_LINK', scope: 'PAGE_ONLY' },
  });
  expect(granted.status(), await granted.text()).toBe(201);
  const { share } = (await granted.json()) as { share: { token: string } };
  return { documentId, token: share.token };
}

function row(page: Page, title: string) {
  return page.getByTestId('my-share').filter({ hasText: title });
}

test('beide Arbeitsbereiche stehen in einer Liste, und Zurückziehen fragt vorher', async ({
  page,
}) => {
  const [first, second] = workspaceIds as [string, string];
  const titleA = `Vergessener Link ${suffix}`;
  const titleB = `Zweiter Link ${suffix}`;
  const { documentId: documentA } = await sharedPage(first, titleA);
  const { token: tokenB } = await sharedPage(second, titleB);

  await page.goto('/arbeitsbereich');
  await page.getByTestId('open-global-menu').click();
  await page.getByTestId('menu-open-shared').click();
  await page.waitForURL('**/geteilt');
  await expect(page.getByTestId('shares-tab-mine')).toHaveAttribute('aria-selected', 'true');

  await expect(row(page, titleA)).toContainText(`Von mir A ${suffix}`);
  await expect(row(page, titleB)).toContainText(`Von mir B ${suffix}`);

  // Die volle Adresse steht wieder da (ADR-044, Nachtrag 2026-09-24), nicht nur
  // ihre ersten Zeichen, und sie ist die, die beim Anlegen herauskam.
  await expect(row(page, titleB).getByTestId('my-share-link-address')).toContainText(
    `/freigabe/${tokenB}`,
  );

  await row(page, titleA).getByTestId('my-share-revoke').click();
  await expect(row(page, titleA).getByTestId('my-share-revoke-confirm')).toContainText(
    'lässt sich nicht wiederherstellen',
  );
  await expect(row(page, titleA).getByTestId('my-share-revoke-cancel')).toBeFocused();
  await row(page, titleA).getByTestId('my-share-revoke-confirm-button').click();

  // Beendete stehen erst hinter dem Schalter.
  await expect(row(page, titleA)).toHaveCount(0);
  await page.getByTestId('my-shares-show-inactive').click();
  await expect(row(page, titleA)).toHaveAttribute('data-state', 'revoked');

  const shares = await api.get(`${origin}/api/documents/${documentA}/shares`);
  const body = (await shares.json()) as { shares: { revokedAt: string | null }[] };
  expect(body.shares.every((share) => share.revokedAt !== null)).toBe(true);
});

test('der zweite Reiter ist adressierbar, wie die Mail zum Entzug ihn verlinkt', async ({
  page,
}) => {
  await page.goto('/geteilt?ansicht=mit-mir');
  await expect(page.getByTestId('shares-tab-incoming')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('shares-tab-mine').click();
  await expect(page).toHaveURL(/\/geteilt$/);
});
