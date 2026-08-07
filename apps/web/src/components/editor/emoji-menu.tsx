'use client';

import { type Editor } from '@tiptap/react';
import * as React from 'react';

import { Button, Input, Popover, PopoverContent, PopoverTrigger } from '@exocortex/ui';

import { filterEmojiGroups } from '@/lib/emoji-catalog';

/**
 * Emoji picker.
 *
 * Inserts the Unicode character as plain text; there is deliberately **no** emoji
 * node in the schema. An emoji *is* text: as a character it round-trips through
 * Markdown perfectly, is found by full-text search, and needs neither a node view
 * nor a shortcode dataset in the bundle. A node would buy nothing and cost all
 * three.
 *
 * The set itself lives in `@/lib/emoji-catalog`, because the page icon picker
 * offers the same emoji and the two must not drift apart.
 */
export function EmojiMenu({
  editor,
  trigger,
}: {
  editor: Editor;
  trigger: React.ReactElement<Record<string, unknown>>;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');

  const groups = React.useMemo(() => filterEmojiGroups(query), [query]);

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
