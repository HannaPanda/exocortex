// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEditorExtensions } from './extensions';
import { type MediaDocumentInfo, type MediaInfoResolver } from './media';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/**
 * The PDF block, at the level of the DOM it actually renders.
 *
 * The browser's built-in PDF viewer comes with annotation tools and a save button
 * that this application cannot honour: the marks never reach the document and the
 * save writes the source file to disk. Switching that toolbar off is therefore a
 * correctness property, not styling, and the two actions that do work have to be
 * present in their place.
 */
describe('pdf block', () => {
  function insertPdf(): HTMLElement {
    editor = new Editor({ extensions: buildEditorExtensions(), content: '<p></p>' });
    editor.commands.insertMedia('pdf', {
      src: '/api/attachments/abc/download',
      name: 'Handbuch.pdf',
    });
    const container = editor.view.dom.querySelector('.exocortex-pdf');
    if (!(container instanceof window.HTMLElement)) throw new Error('no pdf container');
    return container;
  }

  it('hides the viewer toolbar', () => {
    const object = insertPdf().querySelector('object');
    expect(object?.getAttribute('data')).toBe('/api/attachments/abc/download#toolbar=0&navpanes=0');
    expect(object?.type).toBe('application/pdf');
  });

  it('offers opening and downloading, and names the file', () => {
    const container = insertPdf();
    expect(container.querySelector('.exocortex-pdf-name')?.textContent).toBe('Handbuch.pdf');

    const actions = [...container.querySelectorAll('.exocortex-pdf-header a')];
    expect(actions.map((anchor) => anchor.textContent)).toEqual(['Öffnen', 'Herunterladen']);
    // The plain link opens the file itself, without the viewer parameters.
    expect(actions.map((anchor) => anchor.getAttribute('href'))).toEqual([
      '/api/attachments/abc/download',
      '/api/attachments/abc/download',
    ]);
    expect(actions[1]?.hasAttribute('download')).toBe(true);
  });

  it('keeps a download link for a browser without a PDF viewer', () => {
    // `<object>` falls back to its children, which is why it is not an `<iframe>`.
    const fallback = insertPdf().querySelector('object a');
    expect(fallback?.getAttribute('href')).toBe('/api/attachments/abc/download');
  });
});

/**
 * What the block says about the document it shows.
 *
 * The editor knows no routes, so the answer comes from a resolver the host
 * injects. These tests are about the two halves of that seam: the block renders
 * what it is told, and it renders nothing at all when nobody tells it anything.
 */
describe('media block details', () => {
  const READY: MediaDocumentInfo = {
    status: 'ready',
    metadata: {
      title: 'Quartalsbericht Q3',
      author: 'Johanna Panda',
      createdAt: '2026-04-01T12:00:00.000Z',
      pageCount: 3,
      tableCount: 2,
      pictureCount: 0,
      ocrUsed: true,
    },
    error: null,
    filename: 'Kontoauszug-Q3.pdf',
  };

  /** Lets an assertion run after the resolver's promise has settled. */
  async function insertPdfWith(resolver: MediaInfoResolver): Promise<HTMLElement> {
    editor = new Editor({
      extensions: buildEditorExtensions({ mediaInfo: resolver }),
      content: '<p></p>',
    });
    editor.commands.insertMedia('pdf', { src: '/api/attachments/abc/download', name: 'Scan.pdf' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const container = editor.view.dom.querySelector('.exocortex-pdf');
    if (!(container instanceof window.HTMLElement)) throw new Error('no pdf container');
    return container;
  }

  function chipsOf(container: HTMLElement): string[] {
    return [...container.querySelectorAll('.exocortex-media-chip')].map(
      (chip) => chip.textContent ?? '',
    );
  }

  it('lists what the file turned out to be', async () => {
    const container = await insertPdfWith({ read: async () => READY });

    // No "0 Bilder": a count of zero is not worth a chip, and a null would be
    // a different thing again (nobody could tell).
    expect(chipsOf(container)).toEqual([
      'Quartalsbericht Q3',
      'Johanna Panda',
      '3 Seiten',
      '2 Tabellen',
      '01.04.2026',
      'per Texterkennung gelesen',
    ]);
  });

  it('renders nothing without a resolver, so server-side markup is unchanged', () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: '<p></p>' });
    editor.commands.insertMedia('pdf', { src: '/api/attachments/abc/download', name: 'Scan.pdf' });

    expect(editor.view.dom.querySelector('.exocortex-media-meta')).toBeNull();
  });

  it('stays quiet about a file that has no text layer to begin with', async () => {
    const container = await insertPdfWith({
      read: async () => ({ status: 'not_applicable', metadata: null, error: null, filename: 'notiz.txt' }),
    });

    // Every image, video and zip file answers this way. A line saying "no text"
    // under each of them would be noise.
    const bar = container.querySelector('.exocortex-media-meta');
    expect(bar).not.toBeNull();
    expect((bar as HTMLElement).hidden).toBe(true);
  });

  it('offers a retry when extraction failed, and keeps the reason', async () => {
    let requested = 0;
    const container = await insertPdfWith({
      read: async () => ({
        status: 'failed',
        metadata: { ...READY.metadata!, ocrUsed: null },
        error: 'No extractable text layer',
        filename: 'Scan.pdf',
      }),
      request: async () => {
        requested += 1;
        return { status: 'pending', metadata: null, error: null, filename: 'Scan.pdf' };
      },
    });

    const note = container.querySelector('.exocortex-media-chip-failed');
    expect(note?.textContent).toBe('Kein Text lesbar');
    // The full reason belongs in the block, but not on a second line.
    expect(note?.getAttribute('title')).toBe('No extractable text layer');

    const retry = container.querySelector('.exocortex-media-retry');
    if (!(retry instanceof window.HTMLButtonElement)) throw new Error('no retry button');
    retry.click();
    expect(requested).toBe(1);
  });

  it('names a block that was inserted with a URL and nothing else', async () => {
    // What the slash menu produces: `mediaBlocks.run` only ever passes a `src`,
    // so without this the header shows the download URL where the file name
    // belongs -- in documents that already exist, too.
    editor = new Editor({
      extensions: buildEditorExtensions({ mediaInfo: { read: async () => READY } }),
      content: '<p></p>',
    });
    editor.commands.insertMedia('pdf', { src: '/api/attachments/abc/download' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const container = editor.view.dom.querySelector('.exocortex-pdf');
    expect(container?.querySelector('.exocortex-pdf-name')?.textContent).toBe(
      'Kontoauszug-Q3.pdf',
    );
  });

  it('leaves a block that has its own name alone', async () => {
    const container = await insertPdfWith({ read: async () => READY });

    // Inserted as `Scan.pdf`; the stored file name must not overwrite it.
    expect(container.querySelector('.exocortex-pdf-name')?.textContent).toBe('Scan.pdf');
  });

  it('does not offer a retry a reader is not allowed to trigger', async () => {
    const container = await insertPdfWith({
      read: async () => ({ status: 'failed', metadata: null, error: null, filename: 'Scan.pdf' }),
    });

    expect(container.querySelector('.exocortex-media-retry')).toBeNull();
  });
});
