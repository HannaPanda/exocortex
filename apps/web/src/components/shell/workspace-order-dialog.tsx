'use client';

import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@exocortex/ui';

import { useReorderWorkspaces, useWorkspaces } from '@/lib/api/workspace-queries';

type Direction = 'up' | 'down';

/**
 * The person's own order of their workspaces, moved one step at a time.
 *
 * Arrows rather than dragging: the order is the feature, and a pair of
 * buttons per row reaches it from a keyboard, a screen reader and a phone
 * alike. Every click saves at once, so there is nothing to confirm or lose.
 */
export function WorkspaceOrderDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('shell.workspaceSwitcher');
  const workspaces = useWorkspaces();
  const reorder = useReorderWorkspaces();
  const list = workspaces.data ?? [];
  const listRef = React.useRef<HTMLOListElement>(null);

  const move = (index: number, direction: Direction): void => {
    const target = direction === 'up' ? index - 1 : index + 1;
    const moved = list[index];
    if (moved === undefined || target < 0 || target >= list.length) return;
    const ids = list.map((workspace) => workspace.id);
    ids.splice(index, 1);
    ids.splice(target, 0, moved.id);
    reorder.mutate(ids);

    // The row moves away from under the focused button. Keep the focus on the
    // row that moved, so pressing the same arrow again keeps carrying it; at
    // either end that arrow is disabled, so the other one takes the focus.
    const atEnd = direction === 'up' ? target === 0 : target === list.length - 1;
    const focusDirection: Direction = atEnd ? (direction === 'up' ? 'down' : 'up') : direction;
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLButtonElement>(`[data-move="${moved.id}:${focusDirection}"]`)
        ?.focus();
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" data-testid="workspace-order-dialog">
        <DialogHeader>
          <DialogTitle>{t('reorderTitle')}</DialogTitle>
          <DialogDescription>{t('reorderDescription')}</DialogDescription>
        </DialogHeader>
        <ol ref={listRef} className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {list.map((workspace, index) => (
            <li
              key={workspace.id}
              className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted"
              data-testid={`workspace-order-${workspace.id}`}
            >
              <span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">{workspace.name}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('moveUp', { name: workspace.name })}
                disabled={index === 0}
                onClick={() => move(index, 'up')}
                data-move={`${workspace.id}:up`}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('moveDown', { name: workspace.name })}
                disabled={index === list.length - 1}
                onClick={() => move(index, 'down')}
                data-move={`${workspace.id}:down`}
              >
                <ArrowDownIcon />
              </Button>
            </li>
          ))}
        </ol>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} data-testid="workspace-order-done">
            {t('done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
