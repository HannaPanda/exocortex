// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEditorExtensions } from '@exocortex/editor';

import { createEmojiShortcodeExtension, EmojiShortcodePluginKey } from './emoji-shortcode-menu';
import { SuggestionKeyboard } from './suggestion-menu';

/**
 * Where a typed `:` opens the emoji list in the editor (issue #269). The rule
 * itself is tested in `lib/emoji-shortcode.test.ts`; this proves the editor
 * asks it, and adds what only the schema knows: code blocks and inline code.
 */

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function createEditor(content = '<p></p>'): Editor {
  editor = new Editor({
    extensions: buildEditorExtensions({
      additionalExtensions: [createEmojiShortcodeExtension(new SuggestionKeyboard())],
    }),
    content,
  });
  editor.commands.focus('end');
  return editor;
}

/** Types character by character, as a person does, one transaction each. */
function type(instance: Editor, text: string): void {
  for (const char of text) {
    const { state, dispatch } = instance.view;
    dispatch(state.tr.insertText(char));
  }
}

/** The query the list would open for, or `null` while it stays closed. */
function openQuery(instance: Editor): string | null {
  const state = EmojiShortcodePluginKey.getState(instance.state) as
    { active: boolean; query: string | null } | undefined;
  return state?.active === true ? state.query : null;
}

describe('the `:` menu in the editor (issue #269)', () => {
  it('opens for a colon and a letter, and follows the typing', () => {
    const instance = createEditor();
    type(instance, 'Gut :');
    expect(openQuery(instance)).toBeNull();
    type(instance, 'h');
    expect(openQuery(instance)).toBe('h');
    type(instance, 'erz');
    expect(openQuery(instance)).toBe('herz');
    type(instance, ' ');
    expect(openQuery(instance)).toBeNull();
  });

  it('opens at the start of a paragraph', () => {
    const instance = createEditor();
    type(instance, ':tada');
    expect(openQuery(instance)).toBe('tada');
  });

  it('stays closed for a time, an address and an emoticon', () => {
    for (const text of ['um 12:30', 'https://exocortex', 'Hinweis:text', 'so :)', 'so :-D']) {
      const instance = createEditor();
      type(instance, text);
      expect(openQuery(instance), text).toBeNull();
      editor?.destroy();
    }
  });

  it('stays closed in a code block', () => {
    const instance = createEditor('<pre><code>x</code></pre>');
    type(instance, ' :herz');
    expect(openQuery(instance)).toBeNull();
  });

  it('stays closed in inline code', () => {
    const instance = createEditor('<p><code>a</code></p>');
    // The caret at the end of the code span carries its mark on.
    instance.commands.setMark('code');
    type(instance, ' :herz');
    expect(openQuery(instance)).toBeNull();
  });
});
