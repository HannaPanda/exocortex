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
  onTouch = 'hide',
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Popup> & {
  side?: 'top' | 'right' | 'bottom' | 'left';
  sideOffset?: number;
  /**
   * Whether this tooltip still has a job on a device that cannot hover.
   *
   * Almost none do. The tooltip on an icon button repeats the control's
   * `aria-label` and adds a keyboard shortcut, so on a phone it is a box that
   * covers whatever is beside it and then stays: a tap focuses the button, a
   * focus opens the tooltip, and there is no pointer to leave with. Hiding it
   * there loses nothing, because the name is already on the control and the
   * shortcut is not pressable.
   *
   * The exception is a tooltip carrying text the screen is genuinely hiding --
   * `TruncatedText` hands over a title that did not fit -- and that one passes
   * `show`, because on touch it is the only way to read the rest.
   */
  onTouch?: 'hide' | 'show';
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset} className="z-50">
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          data-touch={onTouch}
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
