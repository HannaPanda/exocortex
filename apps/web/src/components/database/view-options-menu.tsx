'use client';

import { Settings2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DatabaseProperty, type DatabaseView } from '@exocortex/contracts';
import {
  Button,
  Checkbox,
  cn,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@exocortex/ui';

import { useUpdateDatabaseView } from '@/lib/api/database-queries';

import {
  ROW_HEIGHTS,
  rowHeightOf,
  toggleColumnVisibility,
  visibleTableProperties,
} from './table-columns';

interface ViewOptionsMenuProps {
  documentId: string;
  view: DatabaseView;
  properties: DatabaseProperty[];
}

/**
 * Density and column visibility of a table view.
 *
 * Both settings live in `view.config`, so two views of the same database can
 * disagree: a wide working table with every column, and a compact overview
 * with four. Hiding a column never touches the property or its values.
 */
export function ViewOptionsMenu({ documentId, view, properties }: ViewOptionsMenuProps) {
  const t = useTranslations('database.viewOptions');
  const updateView = useUpdateDatabaseView(documentId);
  const rowHeight = rowHeightOf(view);
  const visibleIds = new Set(visibleTableProperties(view, properties).map((entry) => entry.id));

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" data-testid="view-options">
            <Settings2Icon /> {t('trigger')}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-64 p-2">
        <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">{t('rowHeight')}</p>
        <div className="flex gap-1" role="group" aria-label={t('rowHeight')}>
          {ROW_HEIGHTS.map((height) => (
            <Button
              key={height}
              size="sm"
              variant={height === rowHeight ? 'default' : 'outline'}
              className="flex-1"
              data-testid={`row-height-${height}`}
              onClick={() =>
                updateView.mutate({ viewId: view.id, request: { config: { rowHeight: height } } })
              }
            >
              {t(`rowHeights.${height}`)}
            </Button>
          ))}
        </div>

        <p className="px-1 pt-3 pb-1 text-xs font-medium text-muted-foreground">{t('columns')}</p>
        <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {properties.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">{t('noProperties')}</p>
          ) : null}
          {properties.map((property) => {
            const checkboxId = `column-visible-${property.id}`;
            return (
              <div
                key={property.id}
                className="flex items-center gap-2 rounded-sm px-1 py-1 hover:bg-accent"
              >
                <Checkbox
                  id={checkboxId}
                  checked={visibleIds.has(property.id)}
                  onCheckedChange={() =>
                    updateView.mutate({
                      viewId: view.id,
                      request: {
                        config: {
                          visibleProperties: toggleColumnVisibility(view, properties, property.id),
                        },
                      },
                    })
                  }
                />
                <Label
                  htmlFor={checkboxId}
                  className={cn('min-w-0 flex-1 truncate text-sm font-normal')}
                >
                  {property.name}
                </Label>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
