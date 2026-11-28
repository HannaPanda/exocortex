// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildEditorExtensions } from '@exocortex/editor';

import {
  ACTIVE_BLOCK_MARKER_CLASS,
  ActiveBlockMarker,
  activeTextblockPos,
  markerBox,
  setActiveBlockMarkerEnabled,
} from './active-block-marker';

/**
 * Issue #238: a line in the left margin beside the block the caret is in,
 * while the editor has the focus. What only a browser shows (the real
 * layout, the gutter, a phone) is in `e2e/tests/active-block-marker.spec.ts`.
 */

const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function createEditor(content: string, options: { editable?: boolean } = {}): Editor {
  const host = document.createElement('div');
  document.body.append(host);
  const mount = document.createElement('div');
  host.append(mount);
  const editor = new Editor({
    element: mount,
    extensions: buildEditorExtensions({ additionalExtensions: [ActiveBlockMarker] }),
    content,
    editable: options.editable ?? true,
  });
  // jsdom lays nothing out, so it knows no positioned parent; the host
  // stands in for the one the page gives the editor.
  Object.defineProperty(editor.view.dom, 'offsetParent', { get: () => host });
  editors.push(editor);
  return editor;
}

/** Where the text `needle` starts, inside its text block. */
function posOf(editor: Editor, needle: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text?.includes(needle) === true) {
      found = pos + node.text.indexOf(needle);
      return false;
    }
    return true;
  });
  expect(found).toBeGreaterThanOrEqual(0);
  return found;
}

function caretAt(editor: Editor, needle: string): void {
  const pos = posOf(editor, needle);
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos + 1)),
  );
}

/** The name and text of the block `activeTextblockPos` picks. */
function activeBlock(editor: Editor): { type: string; text: string } | null {
  const pos = activeTextblockPos(editor.state);
  if (pos === null) return null;
  const node = editor.state.doc.nodeAt(pos);
  return node === null ? null : { type: node.type.name, text: node.textContent };
}

describe('activeTextblockPos', () => {
  it('is the paragraph the caret is in', () => {
    const editor = createEditor('<p>Erster</p><p>Zweiter</p>');
    caretAt(editor, 'Zweiter');
    expect(activeBlock(editor)).toEqual({ type: 'paragraph', text: 'Zweiter' });
  });

  it('is the innermost point of a nested list, not the list around it', () => {
    const editor = createEditor(
      '<ul><li><p>Oben</p><ul><li><p>Tief</p><ul><li><p>Tiefer</p></li></ul></li></ul></li></ul>',
    );
    caretAt(editor, 'Tiefer');
    expect(activeBlock(editor)).toEqual({ type: 'paragraph', text: 'Tiefer' });
    caretAt(editor, 'Tief');
    expect(activeBlock(editor)).toEqual({ type: 'paragraph', text: 'Tief' });
  });

  it('is the paragraph inside a table cell', () => {
    const editor = createEditor(
      '<table><tbody><tr><td><p>Links</p></td><td><p>Rechts</p></td></tr></tbody></table>',
    );
    caretAt(editor, 'Rechts');
    expect(activeBlock(editor)).toEqual({ type: 'paragraph', text: 'Rechts' });
  });

  it('is a code block as a whole', () => {
    const editor = createEditor('<pre><code>eins\nzwei\ndrei</code></pre>');
    caretAt(editor, 'zwei');
    expect(activeBlock(editor)?.type).toBe('codeBlock');
  });

  it('is a heading', () => {
    const editor = createEditor('<h2>Abschnitt</h2><p>Text</p>');
    caretAt(editor, 'Abschnitt');
    expect(activeBlock(editor)?.type).toBe('heading');
  });

  it('marks nothing for a selected block, the whole page or table cells', () => {
    const editor = createEditor(
      '<p>Davor</p><hr><table><tbody><tr><td><p>Links</p></td><td><p>Rechts</p></td></tr></tbody></table>',
    );
    let rule = -1;
    editor.state.doc.forEach((node, offset) => {
      if (node.type.name === 'horizontalRule') rule = offset;
    });
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, rule)),
    );
    expect(activeTextblockPos(editor.state)).toBeNull();

    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
    expect(activeTextblockPos(editor.state)).toBeNull();

    // The cell around each paragraph: one level above the text block.
    const $left = editor.state.doc.resolve(posOf(editor, 'Links'));
    const $right = editor.state.doc.resolve(posOf(editor, 'Rechts'));
    editor.view.dispatch(
      editor.state.tr.setSelection(
        CellSelection.create(
          editor.state.doc,
          $left.before($left.depth - 1),
          $right.before($right.depth - 1),
        ),
      ),
    );
    expect(editor.state.selection).toBeInstanceOf(CellSelection);
    expect(activeTextblockPos(editor.state)).toBeNull();
  });
});

describe('markerBox', () => {
  it('spans the block, in the parent coordinates', () => {
    expect(markerBox({ top: 340.4, bottom: 388.6 }, 100)).toEqual({ top: 240, height: 48 });
  });

  it('never has a negative height', () => {
    expect(markerBox({ top: 20, bottom: 10 }, 0).height).toBe(0);
  });
});

describe('ActiveBlockMarker', () => {
  /** Lets the plugin's frame run. */
  function nextFrame(): Promise<void> {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => {
        resolve();
      });
    });
  }

  /** Gives every element the same box; enough to tell shown from hidden. */
  function layOut(): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 120, width: 400, height: 24 }),
    );
  }

  function line(): HTMLElement | null {
    return document.querySelector<HTMLElement>(`.${ACTIVE_BLOCK_MARKER_CLASS}`);
  }

  function focus(editor: Editor): void {
    editor.view.dom.dispatchEvent(new FocusEvent('focus'));
  }

  function blur(editor: Editor): void {
    editor.view.dom.dispatchEvent(new FocusEvent('blur'));
  }

  it('stands beside the block while the editor has the focus, and goes with it', async () => {
    layOut();
    const editor = createEditor('<p>Erster</p><p>Zweiter</p>');
    caretAt(editor, 'Zweiter');
    focus(editor);
    await nextFrame();
    const marker = line();
    expect(marker?.dataset.visible).toBe('true');
    expect(marker?.getAttribute('aria-hidden')).toBe('true');
    // Block and parent share the stubbed box: the line starts at the top of
    // the parent and is as tall as the block.
    expect(marker?.style.top).toBe('0px');
    expect(marker?.style.height).toBe('24px');

    blur(editor);
    await nextFrame();
    expect(line()?.dataset.visible).toBe('false');
  });

  it('is not drawn before the editor has the focus', async () => {
    layOut();
    const editor = createEditor('<p>Text</p>');
    caretAt(editor, 'Text');
    await nextFrame();
    expect(line()?.dataset.visible ?? 'false').toBe('false');
  });

  it('is never drawn on a page that is only read', async () => {
    layOut();
    const editor = createEditor('<p>Text</p>', { editable: false });
    caretAt(editor, 'Text');
    focus(editor);
    await nextFrame();
    expect(line()?.dataset.visible ?? 'false').toBe('false');
  });

  it('goes when the reader switches it off, and comes back when switched on', async () => {
    layOut();
    const editor = createEditor('<p>Text</p>');
    caretAt(editor, 'Text');
    focus(editor);
    await nextFrame();
    expect(line()?.dataset.visible).toBe('true');

    setActiveBlockMarkerEnabled(editor.view, false);
    await nextFrame();
    expect(line()?.dataset.visible).toBe('false');

    setActiveBlockMarkerEnabled(editor.view, true);
    await nextFrame();
    expect(line()?.dataset.visible).toBe('true');
  });

  it('hides for a selected block and leaves with the editor', async () => {
    layOut();
    const editor = createEditor('<p>Davor</p><hr><p>Danach</p>');
    caretAt(editor, 'Danach');
    focus(editor);
    await nextFrame();
    expect(line()?.dataset.visible).toBe('true');

    let rule = -1;
    editor.state.doc.forEach((node, offset) => {
      if (node.type.name === 'horizontalRule') rule = offset;
    });
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, rule)),
    );
    await nextFrame();
    expect(line()?.dataset.visible).toBe('false');

    editor.destroy();
    expect(line()).toBeNull();
  });
});
