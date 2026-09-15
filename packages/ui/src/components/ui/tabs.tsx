'use client';

import { Tabs as TabsPrimitive } from '@base-ui-components/react/tabs';
import * as React from 'react';

import { cn } from '../../lib/utils';

const Tabs = TabsPrimitive.Root;

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'relative inline-flex h-9 w-full items-center gap-1 overflow-hidden rounded-md bg-muted p-1',
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
        'relative inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 truncate rounded-sm px-2 py-1 text-xs font-medium',
        'text-muted-foreground transition-colors select-none',
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
        'data-active:bg-accent-strong data-active:text-foreground',
        // The surface is never the only signal (tokens.css): a selection that
        // reads only as a slightly warmer rectangle is one people lose track of
        // the moment they look away, and a tab list on a transparent track has
        // no rectangle to compare against at all. Hence the amber bar -- drawn
        // as a pseudo-element so nothing reflows when the selection moves, and
        // it follows the axis: under a horizontal tab, beside a vertical one.
        'after:absolute after:rounded-full after:bg-primary after:opacity-0 after:transition-opacity',
        'after:inset-x-2 after:bottom-0.5 after:h-0.5',
        'data-[orientation=vertical]:after:inset-x-auto data-[orientation=vertical]:after:inset-y-1',
        'data-[orientation=vertical]:after:start-0.5 data-[orientation=vertical]:after:h-auto data-[orientation=vertical]:after:w-0.5',
        'data-active:after:opacity-100',
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
      className={cn('flex-1 outline-none', className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
