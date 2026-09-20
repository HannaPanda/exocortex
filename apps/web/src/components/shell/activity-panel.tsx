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

const dateTimeFormat = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const timeFormat = new Intl.DateTimeFormat('de-DE', { timeStyle: 'short' });
const dayFormat = new Intl.DateTimeFormat('de-DE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const dayWithYearFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'long' });

function formatDateTime(iso: string): string {
  return dateTimeFormat.format(new Date(iso));
}
function formatTime(iso: string): string {
  return timeFormat.format(new Date(iso));
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
function dayHeading(iso: string, now: Date): string {
  const date = new Date(iso);
  if (dayKey(iso) === dayKey(now.toISOString())) return 'Heute';
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return 'Gestern';
  if (date.getFullYear() !== now.getFullYear()) return dayWithYearFormat.format(date);
  return dayFormat.format(date);
}

/** When an entry happened; an editing session is filed under the day it ended. */
function entryTimestamp(entry: DocumentActivityEntry): string {
  return entry.type === 'editingSession' ? entry.endedAt : entry.occurredAt;
}

/** German label for a snapshot's `reason`. */
const SNAPSHOT_REASON_LABEL: Record<
  Extract<DocumentActivityEntry, { type: 'snapshot' }>['reason'],
  string
> = {
  manual: 'Manuell gesichert',
  scheduled: 'Automatisch gesichert',
  pre_restore: 'Vor einer Wiederherstellung gesichert',
  import: 'Beim Import gesichert',
  restore: 'Wiederherstellung',
  api_write: 'Von außen geschrieben',
};

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
            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
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
  const who = entry.actorName ?? 'Unbekannt';
  const at = `${formatTime(entryTimestamp(entry))} · ${who}`;

  switch (entry.type) {
    case 'created':
      return <Row type={entry.type} title="Seite angelegt" meta={at} />;
    case 'renamed':
      return (
        <Row
          type={entry.type}
          title={`Umbenannt: „${entry.previousTitle ?? '?'}“ → „${entry.nextTitle ?? '?'}“`}
          meta={at}
        />
      );
    case 'moved':
      return (
        <Row
          type={entry.type}
          title={entry.acrossWorkspace ? 'In anderen Arbeitsbereich verschoben' : 'Verschoben'}
          meta={at}
        />
      );
    case 'archived':
      return <Row type={entry.type} title="Archiviert" meta={at} />;
    case 'restored':
      return <Row type={entry.type} title="Wiederhergestellt" meta={at} />;
    case 'snapshotRestored':
      return <Row type={entry.type} title="Auf einen früheren Stand zurückgesetzt" meta={at} />;
    case 'shared':
      return (
        <Row
          type={entry.type}
          title={
            entry.kind === 'PUBLIC_LINK'
              ? entry.revoked
                ? 'Öffentlicher Link zurückgezogen'
                : 'Öffentlicher Link erzeugt'
              : entry.revoked
                ? 'Freigabe an ein Konto zurückgezogen'
                : 'An ein Konto freigegeben'
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
              ? 'Bearbeitet'
              : `Bearbeitet ${formatTime(entry.startedAt)} bis ${formatTime(entry.endedAt)}`
          }
          meta={at}
        />
      );
    case 'snapshot':
      return (
        <Row
          type={entry.type}
          title={SNAPSHOT_REASON_LABEL[entry.reason]}
          meta={at}
          /*
           * Comparing is the row's own action, and it is offered to readers
           * too: it changes nothing, and "what did the agent write last night"
           * is a question somebody without write access has as much as anybody
           * else. Restoring is the one that overwrites, so it stays behind the
           * menu and behind a confirmation after that.
           */
          onActivate={() => onRequestCompare(entry)}
          activateLabel={`Stand vom ${formatDateTime(entry.occurredAt)} vergleichen`}
          actions={
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="mt-1 shrink-0"
                    aria-label={`Aktionen für den Stand vom ${formatDateTime(entry.occurredAt)}`}
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
                  <GitCompareIcon /> Vergleichen
                </DropdownMenuItem>
                {readOnly ? null : (
                  <DropdownMenuItem
                    data-testid="activity-restore-item"
                    onClick={() => onRequestRestore(entry)}
                  >
                    <RotateCcwIcon /> Wiederherstellen …
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
function groupByDay(entries: DocumentActivityEntry[], now: Date): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const entry of entries) {
    const timestamp = entryTimestamp(entry);
    const key = dayKey(timestamp);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.key === key) last.entries.push(entry);
    else groups.push({ key, heading: dayHeading(timestamp, now), entries: [entry] });
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
  const document = useDocument(documentId ?? undefined);
  const activity = useDocumentActivity(documentId ?? undefined);
  const restoreSnapshot = useRestoreSnapshot(documentId ?? undefined);
  const [pendingRestore, setPendingRestore] = React.useState<SnapshotEntry | null>(null);
  const [comparing, setComparing] = React.useState<DiffableSnapshot | null>(null);
  const [restoreError, setRestoreError] = React.useState<string | null>(null);

  if (documentId === null || workspaceId === null) {
    return (
      <EmptyState
        title="Keine Seite geöffnet"
        description="Öffne eine Seite, um ihre Aktivität zu sehen."
        icon={ActivityIcon}
      />
    );
  }

  if (activity.isPending || document.isPending) {
    return <LoadingState variant="skeleton" rows={5} label="Aktivität wird geladen …" />;
  }

  if (activity.isError) {
    return (
      <ErrorState
        title="Aktivität nicht verfügbar"
        description="Der Verlauf konnte nicht geladen werden."
        onRetry={() => void activity.refetch()}
      />
    );
  }
  if (document.isError) {
    return (
      <ErrorState
        title="Aktivität nicht verfügbar"
        description="Die Seite konnte nicht geladen werden."
        onRetry={() => void document.refetch()}
      />
    );
  }

  const readOnly = document.data.access === 'read';
  const entries = activity.data.entries;
  const snapshots: DiffableSnapshot[] = entries
    .filter((entry): entry is SnapshotEntry => entry.type === 'snapshot')
    .map((entry) => ({ id: entry.id, createdAt: entry.occurredAt }));
  const groups = groupByDay(entries, new Date());

  return (
    <div className="flex flex-col gap-3" data-testid="activity-panel">
      <SectionRule as="h3" trailing={entries.length === 0 ? undefined : entries.length}>
        Verlauf
      </SectionRule>
      {entries.length === 0 ? (
        <EmptyState
          title="Noch keine Aktivität"
          description="Sobald sich an dieser Seite etwas ändert, erscheint es hier."
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
            <DialogTitle>Auf diesen Stand zurücksetzen?</DialogTitle>
            <DialogDescription>
              {pendingRestore !== null
                ? `Der Inhalt der Seite wird auf den Stand vom ${formatDateTime(pendingRestore.occurredAt)} zurückgesetzt. Der aktuelle Stand wird davor automatisch gesichert, die Wiederherstellung selbst lässt sich aber nicht rückgängig machen. Eine offen geöffnete Seite übernimmt die Änderung sofort.`
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
              Abbrechen
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
                    setRestoreError(error instanceof Error ? error.message : 'Unbekannter Fehler');
                  },
                });
              }}
            >
              Wiederherstellen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
