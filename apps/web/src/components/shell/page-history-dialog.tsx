'use client';

import { RotateCcwIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useIsMobile,
} from '@exocortex/ui';

import { usePageHistory, useRestoreSnapshot } from '@/lib/api/snapshot-queries';
import { useFormatter } from '@/lib/formatter';

import {
  findVersion,
  HistoryListPane,
  HistoryVersionPane,
  type HistoryView,
  type SelectedVersion,
} from './page-history-panes';
import { SnapshotDiffDialog } from './snapshot-diff-dialog';

/** What the last restore did, so it can be taken back from the same place. */
type RestoreNote =
  | { kind: 'restored'; date: string; snapshotBeforeId: string }
  | { kind: 'undone' }
  | { kind: 'error'; message: string };

export interface PageHistoryDialogProps {
  documentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** No restore for a reader, or for a page in the trash. */
  readOnly: boolean;
  /** The version to show first; the newest entry when absent. */
  initialSnapshotId?: string | null;
}

/**
 * The page history (issue #235), Notion's "Seitenverlauf": the stored versions
 * of this page on the right, the chosen one on the left, rendered read-only or
 * as its difference from the page as it stands, and restorable from there.
 *
 * A restore goes through the same route as before: the current state is saved
 * as a version of its own first, and the result reaches every open editor
 * through the collaboration server (ADR-016). The note it leaves offers the
 * way back, because that saved version is exactly what undoing it restores.
 *
 * The layout is the settings dialog's: two panes side by side, and on a phone
 * the whole screen with the list and the version taking turns.
 */
export function PageHistoryDialog({
  documentId,
  open,
  onOpenChange,
  readOnly,
  initialSnapshotId = null,
}: PageHistoryDialogProps) {
  const t = useTranslations('document.pageHistory');
  const isMobile = useIsMobile();
  const history = usePageHistory(documentId, open);
  const restore = useRestoreSnapshot(documentId);
  const [selectedId, setSelectedId] = React.useState<string | null>(initialSnapshotId);
  const [showVersion, setShowVersion] = React.useState(initialSnapshotId !== null);
  const [view, setView] = React.useState<HistoryView>('preview');
  const [confirming, setConfirming] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const [note, setNote] = React.useState<RestoreNote | null>(null);

  // Opening again starts where the caller points, not where the last visit ended.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSelectedId(initialSnapshotId);
      setShowVersion(initialSnapshotId !== null);
      setView('preview');
      setNote(null);
    }
  }

  const groups = React.useMemo(
    () => history.data?.pages.flatMap((page) => page.groups) ?? [],
    [history.data],
  );
  const effectiveId = selectedId ?? groups[0]?.representativeId ?? null;
  const selected = findVersion(groups, effectiveId);

  const runRestore = (
    snapshotId: string,
    after: (snapshotBeforeId: string) => RestoreNote,
  ): void => {
    restore.mutate(snapshotId, {
      onSuccess: (result) => {
        setConfirming(false);
        setNote(after(result.snapshotBeforeId));
      },
      onError: (error) => {
        setConfirming(false);
        setNote({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="page-history-dialog"
        className={cn(
          'gap-0 overflow-hidden p-0',
          'h-[min(48rem,calc(100dvh-2rem))] max-w-6xl',
          'max-md:top-0 max-md:left-0 max-md:h-dvh max-md:max-h-none max-md:w-full',
          'max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0',
          'max-md:rounded-none max-md:border-0',
        )}
      >
        <DialogHeader className="border-b border-border px-6 py-4 pr-12">
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{readOnly ? t('readOnlyHint') : t('description')}</DialogDescription>
        </DialogHeader>

        {/* The list comes first in the reading and tab order, which is where a
            visit starts; it stands on the right, as Notion's does. */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row-reverse">
          <HistoryListPane
            history={history}
            groups={groups}
            selectedId={effectiveId}
            onSelect={(snapshotId) => {
              setSelectedId(snapshotId);
              setShowVersion(true);
              setNote(null);
            }}
            hidden={isMobile && showVersion}
          />
          <HistoryVersionPane
            documentId={documentId}
            selected={selected}
            waiting={history.isPending}
            view={view}
            onView={setView}
            readOnly={readOnly}
            onBack={isMobile ? () => setShowVersion(false) : null}
            onPickBlocks={() => setPicking(true)}
            hidden={isMobile && !showVersion}
          />
        </div>

        <DialogFooter className="items-center border-t border-border px-6 py-3">
          <RestoreNoteLine
            note={note}
            pending={restore.isPending}
            onUndo={(snapshotBeforeId) => runRestore(snapshotBeforeId, () => ({ kind: 'undone' }))}
          />
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('close')}
          </Button>
          {readOnly || selected === null ? null : (
            <Button
              data-testid="page-history-restore"
              disabled={restore.isPending}
              onClick={() => setConfirming(true)}
            >
              <RotateCcwIcon /> {t('restore')}
            </Button>
          )}
        </DialogFooter>

        <RestoreConfirmDialog
          selected={confirming ? selected : null}
          pending={restore.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={(target, date) =>
            runRestore(target.version.id, (snapshotBeforeId) => ({
              kind: 'restored',
              date,
              snapshotBeforeId,
            }))
          }
        />

        <SnapshotDiffDialog
          documentId={documentId}
          snapshot={
            picking && selected !== null
              ? { id: selected.version.id, createdAt: selected.version.createdAt }
              : null
          }
          snapshots={[]}
          readOnly={readOnly}
          onClose={() => setPicking(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The dialog plus the function that opens it, for a surface that offers the
 * history from a menu and from the palette at once. Restoring is offered only
 * where the reader may write and the page is not in the trash.
 */
export function usePageHistoryDialog(input: {
  documentId: string;
  access: 'read' | 'write';
  archived: boolean;
}): { open: () => void; dialog: React.ReactElement } {
  const [open, setOpen] = React.useState(false);
  return {
    open: () => setOpen(true),
    dialog: (
      <PageHistoryDialog
        documentId={input.documentId}
        open={open}
        onOpenChange={setOpen}
        readOnly={input.archived || input.access !== 'write'}
      />
    ),
  };
}

function RestoreConfirmDialog({
  selected,
  pending,
  onCancel,
  onConfirm,
}: {
  /** The version to restore; `null` closes the dialog. */
  selected: SelectedVersion | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (target: SelectedVersion, date: string) => void;
}) {
  const t = useTranslations('document.pageHistory');
  const format = useFormatter();
  const date =
    selected === null
      ? ''
      : format.dateTime(new Date(selected.version.createdAt), {
          dateStyle: 'medium',
          timeStyle: 'short',
        });
  return (
    <Dialog
      open={selected !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('restoreTitle')}</DialogTitle>
          <DialogDescription>{t('restoreDescription', { date })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button
            data-testid="page-history-restore-confirm"
            disabled={pending || selected === null}
            onClick={() => {
              if (selected !== null) onConfirm(selected, date);
            }}
          >
            {t('restoreConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RestoreNoteLine({
  note,
  pending,
  onUndo,
}: {
  note: RestoreNote | null;
  pending: boolean;
  onUndo: (snapshotBeforeId: string) => void;
}) {
  const t = useTranslations('document.pageHistory');
  if (note === null) return <span className="mr-auto" />;
  return (
    <p
      role="status"
      className={cn(
        'mr-auto flex flex-wrap items-center gap-2 text-sm',
        note.kind === 'error' ? 'text-destructive-text' : 'text-muted-foreground',
      )}
      data-testid="page-history-note"
    >
      {note.kind === 'restored' ? (
        <>
          {t('restored', { date: note.date })}
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            disabled={pending}
            data-testid="page-history-undo"
            onClick={() => onUndo(note.snapshotBeforeId)}
          >
            {t('undoRestore')}
          </Button>
        </>
      ) : note.kind === 'undone' ? (
        t('undone')
      ) : (
        t('restoreError', { message: note.message })
      )}
    </p>
  );
}
