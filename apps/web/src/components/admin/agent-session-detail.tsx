'use client';

import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import {
  ErrorState,
  LoadingState,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import { useAgentSession } from '@/lib/api/admin-queries';

type ActionKey =
  'created' | 'updated' | 'contentReplaced' | 'moved' | 'archived' | 'restored' | 'deleted';

/** Event types, mapped to the catalogue key naming them in the words a person uses. */
const ACTION_KEYS: Record<string, ActionKey> = {
  'document.created': 'created',
  'document.updated': 'updated',
  'document.content.replaced': 'contentReplaced',
  'document.moved': 'moved',
  'document.archived': 'archived',
  'document.restored': 'restored',
  'document.deleted': 'deleted',
};

/**
 * What one session did, write by write.
 *
 * The "Stand davor" column is the whole point of the list: it is the
 * difference between a page this can take back and one it can only report on,
 * and somebody about to press "Alles zurücknehmen" deserves to see which is
 * which beforehand.
 */
export function AgentSessionDetail({ sessionId }: { sessionId: string }) {
  const detailQuery = useAgentSession(sessionId);
  const t = useTranslations('admin.agentSessionDetail');
  const format = useFormatter();

  if (detailQuery.isPending) {
    return <LoadingState label={t('loading')} variant="skeleton" rows={4} />;
  }
  if (detailQuery.isError) {
    return <ErrorState title={t('loadFailed')} onRetry={() => void detailQuery.refetch()} />;
  }

  const { writes } = detailQuery.data;
  const actionLabel = (action: string): string => {
    const key = ACTION_KEYS[action];
    return key === undefined ? action : t(`actions.${key}`);
  };
  if (writes.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  }

  return (
    <Table narrow="list">
      <TableCaption className="sr-only">{t('caption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>{t('columns.time')}</TableHead>
          <TableHead>{t('columns.page')}</TableHead>
          <TableHead>{t('columns.action')}</TableHead>
          <TableHead>{t('columns.snapshotBefore')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {writes.map((write) => (
          <TableRow key={write.id} data-testid="agent-write-row">
            <TableCell
              label={t('columns.time')}
              className="whitespace-nowrap text-muted-foreground"
            >
              {format.dateTime(new Date(write.createdAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </TableCell>
            <TableCell cell="title">{write.documentTitle ?? t('deletedPage')}</TableCell>
            <TableCell label={t('columns.action')}>{actionLabel(write.action)}</TableCell>
            <TableCell label={t('columns.snapshotBefore')} className="text-muted-foreground">
              {write.snapshotBeforeId === null ? t('snapshotNone') : t('snapshotPresent')}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
