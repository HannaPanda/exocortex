'use client';

import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import * as React from 'react';

import { cn } from '../../lib/utils';

/**
 * Installed with the official shadcn CLI (`shadcn add slider`) and adapted to
 * Base UI (issue #189, the knowledge map's timeline): Radix's Track/Range
 * became Base UI's Control/Track/Indicator, `data-[disabled]` the boolean
 * `data-disabled`, and the thumb's `bg-white` the page token, because a
 * literal colour is refused by the gate (rule 9). One thumb per value, so the
 * same component carries a range.
 */
function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  thumbLabel,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & {
  /** The accessible name of each thumb, since the control has no visible label of its own. */
  thumbLabel?: string;
}) {
  const values = React.useMemo(
    () =>
      Array.isArray(value)
        ? value
        : typeof value === 'number'
          ? [value]
          : Array.isArray(defaultValue)
            ? defaultValue
            : typeof defaultValue === 'number'
              ? [defaultValue]
              : [min],
    [value, defaultValue, min],
  );

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn('relative w-full touch-none select-none data-disabled:opacity-50', className)}
      {...props}
    >
      <SliderPrimitive.Control
        data-slot="slider-control"
        className="relative flex h-5 w-full items-center"
      >
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="absolute h-full bg-primary"
          />
        </SliderPrimitive.Track>
        {values.map((_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            // A thumb is identified by its position among the values, which is what Base UI keys on too.
            key={index}
            aria-label={thumbLabel}
            className="block size-4 shrink-0 rounded-full border border-primary bg-foreground shadow-sm ring-ring/50 transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden data-disabled:pointer-events-none"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
