'use client';

import {
  CopyIcon,
  ExternalLinkIcon,
  FolderInputIcon,
  GripVerticalIcon,
  LinkIcon,
  PanelRightOpenIcon,
  Trash2Icon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@exocortex/ui';

/** What the menu of one row can ask its table to do. */
export interface RowHandleActions {
  openPeek: () => void;
  openPage: () => void;
  duplicate: () => void;
  copyLink: () => void;
  move: () => void;
  trash: () => void;
}

/**
 * The handle at the start of a row (issue #244), the table's counterpart of a
 * block's six dots in the editor: one button, one menu for the row.
 *
 * It does not drag. A table's order is its sort, and rows have no manual
 * order to drag them into; the grip only says "this row has a menu here".
 * Hidden until the row is hovered or the handle has focus, always shown on a
 * touch screen, where nothing hovers.
 */
export function RowHandle({
  title,
  readOnly,
  actions,
  className,
}: {
  title: string;
  readOnly: boolean;
  actions: RowHandleActions;
  className?: string;
}) {
  const t = useTranslations('database.rowActions');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('menu', { title })}
            data-testid="row-handle"
            className={cn('text-muted-foreground hover:text-foreground', className)}
          >
            <GripVerticalIcon />
          </Button>
        }
      />
      <DropdownMenuContent align="start" data-testid="row-menu">
        <DropdownMenuItem data-testid="row-open-peek" onClick={actions.openPeek}>
          <PanelRightOpenIcon /> {t('open')}
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="row-open-page" onClick={actions.openPage}>
          <ExternalLinkIcon /> {t('openAsPage')}
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="row-copy-link" onClick={actions.copyLink}>
          <LinkIcon /> {t('copyLink')}
        </DropdownMenuItem>
        {readOnly ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-testid="row-duplicate" onClick={actions.duplicate}>
              <CopyIcon /> {t('duplicate')}
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="row-move" onClick={actions.move}>
              <FolderInputIcon /> {t('move')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" data-testid="row-trash" onClick={actions.trash}>
              <Trash2Icon /> {t('trash')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
