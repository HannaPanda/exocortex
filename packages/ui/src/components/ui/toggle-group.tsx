'use client';

import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';
import * as React from 'react';

import { cn } from '../../lib/utils';

/**
 * Installed with the official shadcn CLI (`shadcn add toggle-group`) and adapted
 * from Radix to Base UI (ADR-002).
 *
 * Base UI's group always works on an array of values and distinguishes single
 * from multiple selection with `multiple`, so shadcn's
 * `type="single" | "multiple"` prop does not exist here. Arrow-key navigation
 * between the items comes from the primitive; the items themselves are `Toggle`
 * components from `./toggle`, which read their pressed state from the group.
 */
function ToggleGroup({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive>) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      className={cn('flex w-fit items-center gap-0.5', className)}
      {...props}
    />
  );
}

export { ToggleGroup };
