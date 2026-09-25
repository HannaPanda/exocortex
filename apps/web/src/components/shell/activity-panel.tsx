'use client';

import {
  ActivityIcon,
  ArchiveIcon,
  ArrowRightLeftIcon,
  EllipsisIcon,
  FilePlusIcon,
  GitCompareIcon,
  HistoryIcon,
  PencilIcon,
  RotateCcwIcon,
  Share2Icon,
  Undo2Icon,
} from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import { type DocumentActivityEntry } from '@exocortex/contracts';
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  ErrorState,
  LoadingState,
  sectionLabelClassName,
  SectionRule,
  TruncatedText,
} from '@exocortex/ui';

import { useDocument } from '@/lib/api/document-queries';
import { useDocumentActivity, useRestoreSnapshot } from '@/lib/api/snapshot-queries';

import { type DiffableSnapshot, SnapshotDiffDialog } from './snapshot-diff-dialog';

type Formatter = ReturnType<typeof useFormatter>;
type Translate = ReturnType<typeof useTranslations<'dialogs.activity'>>;

function formatDateTime(format: Formatter, iso: string): string {
  return format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
}
function formatTime(format: Formatter, iso: string): string {
  return format.dateTime(new Date(iso), { timeStyle: 'short' });
}

/** Local calendar day, which is what a reader means by "the same day". */
function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * The heading over a day's entries.
 *
 * "Heute" and "Gestern" are what somebody reading their own page's history is
 * actually looking for; a weekday carries the rest of the current year, because
 * "Mittwoch" places a change in memory in a way "17.09." does not. Only once
 * the year differs does the year become worth its width.
 */
function dayHeading(iso: string, now: Date, t: Translate, format: Formatter): string {
  const date = new Date(iso);
  if (dayKey(iso) === dayKey(now.toISOString())) return t('today');
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return t('yesterday');
  if (date.getFullYear() !== now.getFullYear()) {
    return format.dateTime(date, { dateStyle: 'long' });
  }
  return format.dateTime(date, { weekday: 'long', day: 'numeric', month: 'long' });
}

/** When an entry happened; an editing session is filed under the day it ended. */
function entryTimestamp(entry: DocumentActivityEntry): string {
  return entry.type === 'editingSession' ? entry.endedAt : entry.occurredAt;
}

/** Message key of the label for a snapshot's `reason`. */
const SNAPSHOT_REASON_LABEL = {
  manual: 'snapshotReason.manual',
  scheduled: 'snapshotReason.scheduled',
  pre_restore: 'snapshotReason.preRestore',
  import: 'snapshotReason.import',
  restore: 'snapshotReason.restore',
  api_write: 'snapshotReason.apiWrite',
} as const satisfies Record<Extract<DocumentActivityEntry, { type: 'snapshot' }>['reason'], string>;

type SnapshotEntry = Extract<DocumentActivityEntry, { type: 'snapshot' }>;

/** One row's icon, matched to the entry kind so the timeline scans quickly. */
function EntryIcon({ type }: { type: DocumentActivityEntry['type'] }) {
  const className = 'mt-0.5 size-4 shrink-0 text-muted-foreground';
  switch (type) {
    case 'created':
      return <FilePlusIcon className={className} aria-hidden />;
    case 'renamed':
    case 'editingSession':
      return <PencilIcon className={className} aria-hidden />;
    case 'moved':
      return <ArrowRightLeftIcon className={className} aria-hidden />;
    case 'archived':
      return <ArchiveIcon className={className} aria-hidden />;
    case 'restored':
      return <Undo2Icon className={className} aria-hidden />;
    case 'snapshotRestored':
      return <RotateCcwIcon className={className} aria-hidden />;
    case 'snapshot':
      return <HistoryIcon className={className} aria-hidden />;
    case 'shared':
      return <Share2Icon className={className} aria-hidden />;
  }
}

/**
 * One event.
 *
 * The title says *what happened* and the second line says when and by whom,
 * which is the opposite of how this panel used to read. A history sorted by
 * time that also prints the date on every row spends its width restating the
 * order it is already in: the date moved up into the day heading, the row kept
 * the clock time, and the sentence that is actually news moved into the title.
 *
 * What it does not do is grow a column of buttons. This panel is resizable down
 * to 260 pixels, where two labelled buttons leave the text about sixty pixels
 * to live in. An entry that can be acted on is a button itself, with its other
 * actions behind one menu of fixed width.
 */
function Row({
  type,
  title,
  meta,
  onActivate,
  activateLabel,
  actions,
}: {
  type: DocumentActivityEntry['type'];
  title: string;
  meta: string;
  /** Makes the row itself the primary action. Omit for an entry that has none. */
  onActivate?: () => void;
  activateLabel?: string;
  actions?: React.ReactNode;
}) {
  const body = (
    <>
      <EntryIcon type={type} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <TruncatedText text={title} className="font-medium" />
        <span className="exocortex-numeric truncate text-xs text-muted-foreground">{meta}</span>
      </span>
    </>
  );

  return (
    // Borderless: a boxed row per event turned a history into a stack of
    // identical cards. The aligned icon column and the day headings carry the
    // sequence; a box around each one only added chrome.
    <div className="group flex items-start gap-0.5 text-sm">
      {onActivate === undefined ? (
        <div className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5">{body}</div>
      ) : (
        <button
          type="button"
          onClick={onActivate}
          aria-label={activateLabel}
          data-testid="activity-entry-open"
          className={cn(
            'flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
            'hover:bg-accent hover:text-foreground',
            'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
          )}
        >
          {body}
        </button>
      )}
      {actions}
    </div>
  );
}

function ActivityEntryRow({
  entry,
  readOnly,
  onRequestRestore,
  onRequestCompare,
}: {
  entry: DocumentActivityEntry;
  readOnly: boolean;
  onRequestRestore: (entry: SnapshotEntry) => void;
  onRequestCompare: (entry: SnapshotEntry) => void;
}) {
  const t = useTranslations('dialogs.activity');
  const format = useFormatter();
  const who = entry.actorName ?? t('unknownActor');
  const at = t('meta', { time: formatTime(format, entryTimestamp(entry)), who });

  switch (entry.type) {
    case 'created':
      return <Row type={entry.type} title={t('created')} meta={at} />;
    case 'renamed':
      return (
        <Row
          type={entry.type}
          title={t('renamed', {
            previous: entry.previousTitle ?? '?',
            next: entry.nextTitle ?? '?',
          })}
          meta={at}
        />
      );
    case 'moved':
      return (
        <Row
          type={entry.type}
          title={entry.acrossWorkspace ? t('movedAcrossWorkspace') : t('moved')}
          meta={at}
        />
      );
    case 'archived':
      return <Row type={entry.type} title={t('archived')} meta={at} />;
    case 'restored':
      return <Row type={entry.type} title={t('restored')} meta={at} />;
    case 'snapshotRestored':
      return <Row type={entry.type} title={t('snapshotRestored')} meta={at} />;
    case 'shared':
      return (
        <Row
          type={entry.type}
          title={
            entry.kind === 'PUBLIC_LINK'
              ? entry.revoked
                ? t('publicLinkRevoked')
                : t('publicLinkCreated')
              : entry.revoked
                ? t('grantRevoked')
                : t('granted')
          }
          meta={at}
        />
      );
    case 'editingSession':
      return (
        <Row
          type={entry.type}
          title={
            entry.startedAt === entry.endedAt
              ? t('edited')
              : t('editedBetween', {
                  from: formatTime(format, entry.startedAt),
                  to: formatTime(format, entry.endedAt),
                })
          }
          meta={at}
        />
      );
    case 'snapshot':
      return (
        <Row
          type={entry.type}
          title={t(SNAPSHOT_REASON_LABEL[entry.reason])}
          meta={at}
          /*
           * Comparing is the row's own action, and it is offered to readers
           * too: it changes nothing, and "what did the agent write last night"
           * is a question somebody without write access has as much as anybody
           * else. Restoring is the one that overwrites, so it stays behind the
           * menu and behind a confirmation after that.
           */
          onActivate={() => onRequestCompare(entry)}
          activateLabel={t('compareSnapshot', { date: formatDateTime(format, entry.occurredAt) })}
          actions={
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="mt-1 shrink-0"
                    aria-label={t('snapshotActions', {
                      date: formatDateTime(format, entry.occurredAt),
                    })}
                    data-testid="activity-entry-menu"
                  >
                    <EllipsisIcon />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  data-testid="activity-compare-item"
                  onClick={() => onRequestCompare(entry)}
                >
                  <GitCompareIcon /> {t('compare')}
                </DropdownMenuItem>
                {readOnly ? null : (
                  <DropdownMenuItem
                    data-testid="activity-restore-item"
                    onClick={() => onRequestRestore(entry)}
                  >
                    <RotateCcwIcon /> {t('restoreEllipsis')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
      );
  }
}

interface DayGroup {
  key: string;
  heading: string;
  entries: DocumentActivityEntry[];
}

/**
 * Splits the list into calendar days, keeping the order the server sent.
 *
 * A day that comes back twice would be printed twice rather than merged: the
 * list is the server's ordering, and quietly regrouping it here would hide a
 * sorting bug instead of showing it.
 */
function groupByDay(
  entries: DocumentActivityEntry[],
  now: Date,
  heading: (iso: string, now: Date) => string,
): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const entry of entries) {
    const timestamp = entryTimestamp(entry);
    const key = dayKey(timestamp);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.key === key) last.entries.push(entry);
    else groups.push({ key, heading: heading(timestamp, now), entries: [entry] });
  }
  return groups;
}

export interface ActivityPanelProps {
  workspaceId: string | null;
  documentId: string | null;
}

/**
 * The "Aktivität" tab: the page's own history, not a compliance audit trail
 * (issue #20). One merged, reverse-chronological list of what happened to
 * *this* page -- created, renamed, moved, archived, restored, restorable
 * snapshots, and condensed editing sessions -- built server-side by
 * `DocumentActivityService`, grouped into days here.
 *
 * A snapshot row opens the comparison (issue #77), which is the question this
 * panel is usually open for. Restoring a snapshot is destructive (it overwrites
 * the page's current content, even though the current state is itself
 * snapshotted first), so it sits in the row's menu and goes through a
 * confirmation dialog rather than firing on a click.
 */
export function ActivityPanel({ workspaceId, documentId }: ActivityPanelProps) {
  const t = useTranslations('dialogs.activity');
  const format = useFormatter();
  const document = useDocument(documentId ?? undefined);
  const activity = useDocumentActivity(documentId ?? undefined);
  const restoreSnapshot = useRestoreSnapshot(documentId ?? undefined);
  const [pendingRestore, setPendingRestore] = React.useState<SnapshotEntry | null>(null);
  const [comparing, setComparing] = React.useState<DiffableSnapshot | null>(null);
  const [restoreError, setRestoreError] = React.useState<string | null>(null);

  if (documentId === null || workspaceId === null) {
    return (
      <EmptyState
        title={t('noPageTitle')}
        description={t('noPageDescription')}
        icon={ActivityIcon}
      />
    );
  }

  if (activity.isPending || document.isPending) {
    return <LoadingState variant="skeleton" rows={5} label={t('loading')} />;
  }

  if (activity.isError) {
    return (
      <ErrorState
        title={t('unavailable')}
        description={t('historyLoadError')}
        onRetry={() => void activity.refetch()}
      />
    );
  }
  if (document.isError) {
    return (
      <ErrorState
        title={t('unavailable')}
        description={t('pageLoadError')}
        onRetry={() => void document.refetch()}
      />
    );
  }

  const readOnly = document.data.access === 'read';
  const entries = activity.data.entries;
  const snapshots: DiffableSnapshot[] = entries
    .filter((entry): entry is SnapshotEntry => entry.type === 'snapshot')
    .map((entry) => ({ id: entry.id, createdAt: entry.occurredAt }));
  const groups = groupByDay(entries, new Date(), (iso, now) => dayHeading(iso, now, t, format));

  return (
    <div className="flex flex-col gap-3" data-testid="activity-panel">
      <SectionRule as="h3" trailing={entries.length === 0 ? undefined : entries.length}>
        {t('history')}
      </SectionRule>
      {entries.length === 0 ? (
        <EmptyState
          title={t('emptyTitle')}
          description={t('emptyDescription')}
          icon={ActivityIcon}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <section key={group.key} className="flex flex-col gap-0.5">
              {/* Quieter than the `SectionRule` above it: this is a marker
                  inside a section, not a second section. What makes it quieter
                  is the missing square and the missing hairline, not a
                  different tracking -- it carried `0.12em` against the
                  component's `0.14em`, which nobody can see and which meant the
                  mark had two definitions. */}
              <h4 className={cn('exocortex-numeric px-2 pb-1', sectionLabelClassName)}>
                {group.heading}
              </h4>
              {group.entries.map((entry) => (
                <ActivityEntryRow
                  key={entry.id}
                  entry={entry}
                  readOnly={readOnly}
                  onRequestRestore={(target) => {
                    setRestoreError(null);
                    setPendingRestore(target);
                  }}
                  onRequestCompare={(target) =>
                    setComparing({ id: target.id, createdAt: target.occurredAt })
                  }
                />
              ))}
            </section>
          ))}
        </div>
      )}

      <SnapshotDiffDialog
        documentId={documentId}
        snapshot={comparing}
        snapshots={snapshots}
        readOnly={readOnly}
        onClose={() => setComparing(null)}
      />

      <Dialog
        open={pendingRestore !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingRestore(null);
            setRestoreError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('restoreTitle')}</DialogTitle>
            <DialogDescription>
              {pendingRestore !== null
                ? t('restoreDescription', {
                    date: formatDateTime(format, pendingRestore.occurredAt),
                  })
                : null}
            </DialogDescription>
          </DialogHeader>
          {restoreError !== null ? (
            <p role="alert" className="text-sm text-destructive-text">
              {restoreError}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingRestore(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={restoreSnapshot.isPending}
              data-testid="activity-restore-confirm"
              onClick={() => {
                if (pendingRestore === null) return;
                restoreSnapshot.mutate(pendingRestore.id, {
                  onSuccess: () => {
                    setPendingRestore(null);
                    setRestoreError(null);
                  },
                  onError: (error) => {
                    setRestoreError(
                      error instanceof Error ? error.message : t('restoreUnknownError'),
                    );
                  },
                });
              }}
            >
              {t('restore')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
