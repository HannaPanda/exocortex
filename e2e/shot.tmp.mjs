import { chromium } from '@playwright/test';

const OUT = '/tmp/claude-1000/-var-www-exocortex/49753237-4d57-4ef4-81e9-9692578f5b33/scratchpad';
const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL: 'https://exocortex.app',
  storageState: 'support/.auth/johanna.json',
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();
await page.goto('https://exocortex.app/arbeitsbereich');
await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60000 });
const workspaceId = new URL(page.url()).pathname.split('/')[2];

// A page with a title far too long for one line.
const title =
  'Ein absurd langer Seitentitel, der in einer einzigen Zeile ganz sicher nicht mehr Platz findet und deshalb umbrechen muss';
const created = await page.request.post(`/api/workspaces/${workspaceId}/import/markdown`, {
  data: { markdown: 'Ein Absatz unter dem langen Titel.\n', title },
});
const id = (await created.json()).document.id;

await page.goto(`https://exocortex.app/arbeitsbereich/${workspaceId}/seite/${id}`);
await page.getByTestId('document-title').waitFor();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/titel-umbruch.png` });

// Hover the tree row to show the tooltip.
const row = page.getByTestId(`tree-link-${id}`);
await row.hover();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/tooltip.png` });

await page.request.delete(`/api/documents/${id}`);
console.log('ok', id);
await browser.close();
