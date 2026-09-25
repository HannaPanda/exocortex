'use client';

import { useFormatter, useTranslations } from 'next-intl';
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

const DATE_TIME = { dateStyle: 'medium', timeStyle: 'short' } as const;

/** Skip reasons the catalogue has a sentence for; anything else is shown raw. */
const SKIP_REASONS = ['changed_since', 'no_snapshot', 'unavailable'] as const;
type SkipReason = (typeof SKIP_REASONS)[number];

function isSkipReason(reason: string): reason is SkipReason {
  return (SKIP_REASONS as readonly string[]).includes(reason);
}

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
  const t = useTranslations('admin.agentSessions');
  const format = useFormatter();

  const [pending, setPending] = React.useState<AgentSession | null>(null);
  const [inspected, setInspected] = React.useState<AgentSession | null>(null);
  const [result, setResult] = React.useState<AgentSessionRevertResponse | null>(null);

  if (sessionsQuery.isPending) {
    return <LoadingState label={t('loading')} variant="skeleton" rows={5} />;
  }
  if (sessionsQuery.isError) {
    return <ErrorState title={t('loadFailed')} onRetry={() => void sessionsQuery.refetch()} />;
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
        <SectionRule>{t('title')}</SectionRule>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
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
              {t('revertResult', {
                reverted: result.reverted.length,
                skipped: result.skipped.length,
              })}
            </span>
            {result.skipped.length > 0 ? (
              <ul className="mt-2 list-disc pl-5">
                {result.skipped.map((entry) => (
                  <li key={entry.documentId}>
                    {t('skippedEntry', {
                      title: entry.documentTitle ?? entry.documentId,
                      reason: isSkipReason(entry.reason)
                        ? t(`skipReasons.${entry.reason}`)
                        : entry.reason,
                    })}
                  </li>
                ))}
              </ul>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {sessions.length === 0 ? (
        <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : (
        <Table narrow="list">
          <TableCaption className="sr-only">{t('caption')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t('columns.client')}</TableHead>
              <TableHead>{t('columns.account')}</TableHead>
              <TableHead>{t('columns.period')}</TableHead>
              <TableHead>{t('columns.writes')}</TableHead>
              <TableHead>{t('columns.pages')}</TableHead>
              <TableHead className="sr-only">{t('columns.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((session) => (
              <TableRow key={session.id} data-testid="agent-session-row">
                <TableCell cell="title" className="font-medium">
                  {session.clientLabel ?? session.externalId}
                  {session.transport === null ? null : (
                    <Badge variant="secondary" className="ml-2">
                      {session.transport}
                    </Badge>
                  )}
                </TableCell>
                <TableCell label={t('columns.account')} className="text-muted-foreground">
                  {session.userName ?? '–'}
                </TableCell>
                <TableCell
                  label={t('columns.period')}
                  className="whitespace-nowrap text-muted-foreground"
                >
                  {t('period', {
                    start: format.dateTime(new Date(session.startedAt), DATE_TIME),
                    end: format.dateTime(new Date(session.lastSeenAt), DATE_TIME),
                  })}
                </TableCell>
                <TableCell label={t('columns.writes')}>{session.writeCount}</TableCell>
                <TableCell label={t('columns.pages')}>{session.documentCount}</TableCell>
                <TableCell cell="actions" className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setInspected(session)}>
                    {t('details')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!session.revertable || revert.isPending}
                    onClick={() => setPending(session)}
                    data-testid="revert-agent-session"
                  >
                    {t('revert')}
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
            <DialogTitle>{inspected?.clientLabel ?? t('detailTitleFallback')}</DialogTitle>
            <DialogDescription>{t('detailDescription')}</DialogDescription>
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
            <DialogTitle>{t('confirmTitle')}</DialogTitle>
            <DialogDescription>
              {pending === null ? null : t('confirmDescription', { count: pending.documentCount })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPending(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={revert.isPending}
              onClick={() => {
                if (pending !== null) runRevert(pending);
              }}
              data-testid="confirm-revert-agent-session"
            >
              {t('revert')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
