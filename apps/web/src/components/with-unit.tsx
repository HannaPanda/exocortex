import type * as React from 'react';

import { cn } from '@exocortex/ui';

/**
 * A field followed by the unit it counts in (`%`, `Zeichen`, `Tokens`,
 * `$ je 1 Mio. Tokens`), issue #203. The pattern the percentage field of
 * issue #170 started, kept in one place.
 *
 * The unit is drawn for the eye only and hidden from assistive technology:
 * read after the field it would be announced as loose text belonging to
 * nothing. The caller puts the unit where a screen reader does read it, in the
 * label or in the description the field points at.
 */
export function WithUnit({
  unit,
  className,
  children,
}: {
  unit: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    // Aligned at the top with the line height of a field, so the unit stays
    // beside the field when a message opens up under it.
    <div className={cn('flex min-w-0 items-start gap-2', className)}>
      {children}
      <span className="shrink-0 text-sm leading-9 text-muted-foreground" aria-hidden="true">
        {unit}
      </span>
    </div>
  );
}
