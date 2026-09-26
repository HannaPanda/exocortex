'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type ChangesetSummary } from '@exocortex/contracts';
import {
  AppPage,
  Badge,
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

import { type ChangesetListFilter, useChangesets } from '@/lib/api/changeset-queries';

import { useWorkItemWording } from '../work-items/work-item-labels';

import { changesetStatusVariant } from './changeset-labels';

/**
 * The proposed changes of one workspace (issue #141, ADR-070).
 *
 * What the screen answers is "what waits for me to look at", so the open ones
 * come first and the count of what is still undecided stands beside each.
 * Deciding happens on the changeset itself, where the diff is.
 */

type FilterKey = ChangesetListFilter['state'];
const FILTER_ORDER: readonly FilterKey[] = ['open', 'closed', 'all'];

export function ChangesetsPage({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('changesets.list');
  const [filter, setFilter] = React.useState<FilterKey>('open');
  const list = useChangesets(workspaceId, { state: filter });

  return (
    <AppPage maxWidth="max-w-5xl">
      <h1 className="exocortex-page-title">{t('title')}</h1>
      <p className="mt-1 max-w-measure text-sm text-muted-foreground">{t('intro')}</p>

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
        {list.isPending ? (
          <LoadingState variant="skeleton" rows={4} label={t('loading')} />
        ) : list.isError ? (
          <ErrorState title={t('loadFailed')} onRetry={() => void list.refetch()} />
        ) : list.data.changesets.length === 0 ? (
          <EmptyState
            title={t(filter === 'open' ? 'emptyTitle' : 'emptyAllTitle')}
            description={t('emptyDescription')}
          />
        ) : (
          <>
            <ChangesetTable workspaceId={workspaceId} changesets={list.data.changesets} />
            {list.data.truncated ? (
              <p className="mt-2 text-xs text-muted-foreground">{t('truncated')}</p>
            ) : null}
          </>
        )}
      </section>
    </AppPage>
  );
}

export function ChangesetTable({
  workspaceId,
  changesets,
}: {
  workspaceId: string;
  changesets: readonly ChangesetSummary[];
}) {
  const t = useTranslations('changesets');
  const wording = useWorkItemWording();
  return (
    <Table narrow="list" data-testid="changesets">
      <TableHeader>
        <TableRow>
          <TableHead>{t('list.columns.title')}</TableHead>
          <TableHead>{t('list.columns.status')}</TableHead>
          <TableHead>{t('list.columns.proposedBy')}</TableHead>
          <TableHead>{t('list.columns.changes')}</TableHead>
          <TableHead>{t('list.columns.updated')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {changesets.map((changeset) => (
          <TableRow key={changeset.id} data-testid="changeset-row">
            <TableCell cell="title">
              <Link
                href={`/arbeitsbereich/${workspaceId}/vorschlaege/${changeset.id}`}
                className="font-medium hover:underline"
              >
                {changeset.title}
              </Link>
              {changeset.workItem === null ? null : (
                <div className="text-xs text-muted-foreground">
                  {t('list.workItem', { title: changeset.workItem.title })}
                </div>
              )}
            </TableCell>
            <TableCell label={t('list.columns.status')}>
              <Badge variant={changesetStatusVariant(changeset.status)}>
                {t(`labels.status.${changeset.status}`)}
              </Badge>
            </TableCell>
            <TableCell
              label={t('list.columns.proposedBy')}
              className="text-sm text-muted-foreground"
            >
              {wording.participant(changeset.proposedBy)}
            </TableCell>
            <TableCell label={t('list.columns.changes')} className="text-sm text-muted-foreground">
              {t('list.counts', {
                pending: changeset.counts.pending,
                total: changeset.counts.total,
              })}
            </TableCell>
            <TableCell label={t('list.columns.updated')} className="text-sm text-muted-foreground">
              {wording.moment(changeset.updatedAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
