'use client';

import { CheckIcon, CopyIcon } from 'lucide-react';
import * as React from 'react';

import { Button, cn } from '@exocortex/ui';

interface CopyBlockProps {
  /** The text to show and to copy. Copied verbatim, including line breaks. */
  value: string;
  /** Accessible name for the button, e.g. "Befehl für Claude Code kopieren". */
  label: string;
  className?: string;
}

/**
 * A block of text with one job: get into the clipboard unaltered.
 *
 * `select-all` on the pre is the fallback for browsers that refuse
 * `navigator.clipboard` outside a secure context -- a triple click still selects
 * the whole command rather than one line of a wrapped one.
 */
export function CopyBlock({ value, label, className }: CopyBlockProps) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // No clipboard permission (insecure origin, denied prompt). The text is
      // on screen and selectable, so this is a missing convenience, not an
      // error worth an alert.
    }
  }

  return (
    <div className={cn('relative', className)}>
      <pre className="overflow-x-auto rounded-md border border-border bg-sunken p-3 pr-12 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all select-all">
        {value}
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        className="absolute top-2 right-2"
        onClick={() => void handleCopy()}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}
