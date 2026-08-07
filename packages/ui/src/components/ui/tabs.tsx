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
        'inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 truncate rounded-sm px-2 py-1 text-xs font-medium',
        'text-muted-foreground transition-colors select-none',
        'hover:text-foreground',
        // The selected tab has to sit *above* the track, not below it: `bg-card`
        // is darker than `bg-muted` and read as a hole punched into the list.
        // No weight change here: the triggers share the row with `flex-1`, and a
        // heavier label would reflow the neighbours on every tab switch.
        'data-selected:bg-accent-strong data-selected:text-foreground',
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
