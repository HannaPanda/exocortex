'use client';

import { Select as SelectPrimitive } from '@base-ui/react/select';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import * as React from 'react';

import { cn } from '../../lib/utils';

/**
 * Installed with the official shadcn CLI (`shadcn add select`) and adapted from
 * Radix to Base UI (ADR-002).
 *
 * Structural differences to the shadcn source: Radix's `Content` becomes
 * `Portal` + `Positioner` + `Popup` + `List`, `Icon asChild` becomes a plain
 * child, and the scroll arrows are separate parts. Typeahead, keyboard selection
 * and `aria-*` come from the primitive.
 */
const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectItemText = SelectPrimitive.ItemText;

/**
 * Unlike Radix's `Select.Value`, Base UI's renders the selected *value*, not the
 * selected item's text. A bare `<SelectValue />` therefore puts an id, a slug or
 * an English enum member on screen wherever the value is not already the label,
 * which is a defect nothing catches: the popup reads correctly, only the closed
 * trigger lies.
 *
 * Hence `children` is required here rather than optional as in the primitive.
 * Pass the label the closed trigger should show:
 * `<SelectValue>{() => LABELS[value]}</SelectValue>`. Where the value really is
 * the label, say so explicitly (`{() => value}`) instead of leaving it out, so
 * the reader can tell a considered case from a forgotten one.
 */
export interface SelectValueProps extends Omit<
  React.ComponentProps<typeof SelectPrimitive.Value>,
  'children'
> {
  children: NonNullable<React.ComponentProps<typeof SelectPrimitive.Value>['children']>;
}

function SelectValue({ className, ...props }: SelectValueProps) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn('min-w-0 truncate', className)}
      {...props}
    />
  );
}

function SelectTrigger({
  className,
  size = 'default',
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & { size?: 'sm' | 'default' }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        'flex w-fit items-center justify-between gap-2 overflow-hidden rounded-md border border-input bg-transparent px-3 text-sm whitespace-nowrap',
        'transition-[color,box-shadow] outline-none',
        'hover:bg-accent hover:text-accent-foreground',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8' : 'h-9',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="shrink-0">
        <ChevronDownIcon className="size-4 text-muted-foreground" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  align = 'start',
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Popup> & {
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
}) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        align={align}
        sideOffset={sideOffset}
        className="z-50 outline-none"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            'max-h-[min(24rem,var(--available-height))] min-w-[8rem] overflow-y-auto rounded-md border border-border bg-popover p-1',
            'text-popover-foreground shadow-lg outline-none',
            'transition-[transform,opacity] duration-100',
            'data-[starting-style]:scale-98 data-[starting-style]:opacity-0',
            'data-[ending-style]:scale-98 data-[ending-style]:opacity-0',
            className,
          )}
          {...props}
        >
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-7 text-sm outline-none select-none',
        'data-highlighted:bg-accent data-highlighted:text-accent-foreground',
        'data-disabled:pointer-events-none data-disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-3.5" />
        </SelectPrimitive.ItemIndicator>
      </span>
      {children}
    </SelectPrimitive.Item>
  );
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.GroupLabel>) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn('px-2 py-1.5 text-xs font-medium text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectItemText,
  SelectLabel,
  SelectTrigger,
  SelectValue,
};
