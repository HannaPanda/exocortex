'use client';

import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { type Editor } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps } from '@tiptap/suggestion';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type BlockCatalogEntry, filterBlockCatalog, groupBlockCatalog } from '@exocortex/editor';
import { cn } from '@exocortex/ui';

import { BlockIcon } from './block-icon';
import { useBlockGroupLabel } from './block-labels';
import {
  SuggestionKeyboard,
  SuggestionPopup,
  useSuggestionAnchor,
  useSuggestionHighlight,
  useSuggestionSnapshot,
} from './suggestion-menu';

const SlashMenuPluginKey = new PluginKey('exocortexSlashMenu');

/** Creates the keyboard bridge. Call once, next to `useEditor`. */
export function createSlashKeyboard(): SuggestionKeyboard {
  return new SuggestionKeyboard();
}

/**
 * The ProseMirror side of the slash menu.
 *
 * Only detection and key handling live here; the popup is rendered from the plugin
 * state by `SlashMenu` below (see `suggestion-menu.tsx` for why). A non-schema
 * extension, which is why it may live in `apps/web` (docs/editor-extensions.md).
 */
export function createSlashExtension(keyboard: SuggestionKeyboard): Extension {
  return Extension.create({
    name: 'exocortexSlashMenu',

    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          pluginKey: SlashMenuPluginKey,
          char: '/',
          allowSpaces: false,
          // A slash inside a code block is a slash, not a command.
          allow: ({ editor }) => editor.isEditable && !editor.isActive('codeBlock'),
          render: () => ({
            onKeyDown: ({ event }: SuggestionKeyDownProps) => keyboard.handleKeyDown(event),
          }),
        }),
      ];
    },
  });
}

/**
 * The slash menu.
 *
 * Everything it offers comes from the block catalog in `packages/editor`, so a new
 * block shows up here without touching this file.
 */
export function SlashMenu({
  editor,
  keyboard,
  catalog,
  execute,
}: {
  editor: Editor;
  keyboard: SuggestionKeyboard;
  catalog: readonly BlockCatalogEntry[];
  execute: (entry: BlockCatalogEntry) => void;
}) {
  const snapshot = useSuggestionSnapshot(editor, SlashMenuPluginKey);
  const anchor = useSuggestionAnchor(editor, snapshot);
  const { index, setIndex } = useSuggestionHighlight(snapshot?.query ?? null);

  const items = React.useMemo(
    () => (snapshot === null ? [] : filterBlockCatalog(catalog, snapshot.query)),
    [catalog, snapshot],
  );

  const choose = React.useCallback(
    (chosen: number): void => {
      const entry = items[chosen];
      if (entry === undefined || snapshot === null) return;
      // Removing the `/query` first means the block is inserted into a clean block.
      editor.chain().focus().deleteRange({ from: snapshot.from, to: snapshot.to }).run();
      execute(entry);
    },
    [editor, execute, items, snapshot],
  );

  React.useEffect(() => {
    keyboard.publish({ count: items.length, index, setIndex, choose });
    return () => keyboard.publish(null);
  }, [choose, index, items.length, keyboard, setIndex]);

  if (snapshot === null || anchor === null) return null;

  return (
    <SuggestionPopup anchor={anchor}>
      <SlashMenuList
        items={items}
        query={snapshot.query}
        activeIndex={index}
        onSelect={(chosen) => choose(chosen)}
      />
    </SuggestionPopup>
  );
}

interface SlashMenuListProps {
  items: readonly BlockCatalogEntry[];
  query: string;
  activeIndex: number;
  onSelect: (index: number) => void;
}

/**
 * A `listbox` rather than a menu: the editor keeps the focus while the user types,
 * so the active option is announced through `aria-activedescendant` — the same
 * pattern the command palette uses.
 */
function SlashMenuList({ items, query, activeIndex, onSelect }: SlashMenuListProps) {
  const t = useTranslations('editor.slashMenu');
  const groupLabel = useBlockGroupLabel();
  const sections = React.useMemo(() => groupBlockCatalog(items), [items]);

  if (items.length === 0) {
    return (
      <div
        className="w-72 rounded-md border border-border bg-popover p-3 text-sm text-muted-foreground shadow-md"
        data-testid="slash-menu-empty"
      >
        {t('empty', { query })}
      </div>
    );
  }

  return (
    <div
      role="listbox"
      aria-label={t('label')}
      aria-activedescendant={`slash-option-${items[activeIndex]?.id ?? ''}`}
      data-testid="slash-menu"
      className="max-h-80 w-72 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {sections.map((section) => (
        <div key={section.group} role="group" aria-label={groupLabel(section.group)}>
          <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            {groupLabel(section.group)}
          </p>
          {section.entries.map((entry) => {
            const position = items.indexOf(entry);
            return (
              <div
                key={entry.id}
                id={`slash-option-${entry.id}`}
                role="option"
                aria-selected={position === activeIndex}
                data-testid={`slash-option-${entry.id}`}
                className={cn(
                  'flex cursor-default items-start gap-2 rounded-sm px-2 py-1.5 text-sm',
                  position === activeIndex && 'bg-accent-strong text-foreground',
                )}
                // `onMouseDown` rather than `onClick`: a click would first blur the
                // editor, which closes the suggestion before the handler runs.
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(position);
                }}
              >
                <span className="mt-0.5 shrink-0 text-muted-foreground">
                  <BlockIcon name={entry.icon} className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{entry.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {entry.description}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
