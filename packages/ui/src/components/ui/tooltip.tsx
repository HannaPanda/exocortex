'use client';

import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import * as React from 'react';

import { cn } from '../../lib/utils';

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({
  className,
  side = 'top',
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Popup> & {
  side?: 'top' | 'right' | 'bottom' | 'left';
  sideOffset?: number;
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset} className="z-50">
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            'rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md',
            'transition-opacity duration-100 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
            className,
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
