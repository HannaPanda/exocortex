// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';

import { coreStructureBlocks } from './block-catalog';
import { turnBlockInto } from './block-target';
import { buildEditorExtensions } from './extensions';
import { parseMarkdown } from './markdown';

/**
 * Issue #258: a new code block starts with its neighbour's language. These
 * run the real commands: the catalog entry behind the slash menu and "Umwandeln
 * in", the ``` fence and `Mod-Alt-c`'s `toggleCodeBlock`.
 */

let editor: Editor | null = null;

function createEditor(content: string): Editor {
  editor = new Editor({ extensions: buildEditorExtensions(), content });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const codeEntry = coreStructureBlocks.find((entry) => entry.id === 'code-block');
if (codeEntry === undefined) throw new Error('no code block entry');

/** Puts the caret right after the first occurrence of `text`. */
function caretAfter(instance: Editor, text: string): void {
  let at = -1;
  instance.state.doc.descendants((node, pos) => {
    if (at >= 0 || !node.isText) return at < 0;
    const index = (node.text ?? '').indexOf(text);
    if (index >= 0) at = pos + index + text.length;
    return false;
  });
  if (at < 0) throw new Error(`no text ${text}`);
  instance.view.dispatch(
    instance.state.tr.setSelection(TextSelection.create(instance.state.doc, at)),
  );
}

/** Types `text` the way the keyboard does, input rules included. */
function type(instance: Editor, text: string): void {
  for (const character of text) {
    const { from, to } = instance.state.selection;
    const handled = instance.view.someProp('handleTextInput', (handler) =>
      handler(instance.view, from, to, character, () =>
        instance.state.tr.insertText(character, from, to),
      ),
    );
    if (handled !== true) instance.view.dispatch(instance.state.tr.insertText(character, from, to));
  }
}

/** Every code block of the page as `language:text`, `-` for no language. */
function codeBlocks(instance: Editor): string[] {
  const blocks: string[] = [];
  instance.state.doc.descendants((node) => {
    if (node.type.name !== 'codeBlock') return true;
    const language: unknown = node.attrs.language;
    const name = typeof language === 'string' && language.length > 0 ? language : '-';
    blocks.push(`${name}:${node.textContent}`);
    return false;
  });
  return blocks;
}

const python = '<pre><code class="language-python">x = 1</code></pre>';
const bash = '<pre><code class="language-bash">ls</code></pre>';
const plain = '<pre><code>output</code></pre>';

describe('a new code block takes its neighbour language (issue #258)', () => {
  it('from the slash menu, the nearest one above', () => {
    const instance = createEditor(`${python}${bash}<p>Neu</p>`);
    caretAfter(instance, 'Neu');
    expect(codeEntry.run(instance)).toBe(true);
    expect(codeBlocks(instance)).toEqual(['python:x = 1', 'bash:ls', 'bash:Neu']);
  });

  it('from the fence without a name', () => {
    const instance = createEditor(`${python}<p></p>`);
    caretAfter(instance, 'x = 1');
    instance.commands.setTextSelection(instance.state.doc.content.size - 1);
    type(instance, '``` ');
    expect(codeBlocks(instance)).toEqual(['python:x = 1', 'python:']);
  });

  it('a fence that names a language keeps its own', () => {
    const instance = createEditor(`${python}<p></p>`);
    instance.commands.setTextSelection(instance.state.doc.content.size - 1);
    type(instance, '```sql ');
    expect(codeBlocks(instance)).toEqual(['python:x = 1', 'sql:']);
  });

  it('from "Umwandeln in" on a list item', () => {
    const instance = createEditor(`${python}<ul><li><p>Eins</p></li><li><p>Zwei</p></li></ul>`);
    let itemPos = -1;
    instance.state.doc.descendants((node, pos) => {
      if (itemPos < 0 && node.type.name === 'listItem' && node.textContent === 'Zwei') {
        itemPos = pos;
      }
      return itemPos < 0;
    });
    expect(turnBlockInto(instance, itemPos, codeEntry)).toBe(true);
    expect(codeBlocks(instance)).toEqual(['python:x = 1', 'python:Zwei']);
  });

  it('under a list item, from a code block inside a callout above', () => {
    const doc = parseMarkdown(
      ['> [!note]', '> ```rust', '> fn main() {}', '> ```', '', '- Punkt'].join('\n'),
    );
    const instance = createEditor('');
    instance.commands.setContent(doc.document);
    caretAfter(instance, 'Punkt');
    expect(codeEntry.run(instance)).toBe(true);
    expect(codeBlocks(instance)).toEqual(['rust:fn main() {}', 'rust:']);
  });

  it('with none above, the nearest one below', () => {
    const instance = createEditor(`<p>Oben</p>${bash}${python}`);
    caretAfter(instance, 'Oben');
    expect(instance.commands.toggleCodeBlock()).toBe(true);
    expect(codeBlocks(instance)).toEqual(['bash:Oben', 'bash:ls', 'python:x = 1']);
  });

  it('a neighbour without a language is a choice too', () => {
    const instance = createEditor(`${bash}${plain}<p>Neu</p>`);
    caretAfter(instance, 'Neu');
    expect(codeEntry.run(instance)).toBe(true);
    expect(codeBlocks(instance)).toEqual(['bash:ls', '-:output', '-:Neu']);
  });

  it('without a code block on the page there is no language, as before', () => {
    const instance = createEditor('<p>Neu</p>');
    caretAfter(instance, 'Neu');
    expect(codeEntry.run(instance)).toBe(true);
    expect(codeBlocks(instance)).toEqual(['-:Neu']);
  });

  it('the language can still be changed afterwards', () => {
    const instance = createEditor(`${python}<p>Neu</p>`);
    caretAfter(instance, 'Neu');
    expect(codeEntry.run(instance)).toBe(true);
    expect(instance.commands.updateAttributes('codeBlock', { language: 'go' })).toBe(true);
    expect(codeBlocks(instance)).toEqual(['python:x = 1', 'go:Neu']);
  });

  it('inside a code block the command still turns it back into a paragraph', () => {
    const instance = createEditor(`${bash}${python}`);
    caretAfter(instance, 'x = 1');
    expect(codeEntry.run(instance)).toBe(true);
    expect(codeBlocks(instance)).toEqual(['bash:ls']);
  });

  it('a Markdown fence without a language stays without one', () => {
    const doc = parseMarkdown(['```python', 'x = 1', '```', '', '```', 'y', '```'].join('\n'));
    const instance = createEditor('');
    instance.commands.setContent(doc.document);
    expect(codeBlocks(instance)).toEqual(['python:x = 1', '-:y']);
  });
});
