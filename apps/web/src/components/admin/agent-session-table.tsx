'use client';

import * as React from 'react';

import { type AgentSession, type AgentSessionRevertResponse } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  LoadingState,
  SectionRule,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import { AgentSessionDetail } from '@/components/admin/agent-session-detail';
import { useAgentSessions, useRevertAgentSession } from '@/lib/api/admin-queries';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';

const dateTimeFormat = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const SKIP_REASONS: Record<string, string> = {
  changed_since: 'seither von jemand anderem bearbeitet',
  no_snapshot: 'kein Stand davor vorhanden',
  unavailable: 'Seite nicht verfügbar',
};

/**
 * Which agents wrote here, and the way back (issue #49).
 *
 * The list exists so that giving an agent write access stops being a decision
 * one has to be brave about: a mistake is a button, not an afternoon of
 * comparing pages. Which is also why the revert dialog names what it will
 * leave alone before it runs, rather than reporting it afterwards.
 */
export function AgentSessionTable() {
  const sessionsQuery = useAgentSessions();
  const revert = useRevertAgentSession();

  const [pending, setPending] = React.useState<AgentSession | null>(null);
  const [inspected, setInspected] = React.useState<AgentSession | null>(null);
  const [result, setResult] = React.useState<AgentSessionRevertResponse | null>(null);

  if (sessionsQuery.isPending) {
    return <LoadingState label="Agenten-Sitzungen werden geladen …" variant="skeleton" rows={5} />;
  }
  if (sessionsQuery.isError) {
    return (
      <ErrorState
        title="Sitzungen konnten nicht geladen werden"
        onRetry={() => void sessionsQuery.refetch()}
      />
    );
  }

  const sessions = sessionsQuery.data;
  const error = revert.error instanceof ApiError ? revert.error : null;

  const runRevert = (session: AgentSession): void => {
    revert.mutate(session.id, {
      onSuccess: (response) => {
        setResult(response);
        setPending(null);
      },
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <SectionRule>Agenten-Sitzungen</SectionRule>
        <p className="text-sm text-muted-foreground">
          Jede Verbindung eines Agenten mit dem, was sie geschrieben hat. Zurücknehmen setzt jede
          betroffene Seite auf den Stand vor dem ersten Eingriff dieser Sitzung zurück; Seiten, die
          inzwischen jemand anderes bearbeitet hat, bleiben unangetastet.
        </p>
      </div>

      {error !== null ? (
        <Alert variant="destructive" data-testid="agent-session-error">
          <AlertDescription>{messageForCode(error.code)}</AlertDescription>
        </Alert>
      ) : null}

      {result !== null ? (
        <Alert data-testid="agent-session-revert-result">
          <AlertDescription>
            <span className="font-medium">
              {result.reverted.length} Seite(n) zurückgesetzt, {result.skipped.length} übersprungen.
            </span>
            {result.skipped.length > 0 ? (
              <ul className="mt-2 list-disc pl-5">
                {result.skipped.map((entry) => (
                  <li key={entry.documentId}>
                    {entry.documentTitle ?? entry.documentId}:{' '}
                    {SKIP_REASONS[entry.reason] ?? entry.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {sessions.length === 0 ? (
        <EmptyState
          title="Noch keine Agenten-Sitzung aufgezeichnet"
          description="Sobald ein Agent über MCP oder die eingebaute KI eine Seite schreibt, erscheint die Sitzung hier."
        />
      ) : (
        <Table>
          <TableCaption className="sr-only">Agenten-Sitzungen dieser Installation</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead>Konto</TableHead>
              <TableHead>Zeitraum</TableHead>
              <TableHead>Schreibvorgänge</TableHead>
              <TableHead>Seiten</TableHead>
              <TableHead className="sr-only">Aktionen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((session) => (
              <TableRow key={session.id} data-testid="agent-session-row">
                <TableCell className="font-medium">
                  {session.clientLabel ?? session.externalId}
                  {session.transport === null ? null : (
                    <Badge variant="secondary" className="ml-2">
                      {session.transport}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{session.userName ?? '—'}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {dateTimeFormat.format(new Date(session.startedAt))} bis{' '}
                  {dateTimeFormat.format(new Date(session.lastSeenAt))}
                </TableCell>
                <TableCell>{session.writeCount}</TableCell>
                <TableCell>{session.documentCount}</TableCell>
                <TableCell className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setInspected(session)}>
                    Details
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!session.revertable || revert.isPending}
                    onClick={() => setPending(session)}
                    data-testid="revert-agent-session"
                  >
                    Zurücknehmen
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog
        open={inspected !== null}
        onOpenChange={(open) => {
          if (!open) setInspected(null);
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{inspected?.clientLabel ?? 'Agenten-Sitzung'}</DialogTitle>
            <DialogDescription>Was diese Sitzung angefasst hat, neueste zuerst.</DialogDescription>
          </DialogHeader>
          {inspected === null ? null : <AgentSessionDetail sessionId={inspected.id} />}
        </DialogContent>
      </Dialog>

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sitzung zurücknehmen?</DialogTitle>
            <DialogDescription>
              {pending === null
                ? null
                : `${pending.documentCount} Seite(n) werden auf den Stand vor dieser Sitzung zurückgesetzt. ` +
                  'Der aktuelle Stand jeder Seite wird vorher gesichert, der Schritt ist also selbst umkehrbar.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              disabled={revert.isPending}
              onClick={() => {
                if (pending !== null) runRevert(pending);
              }}
              data-testid="confirm-revert-agent-session"
            >
              Zurücknehmen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
