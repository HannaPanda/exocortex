'use client';

import { Toolbar as ToolbarPrimitive } from '@base-ui-components/react/toolbar';
import * as React from 'react';

import { cn } from '../../lib/utils';

/**
 * Floating toolbar surface.
 *
 * Custom primitive: the shadcn registry has no toolbar, but Base UI does, and a
 * formatting bar genuinely needs `role="toolbar"` with a roving tabindex — one
 * Tab stop for the whole bar, arrow keys between the controls. Rebuilding that
 * by hand is exactly the kind of accessibility behaviour docs/ui-system.md says
 * to take from the primitive.
 *
 * Used by the editor selection toolbar and the block action bar.
 */
function Toolbar({ className, ...props }: React.ComponentProps<typeof ToolbarPrimitive.Root>) {
  return (
    <ToolbarPrimitive.Root
      data-slot="toolbar"
      className={cn(
        'flex items-center gap-0.5 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg',
        className,
      )}
      {...props}
    />
  );
}

const ToolbarGroup = ToolbarPrimitive.Group;
const ToolbarButton = ToolbarPrimitive.Button;

function ToolbarSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ToolbarPrimitive.Separator>) {
  return (
    <ToolbarPrimitive.Separator
      data-slot="toolbar-separator"
      className={cn('mx-1 h-5 w-px shrink-0 bg-border', className)}
      {...props}
    />
  );
}

export { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator };
