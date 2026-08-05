'use client';

import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { type Editor } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps } from '@tiptap/suggestion';
import { AtSignIcon, CalendarIcon, FileTextIcon } from 'lucide-react';
import * as React from 'react';

import { type DocumentSummary } from '@exocortex/contracts';
import { type MentionKind } from '@exocortex/editor';
import { cn } from '@exocortex/ui';

import {
  SuggestionKeyboard,
  SuggestionPopup,
  useSuggestionAnchor,
  useSuggestionHighlight,
  useSuggestionSnapshot,
} from './suggestion-menu';

/** One offered mention. */
export interface MentionCandidate {
  kind: MentionKind;
  label: string;
  /** Short qualifier shown on the right, so the kinds stay distinguishable. */
  hint: string;
}

const MentionPluginKey = new PluginKey('exocortexMentionMenu');

const KIND_ICONS: Readonly<Record<MentionKind, React.ComponentType<{ className?: string }>>> = {
  page: FileTextIcon,
  user: AtSignIcon,
  date: CalendarIcon,
};

/** Creates the keyboard bridge. Call once, next to `useEditor`. */
export function createMentionKeyboard(): SuggestionKeyboard {
  return new SuggestionKeyboard();
}

/** The ProseMirror side of the `@` menu; see `slash-menu.tsx` for the split. */
export function createMentionExtension(keyboard: SuggestionKeyboard): Extension {
  return Extension.create({
    name: 'exocortexMentionMenu',

    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          pluginKey: MentionPluginKey,
          char: '@',
          // A person's name contains spaces, so the query must be allowed to.
          allowSpaces: true,
          allow: ({ editor }) => editor.isEditable && !editor.isActive('codeBlock'),
          render: () => ({
            onKeyDown: ({ event }: SuggestionKeyDownProps) => keyboard.handleKeyDown(event),
          }),
        }),
      ];
    },
  });
}

/** ISO date, which is what the `@(…)` mention notation stores. */
function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * Date shortcuts offered while typing `@`.
 *
 * Relative labels are resolved to an absolute date at insertion time: „heute" in a
 * document read next month would otherwise mean the wrong day.
 */
function dateCandidates(query: string): MentionCandidate[] {
  const now = new Date();
  const shift = (days: number): Date => new Date(now.getTime() + days * 86_400_000);

  const options: MentionCandidate[] = [
    { kind: 'date', label: isoDate(now), hint: 'Heute' },
    { kind: 'date', label: isoDate(shift(1)), hint: 'Morgen' },
    { kind: 'date', label: isoDate(shift(-1)), hint: 'Gestern' },
  ];

  // A typed ISO date is offered verbatim, so any day is reachable.
  if (/^\d{4}-\d{2}-\d{2}$/.test(query)) {
    options.unshift({ kind: 'date', label: query, hint: 'Eingegebenes Datum' });
  }

  if (query.length === 0) return options;
  return options.filter(
    (option) => option.label.startsWith(query) || option.hint.toLowerCase().startsWith(query),
  );
}

/**
 * The `@` menu: pages, people and dates.
 *
 * Pages and people come from data the shell already loaded, so typing `@` costs no
 * request.
 */
export function MentionMenu({
  editor,
  keyboard,
  pages,
  users,
}: {
  editor: Editor;
  keyboard: SuggestionKeyboard;
  pages: readonly DocumentSummary[];
  users: readonly { id: string; name: string }[];
}) {
  const snapshot = useSuggestionSnapshot(editor, MentionPluginKey);
  const anchor = useSuggestionAnchor(editor, snapshot);
  const { index, setIndex } = useSuggestionHighlight(snapshot?.query ?? null);

  const items = React.useMemo((): MentionCandidate[] => {
    if (snapshot === null) return [];
    const needle = snapshot.query.trim().toLowerCase();
    const matches = (value: string): boolean =>
      needle.length === 0 || value.toLowerCase().includes(needle);

    return [
      ...pages
        .filter((page) => matches(page.title))
        .slice(0, 6)
        .map<MentionCandidate>((page) => ({ kind: 'page', label: page.title, hint: 'Seite' })),
      ...users
        .filter((user) => matches(user.name))
        .slice(0, 4)
        .map<MentionCandidate>((user) => ({ kind: 'user', label: user.name, hint: 'Person' })),
      ...dateCandidates(needle),
    ];
  }, [pages, snapshot, users]);

  const choose = React.useCallback(
    (chosen: number): void => {
      const candidate = items[chosen];
      if (candidate === undefined || snapshot === null) return;
      editor
        .chain()
        .focus()
        .deleteRange({ from: snapshot.from, to: snapshot.to })
        .insertMention({ kind: candidate.kind, label: candidate.label })
        .run();
    },
    [editor, items, snapshot],
  );

  React.useEffect(() => {
    keyboard.publish({ count: items.length, index, setIndex, choose });
    return () => keyboard.publish(null);
  }, [choose, index, items.length, keyboard, setIndex]);

  if (snapshot === null || anchor === null) return null;

  return (
    <SuggestionPopup anchor={anchor}>
      {items.length === 0 ? (
        <div
          className="w-64 rounded-md border border-border bg-popover p-3 text-sm text-muted-foreground shadow-lg"
          data-testid="mention-menu-empty"
        >
          Nichts gefunden zu „{snapshot.query}“.
        </div>
      ) : (
        <div
          role="listbox"
          aria-label="Erwähnung einfügen"
          aria-activedescendant={`mention-option-${index}`}
          data-testid="mention-menu"
          className="max-h-72 w-64 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {items.map((candidate, position) => {
            const Icon = KIND_ICONS[candidate.kind];
            return (
              <div
                key={`${candidate.kind}-${candidate.label}`}
                id={`mention-option-${position}`}
                role="option"
                aria-selected={position === index}
                data-testid={`mention-option-${candidate.kind}`}
                className={cn(
                  'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                  position === index && 'bg-accent-strong text-foreground',
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(position);
                }}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{candidate.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{candidate.hint}</span>
              </div>
            );
          })}
        </div>
      )}
    </SuggestionPopup>
  );
}
