'use client';

import { type Editor } from '@tiptap/react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { Input, Popover, PopoverContent, PopoverTrigger } from '@exocortex/ui';

import { EmojiPalette } from '@/components/document/emoji-palette';

/**
 * Emoji picker.
 *
 * Inserts the Unicode character as plain text; there is deliberately **no** emoji
 * node in the schema. An emoji *is* text: as a character it round-trips through
 * Markdown perfectly, is found by full-text search, and needs neither a node view
 * nor a shortcode dataset in the bundle. A node would buy nothing and cost all
 * three.
 *
 * The grid itself is `EmojiPalette`, shared with the page icon picker: the two
 * offer the same emoji, remember the same recent ones, and must not drift apart.
 */
export function EmojiMenu({
  editor,
  trigger,
}: {
  editor: Editor;
  trigger: React.ReactElement<Record<string, unknown>>;
}) {
  const t = useTranslations('editor.emojiMenu');
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');

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
          aria-label={t('search')}
          data-testid="emoji-search"
          placeholder={t('placeholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
        {/* Mounted only while open: the palette pulls in 160 kB of emoji names,
            and the toolbar must not pay for that before anyone asks for one. */}
        {open ? (
          <EmojiPalette
            query={query}
            testIdPrefix="emoji"
            className="mt-2 max-h-56"
            onPick={insert}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
