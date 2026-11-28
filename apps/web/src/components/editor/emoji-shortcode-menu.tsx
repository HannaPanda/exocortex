'use client';

import { Extension } from '@tiptap/core';
import { type EditorState, PluginKey } from '@tiptap/pm/state';
import { type Editor } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps } from '@tiptap/suggestion';
import * as React from 'react';

import {
  emojiOptionId,
  EmojiSuggestionList,
  useEmojiSuggestions,
  useHighlightMoved,
} from '@/components/document/emoji-suggestions';
import { colonMayOpenAfter, enterChoosesEmoji, isEmojiQuery } from '@/lib/emoji-shortcode';

import {
  SuggestionKeyboard,
  SuggestionPopup,
  useActiveOptionInView,
  useSuggestionAnchor,
  useSuggestionHighlight,
  useSuggestionSnapshot,
} from './suggestion-menu';

/** Exported for the tests, which read whether the list would open. */
export const EmojiShortcodePluginKey = new PluginKey('exocortexEmojiShortcodeMenu');

/** Creates the keyboard bridge. Call once, next to `useEditor`. */
export function createEmojiShortcodeKeyboard(): SuggestionKeyboard {
  return new SuggestionKeyboard();
}

/** Stands for an inline node (a mention, a formula) in the text before a colon. */
const OBJECT_CHARACTER = '￼';

/**
 * Whether the colon at `from` may open the list, by the rule in
 * `emoji-shortcode.ts` plus what only the schema knows: no list in a code
 * block, and none in inline code.
 */
function mayOpenAt(state: EditorState, range: { from: number; to: number }): boolean {
  const $from = state.doc.resolve(range.from);
  if ($from.parent.type.spec.code === true) return false;
  const code = state.schema.marks.code;
  if (code !== undefined && state.doc.rangeHasMark(range.from, range.to, code)) return false;
  if (!isEmojiQuery(state.doc.textBetween(range.from + 1, range.to))) return false;
  const offset = $from.parentOffset;
  const previous =
    offset === 0 ? '' : $from.parent.textBetween(offset - 1, offset, undefined, OBJECT_CHARACTER);
  return colonMayOpenAfter(previous);
}

/**
 * The ProseMirror side of the `:` menu (issue #269); see `slash-menu.tsx` for
 * the split. Every prefix passes the plugin's own check (`allowedPrefixes:
 * null`), because which character may stand before the colon is decided in
 * `mayOpenAt`, the same way the chat field decides it.
 */
export function createEmojiShortcodeExtension(keyboard: SuggestionKeyboard): Extension {
  return Extension.create({
    name: 'exocortexEmojiShortcodeMenu',

    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          pluginKey: EmojiShortcodePluginKey,
          char: ':',
          allowSpaces: false,
          allowedPrefixes: null,
          allow: ({ editor, state, range }) => editor.isEditable && mayOpenAt(state, range),
          render: () => ({
            onKeyDown: ({ event }: SuggestionKeyDownProps) => keyboard.handleKeyDown(event),
          }),
        }),
      ];
    },
  });
}

/**
 * The `:` menu: emoji by name, in the reader's language or by shortcode.
 *
 * Inserts the character as text, like the toolbar's emoji picker
 * (`emoji-menu.tsx` says why there is no emoji node). Nothing found shows
 * nothing, so a colon that was punctuation after all costs no popup and no key.
 */
export function EmojiShortcodeMenu({
  editor,
  keyboard,
}: {
  editor: Editor;
  keyboard: SuggestionKeyboard;
}) {
  const snapshot = useSuggestionSnapshot(editor, EmojiShortcodePluginKey);
  const anchor = useSuggestionAnchor(editor, snapshot);
  const query = snapshot?.query ?? null;
  const { index, setIndex } = useSuggestionHighlight(query);
  const { moved, markMoved } = useHighlightMoved(query);
  const { entries, exact, remember } = useEmojiSuggestions(query);
  const listRef = React.useRef<HTMLDivElement>(null);

  const insert = React.useCallback(
    (char: string): void => {
      if (snapshot === null) return;
      remember(char);
      editor.chain().focus().insertContentAt({ from: snapshot.from, to: snapshot.to }, char).run();
    },
    [editor, remember, snapshot],
  );

  const choose = React.useCallback(
    (chosen: number): void => {
      const entry = entries[chosen];
      if (entry !== undefined) insert(entry.char);
    },
    [entries, insert],
  );

  const intercept = React.useCallback(
    (event: KeyboardEvent): boolean | null => {
      if (query === null) return null;
      // `:tada:` typed out: the closing colon is the choice.
      if (event.key === ':') {
        const named = exact(query);
        if (named === null) return null;
        insert(named.char);
        return true;
      }
      if (event.key === 'Enter' && !enterChoosesEmoji(query, moved)) return false;
      return null;
    },
    [exact, insert, moved, query],
  );

  const move = React.useCallback(
    (next: number): void => {
      markMoved();
      setIndex(next);
    },
    [markMoved, setIndex],
  );

  const idPrefix = 'emoji-shortcode-option';
  useActiveOptionInView(listRef, entries.length === 0 ? '' : emojiOptionId(idPrefix, index));

  React.useEffect(() => {
    keyboard.publish({ count: entries.length, index, setIndex: move, choose, intercept });
    return () => keyboard.publish(null);
  }, [choose, entries.length, index, intercept, keyboard, move]);

  if (snapshot === null || anchor === null || entries.length === 0) return null;

  return (
    <SuggestionPopup anchor={anchor}>
      <EmojiSuggestionList
        entries={entries}
        activeIndex={index}
        idPrefix={idPrefix}
        onChoose={choose}
        listRef={listRef}
        className="max-h-[min(18rem,var(--available-height,18rem))]"
      />
    </SuggestionPopup>
  );
}
