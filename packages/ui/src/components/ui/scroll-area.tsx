'use client';

import { ScrollArea as ScrollAreaPrimitive } from '@base-ui-components/react/scroll-area';
import * as React from 'react';

import { cn } from '../../lib/utils';

function ScrollArea({
  className,
  children,
  viewportClassName,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & { viewportClassName?: string }) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className={cn('h-full w-full overscroll-contain', viewportClassName)}
      >
        <ScrollAreaPrimitive.Content>{children}</ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        className="flex w-2 justify-center rounded p-0.5 opacity-0 transition-opacity data-hovering:opacity-100 data-scrolling:opacity-100"
        orientation="vertical"
      >
        <ScrollAreaPrimitive.Thumb className="w-full rounded-full bg-border-strong" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

export { ScrollArea };
