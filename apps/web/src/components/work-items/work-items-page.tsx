'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type WorkItemSummary } from '@exocortex/contracts';
import {
  AppPage,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Toggle,
  ToggleGroup,
} from '@exocortex/ui';

import { useWorkItems, type WorkItemListFilter } from '@/lib/api/work-item-queries';
import { useWorkspaceDetail } from '@/lib/api/workspace-queries';

import { WorkItemDialog } from './work-item-dialog';
import { statusVariant, useWorkItemWording } from './work-item-labels';

/**
 * The delegated work of one workspace (issue #138, ADR-066).
 *
 * A dense list on purpose, no board: the question this screen answers is
 * "what is open, who has it, and what is it waiting for", and a column per
 * status would spread eight words over the width of a screen. The status
 * reason sits under the title because it is the part a reader acts on.
 */

type FilterKey = 'open' | 'mine' | 'requested' | 'all';

const FILTERS: Record<FilterKey, WorkItemListFilter> = {
  open: { open: 'true' },
  mine: { open: 'true', assignee: 'me' },
  requested: { open: 'true', requester: 'me' },
  all: { open: 'all' },
};

const FILTER_ORDER: readonly FilterKey[] = ['open', 'mine', 'requested', 'all'];

export function WorkItemsPage({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('workItems.list');
  const detail = useWorkspaceDetail(workspaceId);
  const [filter, setFilter] = React.useState<FilterKey>('open');
  const items = useWorkItems(workspaceId, FILTERS[filter]);
  const params = useSearchParams();
  const router = useRouter();
  // `?new=1` is the palette's "Neuer Auftrag": the list opens with its dialog,
  // and the parameter is dropped so a reload does not open it again.
  const [dialogOpen, setDialogOpen] = React.useState(() => params.get('new') === '1');
  React.useEffect(() => {
    if (params.get('new') === '1') router.replace(`/arbeitsbereich/${workspaceId}/auftraege`);
  }, [params, router, workspaceId]);

  const canWrite = detail.data !== undefined && detail.data.role !== 'GUEST';

  return (
    <AppPage maxWidth="max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="exocortex-page-title">{t('title')}</h1>
          <p className="mt-1 max-w-measure text-sm text-muted-foreground">{t('intro')}</p>
        </div>
        {canWrite ? (
          <Button onClick={() => setDialogOpen(true)} data-testid="work-item-new">
            {t('newItem')}
          </Button>
        ) : null}
      </div>

      <ToggleGroup
        className="mt-6"
        aria-label={t('filterLabel')}
        value={[filter]}
        onValueChange={(next: string[]) => {
          const chosen = next[0];
          if (chosen !== undefined) setFilter(chosen as FilterKey);
        }}
      >
        {FILTER_ORDER.map((key) => (
          <Toggle key={key} value={key} variant="outline" size="sm">
            {t(`filters.${key}`)}
          </Toggle>
        ))}
      </ToggleGroup>

      <section className="mt-4">
        {items.isPending ? (
          <LoadingState variant="skeleton" rows={5} label={t('loading')} />
        ) : items.isError ? (
          <ErrorState title={t('loadFailed')} onRetry={() => void items.refetch()} />
        ) : items.data.workItems.length === 0 ? (
          <EmptyState
            title={t(filter === 'all' ? 'emptyAllTitle' : 'emptyTitle')}
            description={t('emptyDescription')}
          />
        ) : (
          <>
            <WorkItemTable workspaceId={workspaceId} items={items.data.workItems} />
            {items.data.truncated ? (
              <p className="mt-2 text-xs text-muted-foreground">{t('truncated')}</p>
            ) : null}
          </>
        )}
      </section>

      {canWrite ? (
        <WorkItemDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          workspaceId={workspaceId}
          members={detail.data?.members ?? []}
          item={null}
        />
      ) : null}
    </AppPage>
  );
}

function WorkItemTable({
  workspaceId,
  items,
}: {
  workspaceId: string;
  items: readonly WorkItemSummary[];
}) {
  const t = useTranslations('workItems.list');
  const wording = useWorkItemWording();
  return (
    <Table narrow="list" data-testid="work-items">
      <TableHeader>
        <TableRow>
          <TableHead>{t('columns.title')}</TableHead>
          <TableHead>{t('columns.status')}</TableHead>
          <TableHead>{t('columns.assignee')}</TableHead>
          <TableHead>{t('columns.requester')}</TableHead>
          <TableHead>{t('columns.progress')}</TableHead>
          <TableHead>{t('columns.updated')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.id} data-testid="work-item-row">
            <TableCell cell="title">
              <Link
                href={`/arbeitsbereich/${workspaceId}/auftraege/${item.id}`}
                className="font-medium hover:underline"
              >
                {item.title}
              </Link>
              {item.statusReason === null ? null : (
                <div className="text-xs text-muted-foreground">{item.statusReason}</div>
              )}
              {item.priority === 'high' || item.priority === 'urgent' ? (
                <div className="text-xs text-destructive-text">
                  {wording.priority(item.priority)}
                </div>
              ) : null}
            </TableCell>
            <TableCell label={t('columns.status')}>
              <Badge variant={statusVariant(item.status)}>{wording.status(item.status)}</Badge>
            </TableCell>
            <TableCell label={t('columns.assignee')} className="text-sm text-muted-foreground">
              {wording.participant(item.assignee)}
            </TableCell>
            <TableCell label={t('columns.requester')} className="text-sm text-muted-foreground">
              {wording.participant(item.requester)}
            </TableCell>
            <TableCell label={t('columns.progress')} className="text-sm text-muted-foreground">
              {item.criteriaTotal === 0
                ? t('noCriteria')
                : t('criteria', { met: item.criteriaMet, total: item.criteriaTotal })}
              {item.childCount === 0 ? null : (
                <div className="text-xs">{t('children', { count: item.childCount })}</div>
              )}
            </TableCell>
            <TableCell label={t('columns.updated')} className="text-sm text-muted-foreground">
              {wording.moment(item.updatedAt)}
              {item.dueAt === null ? null : (
                <div className="text-xs">{t('due', { day: wording.day(item.dueAt) })}</div>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
