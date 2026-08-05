'use client';

import { type Editor } from '@tiptap/react';
import * as React from 'react';

import { Button, Input, Popover, PopoverContent, PopoverTrigger } from '@exocortex/ui';

/**
 * Emoji picker.
 *
 * Inserts the Unicode character as plain text; there is deliberately **no** emoji
 * node in the schema. An emoji *is* text: as a character it round-trips through
 * Markdown perfectly, is found by full-text search, and needs neither a node view
 * nor a shortcode dataset in the bundle. A node would buy nothing and cost all
 * three.
 *
 * The list is a curated set rather than the full Unicode table for the same
 * reason the code-block languages are: a 1,800-entry dataset in a product whose
 * personality is speed is a bad trade (PRODUCT.md).
 */
interface EmojiGroup {
  label: string;
  emojis: readonly { char: string; keywords: readonly string[] }[];
}

const EMOJI_GROUPS: readonly EmojiGroup[] = [
  {
    label: 'Häufig',
    emojis: [
      { char: '✅', keywords: ['haken', 'fertig', 'check', 'ok'] },
      { char: '❌', keywords: ['kreuz', 'fehler', 'nein', 'x'] },
      { char: '⚠️', keywords: ['warnung', 'achtung', 'warning'] },
      { char: '💡', keywords: ['idee', 'glühbirne', 'tipp'] },
      { char: '📌', keywords: ['pin', 'wichtig', 'merken'] },
      { char: '🔥', keywords: ['feuer', 'dringend', 'hot'] },
      { char: '🚀', keywords: ['rakete', 'start', 'launch', 'deploy'] },
      { char: '🐛', keywords: ['bug', 'fehler', 'käfer'] },
      { char: '🧠', keywords: ['gehirn', 'brain', 'denken'] },
      { char: '⏱️', keywords: ['zeit', 'timer', 'stoppuhr'] },
    ],
  },
  {
    label: 'Arbeit',
    emojis: [
      { char: '📝', keywords: ['notiz', 'schreiben', 'notes'] },
      { char: '📄', keywords: ['dokument', 'seite', 'datei'] },
      { char: '📁', keywords: ['ordner', 'projekt', 'folder'] },
      { char: '📊', keywords: ['diagramm', 'daten', 'chart'] },
      { char: '📅', keywords: ['kalender', 'termin', 'datum'] },
      { char: '🔗', keywords: ['link', 'verweis', 'kette'] },
      { char: '🔍', keywords: ['suche', 'lupe', 'finden'] },
      { char: '🛠️', keywords: ['werkzeug', 'tools', 'wartung'] },
      { char: '⚙️', keywords: ['einstellung', 'zahnrad', 'config'] },
      { char: '🔒', keywords: ['schloss', 'sicherheit', 'privat'] },
    ],
  },
  {
    label: 'Menschen',
    emojis: [
      { char: '👋', keywords: ['hallo', 'winken', 'hi'] },
      { char: '👍', keywords: ['daumen', 'gut', 'ok', 'plus'] },
      { char: '👎', keywords: ['daumen runter', 'schlecht'] },
      { char: '🙏', keywords: ['danke', 'bitte', 'hände'] },
      { char: '🎉', keywords: ['feier', 'party', 'erfolg'] },
      { char: '😀', keywords: ['lachen', 'freude', 'smile'] },
      { char: '🤔', keywords: ['nachdenken', 'hmm', 'frage'] },
      { char: '😅', keywords: ['schwitzen', 'knapp', 'ups'] },
      { char: '❤️', keywords: ['herz', 'liebe', 'love'] },
      { char: '☕', keywords: ['kaffee', 'pause', 'coffee'] },
    ],
  },
];

export function EmojiMenu({
  editor,
  trigger,
}: {
  editor: Editor;
  trigger: React.ReactElement<Record<string, unknown>>;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');

  const groups = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return EMOJI_GROUPS;
    return EMOJI_GROUPS.map((group) => ({
      label: group.label,
      emojis: group.emojis.filter((emoji) =>
        emoji.keywords.some((keyword) => keyword.includes(needle)),
      ),
    })).filter((group) => group.emojis.length > 0);
  }, [query]);

  const insert = (char: string): void => {
    editor.chain().focus().insertContent(char).run();
    setOpen(false);
    setQuery('');
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger render={trigger} />
      <PopoverContent align="start" className="w-72">
        <Input
          autoFocus
          value={query}
          aria-label="Emoji suchen"
          data-testid="emoji-search"
          placeholder="Suchen …"
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="mt-2 max-h-56 overflow-y-auto">
          {groups.length === 0 ? (
            <p className="px-1 py-2 text-sm text-muted-foreground">Kein Emoji passt dazu.</p>
          ) : (
            groups.map((group) => (
              <div key={group.label}>
                <p className="px-1 py-1 text-xs font-medium text-muted-foreground">
                  {group.label}
                </p>
                <div className="grid grid-cols-8 gap-0.5">
                  {group.emojis.map((emoji) => (
                    <Button
                      key={emoji.char}
                      variant="ghost"
                      size="icon-sm"
                      aria-label={emoji.keywords[0] ?? emoji.char}
                      data-testid={`emoji-${emoji.char}`}
                      className="text-base"
                      onClick={() => insert(emoji.char)}
                    >
                      {emoji.char}
                    </Button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
