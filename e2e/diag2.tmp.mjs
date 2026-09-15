import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL: 'https://exocortex.app',
  storageState: 'support/.auth/johanna.json',
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();
await page.goto('/arbeitsbereich');
await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60000 });
const workspaceId = new URL(page.url()).pathname.split('/')[2];
const created = await page.request.post(`/api/workspaces/${workspaceId}/import/markdown`, {
  data: {
    markdown: 'Ein Absatz.\n',
    title:
      'Ein absurd langer Seitentitel, der in einer einzigen Zeile ganz sicher nicht mehr Platz findet und deshalb umbrechen muss',
  },
});
const id = (await created.json()).document.id;
await page.goto(`/arbeitsbereich/${workspaceId}/seite/${id}`);
await page.getByTestId('document-title').waitFor();
await page.waitForTimeout(1000);
const info = await page.getByTestId(`tree-link-${id}`).evaluate((link) => {
  const span = link.querySelector('span');
  const s = span ? getComputedStyle(span) : null;
  return {
    linkHtml: link.outerHTML.slice(0, 400),
    spanClass: span?.className,
    overflow: s?.overflow,
    textOverflow: s?.textOverflow,
    whiteSpace: s?.whiteSpace,
    display: s?.display,
    scrollWidth: span?.scrollWidth,
    clientWidth: span?.clientWidth,
  };
});
console.log(JSON.stringify(info, null, 2));
await page.request.delete(`/api/documents/${id}`);
await browser.close();
