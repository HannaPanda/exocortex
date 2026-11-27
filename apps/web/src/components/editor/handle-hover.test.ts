// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEditorExtensions } from '@exocortex/editor';

import {
  type Box,
  type HandleRule,
  inHandleCorridor,
  NESTED_TARGETS,
  noteHandleTarget,
  trackHandleHover,
} from './handle-hover';

/**
 * Issue #286: the handle of a nested list item jumped to the item above while
 * the pointer travelled from the item's text to the handle.
 *
 * jsdom lays nothing out, so every element the rules measure is given a box
 * here, the way a browser would place it.
 */

let editor: Editor | null = null;
let stopTracking: (() => void) | null = null;

afterEach(() => {
  stopTracking?.();
  stopTracking = null;
  editor?.destroy();
  editor = null;
});

function rule(id: string): HandleRule {
  const found = (NESTED_TARGETS.rules ?? []).find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no rule ${id}`);
  return found;
}

function setBox(element: Element, box: { left: number; top: number; bottom: number }): void {
  const rect = {
    ...box,
    right: box.left + 400,
    x: box.left,
    y: box.top,
    width: 400,
    height: box.bottom - box.top,
    toJSON: () => ({}),
  };
  element.getBoundingClientRect = () => rect;
}

interface Located {
  pos: number;
  depth: number;
  element: HTMLElement;
}

/** The innermost node of `type` whose text starts with `text`. */
function locate(instance: Editor, type: string, text: string): Located {
  let found: { pos: number; depth: number } | null = null;
  instance.state.doc.descendants((node, pos) => {
    if (node.type.name === type && node.textContent.startsWith(text)) {
      found = { pos, depth: instance.state.doc.resolve(pos).depth + 1 };
    }
  });
  if (found === null) throw new Error(`no ${type} "${text}"`);
  const { pos, depth } = found;
  const element = instance.view.nodeDOM(pos);
  if (!(element instanceof HTMLElement)) throw new Error('no element');
  return { pos, depth, element };
}

function setup(content: string): { instance: Editor; handle: HTMLElement } {
  const instance = new Editor({ extensions: buildEditorExtensions({}), content });
  editor = instance;
  const handle = document.createElement('div');
  setBox(handle, { left: 40, top: 0, bottom: 28 });
  stopTracking = trackHandleHover(instance.view, handle);
  return { instance, handle };
}

function movePointer(instance: Editor, x: number, y: number): void {
  instance.view.dom.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }));
}

function score(instance: Editor, ruleId: string, located: Located): number {
  const $pos = instance.state.doc.resolve(located.pos);
  return rule(ruleId).evaluate({
    node: instance.state.doc.nodeAt(located.pos)!,
    pos: located.pos,
    depth: located.depth,
    parent: $pos.parent,
    index: $pos.index(),
    isFirst: $pos.index() === 0,
    isLast: $pos.index() === $pos.parent.childCount - 1,
    $pos,
    view: instance.view,
  });
}

describe('inHandleCorridor', () => {
  const block: Box = { left: 140, top: 100, bottom: 160 };
  const line: Box = { left: 140, top: 100, bottom: 124 };
  const handle: Box = { left: 60, top: 100, bottom: 128 };

  it('holds the strip from the line to the handle', () => {
    expect(inHandleCorridor({ x: 139, y: 112 }, block, line, handle)).toBe(true);
    expect(inHandleCorridor({ x: 100, y: 112 }, block, line, handle)).toBe(true);
    expect(inHandleCorridor({ x: 60, y: 100 }, block, line, handle)).toBe(true);
  });

  it('lets go over the block, past the handle and off the line', () => {
    expect(inHandleCorridor({ x: 150, y: 112 }, block, line, handle)).toBe(false);
    expect(inHandleCorridor({ x: 59, y: 112 }, block, line, handle)).toBe(false);
    expect(inHandleCorridor({ x: 100, y: 99 }, block, line, handle)).toBe(false);
    // The sub-items' lines below the item's own line have handles of their own.
    expect(inHandleCorridor({ x: 100, y: 140 }, block, line, handle)).toBe(false);
  });
});

describe('the nested handle rules (issue #286)', () => {
  const nestedList = '<ul><li><p>Eins</p><ul><li><p>Zwei</p></li></ul></li></ul>';

  it('never hands a sub-item to the item around it for the pointer being left of it', () => {
    const { instance } = setup(nestedList);
    const outer = locate(instance, 'listItem', 'Eins');
    const inner = locate(instance, 'listItem', 'Zwei');
    setBox(outer.element, { left: 120, top: 100, bottom: 160 });
    setBox(inner.element, { left: 150, top: 130, bottom: 160 });

    // In the indentation in front of "Zwei", left of its text.
    movePointer(instance, 135, 140);
    expect(score(instance, 'exocortexLeftOfBlock', inner)).toBe(0);
    // Right at the start of its text, where the plugin's edge zone used to be.
    movePointer(instance, 155, 140);
    expect(score(instance, 'exocortexLeftOfBlock', inner)).toBe(0);
  });

  it("gives a quote's paragraph to the quote only left of the paragraph", () => {
    const { instance } = setup('<blockquote><p>Eins</p><p>Zwei</p></blockquote>');
    const paragraph = locate(instance, 'paragraph', 'Zwei');
    setBox(paragraph.element, { left: 136, top: 130, bottom: 154 });

    movePointer(instance, 140, 140);
    expect(score(instance, 'exocortexLeftOfBlock', paragraph)).toBe(0);
    movePointer(instance, 128, 140);
    expect(score(instance, 'exocortexLeftOfBlock', paragraph)).toBeGreaterThanOrEqual(1000);
  });

  it('keeps every other block from taking the handle on the way to it', () => {
    const { instance, handle } = setup(nestedList);
    const outer = locate(instance, 'listItem', 'Eins');
    const inner = locate(instance, 'listItem', 'Zwei');
    setBox(outer.element, { left: 120, top: 100, bottom: 160 });
    setBox(inner.element, { left: 150, top: 130, bottom: 160 });
    setBox(handle, { left: 70, top: 130, bottom: 158 });
    noteHandleTarget(instance.view, inner.pos);

    movePointer(instance, 110, 142);
    expect(score(instance, 'exocortexHandleCorridor', outer)).toBeGreaterThanOrEqual(1000);
    expect(score(instance, 'exocortexHandleCorridor', inner)).toBe(0);

    // Past the handle the corridor ends.
    movePointer(instance, 60, 142);
    expect(score(instance, 'exocortexHandleCorridor', outer)).toBe(0);
  });

  it("holds only the item's own line, not the lines of its sub-items", () => {
    const { instance, handle } = setup(nestedList);
    const outer = locate(instance, 'listItem', 'Eins');
    const inner = locate(instance, 'listItem', 'Zwei');
    const ownText = locate(instance, 'paragraph', 'Eins');
    setBox(outer.element, { left: 120, top: 100, bottom: 160 });
    setBox(ownText.element, { left: 120, top: 100, bottom: 124 });
    setBox(inner.element, { left: 150, top: 130, bottom: 160 });
    setBox(handle, { left: 40, top: 100, bottom: 128 });
    noteHandleTarget(instance.view, outer.pos);

    movePointer(instance, 100, 112);
    expect(score(instance, 'exocortexHandleCorridor', inner)).toBeGreaterThanOrEqual(1000);
    movePointer(instance, 100, 142);
    expect(score(instance, 'exocortexHandleCorridor', inner)).toBe(0);
  });

  it('holds nothing while the handle is hidden or stands nowhere', () => {
    const { instance, handle } = setup(nestedList);
    const outer = locate(instance, 'listItem', 'Eins');
    const inner = locate(instance, 'listItem', 'Zwei');
    setBox(outer.element, { left: 120, top: 100, bottom: 160 });
    setBox(inner.element, { left: 150, top: 130, bottom: 160 });
    setBox(handle, { left: 70, top: 130, bottom: 158 });
    noteHandleTarget(instance.view, inner.pos);
    movePointer(instance, 110, 142);

    handle.style.visibility = 'hidden';
    expect(score(instance, 'exocortexHandleCorridor', outer)).toBe(0);
    handle.style.visibility = '';
    noteHandleTarget(instance.view, null);
    expect(score(instance, 'exocortexHandleCorridor', outer)).toBe(0);
  });
});
