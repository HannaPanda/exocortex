import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';

import { BASIC_AUTH_CREDENTIALS } from '../support/basic-auth';
import { recordWorkspace } from '../support/created-workspaces';
import { apiSignIn, requireSeedCredentials, SEED_USERS } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

/**
 * Der Teilen-Dialog mit viel Inhalt (issue #230).
 *
 * Der Dialog war für eine Freigabe gebaut und hat mit zwölf nicht mitgehalten:
 * der Satz jeder Freigabe endete in einer Ellipse, eine lange Adresse im
 * Hinweis auf geerbte Freigaben schob den Text rechts aus dem Kasten, und weil
 * der ganze Dialog scrollte, verschwanden Titel und Schließen-Knopf mit der
 * Liste. Geprüft wird hier, was davon im Browser messbar ist: nichts ragt aus
 * seinem Kasten, die Liste scrollt zwischen Kopf und Fuß, und Tastatur und
 * Escape tun, was sie vorher taten.
 */

test.use({ storageState: storageStatePath('johanna') });

/** Länger als jede Zeile im Dialog breit ist, und ohne Leerzeichen zum Umbrechen. */
const LONG_ADDRESS =
  'eine.ausgesprochen.lange.adresse.ohne.jede.leerstelle.zum.umbrechen@eine-lange-domain.example';

let api: APIRequestContext;
let origin: string;
let workspaceId: string;
let documentId: string;

test.beforeAll(async ({ playwright, baseURL }) => {
  requireSeedCredentials();
  origin = baseURL as string;
  api = await playwright.request.newContext({ httpCredentials: BASIC_AUTH_CREDENTIALS });
  await apiSignIn(api, 'johanna', origin);

  const created = await api.post(`${origin}/api/workspaces`, {
    data: { name: `Teilen-Dialog ${Date.now().toString(36)}` },
  });
  expect(created.ok(), await created.text()).toBe(true);
  workspaceId = ((await created.json()) as { id: string }).id;
  recordWorkspace(workspaceId);

  const page = async (title: string, parentId?: string): Promise<string> => {
    const response = await api.post(`${origin}/api/workspaces/${workspaceId}/documents`, {
      data: { title, type: 'PAGE', ...(parentId === undefined ? {} : { parentId }) },
    });
    expect(response.status(), await response.text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };
  const share = async (target: string, data: Record<string, unknown>): Promise<void> => {
    const response = await api.post(`${origin}/api/documents/${target}/shares`, { data });
    expect(response.status(), await response.text()).toBe(201);
  };

  const parentId = await page('Ein Bereich, der schon von weiter oben freigegeben ist');
  documentId = await page(
    'Eine Seite mit einem so langen Titel, dass die Überschrift des Dialogs umbrechen muss',
    parentId,
  );
  await share(parentId, {
    kind: 'USER',
    email: SEED_USERS.stefan.email,
    permission: 'READ',
    scope: 'SUBTREE',
    expiresInDays: 90,
  });
  await share(documentId, {
    kind: 'USER',
    email: SEED_USERS.stefan.email,
    permission: 'WRITE',
    scope: 'SUBTREE',
    expiresInDays: 30,
  });
  for (let index = 0; index < 10; index += 1) {
    await share(documentId, {
      kind: 'PUBLIC_LINK',
      scope: index % 2 === 0 ? 'PAGE_ONLY' : 'SUBTREE',
      expiresInDays: index % 3 === 0 ? null : 30,
    });
  }
});

test.afterAll(async () => {
  await api.dispose();
});

async function openShareDialog(page: Page): Promise<Locator> {
  await page.goto(`/arbeitsbereich/${workspaceId}/seite/${documentId}`);
  await page.getByTestId('document-actions').click();
  await page.getByTestId('open-share').click();
  const dialog = page.getByTestId('share-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('share-row')).toHaveCount(11);
  return dialog;
}

/**
 * An account with an address this long cannot be invited here (only the two
 * seed accounts exist), so the inherited grant's sentence is lengthened in
 * place. What is measured is the layout's answer to a long word, which is the
 * same whoever wrote it.
 */
async function lengthenAddress(page: Page): Promise<void> {
  await page
    .locator('[data-testid="share-inherited"] li, [data-testid="share-row-description"]')
    .evaluateAll(
      (nodes, [short, long]) => {
        for (const node of nodes) {
          if (node.textContent?.includes(short) === true) {
            node.textContent = node.textContent.replace(short, long);
          }
        }
      },
      [SEED_USERS.stefan.email, LONG_ADDRESS] as const,
    );
}

/** Every element of the dialog that sticks out of the dialog to the right. */
async function overflowingRight(dialog: Locator): Promise<string[]> {
  return dialog.evaluate((root) => {
    const edge = root.getBoundingClientRect().right;
    return [...root.querySelectorAll('*')]
      .filter((node) => node.getBoundingClientRect().right > edge + 1)
      .map((node) => `${node.tagName} ${(node.textContent ?? '').trim().slice(0, 40)}`);
  });
}

/** Text that is cut off by its own box (an ellipsis), as opposed to wrapped. */
async function cutDescriptions(page: Page): Promise<number> {
  return page
    .getByTestId('share-row-description')
    .evaluateAll(
      (nodes) =>
        nodes.filter(
          (node) =>
            node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1,
        ).length,
    );
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`Teilen-Dialog bei ${viewport.width} px`, () => {
    test.use({ viewport });

    test('nichts ragt heraus, und die Liste scrollt zwischen Kopf und Fuß', async ({ page }) => {
      const dialog = await openShareDialog(page);
      await lengthenAddress(page);

      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      if (box === null) return;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

      expect(await overflowingRight(dialog)).toEqual([]);
      expect(await cutDescriptions(page)).toBe(0);
      const pageOverflows = await page
        .locator('html')
        .evaluate((root) => root.scrollWidth > root.clientWidth);
      expect(pageOverflows).toBe(false);

      // The list is taller than the screen, so the middle scrolls -- and the
      // title, the close button and the footer stay where they are.
      const body = page.getByTestId('share-dialog-body');
      const scrolls = await body.evaluate((node) => node.scrollHeight > node.clientHeight);
      expect(scrolls).toBe(true);
      await page.getByTestId('share-row').last().scrollIntoViewIfNeeded();
      await expect(page.getByTestId('share-row').last()).toBeInViewport();
      await expect(dialog.locator('[data-slot="dialog-title"]')).toBeInViewport();
      await expect(dialog.getByRole('button', { name: 'Schließen' }).last()).toBeInViewport();
    });

    test('Tab bleibt im Dialog, und Escape schließt ihn', async ({ page }) => {
      const dialog = await openShareDialog(page);
      for (let step = 0; step < 50; step += 1) await page.keyboard.press('Tab');
      const inside = await dialog.evaluate((root) =>
        root.contains(root.ownerDocument.activeElement),
      );
      expect(inside).toBe(true);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });
  });
}
