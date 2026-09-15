'use client';

import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { CheckIcon } from 'lucide-react';
import * as React from 'react';

import { cn } from '../../lib/utils';

/**
 * Installed with the official shadcn CLI (`shadcn add checkbox`) and adapted:
 * Radix's `data-[state=checked]` selector became Base UI's boolean
 * `data-checked`/`data-unchecked` presence attributes (see
 * `@base-ui/react/checkbox`'s `CheckboxRootDataAttributes`).
 */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer size-4 shrink-0 rounded-[4px] border border-input shadow-xs transition-shadow outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
