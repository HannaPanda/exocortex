'use client';

import { ScrollArea as ScrollAreaPrimitive } from '@base-ui-components/react/scroll-area';
import * as React from 'react';

import { cn } from '../../lib/utils';

function ScrollArea({
  className,
  children,
  viewportClassName,
  clampContentWidth = false,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportClassName?: string;
  /**
   * Keep the content from growing wider than the viewport.
   *
   * Base UI gives the content `min-width: fit-content` so a child that is wider
   * than the area can be scrolled to, which is what a table or a code block
   * wants. A list of rows that cut their text off wants the opposite: the rows
   * have to be allowed to shrink, or a long title makes the whole list
   * something you scroll sideways instead of ending in an ellipsis.
   */
  clampContentWidth?: boolean;
}) {
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
        {/* The style, not a class: Base UI writes `min-width` inline, where no
            class reaches it. */}
        <ScrollAreaPrimitive.Content style={clampContentWidth ? { minWidth: 0 } : undefined}>
          {children}
        </ScrollAreaPrimitive.Content>
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
