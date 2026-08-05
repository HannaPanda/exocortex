'use client';

import { Toggle as TogglePrimitive } from '@base-ui-components/react/toggle';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '../../lib/utils';

/**
 * Installed with the official shadcn CLI (`shadcn add toggle`) and adapted from
 * Radix to Base UI (ADR-002). Base UI reports the pressed state as
 * `data-pressed` rather than `data-state="on"`, and the callback receives the new
 * value directly.
 *
 * The pressed surface is `--accent-strong`: a formatting button that is on is a
 * selected control, and selection is not a stronger hover (docs/ui-system.md).
 */
const toggleVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-sm text-sm font-medium whitespace-nowrap',
    'transition-[color,background-color,box-shadow] outline-none',
    'hover:bg-accent hover:text-accent-foreground',
    'focus-visible:ring-[3px] focus-visible:ring-ring/50',
    'disabled:pointer-events-none disabled:opacity-50',
    'data-pressed:bg-accent-strong data-pressed:text-foreground',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline: 'border border-border bg-transparent',
      },
      size: {
        default: 'h-8 min-w-8 px-2',
        sm: 'h-7 min-w-7 px-1.5',
        lg: 'h-9 min-w-9 px-2.5',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

function Toggle({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive> & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
