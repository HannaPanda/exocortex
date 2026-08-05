'use client';

import * as React from 'react';

import { cn } from '../../lib/utils';

export interface ProgressProps extends React.ComponentPropsWithoutRef<'div'> {
  /** 0..100 */
  value: number;
  label?: string;
}

/**
 * Determinate progress bar for background job progress. Implemented directly
 * because the Base UI progress primitive adds no behaviour this needs beyond the
 * ARIA attributes below.
 */
export function Progress({ value, label, className, ...props }: ProgressProps) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn('h-1 w-full overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <div
        className="h-full bg-primary transition-[width] duration-200"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
