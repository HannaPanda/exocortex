'use client';

import { type Editor } from '@tiptap/react';
import * as React from 'react';

import { useActiveBlockMarkerPreference } from '@/lib/api/preferences-queries';

import { setActiveBlockMarkerEnabled } from './active-block-marker';

/**
 * Hands the reader's choice to the line beside the caret's block (issue
 * #238).
 *
 * Renders nothing. It lives in the editor chrome, like `CommentMarkers`,
 * because the surface must not subscribe to anything: a changed setting is a
 * meta transaction on the running editor, never a rebuilt one.
 */
export function ActiveBlockMarkerSync({ editor }: { editor: Editor }) {
  const { enabled } = useActiveBlockMarkerPreference();
  React.useEffect(() => {
    if (editor.isDestroyed) return;
    setActiveBlockMarkerEnabled(editor.view, enabled);
  }, [editor, enabled]);
  return null;
}
