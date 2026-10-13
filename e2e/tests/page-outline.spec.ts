import { expect, type Page, test } from '@playwright/test';

import { requireSeedCredentials, waitForCollaboration, workspaceIdFrom } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

const SECTIONS = ['Einleitung', 'Architektur', 'Datenmodell', 'Betrieb', 'Sicherheit', 'Ausblick'];

/** A page long enough for the outline: six sections, each with a subsection. */
function longMarkdown(marker: string): string {
  const paragraph =
    'Ein Absatz, der lang genug ist, um eine Zeile zu füllen und die Seite in die Länge ' +
    'zu ziehen, damit die Gliederung etwas zu tun bekommt. ';
  return SECTIONS.map(
    (section) =>
      `## ${section} ${marker}\n\n${paragraph.repeat(6)}\n\n${paragraph.repeat(5)}\n\n` +
      `### Details zu ${section}\n\n${paragraph.repeat(6)}\n\n${paragraph.repeat(4)}\n`,
  ).join('\n');
}

async function importPage(page: Page, title: string, markdown: string): Promise<string> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  const workspaceId = workspaceIdFrom(page);
  const response = await page.request.post(`/api/workspaces/${workspaceId}/import/markdown`, {
    data: { markdown, title },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const id = ((await response.json()) as { document: { id: string } }).document.id;
  await page.goto(`/arbeitsbereich/${workspaceId}/seite/${id}`);
  await expect(page.getByTestId('editor-surface')).toBeVisible();
  await waitForCollaboration(page);
  return id;
}

async function exportMarkdown(page: Page, id: string): Promise<string> {
  const response = await page.request.get(`/api/documents/${id}/export/markdown`);
  return ((await response.json()) as { markdown: string }).markdown;
}

/** Distance of a heading from the top of the page's scroll container. */
async function headingOffset(page: Page, text: string): Promise<number> {
  return page.evaluate((needle) => {
    const scroller = document.querySelector('.exocortex-page-scroll') as HTMLElement;
    const heading = [...scroller.querySelectorAll('h2, h3')].find((element) =>
      element.textContent.includes(needle),
    ) as HTMLElement;
    return heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, text);
}

/**
 * The floating outline of a long page (issue #194). The rules underneath
 * (which headings a collapsed section hides, where the reading line sits,
 * which strokes the scale keeps) are unit tests in `packages/editor` and
 * `outline-geometry.test.ts`; this proves the loop in a real page.
 */
test.describe('page outline', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('leaves a short page alone', async ({ page }) => {
    await importPage(
      page,
      `Kurz ${Date.now().toString(36)}`,
      '## Eins\n\nText.\n\n## Zwei\n\nText.\n',
    );
    await expect(page.locator('.ProseMirror h2').first()).toBeVisible();
    await expect(page.getByTestId('page-outline-rail')).toHaveCount(0);
    await expect(page.getByTestId('page-outline-compact')).toHaveCount(0);
  });

  test('opens, jumps without editing, and follows the reader', async ({ page }) => {
    const marker = Date.now().toString(36);
    const id = await importPage(page, `Gliederung ${marker}`, longMarkdown(marker));
    const before = await exportMarkdown(page, id);

    const rail = page.getByTestId('page-outline-rail');
    await expect(rail).toBeVisible();

    // Keyboard: the trigger opens with Enter, Escape closes and hands focus back.
    await rail.focus();
    await page.keyboard.press('Enter');
    const popover = page.getByTestId('page-outline-popover');
    await expect(popover).toBeVisible();
    const entries = popover.getByTestId('page-outline-entry');
    await expect(entries).toHaveCount(SECTIONS.length * 2);
    await expect(entries.nth(0)).toContainText(`Einleitung ${marker}`);
    await expect(entries.nth(0)).toHaveAttribute('data-depth', '0');
    await expect(entries.nth(1)).toHaveAttribute('data-depth', '1');
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(rail).toBeFocused();

    // A jump puts the heading just below the top of the visible page.
    await rail.click();
    await popover.getByRole('button', { name: `Sicherheit ${marker}` }).click();
    await expect(popover).toBeHidden();
    await expect.poll(() => headingOffset(page, `Sicherheit ${marker}`)).toBeLessThan(60);
    await expect.poll(() => headingOffset(page, `Sicherheit ${marker}`)).toBeGreaterThan(0);

    await rail.click();
    await expect(popover.locator('[aria-current="location"]')).toContainText(
      `Sicherheit ${marker}`,
    );
    await page.keyboard.press('Escape');

    // Scrolling by hand moves the current section along.
    await page.evaluate((needle) => {
      const scroller = document.querySelector('.exocortex-page-scroll') as HTMLElement;
      const heading = [...scroller.querySelectorAll('h2')].find((element) =>
        element.textContent.includes(needle),
      ) as HTMLElement;
      scroller.scrollTop +=
        heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40;
    }, `Datenmodell ${marker}`);
    await rail.click();
    await expect(popover.locator('[aria-current="location"]')).toContainText(
      `Datenmodell ${marker}`,
    );
    await page.keyboard.press('Escape');

    // Navigating changed nothing in the document.
    expect(await exportMarkdown(page, id)).toBe(before);
  });

  test('follows a heading written from outside the editor', async ({ page }) => {
    const marker = Date.now().toString(36);
    const id = await importPage(page, `Live ${marker}`, longMarkdown(marker));
    await expect(page.getByTestId('page-outline-rail')).toBeVisible();

    const write = await page.request.post(`/api/documents/${id}/content`, {
      data: { markdown: `## Nachtrag ${marker}\n\nVon außen geschrieben.\n`, mode: 'append' },
    });
    expect(write.ok(), await write.text()).toBe(true);
    await expect(page.locator('.ProseMirror h2', { hasText: `Nachtrag ${marker}` })).toBeVisible({
      timeout: 30_000,
    });

    await page.getByTestId('page-outline-rail').click();
    const entries = page.getByTestId('page-outline-popover').getByTestId('page-outline-entry');
    await expect(entries.last()).toContainText(`Nachtrag ${marker}`);
  });

  test('lists a collapsed section once and does not unfold it', async ({ page }) => {
    const marker = Date.now().toString(36);
    await importPage(page, `Eingeklappt ${marker}`, longMarkdown(marker));
    const heading = page.locator('.ProseMirror h2', { hasText: `Architektur ${marker}` });
    await heading.hover();
    await heading.getByTestId('heading-toggle').click();
    await expect(
      page.locator('.ProseMirror h3', { hasText: 'Details zu Architektur' }),
    ).toBeHidden();

    await page.getByTestId('page-outline-rail').click();
    const popover = page.getByTestId('page-outline-popover');
    await expect(popover.getByTestId('page-outline-entry')).toHaveCount(SECTIONS.length * 2 - 1);
    await expect(popover.getByText('Details zu Architektur')).toHaveCount(0);
    await popover.getByRole('button', { name: new RegExp(`Architektur ${marker}`) }).click();
    await expect.poll(() => headingOffset(page, `Architektur ${marker}`)).toBeLessThan(60);
    await expect(
      page.locator('.ProseMirror h3', { hasText: 'Details zu Architektur' }),
    ).toBeHidden();
  });

  test('can be pinned beside the page where there is room', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    const marker = Date.now().toString(36);
    await importPage(page, `Angepinnt ${marker}`, longMarkdown(marker));
    await page.getByTestId('page-outline-rail').click();
    await page.getByTestId('page-outline-pin').click();
    const pinned = page.getByTestId('page-outline-pinned');
    await expect(pinned).toBeVisible();

    // It sits beside the text, never over it.
    const text = await page.locator('.ProseMirror').boundingBox();
    const box = await pinned.boundingBox();
    expect(box !== null && text !== null && box.x >= text.x + text.width).toBe(true);

    await page.reload();
    await expect(page.getByTestId('page-outline-pinned')).toBeVisible();
    await page.getByTestId('page-outline-pin').click();
    await expect(page.getByTestId('page-outline-rail')).toBeVisible();
  });
});

test.describe('page outline on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('is a compact button whose list stays on screen', async ({ page }) => {
    const marker = Date.now().toString(36);
    await importPage(page, `Telefon ${marker}`, longMarkdown(marker));
    const button = page.getByTestId('page-outline-compact');
    await expect(button).toBeVisible();
    await button.tap();
    const popover = page.getByTestId('page-outline-popover');
    await expect(popover).toBeVisible();
    const box = await popover.boundingBox();
    expect(box !== null && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    await popover.getByRole('button', { name: `Betrieb ${marker}` }).tap();
    await expect.poll(() => headingOffset(page, `Betrieb ${marker}`)).toBeLessThan(60);
  });
});
