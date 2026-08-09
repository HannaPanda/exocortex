'use client';

import { type Editor, useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { ExternalLinkIcon, PencilIcon, UnlinkIcon } from 'lucide-react';
import * as React from 'react';

import { parseLinkHref, wikiLinkDocumentId } from '@exocortex/editor';
import { Button, Toolbar, ToolbarSeparator } from '@exocortex/ui';

import { FollowLinkContext } from './follow-link-context';
import { displayValue, LinkMenu } from './link-menu';

interface LinkBubbleProps {
  editor: Editor;
  /** Passed through to `LinkMenu`, whose page search reads this workspace's tree. */
  workspaceId: string;
}

/**
 * Small toolbar over the caret when it sits inside a link mark and nothing is
 * selected: open, edit or remove.
 *
 * This closes the gap the issue names for `wiki:` links: `LinkMenu`'s own
 * "Öffnen" only ever handed out a plain `<a>` for external addresses, so
 * there was previously no way at all to follow a `wiki:` link while editing.
 * "Öffnen" here goes through the same `follow` function the click handler in
 * `collaborative-editor.tsx` uses, via `FollowLinkContext`.
 *
 * Never overlaps `SelectionToolbar`: that one only shows for `from !== to`
 * (`selection-toolbar.tsx`), this one only for `from === to`.
 */
export function LinkBubble({ editor, workspaceId }: LinkBubbleProps) {
  const followLinkRef = React.useContext(FollowLinkContext);

  const href = useEditorState({
    editor,
    selector: ({ editor: instance }) => {
      const value = instance.getAttributes('link').href;
      return typeof value === 'string' ? value : null;
    },
  });

  // The identity next to the address (issue #24): "Öffnen" has to land on the
  // page the reference means, not merely on one that carries its title.
  const documentId = useEditorState({
    editor,
    selector: ({ editor: instance }) => wikiLinkDocumentId(instance.getAttributes('link')),
  });

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: 'bottom', offset: 6 }}
      shouldShow={({ editor: instance, from, to }) =>
        instance.isEditable && from === to && instance.isActive('link')
      }
    >
      <Toolbar aria-label="Verweis" data-testid="link-bubble">
        <span
          data-testid="link-bubble-target"
          className="max-w-48 truncate px-2 text-xs text-muted-foreground"
        >
          {href === null ? '' : displayValue(href)}
        </span>

        <ToolbarSeparator />

        <Button
          variant="ghost"
          size="sm"
          data-testid="link-bubble-open"
          // Keeps the caret inside the link mark so a later "Bearbeiten" or
          // "Entfernen" click still acts on it, same reasoning as the mark
          // buttons in `SelectionToolbar`.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const parsed = parseLinkHref(href);
            const target = parsed.kind === 'wiki' ? { ...parsed, documentId } : parsed;
            // An explicit "Öffnen" while editing must not take the editor away:
            // a target that leaves the application gets its own tab, an
            // internal one is a normal in-app navigation.
            if (target.kind !== 'unknown') {
              followLinkRef?.current?.(target, {
                download: false,
                newTab: target.kind === 'external',
              });
            }
          }}
        >
          <ExternalLinkIcon /> Öffnen
        </Button>

        {/* The trigger owns its own click, like the other popover triggers in
            `SelectionToolbar` (`LinkMenu`, `ColorMenu`, `EmojiMenu`). */}
        <LinkMenu
          editor={editor}
          workspaceId={workspaceId}
          trigger={
            <Button variant="ghost" size="sm" data-testid="link-bubble-edit">
              <PencilIcon /> Bearbeiten
            </Button>
          }
        />

        <Button
          variant="ghost"
          size="sm"
          data-testid="link-bubble-remove"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}
        >
          <UnlinkIcon /> Entfernen
        </Button>
      </Toolbar>
    </BubbleMenu>
  );
}
