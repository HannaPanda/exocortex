'use client';

import { type Editor } from '@tiptap/react';
import { ExternalLinkIcon, UnlinkIcon } from 'lucide-react';
import * as React from 'react';

import { Button, Input, Popover, PopoverContent, PopoverTrigger } from '@exocortex/ui';

/** Internal page links use this scheme; see packages/editor markdown/serialize.ts. */
const WIKI_LINK_SCHEME = 'wiki:';

interface LinkMenuProps {
  editor: Editor;
  trigger: React.ReactElement<Record<string, unknown>>;
}

/**
 * Link editor.
 *
 * Accepts three inputs and normalizes all of them:
 *   * `https://…` and `mailto:…` stay as they are,
 *   * `[[Seite]]` and a bare page title become the internal `wiki:` scheme,
 *   * everything else that looks like a host gets `https://` prepended, because a
 *     protocol-less href would resolve against the app itself.
 */
export function LinkMenu({ editor, trigger }: LinkMenuProps) {
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState('');

  const currentHref = editor.getAttributes('link').href;

  // Opening the popover seeds the field from the link under the cursor.
  const onOpenChange = (next: boolean): void => {
    if (next) setValue(typeof currentHref === 'string' ? displayValue(currentHref) : '');
    setOpen(next);
  };

  const apply = (): void => {
    const href = normalizeHref(value);
    if (href === null) {
      editor.chain().focus().unsetLink().run();
    } else {
      editor.chain().focus().setLink({ href }).run();
    }
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align="start" className="w-80">
        <div className="flex items-center gap-1.5">
          <Input
            autoFocus
            value={value}
            aria-label="Adresse oder Seitentitel"
            data-testid="link-input"
            placeholder="https://… oder [[Seite]]"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                apply();
              }
            }}
          />
          <Button size="sm" data-testid="link-apply" onClick={apply}>
            Setzen
          </Button>
        </div>

        {typeof currentHref === 'string' && currentHref.length > 0 ? (
          <div className="mt-2 flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              data-testid="link-remove"
              onClick={() => {
                editor.chain().focus().unsetLink().run();
                setOpen(false);
              }}
            >
              <UnlinkIcon /> Entfernen
            </Button>
            {currentHref.startsWith(WIKI_LINK_SCHEME) ? null : (
              <Button
                variant="ghost"
                size="sm"
                render={
                  <a href={currentHref} target="_blank" rel="noopener noreferrer">
                    <ExternalLinkIcon /> Öffnen
                  </a>
                }
              />
            )}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** Shows an internal link the way it is written in Markdown. */
function displayValue(href: string): string {
  return href.startsWith(WIKI_LINK_SCHEME)
    ? `[[${href.slice(WIKI_LINK_SCHEME.length)}]]`
    : href;
}

/** `null` means "remove the link". */
function normalizeHref(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const wiki = /^\[\[(.+)\]\]$/.exec(trimmed);
  if (wiki !== null) return `${WIKI_LINK_SCHEME}${(wiki[1] ?? '').trim()}`;

  if (/^(https?:|mailto:|wiki:)/i.test(trimmed)) return trimmed;
  // A bare token with a dot is a host; anything else is a page title.
  if (/^[^\s/]+\.[^\s/]{2,}(\/.*)?$/.test(trimmed)) return `https://${trimmed}`;
  return `${WIKI_LINK_SCHEME}${trimmed}`;
}
