import { deflateRawSync } from 'node:zlib';

import { expect, test } from '@playwright/test';

import { requireSeedCredentials, workspaceIdFrom } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * That a LaTeX project can be created, edited and built from the browser
 * (issue #43, ADR-027).
 *
 * Written after the whole write half of the feature turned out to be dead on
 * arrival: `project-queries.ts` handed `JSON.stringify(request)` to a wrapper
 * that stringifies its body itself, so every project mutation left the browser
 * as a JSON *string* and came back `validation_failed`. Nothing in the
 * repository noticed -- the types are identical on both sides of the wrapper
 * (`body` is `unknown`), the tools reach the same routes through their own
 * client, and there was no browser test at all.
 *
 * So this test is deliberately the whole loop rather than one click: create,
 * write a file, build, and see a PDF. Each step is a different mutation, and
 * the bug was in all of them at once.
 */
test.describe('LaTeX-Projekt im Browser', () => {
  // A container build with latexmk at the end of it; the 90 s default is for a
  // test that only clicks.
  test.setTimeout(240_000);

  test('legt ein Projekt an, schreibt eine Datei und baut ein PDF', async ({ page }) => {
    const stamp = Date.now().toString(36);

    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const workspaceId = workspaceIdFrom(page);

    await page.getByTestId('create-root-page').click();
    await page.getByTestId('create-root-project').click();

    // The project route, not the page route: a PROJECT opens its own workspace
    // rather than the editor.
    await page.waitForURL(/\/projekt\/[a-z0-9]+/, { timeout: 60_000 });
    expect(workspaceIdFrom(page)).toBe(workspaceId);
    await expect(page.getByTestId('project-view')).toBeVisible();
    await expect(page.getByTestId('project-editor')).toBeVisible();

    const path = `kapitel/probe-${stamp}.tex`;
    await page.getByTestId('project-file-create').click();
    await page.getByTestId('project-new-path').fill(path);
    await page.getByRole('button', { name: 'Anlegen', exact: true }).click();

    // The tree is a projection rebuilt by a debounced job, so the row appears a
    // second or two after the write reaches the collaboration server.
    await expect(page.getByText(`probe-${stamp}.tex`)).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('project-build').click();

    // The first build of a project pulls the image's format files into place;
    // every one after that is cached.
    await expect(page.getByText('fertig', { exact: true })).toBeVisible({ timeout: 180_000 });
    await expect(page.getByLabel('Gebautes PDF')).toBeVisible();
  });
});

/**
 * That an existing thesis gets in and back out again (issue #54).
 *
 * The archive is built here rather than committed as a fixture, because the
 * interesting part is what the reader does with entries it did not write: a
 * folder entry, a shared top-level folder, and a file that collides with the
 * scaffolded `main.tex`. A committed `.zip` would hide all three behind a blob
 * nobody re-reads.
 */
test.describe('ZIP-Import und -Export', () => {
  test.setTimeout(180_000);

  test('liest ein Archiv ein und gibt das Projekt wieder heraus', async ({ page }) => {
    const stamp = Date.now().toString(36);

    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });

    await page.getByTestId('create-root-page').click();
    await page.getByTestId('create-root-project').click();
    await page.waitForURL(/\/projekt\/[a-z0-9]+/, { timeout: 60_000 });
    await expect(page.getByTestId('project-view')).toBeVisible();

    // One shared folder, one folder entry, and a main file that collides with
    // the scaffold the new project already has.
    const archive = zipArchive([
      ['arbeit/', ''],
      ['arbeit/main.tex', '\\documentclass{article}\\begin{document}Aus dem Archiv\\end{document}'],
      [`arbeit/kapitel/intro-${stamp}.tex`, 'Einleitung'],
      ['arbeit/__MACOSX/._main.tex', 'Müll'],
    ]);
    await page
      .getByTestId('project-import')
      .setInputFiles({ name: 'arbeit.zip', mimeType: 'application/zip', buffer: archive });

    const result = page.getByTestId('project-import-result');
    await expect(result).toBeVisible({ timeout: 60_000 });
    // The shared folder is gone from the paths, and `main.tex` was left alone
    // because the scaffold is sitting on it.
    await expect(result.getByText('arbeit', { exact: false }).first()).toBeVisible();
    await page.getByTestId('project-import-overwrite').click();
    await expect(page.getByTestId('project-import-overwrite')).toBeHidden({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Schließen', exact: true }).click();

    await expect(page.getByText(`intro-${stamp}.tex`)).toBeVisible({ timeout: 30_000 });

    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByTestId('project-export').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.zip$/);
  });
});

// ---------------------------------------------------------------------------
// A ZIP archive, by hand
// ---------------------------------------------------------------------------

/**
 * The smallest archive a real reader accepts, written here so the test owns
 * every byte of what it feeds the import.
 */
function zipArchive(entries: readonly [string, string][]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const payload = raw.byteLength === 0 ? raw : deflateRawSync(raw);
    const method = raw.byteLength === 0 ? 0 : 8;

    const local = Buffer.alloc(30 + nameBytes.byteLength);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(payload.byteLength, 18);
    local.writeUInt32LE(raw.byteLength, 22);
    local.writeUInt16LE(nameBytes.byteLength, 26);
    nameBytes.copy(local, 30);

    const central = Buffer.alloc(46 + nameBytes.byteLength);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(payload.byteLength, 20);
    central.writeUInt32LE(raw.byteLength, 24);
    central.writeUInt16LE(nameBytes.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.byteLength + payload.byteLength;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
