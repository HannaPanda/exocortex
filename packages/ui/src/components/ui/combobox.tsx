'use client';

import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import * as React from 'react';

import { cn } from '../../lib/utils';

/**
 * Taken from the shadcn registry's Base UI style (`base-nova/combobox`), since
 * the CLI installs the Radix one for this project's `new-york` style (issue
 * #172).
 *
 * Kept: the primitive's parts, so filtering, `aria-activedescendant`, the
 * listbox role and keyboard selection come from Base UI. Changed: the
 * `InputGroup` the registry builds the field from does not exist here, so the
 * field is `Input`'s classes with the trigger laid over its end; the popup and
 * the items carry `Select`'s look, so the two read as one family. Left out:
 * chips and multiple selection, which nothing here asks for yet.
 */
const Combobox = ComboboxPrimitive.Root;
const ComboboxGroup = ComboboxPrimitive.Group;
const ComboboxCollection = ComboboxPrimitive.Collection;

function ComboboxInput({
  className,
  disabled = false,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.Input>) {
  return (
    <div data-slot="combobox-field" className={cn('relative w-full', className)}>
      <ComboboxPrimitive.Input
        data-slot="combobox-input"
        disabled={disabled}
        className={cn(
          'h-9 w-full min-w-0 rounded-md border border-input bg-transparent py-1 pr-9 pl-3 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        )}
        {...props}
      />
      <ComboboxPrimitive.Trigger
        data-slot="combobox-trigger"
        disabled={disabled}
        className={cn(
          'absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-muted-foreground outline-none',
          'hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        <ChevronDownIcon className="size-4" aria-hidden />
      </ComboboxPrimitive.Trigger>
    </div>
  );
}

function ComboboxContent({
  className,
  align = 'start',
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.Popup> & {
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
}) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        align={align}
        sideOffset={sideOffset}
        className="z-50 outline-none"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            'w-(--anchor-width) max-w-(--available-width) min-w-[12rem] overflow-hidden rounded-md border border-border bg-popover',
            'text-popover-foreground shadow-md outline-none',
            'transition-[transform,opacity] duration-100',
            'data-[starting-style]:scale-98 data-[starting-style]:opacity-0',
            'data-[ending-style]:scale-98 data-[ending-style]:opacity-0',
            className,
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxList({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.List>) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn(
        'max-h-[min(20rem,var(--available-height))] scroll-py-1 overflow-y-auto overscroll-contain p-1 data-[empty]:p-0',
        className,
      )}
      {...props}
    />
  );
}

function ComboboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.Item>) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        'relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-7 text-sm outline-none select-none',
        'data-highlighted:bg-accent data-highlighted:text-accent-foreground',
        'data-disabled:pointer-events-none data-disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <span className="absolute top-2 left-2 flex size-3.5 items-center justify-center">
        <ComboboxPrimitive.ItemIndicator>
          <CheckIcon className="size-3.5" />
        </ComboboxPrimitive.ItemIndicator>
      </span>
      {children}
    </ComboboxPrimitive.Item>
  );
}

function ComboboxLabel({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.GroupLabel>) {
  return (
    <ComboboxPrimitive.GroupLabel
      data-slot="combobox-label"
      className={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', className)}
      {...props}
    />
  );
}

/** Renders its children only while the filtered list is empty. */
function ComboboxEmpty({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitive.Empty>) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn('px-3 py-2 text-sm text-muted-foreground empty:hidden', className)}
      {...props}
    />
  );
}

export {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
};
