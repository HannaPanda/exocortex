'use client';

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

const dateTimeFormat = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** Event types, in the words a person uses for them. */
const ACTION_LABELS: Record<string, string> = {
  'document.created': 'angelegt',
  'document.updated': 'geschrieben',
  'document.content.replaced': 'Inhalt ersetzt',
  'document.moved': 'verschoben',
  'document.archived': 'in den Papierkorb',
  'document.restored': 'wiederhergestellt',
  'document.deleted': 'endgültig gelöscht',
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

  if (detailQuery.isPending) {
    return <LoadingState label="Sitzung wird geladen …" variant="skeleton" rows={4} />;
  }
  if (detailQuery.isError) {
    return (
      <ErrorState
        title="Sitzung konnte nicht geladen werden"
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }

  const { writes } = detailQuery.data;
  if (writes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Diese Sitzung hat nichts geschrieben. Aufgezeichnet wird nur, was Seiten verändert.
      </p>
    );
  }

  return (
    <Table narrow="list">
      <TableCaption className="sr-only">Schreibvorgänge dieser Agenten-Sitzung</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Zeitpunkt</TableHead>
          <TableHead>Seite</TableHead>
          <TableHead>Vorgang</TableHead>
          <TableHead>Stand davor</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {writes.map((write) => (
          <TableRow key={write.id} data-testid="agent-write-row">
            <TableCell label="Zeitpunkt" className="whitespace-nowrap text-muted-foreground">
              {dateTimeFormat.format(new Date(write.createdAt))}
            </TableCell>
            <TableCell cell="title">{write.documentTitle ?? 'Gelöschte Seite'}</TableCell>
            <TableCell label="Vorgang">{ACTION_LABELS[write.action] ?? write.action}</TableCell>
            <TableCell label="Stand davor" className="text-muted-foreground">
              {write.snapshotBeforeId === null ? 'keiner' : 'vorhanden'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
