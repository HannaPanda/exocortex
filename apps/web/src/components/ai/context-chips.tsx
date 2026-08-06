'use client';

import { FileTextIcon, PlusIcon, TableIcon, XIcon } from 'lucide-react';
import * as React from 'react';

import { Badge, Button, Tooltip, TooltipContent, TooltipTrigger } from '@exocortex/ui';

export interface ContextChipsProps {
  /** Title of the page the panel is standing on, or `null` when there is none. */
  documentTitle: string | null;
  isCollection: boolean;
  /** Whether the page is disclosed to the model. */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  disabled: boolean;
}

/**
 * The row above the composer that says what the assistant is given.
 *
 * The rule this encodes: what stands here goes out, what does not stand here
 * does not. So the chip is not decoration -- removing it actually stops the
 * page from reaching the model (`AiConversation.pageContextEnabled`), and a run
 * without a chip is a run without page context.
 *
 * Nothing is rendered when no page is open: there is nothing to disclose and
 * nothing to promise.
 */
export function ContextChips({
  documentTitle,
  isCollection,
  enabled,
  onEnabledChange,
  disabled,
}: ContextChipsProps) {
  if (documentTitle === null) return null;

  const Icon = isCollection ? TableIcon : FileTextIcon;
  const kind = isCollection ? 'Diese Datenbank' : 'Diese Seite';

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-2 pt-2" data-testid="ai-context-chips">
      {enabled ? (
        <Badge variant="outline" className="max-w-full gap-1 py-1 pr-1 pl-1.5">
          <Icon aria-hidden />
          <span className="min-w-0 truncate" title={documentTitle}>
            {kind}: {documentTitle}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-4 shrink-0 rounded-sm"
                  aria-label={`${kind} nicht mitschicken`}
                  data-testid="ai-context-remove"
                  disabled={disabled}
                  onClick={() => onEnabledChange(false)}
                >
                  <XIcon />
                </Button>
              }
            />
            <TooltipContent>Nicht mitschicken</TooltipContent>
          </Tooltip>
        </Badge>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
          data-testid="ai-context-add"
          disabled={disabled}
          onClick={() => onEnabledChange(true)}
        >
          <PlusIcon />
          {kind} mitschicken
        </Button>
      )}
    </div>
  );
}
