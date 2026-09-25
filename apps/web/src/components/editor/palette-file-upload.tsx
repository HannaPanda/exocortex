'use client';

import { type Editor } from '@tiptap/react';
import * as React from 'react';

import { usePaletteRequest } from '@/components/palette/palette-requests';

/**
 * "Datei hochladen" from the palette (issue #148).
 *
 * A hidden file input that the palette's request opens; what is chosen goes
 * the same way a dropped file does, into the text where the cursor last was.
 */
export function PaletteFileUpload({
  editor,
  insertFiles,
}: {
  editor: Editor;
  insertFiles: (instance: Editor, files: File[], pos: number) => Promise<void>;
}) {
  const input = React.useRef<HTMLInputElement>(null);
  usePaletteRequest('upload-file', () => input.current?.click());

  return (
    <input
      ref={input}
      type="file"
      multiple
      hidden
      data-testid="palette-file-input"
      onChange={(event) => {
        const files = [...(event.target.files ?? [])];
        // Reset first: picking the same file twice fires no change otherwise.
        event.target.value = '';
        if (files.length === 0) return;
        void insertFiles(editor, files, editor.state.selection.to);
      }}
    />
  );
}
