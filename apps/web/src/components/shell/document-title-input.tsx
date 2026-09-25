'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { cn } from '@exocortex/ui';

interface DocumentTitleInputProps {
  initialTitle: string;
  readOnly: boolean;
  onCommit: (title: string) => void;
}

/**
 * The title field owns its draft value. It is remounted through its `key` when the
 * document changes, so no effect has to copy server state into local state.
 */
export function DocumentTitleInput({ initialTitle, readOnly, onCommit }: DocumentTitleInputProps) {
  const t = useTranslations('shell.documentTitleInput');
  const [value, setValue] = React.useState(initialTitle);

  const commit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === initialTitle) {
      setValue(initialTitle);
      return;
    }
    onCommit(trimmed);
  };

  return (
    /*
     * A textarea rather than an input, because an input cannot wrap: a long
     * title scrolled sideways inside its own box and had to be read with
     * shift-scroll. The field still behaves like a single-line one -- Enter
     * commits and a pasted line break becomes a space -- it just occupies as
     * many lines as it needs.
     *
     * The height comes from the mirror below it, not from JavaScript: both sit
     * in the same grid cell, the mirror carries the same text and the same
     * wrapping, and the grid row grows to the taller of the two. That keeps the
     * field correct on the very first paint and through every reflow, without a
     * resize effect that would run one frame late.
     */
    <div className="exocortex-page-title mb-5 grid w-full">
      <textarea
        value={value}
        rows={1}
        aria-label={t('label')}
        data-testid="document-title"
        readOnly={readOnly}
        onChange={(event) => setValue(event.target.value.replace(/[\r\n]+/g, ' '))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        className={cn(
          'col-start-1 row-start-1 m-0 resize-none overflow-hidden p-0',
          'bg-transparent outline-none placeholder:text-muted-foreground',
          // The caret alone is too faint a focus mark on a heading this size.
          'rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50',
        )}
        placeholder={t('placeholder')}
      />
      <span aria-hidden className="col-start-1 row-start-1 invisible whitespace-pre-wrap">
        {/* The trailing space reserves room for the caret behind the last
            character, and keeps a title ending in a newline from collapsing. */}
        {`${value} `}
      </span>
    </div>
  );
}
