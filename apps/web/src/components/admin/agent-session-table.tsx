'use client';

import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type AgentSession,
  type AgentSessionRevertResponse,
  type AgentSessionSort,
} from '@exocortex/contracts';
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
import {
  ListFilter,
  ListPager,
  ListSearch,
  pageFrom,
  SortableHead,
  useListParams,
} from '@/components/admin/list-controls';
import { useAgentSessions, useRevertAgentSession } from '@/lib/api/admin-queries';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';

const DATE_TIME = { dateStyle: 'medium', timeStyle: 'short' } as const;

const PAGE_SIZE = 50;

const LIST_DEFAULTS = {
  q: '',
  transport: 'all',
  writes: 'all',
  sort: 'lastSeenAt',
  order: 'desc',
  page: '1',
};

type SessionListParams = typeof LIST_DEFAULTS;

const TRANSPORT_FILTERS = ['all', 'stdio', 'http'] as const;
const WRITE_FILTERS = ['all', 'with', 'without'] as const;

/** The address as an API query; anything unknown falls back to the default. */
function sessionListQuery(params: SessionListParams, page: number) {
  return {
    q: params.q === '' ? undefined : params.q,
    transport:
      params.transport === 'stdio' || params.transport === 'http' ? params.transport : undefined,
    withWrites:
      params.writes === 'with' ? 'true' : params.writes === 'without' ? 'false' : undefined,
    sort: params.sort === 'startedAt' ? 'startedAt' : 'lastSeenAt',
    order: params.order === 'asc' ? 'asc' : 'desc',
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  } as const;
}

function isSessionListFiltered(params: SessionListParams): boolean {
  return params.q !== '' || params.transport !== 'all' || params.writes !== 'all';
}

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
  const [params, setParams] = useListParams(LIST_DEFAULTS);
  const page = pageFrom(params.page);
  const sessionsQuery = useAgentSessions(sessionListQuery(params, page));
  const filtered = isSessionListFiltered(params);
  const onSort = (sort: AgentSessionSort, order: 'asc' | 'desc') => setParams({ sort, order });
  const revert = useRevertAgentSession();
  const t = useTranslations('admin.agentSessions');
  const format = useFormatter();

  const [pending, setPending] = React.useState<AgentSession | null>(null);
  const [inspected, setInspected] = React.useState<AgentSession | null>(null);
  const [result, setResult] = React.useState<AgentSessionRevertResponse | null>(null);

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

      <SessionListFilters params={params} setParams={setParams} />

      {sessionsQuery.isPending ? (
        <LoadingState label={t('loading')} variant="skeleton" rows={5} />
      ) : sessionsQuery.isError ? (
        <ErrorState title={t('loadFailed')} onRetry={() => void sessionsQuery.refetch()} />
      ) : sessionsQuery.data.sessions.length === 0 ? (
        filtered ? (
          <EmptyState title={t('noMatchTitle')} description={t('noMatchDescription')} />
        ) : (
          <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
        )
      ) : (
        <>
          <Table narrow="list" aria-busy={sessionsQuery.isPlaceholderData}>
            <TableCaption className="sr-only">{t('caption')}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.client')}</TableHead>
                <TableHead>{t('columns.account')}</TableHead>
                <SortableHead
                  column="lastSeenAt"
                  sort={params.sort}
                  order={params.order}
                  onSort={onSort}
                  defaultOrder="desc"
                >
                  {t('columns.period')}
                </SortableHead>
                <TableHead>{t('columns.writes')}</TableHead>
                <TableHead>{t('columns.pages')}</TableHead>
                <TableHead className="sr-only">{t('columns.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessionsQuery.data.sessions.map((session) => (
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
                      disabled={
                        !session.revertable || revert.isPending || sessionsQuery.isPlaceholderData
                      }
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
          <ListPager
            page={page}
            pageSize={PAGE_SIZE}
            total={sessionsQuery.data.total}
            onPage={(next) => setParams({ page: String(next) }, { keepPage: true })}
            testId="agent-session-pager"
          />
        </>
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

function SessionListFilters({
  params,
  setParams,
}: {
  params: SessionListParams;
  setParams: (patch: Partial<SessionListParams>) => void;
}) {
  const t = useTranslations('admin.agentSessions');
  const onSearch = React.useCallback((q: string) => setParams({ q }), [setParams]);
  const filtered = isSessionListFiltered(params);
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <ListSearch
        value={params.q}
        onCommit={onSearch}
        label={t('filters.searchLabel')}
        placeholder={t('filters.searchPlaceholder')}
        testId="agent-session-search"
      />
      <ListFilter
        label={t('filters.transport')}
        value={params.transport}
        options={TRANSPORT_FILTERS.map((value) => ({
          value,
          label: value === 'all' ? t('filters.allTransports') : value,
        }))}
        onChange={(transport) => setParams({ transport })}
        testId="agent-session-filter-transport"
      />
      <ListFilter
        label={t('filters.writes')}
        value={params.writes}
        options={WRITE_FILTERS.map((value) => ({
          value,
          label: t(`filters.writeOptions.${value}`),
        }))}
        onChange={(writes) => setParams({ writes })}
        testId="agent-session-filter-writes"
      />
      {filtered ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setParams({ q: '', transport: 'all', writes: 'all' })}
        >
          {t('filters.reset')}
        </Button>
      ) : null}
    </div>
  );
}
