'use client';

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { XIcon } from 'lucide-react';
import * as React from 'react';

import { cn } from '../../lib/utils';

/**
 * Dialog built on the Base UI `Dialog` primitive, styled like shadcn's dialog.
 * Focus trapping, scroll locking and `aria-modal` come from the primitive.
 */
const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;
const DialogPortal = DialogPrimitive.Portal;

function DialogBackdrop({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Backdrop>) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-backdrop"
      className={cn(
        'fixed inset-0 z-50 bg-overlay transition-opacity duration-150',
        'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Popup> & { showCloseButton?: boolean }) {
  return (
    <DialogPortal>
      <DialogBackdrop />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4',
          // A dialog never grows past the viewport: it stops one gutter short of
          // it and scrolls instead, so header, fields and buttons all stay
          // reachable. `DialogBody` moves that scrolling into the middle
          // section; without one, the whole popup scrolls.
          'max-h-[calc(100dvh-2rem)] overflow-y-auto',
          'rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-xl',
          'transition-all duration-150',
          'data-[starting-style]:scale-98 data-[starting-style]:opacity-0',
          'data-[ending-style]:scale-98 data-[ending-style]:opacity-0',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            aria-label="Dialog schließen"
            className="absolute top-3 right-3 rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <XIcon className="size-4" />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex shrink-0 flex-col gap-1.5 text-left', className)}
      {...props}
    />
  );
}

/**
 * The part of a dialog that scrolls when there is more of it than screen.
 *
 * Wrap everything between header and footer in it whenever a dialog can grow:
 * the title stays readable and the buttons stay clickable while the fields
 * scroll between them. The negative margin lets the scrollbar sit at the edge
 * of the popup rather than inside the padding.
 */
function DialogBody({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="dialog-body"
      className={cn('-mx-6 min-h-0 flex-1 overflow-y-auto px-6 py-px', className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-base leading-none font-semibold', className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogBackdrop,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
