import * as React from 'react';

import { cn } from '../lib/utils';

/**
 * LOGO PLACEHOLDER — replace with the final Exocortex logo.
 *
 * This component is intentionally a simple geometric mark. When the real logo
 * exists, drop the asset in `packages/ui/src/assets/` and replace the SVG below.
 * Nothing else in the application references the logo directly.
 */
export function ExocortexLogo({
  className,
  ...props
}: React.ComponentPropsWithoutRef<'svg'>) {
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label="Exocortex"
      className={cn('size-5 text-primary-text', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      {...props}
    >
      {/* Placeholder mark: a node with three synapses. */}
      <circle cx="12" cy="12" r="3.25" />
      <path d="M12 8.75V3.5M12 15.25v5.25M8.75 12H3.5M15.25 12h5.25" />
      <circle cx="12" cy="3.5" r="1.25" />
      <circle cx="20.5" cy="12" r="1.25" />
      <circle cx="12" cy="20.5" r="1.25" />
    </svg>
  );
}

export function ExocortexWordmark({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <ExocortexLogo />
      {/* LOGO PLACEHOLDER: the wordmark is plain text until the brand asset exists. */}
      <span className="text-sm font-semibold tracking-tight">Exocortex</span>
    </span>
  );
}
