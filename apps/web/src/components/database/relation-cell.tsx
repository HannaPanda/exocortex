'use client';

import { CheckIcon, Link2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DatabaseProperty, parseRelationConfig } from '@exocortex/contracts';
import {
  Badge,
  Button,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
} from '@exocortex/ui';

import { RELATION_PICKER_LIMIT, useRelationTargetRows } from '@/lib/api/database-queries';

import type { PropertyCellProps } from './cells';
import { ROW_HEIGHT_BOX_CLAMP } from './table-columns';

/**
 * The cell of a RELATION property: the linked rows as chips, and a picker over
 * the rows of the linked database.
 *
 * The stored value is a list of row ids, never titles (issue #76). Titles are
 * read here through the ordinary rows endpoint of the target database, which
 * is an authorized request of its own -- so a person who cannot open that
 * database sees the bare id instead of a name nobody showed them.
 */
export function RelationCell({ property, value, onChange, readOnly }: PropertyCellProps) {
  const t = useTranslations('database.cells');
  const config = parseRelationConfig(property.config);
  const selected = React.useMemo(() => (Array.isArray(value) ? value.map(String) : []), [value]);
  const targets = useRelationTargetRows(config?.targetCollectionId);
  const byId = React.useMemo(
    () => new Map((targets.data ?? []).map((row) => [row.id, row.title])),
    [targets.data],
  );

  if (config === null) {
    return (
      <span className="px-1.5 py-1.5 text-sm text-muted-foreground">
        {t('relationNotConfigured')}
      </span>
    );
  }

  const chips = (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1 overflow-hidden',
        ROW_HEIGHT_BOX_CLAMP.short,
      )}
    >
      {selected.length === 0 ? (
        <span className="text-sm text-muted-foreground">{t('empty')}</span>
      ) : (
        selected.map((id) => (
          <Badge key={id} variant="secondary" className="max-w-40 truncate">
            {byId.get(id) ?? id}
          </Badge>
        ))
      )}
    </div>
  );

  if (readOnly) return <div className="flex min-h-8 items-start px-1.5 py-1.5">{chips}</div>;

  const toggle = (id: string): void => {
    const next = selected.includes(id)
      ? selected.filter((entry) => entry !== id)
      : config.allowMultiple
        ? [...selected, id]
        : [id];
    onChange(next.length === 0 ? null : next);
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex min-h-8 w-full items-start rounded-md px-1.5 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
            data-testid={`relation-cell-${property.id}`}
          >
            {chips}
          </button>
        }
      />
      <PopoverContent align="start" className="w-72 p-0">
        <ScrollArea className="max-h-72">
          <div className="flex flex-col p-1">
            {(targets.data ?? []).map((row) => (
              <Button
                key={row.id}
                variant="ghost"
                size="sm"
                className="justify-start gap-2"
                onClick={() => toggle(row.id)}
              >
                <CheckIcon
                  className={cn('size-3.5 shrink-0', selected.includes(row.id) ? '' : 'invisible')}
                />
                <span className="truncate">{row.title}</span>
              </Button>
            ))}
            {targets.data?.length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">{t('relationTargetEmpty')}</p>
            ) : null}
            {(targets.data?.length ?? 0) >= RELATION_PICKER_LIMIT ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                {t('relationLimit', { limit: RELATION_PICKER_LIMIT })}
              </p>
            ) : null}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

/** Compact, non-interactive rendering of a relation value for a card summary. */
export function RelationValueDisplay({
  property,
  value,
}: {
  property: DatabaseProperty;
  value: unknown;
}) {
  const config = parseRelationConfig(property.config);
  const ids = Array.isArray(value) ? value.map(String) : [];
  const targets = useRelationTargetRows(config?.targetCollectionId);
  const byId = new Map((targets.data ?? []).map((row) => [row.id, row.title]));
  if (ids.length === 0) return null;
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <Link2Icon className="size-3" />
      {ids.map((id) => byId.get(id) ?? id).join(', ')}
    </span>
  );
}
