import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '../../lib/utils';

/**
 * Installed with the official shadcn CLI (`shadcn add button`) and adapted:
 * the Radix `Slot` primitive was replaced with Base UI's `useRender`, so the
 * project depends on exactly one primitive library (ADR-002).
 *
 * Use `render` instead of shadcn's `asChild`:
 *   <Button render={<Link href="/x" />}>Öffnen</Button>
 */
const buttonVariants = cva(
  // `active:translate-y-px` is the whole press feedback: one pixel, on the
  // project's default curve. A button that does not move under the pointer feels
  // like a picture of a button.
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] outline-none active:translate-y-px focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-border bg-transparent hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary-text underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        sm: 'h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-sm': 'size-7',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ComponentPropsWithoutRef<'button'>, VariantProps<typeof buttonVariants> {
  /** Renders the button as another element while keeping its props and styling. */
  render?: useRender.RenderProp<React.ComponentPropsWithRef<'button'>>;
  /**
   * Forwarded to `useRender`'s own `ref` option (`ComponentPropsWithoutRef`
   * above deliberately excludes it, since Base UI wants the ref passed
   * alongside `render`/`props`, not spread into them). Needed by
   * `CalendarDayButton`, which manages focus imperatively for keyboard
   * navigation between day cells.
   */
  ref?: React.Ref<HTMLButtonElement>;
}

function Button({ className, variant, size, render, type, ref, ...props }: ButtonProps) {
  return useRender({
    // The default element carries no `type`: Base UI lets the render element's
    // own props win, which would silently turn a submit button into a plain one.
    render: render ?? <button />,
    ref,
    props: {
      'data-slot': 'button',
      // Explicit default so a button outside a form never submits by accident.
      type: type ?? 'button',
      className: cn(buttonVariants({ variant, size }), className),
      ...props,
    },
  });
}

export { Button, buttonVariants };
