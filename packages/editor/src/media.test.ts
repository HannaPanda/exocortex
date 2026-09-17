// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEditorExtensions } from './extensions';
import { type MediaDocumentDetail, type MediaDocumentInfo, type MediaInfoResolver } from './media';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/**
 * The PDF block, at the level of the DOM it actually renders.
 *
 * These assertions are about a seam rather than about styling (issue #70). The
 * block does not draw the file: it cannot, because this package is read by the
 * server as well and a PDF renderer has no business in a Markdown export. So
 * the host is handed a box to draw into, and everything below is one of the two
 * halves of that arrangement -- the box appears when a host offers a renderer,
 * and the block is still readable when none does.
 *
 * What is deliberately *not* here any more is an `<object>`. It was refused by
 * the application's own `object-src 'none'` on every page load, silently, for
 * as long as the block existed; a test that asserted its attributes passed
 * throughout.
 */
describe('pdf block', () => {
  function insertPdf(mediaInfo?: MediaInfoResolver): HTMLElement {
    editor = new Editor({
      extensions: buildEditorExtensions(mediaInfo === undefined ? undefined : { mediaInfo }),
      content: '<p></p>',
    });
    editor.commands.insertMedia('pdf', {
      src: '/api/attachments/abc/download',
      name: 'Handbuch.pdf',
    });
    const container = editor.view.dom.querySelector('.exocortex-pdf');
    if (!(container instanceof window.HTMLElement)) throw new Error('no pdf container');
    return container;
  }

  it('embeds nothing the content security policy refuses', () => {
    const container = insertPdf();
    expect(container.querySelector('object')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('embed')).toBeNull();
  });

  it('offers opening and downloading, and names the file', () => {
    const container = insertPdf();
    expect(container.querySelector('.exocortex-pdf-name')?.textContent).toBe('Handbuch.pdf');

    const actions = [...container.querySelectorAll('.exocortex-pdf-header a')];
    expect(actions.map((anchor) => anchor.textContent)).toEqual(['Öffnen', 'Herunterladen']);
    expect(actions.map((anchor) => anchor.getAttribute('href'))).toEqual([
      '/api/attachments/abc/download',
      '/api/attachments/abc/download',
    ]);
    expect(actions[1]?.hasAttribute('download')).toBe(true);
  });

  it('gives the host a box to draw the pages into, and takes it down again', () => {
    const drawn: string[] = [];
    let unmounted = 0;
    const resolver: MediaInfoResolver = {
      read: () => Promise.resolve(null),
      renderPdf: (container, src) => {
        drawn.push(src);
        container.textContent = 'gezeichnet';
        return () => {
          unmounted += 1;
        };
      },
    };

    const container = insertPdf(resolver);
    const viewport = container.querySelector('.exocortex-pdf-viewport');
    expect(drawn).toEqual(['/api/attachments/abc/download']);
    expect(viewport?.textContent).toBe('gezeichnet');

    // A node view is rebuilt whenever its attributes change, so a renderer that
    // is not taken down leaks one root per edit.
    editor?.destroy();
    editor = null;
    expect(unmounted).toBe(1);
  });

  it('leaves the box out entirely when no host can draw', () => {
    // Server-side rendering and the Markdown export go through this path: an
    // empty grey rectangle would be worse than the name and the two links.
    expect(insertPdf().querySelector('.exocortex-pdf-viewport')).toBeNull();
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
      creator: 'LaTeX with hyperref',
      createdAt: '2026-04-01T12:00:00.000Z',
      pageCount: 3,
      tableCount: 2,
      pictureCount: 0,
      ocrUsed: true,
    },
    error: null,
    filename: 'Kontoauszug-Q3.pdf',
    extractable: true,
    correction: null,
    truncated: false,
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
      'Text gelesen',
    ]);
  });

  it('renders nothing without a resolver, so server-side markup is unchanged', () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: '<p></p>' });
    editor.commands.insertMedia('pdf', { src: '/api/attachments/abc/download', name: 'Scan.pdf' });

    expect(editor.view.dom.querySelector('.exocortex-media-meta')).toBeNull();
  });

  it('stays quiet about a file that has no text layer to begin with', async () => {
    const container = await insertPdfWith({
      read: async () => ({
        status: 'not_applicable',
        metadata: null,
        error: null,
        filename: 'notiz.txt',
        extractable: false,
        correction: null,
        truncated: false,
      }),
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
        extractable: true,
        correction: null,
        truncated: false,
      }),
      request: async () => {
        requested += 1;
        return {
          status: 'pending',
          metadata: null,
          error: null,
          filename: 'Scan.pdf',
          extractable: true,
          correction: null,
          truncated: false,
        };
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

  it('offers to read a PDF nobody has asked about yet', async () => {
    // Every PDF uploaded before extraction existed sits in this state. It is
    // the same status an image reports, so without `extractable` the block
    // would show nothing and offer nothing.
    let requested = 0;
    const container = await insertPdfWith({
      read: async () => ({
        status: 'not_applicable',
        metadata: null,
        error: null,
        filename: 'Altbestand.pdf',
        extractable: true,
        correction: null,
        truncated: false,
      }),
      request: async () => {
        requested += 1;
        return {
          status: 'pending',
          metadata: null,
          error: null,
          filename: 'Altbestand.pdf',
          extractable: true,
          correction: null,
          truncated: false,
        };
      },
    });

    expect(chipsOf(container)).toEqual(['Noch nicht ausgelesen']);
    const action = container.querySelector('.exocortex-media-retry');
    if (!(action instanceof window.HTMLButtonElement)) throw new Error('no action button');
    expect(action.textContent).toBe('Text auslesen');
    action.click();
    expect(requested).toBe(1);
  });

  it('names the producing software when nothing else identifies the document', async () => {
    // A scan carries no title and no author, so "PFU ScanSnap Home" is the only
    // thing saying where it came from. Next to a real title it would be noise,
    // which is why it fills in rather than adding on.
    const container = await insertPdfWith({
      read: async () => ({
        ...READY,
        metadata: { ...READY.metadata!, title: null, author: null, creator: 'PFU ScanSnap Home' },
      }),
    });

    expect(chipsOf(container)).toEqual([
      'PFU ScanSnap Home',
      '3 Seiten',
      '2 Tabellen',
      '01.04.2026',
      'per Texterkennung gelesen',
      'Text gelesen',
    ]);
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
    expect(container?.querySelector('.exocortex-pdf-name')?.textContent).toBe('Kontoauszug-Q3.pdf');
  });

  it('leaves a block that has its own name alone', async () => {
    const container = await insertPdfWith({ read: async () => READY });

    // Inserted as `Scan.pdf`; the stored file name must not overwrite it.
    expect(container.querySelector('.exocortex-pdf-name')?.textContent).toBe('Scan.pdf');
  });

  it('does not offer a retry a reader is not allowed to trigger', async () => {
    const container = await insertPdfWith({
      read: async () => ({
        status: 'failed',
        metadata: null,
        error: null,
        filename: 'Scan.pdf',
        extractable: true,
        correction: null,
        truncated: false,
      }),
    });

    expect(container.querySelector('.exocortex-media-retry')).toBeNull();
  });

  it('offers no "Erneut auslesen" or "Ansehen" action when the resolver does not provide them', async () => {
    const container = await insertPdfWith({ read: async () => READY });

    expect(container.querySelector('.exocortex-media-force')).toBeNull();
    expect(container.querySelector('.exocortex-media-view')).toBeNull();
  });

  it('shows a chip for a hand-made correction and for a truncated read', async () => {
    const container = await insertPdfWith({
      read: async () => ({
        ...READY,
        correction: { editedAt: '2026-05-02T00:00:00.000Z', editedById: 'user1' },
        truncated: true,
      }),
    });

    expect(chipsOf(container)).toEqual([
      'Quartalsbericht Q3',
      'Johanna Panda',
      '3 Seiten',
      '2 Tabellen',
      '01.04.2026',
      'per Texterkennung gelesen',
      'Text gelesen',
      'Von Hand korrigiert',
      'Gekürzt',
    ]);
  });

  it('offers to force a re-extraction of an already-ready attachment', async () => {
    let forced = 0;
    const container = await insertPdfWith({
      read: async () => READY,
      forceReextract: async () => {
        forced += 1;
        return { ...READY, status: 'pending', metadata: null };
      },
    });

    const force = container.querySelector('.exocortex-media-force');
    if (!(force instanceof window.HTMLButtonElement)) throw new Error('no force button');
    expect(force.textContent).toBe('Erneut auslesen');
    force.click();
    expect(forced).toBe(1);
  });

  it('offers no "Erneut auslesen" once a re-extraction has been requested for a failed attachment', async () => {
    // The ready-only force action and the failed/not_applicable retry action
    // are deliberately distinct: `forceReextract` never applies here.
    const container = await insertPdfWith({
      read: async () => ({
        status: 'failed',
        metadata: null,
        error: 'No extractable text layer',
        filename: 'Scan.pdf',
        extractable: true,
        correction: null,
        truncated: false,
      }),
      forceReextract: async () => null,
    });

    expect(container.querySelector('.exocortex-media-force')).toBeNull();
  });

  describe('viewing and correcting the text', () => {
    const detail: MediaDocumentDetail = {
      ...READY,
      text: 'der ausgelesene Text',
      machineText: 'der ausgelesene Text',
    };

    it('opens a dialog with the full text on "Ansehen"', async () => {
      const container = await insertPdfWith({
        read: async () => READY,
        readText: async () => detail,
      });

      const view = container.querySelector('.exocortex-media-view');
      if (!(view instanceof window.HTMLButtonElement)) throw new Error('no view button');
      view.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const dialog = window.document.querySelector('.exocortex-media-text-dialog');
      if (!(dialog instanceof window.HTMLDialogElement)) throw new Error('no dialog');
      expect(dialog.open).toBe(true);
      const textarea = dialog.querySelector('.exocortex-media-text-dialog-textarea');
      if (!(textarea instanceof window.HTMLTextAreaElement)) throw new Error('no textarea');
      expect(textarea.value).toBe('der ausgelesene Text');
    });

    it('lets a correction be saved and reflects it in the meta bar without waiting for a poll', async () => {
      let saved: string | null = null;
      const container = await insertPdfWith({
        read: async () => READY,
        readText: async () => detail,
        correctText: async (_src, text) => {
          saved = text;
          return {
            ...detail,
            text: text ?? detail.machineText,
            correction: { editedAt: '2026-05-02T00:00:00.000Z', editedById: 'user1' },
          };
        },
      });

      const view = container.querySelector('.exocortex-media-view');
      if (!(view instanceof window.HTMLButtonElement)) throw new Error('no view button');
      view.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const dialog = window.document.querySelector('.exocortex-media-text-dialog');
      const textarea = dialog?.querySelector('.exocortex-media-text-dialog-textarea');
      if (!(textarea instanceof window.HTMLTextAreaElement)) throw new Error('no textarea');
      textarea.value = 'die korrigierte Fassung';

      const save = dialog?.querySelector('.exocortex-media-text-dialog-save');
      if (!(save instanceof window.HTMLButtonElement)) throw new Error('no save button');
      save.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(saved).toBe('die korrigierte Fassung');
      expect(chipsOf(container)).toContain('Von Hand korrigiert');
    });

    it('offers no editing when the resolver cannot write a correction', async () => {
      const container = await insertPdfWith({
        read: async () => READY,
        readText: async () => detail,
      });

      const view = container.querySelector('.exocortex-media-view');
      if (!(view instanceof window.HTMLButtonElement)) throw new Error('no view button');
      view.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const dialog = window.document.querySelector('.exocortex-media-text-dialog');
      expect(dialog?.querySelector('.exocortex-media-text-dialog-save')).toHaveProperty(
        'hidden',
        true,
      );
      const textarea = dialog?.querySelector('.exocortex-media-text-dialog-textarea');
      expect(textarea).toHaveProperty('readOnly', true);
      dialog?.querySelector<HTMLButtonElement>('.exocortex-media-text-dialog-close')?.click();
    });
  });
});
