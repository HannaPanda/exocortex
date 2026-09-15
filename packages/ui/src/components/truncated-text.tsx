'use client';

import * as React from 'react';

import { cn } from '../lib/utils';

import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

/**
 * One line of text that is cut off when it does not fit, and hands the full
 * text over in a tooltip when it was.
 *
 * The tooltip is conditional on purpose: a row whose title fits already shows
 * everything it has, and a tooltip repeating it is noise on every hover across
 * a whole sidebar. Whether the text fits can only be measured, never derived,
 * so the measurement happens when the pointer arrives and again whenever the
 * element resizes underneath it.
 *
 * Screen readers are unaffected either way -- CSS truncation hides the text
 * visually and not from the accessibility tree.
 */
export function TruncatedText({
  text,
  className,
  side = 'top',
}: {
  text: string;
  className?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  const measure = React.useCallback((): void => {
    const element = ref.current;
    if (element === null) return;
    // A rounded-down layout width can sit a fraction below the content width on
    // text that fits exactly; one pixel of slack keeps that from reading as an
    // overflow.
    setOverflowing(element.scrollWidth > element.clientWidth + 1);
  }, []);

  React.useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <Tooltip open={open && overflowing} onOpenChange={setOpen}>
      <TooltipTrigger
        render={
          <span
            ref={ref}
            className={cn('block truncate', className)}
            onPointerEnter={measure}
            onFocus={measure}
          />
        }
      >
        {text}
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-80 text-wrap break-words">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
