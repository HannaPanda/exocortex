import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL: 'https://exocortex.app',
  storageState: 'support/.auth/johanna.json',
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200));
});
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));

await page.goto('/arbeitsbereich');
await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60000 });
const workspaceId = new URL(page.url()).pathname.split('/')[2];
const title =
  'Ein absurd langer Seitentitel, der in einer einzigen Zeile ganz sicher nicht mehr Platz findet und deshalb umbrechen muss';
const created = await page.request.post(`/api/workspaces/${workspaceId}/import/markdown`, {
  data: { markdown: 'Ein Absatz.\n', title },
});
const id = (await created.json()).document.id;
await page.goto(`/arbeitsbereich/${workspaceId}/seite/${id}`);
await page.getByTestId('document-title').waitFor();
await page.waitForTimeout(1000);

console.log('Zeilen im Baum vorher:', await page.locator('[data-testid^="tree-item-"]').count());
await page.getByTestId(`tree-link-${id}`).hover();
await page.waitForTimeout(1500);
console.log(
  'Zeilen im Baum beim Hovern:',
  await page.locator('[data-testid^="tree-item-"]').count(),
);

const popup = page.locator('[data-slot="tooltip-content"]');
console.log('Tooltips:', await popup.count());
if (await popup.count()) {
  console.log('Box:', JSON.stringify(await popup.first().boundingBox()));
  console.log(
    'Styles:',
    JSON.stringify(
      await popup.first().evaluate((el) => {
        const s = getComputedStyle(el);
        const pos = el.parentElement ? getComputedStyle(el.parentElement) : null;
        return {
          maxWidth: s.maxWidth,
          whiteSpace: s.whiteSpace,
          width: s.width,
          parentTransform: pos?.transform,
          parentPosition: pos?.position,
          parentLeft: pos?.left,
          parentTop: pos?.top,
        };
      }),
    ),
  );
}
await page.request.delete(`/api/documents/${id}`);
await browser.close();
