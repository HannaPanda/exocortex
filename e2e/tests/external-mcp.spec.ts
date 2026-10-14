import { type APIRequestContext, expect, type Page, type Route, test } from '@playwright/test';

import { BASIC_AUTH_CREDENTIALS } from '../support/basic-auth';
import { recordWorkspace } from '../support/created-workspaces';
import { apiSignIn, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

/**
 * „Externe Werkzeuge“ in den Einstellungen des Arbeitsbereichs (issue #196).
 *
 * Ein echter fremder MCP-Server müsste öffentlich per https erreichbar sein,
 * und der Schalter `ai.externalMcpEnabled` gehört der Betreiberin, nicht der
 * Suite. Deshalb prüft der erste Test nur, dass der Reiter mit der echten API
 * erscheint, und der zweite ersetzt die Antworten der API im Browser durch
 * einen Server mit drei Werkzeugen: So ist jeder Zustand einer Zeile zu sehen,
 * ohne dass eine Anfrage die Instanz verlässt.
 */

test.use({ storageState: storageStatePath('johanna') });

let api: APIRequestContext;
let workspaceId: string;

test.beforeAll(async ({ playwright, baseURL }) => {
  requireSeedCredentials();
  const origin = baseURL as string;
  api = await playwright.request.newContext({ httpCredentials: BASIC_AUTH_CREDENTIALS });
  await apiSignIn(api, 'johanna', origin);
  const created = await api.post(`${origin}/api/workspaces`, {
    data: { name: `Externe Werkzeuge ${Date.now().toString(36)}` },
  });
  expect(created.ok(), await created.text()).toBe(true);
  workspaceId = ((await created.json()) as { id: string }).id;
  recordWorkspace(workspaceId);
});

test.afterAll(async () => {
  await api.dispose();
});

const NOW = '2026-10-14T09:00:00.000Z';

function tool(overrides: Record<string, unknown>) {
  return {
    id: 'tool',
    name: 'tool',
    functionName: 'mcp_health__tool',
    title: null,
    description: '',
    inputSchema: { type: 'object', properties: {} },
    hints: {},
    problem: null,
    available: true,
    access: 'blocked',
    suggestedAccess: 'write',
    changedSinceApproval: false,
    approvedAt: null,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

function fixtureServer(readAccess: string) {
  return {
    id: 'srv1',
    workspaceId,
    key: 'health',
    name: 'Health-App',
    transport: 'streamable_http',
    url: 'https://health.example.org/mcp',
    enabled: true,
    trusted: false,
    authKind: 'bearer',
    authHeaderName: null,
    secretConfigured: true,
    secretHint: 'x9Qa',
    status: 'ok',
    lastCheckedAt: NOW,
    lastOkAt: NOW,
    lastErrorCode: null,
    lastErrorDetail: null,
    serverName: 'health-mcp',
    serverVersion: '1.4.0',
    protocolVersion: '2025-06-18',
    instructions: 'Werte immer in metrischen Einheiten.',
    toolsTruncated: false,
    tools: [
      tool({
        id: 't1',
        name: 'get_weight',
        functionName: 'mcp_health__get_weight',
        title: 'Gewicht abrufen',
        description: 'Liefert die Gewichtsmessungen eines Zeitraums.',
        inputSchema: { type: 'object', properties: { from: { type: 'string' } } },
        hints: { readOnlyHint: true },
        suggestedAccess: 'read',
        access: readAccess,
        approvedAt: readAccess === 'read' ? NOW : null,
      }),
      tool({
        id: 't2',
        name: 'log_meal',
        functionName: 'mcp_health__log_meal',
        title: 'Mahlzeit eintragen',
        description: 'Trägt eine Mahlzeit mit Kalorien ein.',
        hints: { readOnlyHint: false, destructiveHint: false },
        changedSinceApproval: true,
      }),
      tool({
        id: 't3',
        name: 'export everything',
        functionName: 'mcp_health__export everything',
        problem: 'invalid_name',
      }),
    ],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function openTab(page: Page): Promise<void> {
  await page.goto(`/arbeitsbereich/${workspaceId}/einstellungen?tab=tools`);
  await expect(page.getByTestId('external-mcp-panel')).toBeVisible({ timeout: 30_000 });
}

test('der Reiter erscheint für die Besitzerin und liest die echte API', async ({ page }) => {
  await openTab(page);
  await expect(page.getByTestId('tab-external-tools')).toBeVisible();
  // Live ist der Schalter der Instanz aus oder an; beides ist ein gültiger
  // Zustand, und jeder hat sein eigenes, sichtbares Zeichen.
  // Der Knopf zum Anbinden ist immer da und genau dann gesperrt, wenn der
  // Hinweis auf den ausgeschalteten Schalter erscheint.
  const add = page.getByTestId('external-mcp-add');
  await expect(add).toBeVisible();
  if (await page.getByTestId('external-mcp-disabled').isVisible()) {
    await expect(add).toBeDisabled();
  } else {
    await expect(add).toBeEnabled();
  }
});

test('jedes Werkzeug zeigt seinen Zustand und wird per Klick freigegeben', async ({
  page,
}, testInfo) => {
  let access = 'blocked';
  const patched: unknown[] = [];
  await page.route(`**/api/workspaces/${workspaceId}/mcp-servers**`, async (route: Route) => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as { access: string };
      patched.push(body);
      access = body.access;
      await route.fulfill({ json: { server: fixtureServer(access) } });
      return;
    }
    await route.fulfill({
      json: { servers: [fixtureServer(access)], enabled: true, credentialsAvailable: true },
    });
  });

  await openTab(page);
  const rows = page.getByTestId('mcp-tool-row');
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId('external-mcp-status')).toHaveAttribute('data-status', 'ok');
  await expect(rows.nth(1).getByTestId('mcp-tool-changed')).toBeVisible();
  await expect(rows.nth(2).getByTestId('mcp-tool-problem')).toBeVisible();
  await expect(rows.nth(2).getByTestId('mcp-tool-access-read')).toBeDisabled();

  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true });

  await rows.nth(0).getByTestId('mcp-tool-access-read').click();
  await expect.poll(() => patched).toEqual([{ access: 'read' }]);
  await expect(rows.nth(0).getByTestId('mcp-tool-access-read')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByTestId('external-mcp-edit').click();
  await expect(page.getByTestId('mcp-form-key')).toBeDisabled();

  await page.setViewportSize({ width: 390, height: 1600 });
  await page.screenshot({ path: testInfo.outputPath('narrow.png'), fullPage: true });
});

test('die Vorschläge lassen sich gesammelt übernehmen, geänderte bleiben außen vor', async ({
  page,
}) => {
  let access = 'blocked';
  const patched: { url: string; body: unknown }[] = [];
  await page.route(`**/api/workspaces/${workspaceId}/mcp-servers**`, async (route: Route) => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      patched.push({ url: request.url(), body: request.postDataJSON() });
      access = 'read';
      await route.fulfill({ json: { server: fixtureServer(access) } });
      return;
    }
    await route.fulfill({
      json: { servers: [fixtureServer(access)], enabled: true, credentialsAvailable: true },
    });
  });

  await openTab(page);
  await expect(
    page.getByTestId('mcp-tool-row').nth(0).getByTestId('mcp-tool-suggested'),
  ).toBeVisible();
  await page.getByTestId('external-mcp-suggestions-review').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('get_weight');
  await expect(dialog).not.toContainText('log_meal');
  await dialog.getByTestId('external-mcp-suggestions-apply').click();

  await expect
    .poll(() => patched)
    .toEqual([
      {
        url: expect.stringMatching(/\/mcp-servers\/srv1\/tools$/u) as unknown as string,
        body: { changes: [{ toolId: 't1', access: 'read' }] },
      },
    ]);
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('external-mcp-suggestions-review')).toBeHidden();
});
