'use client';

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CalendarIcon,
  ImageIcon,
  KanbanSquareIcon,
  MoreHorizontalIcon,
  PlusIcon,
  TableIcon,
  TrashIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DatabaseView, type DatabaseViewType } from '@exocortex/contracts';
import {
  Button,
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@exocortex/ui';

import { useDestructiveConfirmDialog } from '@/components/editor/destructive-confirm';
import {
  useCreateDatabaseView,
  useDeleteDatabaseView,
  useReorderDatabaseView,
} from '@/lib/api/database-queries';

import { type MoveDirection } from './table-columns';

/**
 * The name of a view type in the reader's language. Also reused by the
 * context panel's "Sammlung" tab (issue #17).
 */
export function useViewTypeLabel(): (type: DatabaseViewType) => string {
  const t = useTranslations('database.viewTypes');
  return React.useCallback((type: DatabaseViewType) => t(type), [t]);
}

const VIEW_TYPE_ICONS: Record<DatabaseViewType, typeof TableIcon> = {
  TABLE: TableIcon,
  BOARD: KanbanSquareIcon,
  GALLERY: ImageIcon,
  CALENDAR: CalendarIcon,
};

const VIEW_TYPES: DatabaseViewType[] = ['TABLE', 'BOARD', 'GALLERY', 'CALENDAR'];

interface ViewTabsProps {
  documentId: string;
  views: DatabaseView[];
  activeViewId: string | undefined;
  onSelect: (viewId: string) => void;
  readOnly: boolean;
}

export function ViewTabs({ documentId, views, activeViewId, onSelect, readOnly }: ViewTabsProps) {
  const createView = useCreateDatabaseView(documentId);
  const deleteView = useDeleteDatabaseView(documentId);
  const reorderView = useReorderDatabaseView(documentId);
  const confirmDialog = useDestructiveConfirmDialog();
  const t = useTranslations('database.views');
  const viewTypeLabel = useViewTypeLabel();

  /**
   * One step along the row of tabs. `afterViewId: null` is the front.
   *
   * The tabs were the only place in the application where the order of
   * something was fixed at the moment it was created: `exo_database_view_*`
   * has had this since the catalogue was written, and the browser had the
   * route and no button (ADR-025).
   */
  const moveView = (index: number, direction: MoveDirection): void => {
    const view = views[index];
    if (view === undefined) return;
    if (direction === 'left') {
      if (index === 0) return;
      reorderView.mutate({
        viewId: view.id,
        request: { afterViewId: views[index - 2]?.id ?? null },
      });
      return;
    }
    const next = views[index + 1];
    if (next === undefined) return;
    reorderView.mutate({ viewId: view.id, request: { afterViewId: next.id } });
  };

  const removeView = async (view: DatabaseView): Promise<void> => {
    const confirmed = await confirmDialog.confirm({
      title: t('deleteTitle', { name: view.name }),
      description: t('deleteDescription'),
    });
    if (confirmed) deleteView.mutate(view.id);
  };

  // The same three actions reach both menus: the context menu for a pointer
  // that has a right button, the ⋯ beside the active tab for everybody else
  // (a phone has no right click, and a keyboard has no reason to know one).
  const actionsOf = (view: DatabaseView, index: number) => [
    {
      key: 'left',
      label: t('moveLeft'),
      icon: ArrowLeftIcon,
      disabled: index === 0,
      destructive: false,
      run: () => moveView(index, 'left'),
    },
    {
      key: 'right',
      label: t('moveRight'),
      icon: ArrowRightIcon,
      disabled: index === views.length - 1,
      destructive: false,
      run: () => moveView(index, 'right'),
    },
    {
      key: 'delete',
      label: t('delete'),
      icon: TrashIcon,
      disabled: false,
      destructive: true,
      run: () => void removeView(view),
    },
  ];
  const editable = !readOnly && views.length > 1;
  const activeIndex = views.findIndex((view) => view.id === activeViewId);
  const activeView = views[activeIndex];

  return (
    <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
      {confirmDialog.element}
      <div
        className="flex min-w-0 items-center gap-1 overflow-x-auto"
        role="tablist"
        aria-label={t('tabsLabel')}
      >
        {views.map((view, index) => {
          const Icon = VIEW_TYPE_ICONS[view.type];
          return (
            <ContextMenu key={view.id}>
              <ContextMenuTrigger
                render={
                  <button
                    type="button"
                    role="tab"
                    aria-selected={view.id === activeViewId}
                    data-testid={`view-tab-${view.id}`}
                    onClick={() => onSelect(view.id)}
                    className={cn(
                      'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent',
                      view.id === activeViewId && 'bg-accent-strong text-foreground',
                    )}
                  >
                    <Icon className="size-3.5" />
                    {view.name}
                  </button>
                }
              />
              {editable ? (
                <ContextMenuContent>
                  {actionsOf(view, index).map((action) => (
                    <React.Fragment key={action.key}>
                      {action.destructive ? <ContextMenuSeparator /> : null}
                      <ContextMenuItem
                        disabled={action.disabled}
                        variant={action.destructive ? 'destructive' : 'default'}
                        onClick={action.run}
                        data-testid={`view-${action.key === 'delete' ? 'delete' : `move-${action.key}`}-${view.id}`}
                      >
                        <action.icon /> {action.label}
                      </ContextMenuItem>
                    </React.Fragment>
                  ))}
                </ContextMenuContent>
              ) : null}
            </ContextMenu>
          );
        })}
      </div>
      {editable && activeView !== undefined ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('actionsFor', { name: activeView.name })}
                data-testid="view-actions"
              >
                <MoreHorizontalIcon />
              </Button>
            }
          />
          <DropdownMenuContent align="start">
            {actionsOf(activeView, activeIndex).map((action) => (
              <React.Fragment key={action.key}>
                {action.destructive ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem
                  disabled={action.disabled}
                  variant={action.destructive ? 'destructive' : 'default'}
                  onClick={action.run}
                >
                  <action.icon /> {action.label}
                </DropdownMenuItem>
              </React.Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {readOnly ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label={t('add')} data-testid="add-view">
                <PlusIcon />
              </Button>
            }
          />
          <DropdownMenuContent align="start">
            {VIEW_TYPES.map((type) => {
              const Icon = VIEW_TYPE_ICONS[type];
              return (
                <DropdownMenuItem
                  key={type}
                  data-testid={`add-view-${type.toLowerCase()}`}
                  onClick={() => {
                    const sameType = views.filter((view) => view.type === type).length;
                    const name =
                      sameType === 0
                        ? viewTypeLabel(type)
                        : t('numberedName', { type: viewTypeLabel(type), number: sameType + 1 });
                    createView.mutate(
                      { type, name },
                      { onSuccess: (created) => onSelect(created.id) },
                    );
                  }}
                >
                  <Icon /> {viewTypeLabel(type)}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
