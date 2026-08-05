'use client';

import { Popover as PopoverPrimitive } from '@base-ui-components/react/popover';
import * as React from 'react';

import { cn } from '../../lib/utils';

/**
 * Installed with the official shadcn CLI (`shadcn add popover`) and adapted from
 * Radix to Base UI, so the project depends on exactly one primitive library
 * (ADR-002). The Radix `Content` part maps onto Base UI's `Positioner` plus
 * `Popup`; focus management, dismissal and `aria-*` come from the primitive.
 */
const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverClose = PopoverPrimitive.Close;
const PopoverTitle = PopoverPrimitive.Title;
const PopoverDescription = PopoverPrimitive.Description;

function PopoverContent({
  className,
  align = 'center',
  side = 'bottom',
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Popup> & {
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  sideOffset?: number;
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        className="z-50 outline-none"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            'rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none',
            'transition-[transform,opacity] duration-100',
            'data-[starting-style]:scale-98 data-[starting-style]:opacity-0',
            'data-[ending-style]:scale-98 data-[ending-style]:opacity-0',
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
};
