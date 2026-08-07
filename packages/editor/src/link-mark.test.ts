// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEditorExtensions } from './extensions';

let editor: Editor | null = null;

function createEditor(content: string): Editor {
  editor = new Editor({ extensions: buildEditorExtensions(), content });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('Link mark rendering', () => {
  it('marks an external link with target and rel', () => {
    const instance = createEditor('<p><a href="https://example.com">extern</a></p>');
    const html = instance.getHTML();
    expect(html).toContain('data-link-kind="external"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('marks a wiki: link as internal and drops target', () => {
    const instance = createEditor('<p><a href="wiki:Seite">Seite</a></p>');
    const html = instance.getHTML();
    expect(html).toContain('data-link-kind="internal"');
    expect(html).not.toContain('target="_blank"');
  });
});
