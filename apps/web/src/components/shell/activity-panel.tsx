'use client';

import {
  ActivityIcon,
  ArchiveIcon,
  ArrowRightLeftIcon,
  FilePlusIcon,
  GitCompareIcon,
  HistoryIcon,
  PencilIcon,
  RotateCcwIcon,
  Undo2Icon,
} from 'lucide-react';
import * as React from 'react';

import { type DocumentActivityEntry } from '@exocortex/contracts';
import {
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
} from '@exocortex/ui';

import { useDocument, useDocumentActivity, useRestoreSnapshot } from '@/lib/api/queries';

import { type DiffableSnapshot, SnapshotDiffDialog } from './snapshot-diff-dialog';

const dateTimeFormat = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const timeFormat = new Intl.DateTimeFormat('de-DE', { timeStyle: 'short' });

function formatDateTime(iso: string): string {
  return dateTimeFormat.format(new Date(iso));
}
function formatTime(iso: string): string {
  return timeFormat.format(new Date(iso));
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
  api_write: 'Von außen geschrieben (nicht im Editor)',
};

type SnapshotEntry = Extract<DocumentActivityEntry, { type: 'snapshot' }>;

/** One row's icon, matched to the entry kind so the timeline scans quickly. */
function EntryIcon({ type }: { type: DocumentActivityEntry['type'] }) {
  const className = 'size-4 shrink-0 text-muted-foreground';
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
  }
}

function Row({
  type,
  title,
  meta,
  trailing,
}: {
  type: DocumentActivityEntry['type'];
  title: string;
  meta: string;
  trailing?: React.ReactNode;
}) {
  return (
    // Borderless: a boxed row per event turned a history into a stack of
    // identical cards. The aligned icon column and the monospaced timestamps
    // carry the sequence; a box around each one only added chrome. No painted
    // background either -- a row that paints itself has to know which surface
    // it is on, and gets it wrong the moment it is reused.
    <div className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm">
      <EntryIcon type={type} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{meta}</span>
      </div>
      {trailing}
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

  switch (entry.type) {
    case 'created':
      return (
        <Row
          type={entry.type}
          title="Seite angelegt"
          meta={`${formatDateTime(entry.occurredAt)} · ${who}`}
        />
      );
    case 'renamed':
      return (
        <Row
          type={entry.type}
          title={`Umbenannt: „${entry.previousTitle ?? '?'}“ → „${entry.nextTitle ?? '?'}“`}
          meta={`${formatDateTime(entry.occurredAt)} · ${who}`}
        />
      );
    case 'moved':
      return (
        <Row
          type={entry.type}
          title={entry.acrossWorkspace ? 'In anderen Arbeitsbereich verschoben' : 'Verschoben'}
          meta={`${formatDateTime(entry.occurredAt)} · ${who}`}
        />
      );
    case 'archived':
      return (
        <Row
          type={entry.type}
          title="Archiviert"
          meta={`${formatDateTime(entry.occurredAt)} · ${who}`}
        />
      );
    case 'restored':
      return (
        <Row
          type={entry.type}
          title="Wiederhergestellt"
          meta={`${formatDateTime(entry.occurredAt)} · ${who}`}
        />
      );
    case 'snapshotRestored':
      return (
        <Row
          type={entry.type}
          title="Auf einen früheren Stand zurückgesetzt"
          meta={`${formatDateTime(entry.occurredAt)} · ${who}`}
        />
      );
    case 'editingSession':
      return (
        <Row
          type={entry.type}
          title={
            entry.startedAt === entry.endedAt
              ? `Bearbeitet um ${formatTime(entry.endedAt)}`
              : `Bearbeitet von ${formatTime(entry.startedAt)} bis ${formatTime(entry.endedAt)}`
          }
          meta={who}
        />
      );
    case 'snapshot':
      return (
        <Row
          type={entry.type}
          title={`Stand vom ${formatDateTime(entry.occurredAt)}`}
          meta={`${who} · ${SNAPSHOT_REASON_LABEL[entry.reason]}`}
          trailing={
            /*
             * Comparing is offered to readers too: it changes nothing, and
             * "what did the agent write last night" is a question somebody
             * without write access has as much as anybody else.
             */
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                data-testid="activity-compare-button"
                aria-label="Mit einem anderen Stand vergleichen"
                onClick={() => onRequestCompare(entry)}
              >
                <GitCompareIcon className="size-4" aria-hidden />
                Vergleichen
              </Button>
              {readOnly ? null : (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="activity-restore-button"
                  onClick={() => onRequestRestore(entry)}
                >
                  Wiederherstellen
                </Button>
              )}
            </div>
          }
        />
      );
  }
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
 * `DocumentActivityService`.
 *
 * Restoring a snapshot is destructive (it overwrites the page's current
 * content, even though the current state is itself snapshotted first), so it
 * goes through a confirmation dialog rather than firing on the button click.
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
        <div className="flex flex-col gap-1">
          {entries.map((entry) => (
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
        </div>
      )}

      {documentId === null ? null : (
        <SnapshotDiffDialog
          documentId={documentId}
          snapshot={comparing}
          snapshots={snapshots}
          readOnly={readOnly}
          onClose={() => setComparing(null)}
        />
      )}

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
            <p className="text-sm text-destructive-text">{restoreError}</p>
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
