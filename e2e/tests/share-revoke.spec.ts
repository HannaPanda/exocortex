import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

import { BASIC_AUTH_CREDENTIALS } from '../support/basic-auth';
import { recordWorkspace } from '../support/created-workspaces';
import { apiSignIn, requireSeedCredentials, SEED_USERS } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

/**
 * Die Rückfrage vor dem Widerruf einer Freigabe.
 *
 * `shares.spec.ts` prüft die Berechtigungen und tut das bewusst über die API,
 * weil eine versteckte Oberfläche nie eine Absicherung ist. Hier geht es um
 * etwas anderes, das nur im Browser existiert: der Widerruf war ein einziger
 * Klick ohne Rückfrage, obwohl bei einem öffentlichen Link der Token danach weg
 * ist und sich nicht wiederherstellen lässt. Getestet wird deshalb, dass der
 * erste Klick nichts tut außer zu fragen, dass die Frage die Folge benennt und
 * dass es zwei Wege zurück gibt.
 */

test.use({ storageState: storageStatePath('johanna') });

let api: APIRequestContext;
let origin: string;
let workspaceId: string;

test.beforeAll(async ({ playwright, baseURL }) => {
  requireSeedCredentials();
  origin = baseURL as string;
  api = await playwright.request.newContext({ httpCredentials: BASIC_AUTH_CREDENTIALS });
  await apiSignIn(api, 'johanna', origin);

  const created = await api.post(`${origin}/api/workspaces`, {
    data: { name: `Widerruf ${Date.now().toString(36)}` },
  });
  expect(created.ok(), await created.text()).toBe(true);
  workspaceId = ((await created.json()) as { id: string }).id;
  recordWorkspace(workspaceId);
});

test.afterAll(async () => {
  await api.dispose();
});

/** Eine Seite mit genau einer Freigabe, frisch für jeden Test. */
async function pageWithShare(
  title: string,
  share: Record<string, unknown>,
): Promise<{ documentId: string; shareId: string }> {
  const created = await api.post(`${origin}/api/workspaces/${workspaceId}/documents`, {
    data: { title, type: 'PAGE' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const documentId = ((await created.json()) as { id: string }).id;

  const granted = await api.post(`${origin}/api/documents/${documentId}/shares`, { data: share });
  expect(granted.status(), await granted.text()).toBe(201);
  const shareId = ((await granted.json()) as { share: { id: string } }).share.id;
  return { documentId, shareId };
}

/** Wie viele Freigaben die API für diese Seite noch als aktiv führt. */
async function activeShareCount(documentId: string): Promise<number> {
  const response = await api.get(`${origin}/api/documents/${documentId}/shares`);
  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as { shares: { revokedAt: string | null }[] };
  return body.shares.filter((entry) => entry.revokedAt === null).length;
}

async function openShareDialog(page: Page, documentId: string): Promise<void> {
  await page.goto(`/arbeitsbereich/${workspaceId}/seite/${documentId}`);
  await page.getByTestId('document-actions').click();
  await page.getByTestId('open-share').click();
  await expect(page.getByTestId('share-dialog')).toBeVisible();
  await expect(page.getByTestId('share-row')).toHaveCount(1);
}

test.describe('Freigabe zurückziehen', () => {
  test('der erste Klick zieht nichts zurück, sondern fragt und benennt die Folge', async ({
    page,
  }) => {
    const { documentId } = await pageWithShare('Link mit Rückfrage', {
      kind: 'PUBLIC_LINK',
      scope: 'PAGE_ONLY',
    });
    await openShareDialog(page, documentId);

    await page.getByTestId('share-revoke').click();

    const confirmation = page.getByTestId('share-revoke-confirm');
    await expect(confirmation).toBeVisible();
    // Die zwei Tatsachen, für die es die Rückfrage gibt.
    await expect(confirmation).toContainText('funktioniert danach für niemanden mehr');
    await expect(confirmation).toContainText('lässt sich nicht wiederherstellen');
    // Und der Widerruf ist wirklich noch nicht passiert.
    expect(await activeShareCount(documentId)).toBe(1);

    // Der Tastaturfokus steht auf der sicheren Hälfte der Wahl, nicht auf dem
    // roten Knopf: sonst löscht ein zweites Enter die Freigabe.
    await expect(page.getByTestId('share-revoke-cancel')).toBeFocused();
  });

  test('ein Konto hört eine andere Folge als ein Link', async ({ page }) => {
    const { documentId } = await pageWithShare('Konto mit Rückfrage', {
      kind: 'USER',
      email: SEED_USERS.stefan.email,
      permission: 'READ',
      scope: 'SUBTREE',
    });
    await openShareDialog(page, documentId);
    await page.getByTestId('share-revoke').click();

    const confirmation = page.getByTestId('share-revoke-confirm');
    await expect(confirmation).toContainText(SEED_USERS.stefan.email);
    await expect(confirmation).toContainText('verliert den Zugriff sofort');
    // Der Umfang gehört zur Folge: bei SUBTREE hängt mehr als eine Seite dran.
    await expect(confirmation).toContainText('alles darunter');
    expect(await activeShareCount(documentId)).toBe(1);
  });

  test('Abbrechen und Escape führen beide zurück, ohne etwas zu ändern', async ({ page }) => {
    const { documentId } = await pageWithShare('Rückweg', {
      kind: 'PUBLIC_LINK',
      scope: 'PAGE_ONLY',
    });
    await openShareDialog(page, documentId);

    await page.getByTestId('share-revoke').click();
    await page.getByTestId('share-revoke-cancel').click();
    await expect(page.getByTestId('share-revoke-confirm')).toHaveCount(0);
    await expect(page.getByTestId('share-revoke')).toBeVisible();

    // Escape schließt die Frage und nicht gleich den ganzen Dialog: sonst
    // verliert ein Tastaturnutzer beim Abbrechen auch noch den Ort.
    await page.getByTestId('share-revoke').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('share-revoke-confirm')).toHaveCount(0);
    await expect(page.getByTestId('share-dialog')).toBeVisible();

    expect(await activeShareCount(documentId)).toBe(1);
  });

  test('erst der zweite Klick zieht zurück, und die Zeile verschwindet', async ({ page }) => {
    const { documentId } = await pageWithShare('Wirklich zurückgezogen', {
      kind: 'PUBLIC_LINK',
      scope: 'PAGE_ONLY',
    });
    await openShareDialog(page, documentId);

    await page.getByTestId('share-revoke').click();
    await page.getByTestId('share-revoke-confirm-button').click();

    await expect(page.getByTestId('share-row')).toHaveCount(0);
    await expect(page.getByTestId('share-dialog')).toContainText(
      'Niemand außerhalb dieses Arbeitsbereichs kann diese Seite erreichen.',
    );
    expect(await activeShareCount(documentId)).toBe(0);
  });
});

test.describe('Freigabe zurückziehen in der Übersicht des Arbeitsbereichs', () => {
  test('auch dort fragt der erste Klick nur, und erst der zweite zieht zurück', async ({
    page,
  }) => {
    const title = `Übersicht ${Date.now().toString(36)}`;
    const { documentId } = await pageWithShare(title, {
      kind: 'PUBLIC_LINK',
      scope: 'PAGE_ONLY',
    });
    await page.goto(`/arbeitsbereich/${workspaceId}/freigaben`);
    const row = page.getByTestId('workspace-share-row').filter({ hasText: title });
    await expect(row).toHaveAttribute('data-state', 'active');

    await row.getByTestId('workspace-share-revoke').click();
    await expect(page.getByTestId('workspace-share-revoke-confirm')).toContainText(
      'lässt sich nicht wiederherstellen',
    );
    await expect(page.getByTestId('workspace-share-revoke-cancel')).toBeFocused();
    expect(await activeShareCount(documentId)).toBe(1);

    await page.getByTestId('workspace-share-revoke-confirm-button').click();
    await expect(row).toHaveAttribute('data-state', 'revoked');
    expect(await activeShareCount(documentId)).toBe(0);
  });
});

test.describe('Freigabe zurückziehen auf Telefonbreite', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('die Rückfrage passt in den Dialog und beide Knöpfe sind erreichbar', async ({ page }) => {
    const { documentId } = await pageWithShare('Telefon', {
      kind: 'PUBLIC_LINK',
      scope: 'PAGE_ONLY',
    });
    await openShareDialog(page, documentId);
    await page.getByTestId('share-revoke').click();

    for (const testId of ['share-revoke-cancel', 'share-revoke-confirm-button']) {
      const button = page.getByTestId(testId);
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      if (box === null) throw new Error(`${testId} ist nicht gelayoutet`);
      expect(box.x, `${testId} ragt links hinaus`).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width, `${testId} ragt rechts hinaus`).toBeLessThanOrEqual(391);
      // Kein Ziel unter der Grenze aus WCAG 2.2 AA.
      expect(box.height, `${testId} ist zu flach`).toBeGreaterThanOrEqual(24);
    }
  });
});
