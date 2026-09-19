'use client';

import {
  EllipsisIcon,
  FileTextIcon,
  ListFilterIcon,
  PinIcon,
  PlusIcon,
  TableIcon,
  TextQuoteIcon,
  XIcon,
} from 'lucide-react';
import * as React from 'react';

import {
  type AiConversationSource,
  type AiConversationSourcesResponse,
} from '@exocortex/contracts';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exocortex/ui';

export interface ContextChipsProps {
  /** Title of the page the panel is standing on, or `null` when there is none. */
  documentTitle: string | null;
  isCollection: boolean;
  /** Whether the page is disclosed to the model. */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** Number of blocks in the passage handed over from the editor; `null` when there is none. */
  selectionBlockCount: number | null;
  onSelectionRemove: () => void;
  /** The pinned sources and the shared budget, or `null` before a conversation exists. */
  pinned: AiConversationSourcesResponse | null;
  onPinRequest: () => void;
  onPinModeChange: (source: AiConversationSource, mode: 'EMBED' | 'REFERENCE') => void;
  onPinRemove: (source: AiConversationSource) => void;
  disabled: boolean;
}

const KIND_ICON = {
  PAGE: FileTextIcon,
  DATABASE_VIEW: TableIcon,
  SAVED_QUERY: ListFilterIcon,
} as const;

const KIND_LABEL = {
  PAGE: 'Seite',
  DATABASE_VIEW: 'Datenbankansicht',
  SAVED_QUERY: 'Gespeicherte Suche',
} as const;

/**
 * What a pinned chip says about its cost, in one short line.
 *
 * Characters rather than tokens, because a token is not a unit anybody can
 * check against the page they just pinned. The estimate is stated as one
 * ("etwa"), since the number is measured on the derived text and the provider
 * counts something else.
 */
function costLabel(source: AiConversationSource): string {
  if (source.mode !== 'EMBED') return 'nur genannt';
  if (source.empty) return 'noch leer';
  const chars = new Intl.NumberFormat('de-DE').format(source.chars);
  return source.truncated ? `etwa ${chars} Z., gekürzt` : `etwa ${chars} Z.`;
}

/**
 * The row above the composer that says what the assistant is given.
 *
 * The rule this encodes: what stands here goes out, what does not stand here
 * does not. So a chip is not decoration -- removing the page chip actually
 * stops the page from reaching the model (`AiConversation.pageContextEnabled`),
 * and removing a pinned chip unpins the source from the next turn on.
 *
 * Two kinds of chip sit here, and the difference is the point (issue #75): the
 * open page changes as the user walks around, while a pinned source stays until
 * it is taken away. A pinned chip therefore also says what it costs, because
 * the one that carries its text costs that on every single turn.
 */
export function ContextChips({
  documentTitle,
  isCollection,
  enabled,
  onEnabledChange,
  selectionBlockCount,
  onSelectionRemove,
  pinned,
  onPinRequest,
  onPinModeChange,
  onPinRemove,
  disabled,
}: ContextChipsProps) {
  const sources = pinned?.sources ?? [];
  // Before the first message there is no conversation and therefore no budget
  // to read, and the plus still has to be there: it is what starts the
  // conversation. A workspace that switched pinning off says so when the
  // request arrives, which is one refused click rather than a hidden feature.
  const canPin = pinned === null || pinned.budget.maxSources > 0;
  const full = pinned !== null && sources.length >= pinned.budget.maxSources;

  if (documentTitle === null && selectionBlockCount === null && sources.length === 0 && !canPin) {
    return null;
  }

  const Icon = isCollection ? TableIcon : FileTextIcon;
  const kind = isCollection ? 'Diese Datenbank' : 'Diese Seite';

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1.5 px-2 pt-2"
      data-testid="ai-context-chips"
    >
      {selectionBlockCount === null ? null : (
        <Badge variant="outline" className="max-w-full gap-1 py-1 pr-1 pl-1.5">
          <TextQuoteIcon aria-hidden />
          <span className="min-w-0 truncate">
            Auswahl ({selectionBlockCount} {selectionBlockCount === 1 ? 'Block' : 'Blöcke'})
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-4 shrink-0 rounded-sm"
                  aria-label="Auswahl nicht mitschicken"
                  data-testid="ai-selection-remove"
                  disabled={disabled}
                  onClick={onSelectionRemove}
                >
                  <XIcon />
                </Button>
              }
            />
            <TooltipContent>Nicht mitschicken</TooltipContent>
          </Tooltip>
        </Badge>
      )}

      {documentTitle === null ? null : enabled ? (
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

      {sources.map((source) => {
        const SourceIcon = KIND_ICON[source.kind];
        const label = `${KIND_LABEL[source.kind]}: ${source.title}`;
        return (
          <Badge
            key={source.id}
            variant="outline"
            className="max-w-full gap-1 py-1 pr-1 pl-1.5"
            data-testid="ai-pinned-chip"
          >
            <PinIcon aria-hidden className="shrink-0" />
            <SourceIcon aria-hidden className="shrink-0" />
            <span
              className="min-w-0 truncate"
              title={source.subtitle === null ? label : `${label} (${source.subtitle})`}
            >
              {source.title}
            </span>
            <span className="shrink-0 text-muted-foreground">· {costLabel(source)}</span>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-4 shrink-0 rounded-sm"
                    aria-label={`Aktionen für ${label}`}
                    data-testid="ai-pinned-menu"
                    disabled={disabled}
                  >
                    <EllipsisIcon />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  data-testid="ai-pinned-mode-item"
                  onClick={() =>
                    onPinModeChange(source, source.mode === 'EMBED' ? 'REFERENCE' : 'EMBED')
                  }
                >
                  {source.mode === 'EMBED' ? 'Nur den Namen nennen' : 'Inhalt mitschicken'}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="ai-pinned-remove-item"
                  onClick={() => onPinRemove(source)}
                >
                  Nicht mehr anheften
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </Badge>
        );
      })}

      {!canPin ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
                data-testid="ai-pin-add"
                disabled={disabled || full}
                onClick={onPinRequest}
              >
                <PlusIcon />
                Quelle anheften
              </Button>
            }
          />
          <TooltipContent>
            {full && pinned !== null
              ? `Mehr als ${String(pinned.budget.maxSources)} Quellen sind hier nicht erlaubt.`
              : 'Seite, Datenbankansicht oder gespeicherte Suche dauerhaft anheften'}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
