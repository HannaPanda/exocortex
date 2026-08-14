'use client';

import { Dialog as SheetPrimitive } from '@base-ui-components/react/dialog';
import { XIcon } from 'lucide-react';
import * as React from 'react';

import { cn } from '../../lib/utils';

/**
 * Edge-anchored dialog built on the Base UI `Dialog` primitive, styled like
 * shadcn's sheet. Sibling of `Dialog` (`./dialog.tsx`): same primitive, the
 * popup is pinned to a viewport edge instead of centered.
 */
const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;
const SheetPortal = SheetPrimitive.Portal;

function SheetBackdrop({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Backdrop>) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-backdrop"
      className={cn(
        'fixed inset-0 z-50 bg-overlay transition-opacity duration-150',
        'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

const SIDE_STYLES = {
  left: cn(
    'inset-y-0 left-0 h-full w-3/4 max-w-xs border-r border-border',
    'data-[starting-style]:-translate-x-full data-[ending-style]:-translate-x-full',
  ),
  right: cn(
    'inset-y-0 right-0 h-full w-3/4 max-w-xs border-l border-border',
    'data-[starting-style]:translate-x-full data-[ending-style]:translate-x-full',
  ),
} as const;

function SheetContent({
  className,
  children,
  side = 'right',
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Popup> & {
  side?: keyof typeof SIDE_STYLES;
  showCloseButton?: boolean;
}) {
  return (
    <SheetPortal>
      <SheetBackdrop />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          'fixed z-50 flex flex-col bg-popover text-popover-foreground shadow-xl',
          'transition-transform duration-150',
          SIDE_STYLES[side],
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            aria-label="Schließen"
            className="absolute top-3 right-3 rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <XIcon className="size-4" />
          </SheetPrimitive.Close>
        ) : null}
      </SheetPrimitive.Popup>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex flex-col gap-1.5 p-4', className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('font-semibold text-foreground', className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetBackdrop,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
};
