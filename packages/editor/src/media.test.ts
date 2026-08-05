// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEditorExtensions } from './extensions';

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
