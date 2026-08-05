import * as React from 'react';

import { cn } from '../../lib/utils';

/**
 * shadcn `label`, adapted: the Radix Label primitive only rendered a `<label>`
 * with no extra behaviour, so the native element is used directly instead of
 * pulling in a second primitive library.
 */
function Label({ className, ...props }: React.ComponentPropsWithoutRef<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-medium select-none',
        'peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
