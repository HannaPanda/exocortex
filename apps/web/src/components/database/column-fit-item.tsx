'use client';

import { MoveHorizontalIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { DropdownMenuItem } from '@exocortex/ui';

/**
 * "Breite an Inhalt anpassen" in a column header's menu (issue #277): the
 * same fit a double-click on the column's divider makes, for a keyboard that
 * never finds the divider and a finger too broad for it.
 */
export function ColumnFitItem({ columnKey, onFit }: { columnKey: string; onFit: () => void }) {
  const t = useTranslations('database.table');
  return (
    <DropdownMenuItem onClick={onFit} data-testid={`column-fit-${columnKey}`}>
      <MoveHorizontalIcon /> {t('fitWidth')}
    </DropdownMenuItem>
  );
}
