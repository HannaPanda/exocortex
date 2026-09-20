import * as React from 'react';

import { cn } from '../../lib/utils';

/**
 * A genuinely separable block, and the one primitive here that was never
 * adapted.
 *
 * It arrived as the shadcn default -- `rounded-xl`, a 24px gap between its
 * parts on top of 24px of padding, and an uncoloured `border` -- in a product
 * whose stated principle is density over padding when the two conflict. Three
 * things changed. The radius is `lg`, because `xl` was a step the system
 * claimed and never defined, so it fell through to Tailwind's 12px and a card
 * and a popover shared a radius while DESIGN.md said they did not. The gap is
 * 1rem, because 24px of padding at the edge and 24px again between the heading
 * and the body reads as a slide rather than as a block. And the border names
 * its token instead of inheriting it from the base layer.
 *
 * Where it is still used is the answer to whether it should exist: the front
 * door, where one form floats on an empty page, and the pair of setup recipes
 * in the connection panel. It is not the answer to grouping -- that is what
 * `SectionRule` is for -- and it is never a list row.
 */
function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      className={cn(
        'flex flex-col gap-4 rounded-lg border border-border bg-card py-6 text-card-foreground shadow-sm',
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        '@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6',
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-title"
      className={cn('leading-none font-semibold', className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-action"
      className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('px-6', className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center px-6 [.border-t]:pt-6', className)}
      {...props}
    />
  );
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
