'use client';

import { type Editor } from '@tiptap/react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { TEXT_COLOR_NAMES, type TextColorName } from '@exocortex/editor';
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@exocortex/ui';

/**
 * Tailwind classes per colour name.
 *
 * Written out rather than interpolated because Tailwind only emits classes it can
 * see in the source; `bg-content-${name}` would produce no CSS at all.
 */
const SWATCH_TEXT: Readonly<Record<TextColorName, string>> = {
  default: 'text-foreground',
  gray: 'text-content-gray',
  brown: 'text-content-brown',
  orange: 'text-content-orange',
  yellow: 'text-content-yellow',
  green: 'text-content-green',
  blue: 'text-content-blue',
  purple: 'text-content-purple',
  pink: 'text-content-pink',
  red: 'text-content-red',
};

const SWATCH_BACKGROUND: Readonly<Record<TextColorName, string>> = {
  default: 'bg-transparent',
  gray: 'bg-content-bg-gray',
  brown: 'bg-content-bg-brown',
  orange: 'bg-content-bg-orange',
  yellow: 'bg-content-bg-yellow',
  green: 'bg-content-bg-green',
  blue: 'bg-content-bg-blue',
  purple: 'bg-content-bg-purple',
  pink: 'bg-content-bg-pink',
  red: 'bg-content-bg-red',
};

/**
 * Text and background colour items.
 *
 * Both lists show the colour *and* its name: colour alone is never the only
 * carrier of meaning (PRODUCT.md), and a picker where the swatches are the labels
 * is unusable for anyone who cannot distinguish them.
 *
 * Split from the menu shell so the same list works as a dropdown in the selection
 * toolbar and as a submenu in the block handle.
 */
export function ColorItems({ editor }: { editor: Editor }) {
  const t = useTranslations('editor.colors');
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>{t('text')}</DropdownMenuLabel>
        {TEXT_COLOR_NAMES.map((name) => (
          <DropdownMenuItem
            key={`text-${name}`}
            data-testid={`text-color-${name}`}
            onClick={() => {
              if (name === 'default') editor.chain().focus().setTextColor('default').run();
              else editor.chain().focus().setTextColor(name).run();
            }}
          >
            <span
              aria-hidden
              className={cn(
                'grid size-4 place-items-center rounded-sm border border-border font-semibold',
                SWATCH_TEXT[name],
              )}
            >
              A
            </span>
            {t(`name.${name}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>

      <DropdownMenuSeparator />

      <DropdownMenuGroup>
        <DropdownMenuLabel>{t('background')}</DropdownMenuLabel>
        {TEXT_COLOR_NAMES.map((name) => (
          <DropdownMenuItem
            key={`background-${name}`}
            data-testid={`text-background-${name}`}
            onClick={() => editor.chain().focus().setTextBackground(name).run()}
          >
            <span
              aria-hidden
              className={cn('size-4 rounded-sm border border-border', SWATCH_BACKGROUND[name])}
            />
            {t(`name.${name}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>

      <DropdownMenuSeparator />
      <DropdownMenuItem
        data-testid="text-color-reset"
        onClick={() => editor.chain().focus().unsetTextColor().run()}
      >
        {t('reset')}
      </DropdownMenuItem>
    </>
  );
}

/** Standalone colour dropdown, used by the selection toolbar. */
export function ColorMenu({
  editor,
  trigger,
}: {
  editor: Editor;
  trigger: React.ReactElement<Record<string, unknown>>;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align="start" className="max-h-80 w-44 overflow-y-auto">
        <ColorItems editor={editor} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
