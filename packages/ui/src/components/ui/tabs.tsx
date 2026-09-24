'use client';

import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import * as React from 'react';

import { cn } from '../../lib/utils';

const Tabs = TabsPrimitive.Root;

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        // `min-h-9` rather than `h-9`, and the row is allowed to wrap: four
        // tabs that fit a desk do not fit a phone, and the previous answer was
        // to squeeze each one into a quarter of 342px and truncate what was
        // left -- so the last tab in the workspace settings read
        // "Einstellunger" and there was no gesture that would show the rest. A
        // second line costs 36 pixels and hides nothing.
        'relative inline-flex min-h-9 w-full flex-wrap items-center gap-1 overflow-hidden rounded-md bg-muted p-1',
        // Vertical: a column of full-width rows, as a page's side navigation
        // rather than a segmented control. The height has to come off with it,
        // or fourteen entries are squeezed into nine pixels each.
        'data-[orientation=vertical]:h-auto data-[orientation=vertical]:flex-col',
        'data-[orientation=vertical]:items-stretch data-[orientation=vertical]:overflow-visible',
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Tab>) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        // `flex-auto` rather than `flex-1`: the difference is the flex basis,
        // and with `flex-wrap` on the list the basis is what decides whether a
        // row wraps or shrinks. At `flex-1` the basis is zero, so a row never
        // wraps and every label is squeezed instead; at `auto` the tabs keep
        // their content width, share the leftover space evenly when there is
        // any, and move to a second line when there is not.
        'inline-flex min-w-0 flex-auto items-center justify-center gap-1.5 rounded-sm px-2 py-1 text-xs font-medium',
        // `truncate` only in a row, and now only as the backstop for the one
        // label that is wider than the whole list on its own. In a column the
        // row is free to be two lines high, and truncating there would hide
        // the end of "Struktur, Ablage und Vorlagen" for no gain.
        'data-[orientation=horizontal]:truncate',
        // Not `text-muted-foreground`: on the `bg-muted` track that measures
        // 3.9:1 and fails AA (axe, issue #127). Foreground at 90 % clears 4.5:1
        // and still a clear step below the selected tab.
        'text-foreground/90 transition-colors select-none',
        'hover:text-foreground',
        // `data-active`, not `data-selected`: Base UI's tab puts its selection
        // in `aria-selected` and `data-active`, so the rules this component
        // shipped with matched nothing and every tab list in the application
        // was drawn as if no tab were selected at all.
        //
        // The selected tab has to sit *above* the track, not below it: `bg-card`
        // is darker than `bg-muted` and read as a hole punched into the list.
        // No weight change here: the triggers share the row with `flex-1`, and a
        // heavier label would reflow the neighbours on every tab switch.
        //
        // The second signal tokens.css asks for is the text, which steps from
        // `--muted-foreground` to `--foreground`. An underline was tried here
        // and taken back out: this product draws no rules under anything, so it
        // read as a stray mark rather than as a selection.
        'data-active:bg-accent-strong data-active:text-foreground',
        // Vertical: the row is as tall as its label needs, the label is left
        // aligned and may wrap, and `flex-1` is off because in a column it
        // would stretch every row to the same share of the height.
        'data-[orientation=vertical]:flex-none data-[orientation=vertical]:justify-between',
        'data-[orientation=vertical]:gap-2',
        'data-[orientation=vertical]:px-2.5 data-[orientation=vertical]:py-1.5',
        'data-[orientation=vertical]:text-left data-[orientation=vertical]:text-sm',
        "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Panel>) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn(
        'flex-1 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
