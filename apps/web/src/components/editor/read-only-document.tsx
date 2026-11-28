'use client';

import { EditorContent, useEditor } from '@tiptap/react';
import * as React from 'react';

import { buildEditorExtensions } from '@exocortex/editor';

import { useEditorWords } from './editor-words';

/**
 * A document or a fragment of one, rendered by the canonical schema and
 * nothing else: a transcluded section (issue #78) and a stored version in the
 * page history (issue #235).
 *
 * A second editor instance rather than a Markdown renderer: this is the
 * content in its own vocabulary, and anything that re-derived it would be a
 * second rendering of one document, free to drift from the first. Read-only,
 * and without the node views the live editor mounts, so nothing here can
 * reach a page or ask a database for its rows.
 */
export function ReadOnlyDocument({ content, className }: { content: unknown; className?: string }) {
  // A rendered PDF or table of contents speaks the reader's language too.
  const words = useEditorWords();
  const editor = useEditor(
    {
      immediatelyRender: false,
      editable: false,
      extensions: buildEditorExtensions({ words }),
      content: content as object,
    },
    [words],
  );

  React.useEffect(() => {
    if (editor === null) return;
    editor.commands.setContent(content as object, { emitUpdate: false });
  }, [content, editor]);

  return <EditorContent editor={editor} className={className ?? 'exocortex-editor'} />;
}
