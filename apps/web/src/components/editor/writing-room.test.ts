// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEditorExtensions } from '@exocortex/editor';

import { bottomRoom, coveredBelow, WritingRoom } from './writing-room';

/**
 * Issue #281: the line being written in stays off the bottom edge, and on a
 * phone off the keyboard, through ProseMirror's own scroll props.
 */

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('bottomRoom', () => {
  it('keeps a quarter of a visible page below the caret', () => {
    expect(bottomRoom({ top: 48, bottom: 648 }, { top: 0, bottom: 900 })).toBe(150);
  });

  it('keeps at least two lines and at most 200 pixels', () => {
    expect(bottomRoom({ top: 0, bottom: 120 }, { top: 0, bottom: 900 })).toBe(48);
    expect(bottomRoom({ top: 0, bottom: 1400 }, { top: 0, bottom: 1400 })).toBe(200);
  });

  it('adds what the on-screen keyboard covers', () => {
    // A phone: the scroller reaches the bottom of the layout viewport (844),
    // the keyboard leaves 500 pixels of it visible.
    const room = bottomRoom({ top: 48, bottom: 844 }, { top: 0, bottom: 500 });
    expect(room).toBe(344 + 113);
  });

  it('never asks for more than half of what is still visible', () => {
    expect(bottomRoom({ top: 0, bottom: 844 }, { top: 0, bottom: 60 })).toBe(784 + 30);
  });
});

describe('coveredBelow', () => {
  it('is what the keyboard hides of the scroller, and nothing without one', () => {
    expect(coveredBelow({ top: 48, bottom: 844 }, { top: 0, bottom: 500 })).toBe(344);
    expect(coveredBelow({ top: 48, bottom: 844 }, { top: 0, bottom: 844 })).toBe(0);
    // A scroller that ends above the visual viewport's bottom: nothing hidden.
    expect(coveredBelow({ top: 48, bottom: 400 }, { top: 0, bottom: 500 })).toBe(0);
  });
});

describe('WritingRoom', () => {
  function create(): Editor {
    const host = document.createElement('div');
    host.className = 'exocortex-page-scroll';
    document.body.append(host);
    const mount = document.createElement('div');
    host.append(mount);
    editor = new Editor({
      element: mount,
      extensions: [...buildEditorExtensions(), WritingRoom],
      content: '<p>Text</p>',
    });
    return editor;
  }

  it('hands ProseMirror a bottom margin and threshold read when it scrolls', () => {
    const instance = create();
    const margin = instance.view.someProp('scrollMargin') as Record<string, number>;
    const threshold = instance.view.someProp('scrollThreshold') as Record<string, number>;
    // jsdom lays nothing out, so the scroller is zero pixels high and
    // nothing is visible: ProseMirror's own default.
    expect(margin.bottom).toBe(5);
    expect(threshold.bottom).toBe(5);
    expect([margin.top, margin.left, margin.right]).toEqual([5, 5, 5]);
    expect([threshold.top, threshold.left, threshold.right]).toEqual([0, 0, 0]);
  });

  it('keeps the default when the editor is not inside a page', () => {
    const mount = document.createElement('div');
    document.body.append(mount);
    editor = new Editor({
      element: mount,
      extensions: [...buildEditorExtensions(), WritingRoom],
      content: '<p>Text</p>',
    });
    const margin = editor.view.someProp('scrollMargin') as Record<string, number>;
    expect(margin.bottom).toBe(5);
  });
});
