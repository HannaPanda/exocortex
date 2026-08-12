'use client';

import { ExternalLinkIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { type TrashEntry } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  LoadingState,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import {
  useDeleteDocuments,
  useDeletionPreviews,
  useRestoreDocument,
  useTrash,
  useWorkspaceDetail,
} from '@/lib/api/queries';

interface TrashSheetProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const dayFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'full' });
const timeFormat = new Intl.DateTimeFormat('de-DE', { timeStyle: 'short' });

/** Groups an archive operation under the day it happened. */
function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function countEntries(entries: readonly TrashEntry[]): number {
  return entries.reduce((total, entry) => total + 1 + entry.descendantCount, 0);
}

/**
 * The trash, as a place you can decide in (issues #31 and #32).
 *
 * The sidebar used to list archived titles flat, which answers exactly one
 * question: "what was this called". Deciding whether a page may go for good
 * needs three more, and all three are answerable from data the archive already
 * writes: what hung under it (`parentId` survives archiving), whether it was
 * chosen or came along (one operation stamps every page it takes with the same
 * `archivedAt`), and what is actually written on it (an archived page opens
 * read-only, so the title links straight to it).
 *
 * A sheet rather than the sidebar: 145 nested rows with checkboxes do not fit
 * in a column that has to stay a navigation.
 */
export function TrashSheet({ workspaceId, open, onOpenChange }: TrashSheetProps) {
  const trash = useTrash(workspaceId, open);
  const workspace = useWorkspaceDetail(workspaceId);
  const restore = useRestoreDocument(workspaceId);
  const previews = useDeletionPreviews(workspaceId);
  const remove = useDeleteDocuments(workspaceId);

  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = React.useState(false);

  const role = workspace.data?.role;
  const canDelete = role === 'ADMIN' || role === 'OWNER';

  const entries = React.useMemo(() => trash.data?.entries ?? [], [trash.data]);

  /**
   * Selecting a page selects everything under it, so those rows stop being
   * separate decisions. Without this, a selection could name a page and a page
   * below it, and every count derived from it would be wrong by the size of
   * the overlap.
   */
  const coveredIds = React.useMemo(() => {
    const covered = new Set<string>();
    const walk = (list: readonly TrashEntry[], underSelection: boolean): void => {
      for (const entry of list) {
        const inside = underSelection || selected.has(entry.id);
        if (underSelection) covered.add(entry.id);
        walk(entry.children, inside);
      }
    };
    walk(entries, false);
    return covered;
  }, [entries, selected]);

  /** What a deletion would actually be asked to remove: the tops of the selection. */
  const selectionRoots = React.useMemo(
    () => [...selected].filter((id) => !coveredIds.has(id)),
    [selected, coveredIds],
  );

  const selectedPageCount = React.useMemo(() => {
    let total = 0;
    const walk = (list: readonly TrashEntry[]): void => {
      for (const entry of list) {
        if (selected.has(entry.id) && !coveredIds.has(entry.id)) {
          total += 1 + entry.descendantCount;
          continue;
        }
        walk(entry.children);
      }
    };
    walk(entries);
    return total;
  }, [entries, selected, coveredIds]);

  /** Closing drops the selection: a decision half-made is not one to come back to. */
  const changeOpen = (value: boolean): void => {
    if (!value) {
      setSelected(new Set());
      setConfirming(false);
    }
    onOpenChange(value);
  };

  const toggle = (documentId: string, checked: boolean): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(documentId);
      else next.delete(documentId);
      return next;
    });
  };

  const openConfirmation = (): void => {
    setConfirming(true);
    previews.mutate(selectionRoots);
  };

  const groups = React.useMemo(() => {
    const byDay = new Map<string, TrashEntry[]>();
    for (const entry of entries) {
      const key = dayKey(entry.archivedAt);
      const list = byDay.get(key);
      if (list === undefined) byDay.set(key, [entry]);
      else list.push(entry);
    }
    return [...byDay.entries()];
  }, [entries]);

  const previewTotals = (previews.data?.previews ?? []).reduce(
    (totals, preview) => ({
      documents: totals.documents + preview.documents.length,
      attachments: totals.attachments + preview.attachmentCount,
      links: totals.links + preview.incomingLinkCount,
    }),
    { documents: 0, attachments: 0, links: 0 },
  );

  const renderEntry = (entry: TrashEntry, depth: number): React.ReactElement => {
    const covered = coveredIds.has(entry.id);
    const checked = selected.has(entry.id) || covered;
    return (
      <li key={entry.id}>
        <div
          className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60"
          style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
          data-testid="trash-entry"
        >
          {canDelete ? (
            <Checkbox
              className="mt-1"
              checked={checked}
              disabled={covered}
              aria-label={`„${entry.title}“ zum Löschen auswählen`}
              onCheckedChange={(value) => toggle(entry.id, value === true)}
            />
          ) : null}

          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <DocumentIcon icon={entry.icon} iconColor={entry.iconColor} type={entry.type} />
              <Link
                href={`/arbeitsbereich/${workspaceId}/seite/${entry.id}`}
                onClick={() => changeOpen(false)}
                className="min-w-0 flex-1 truncate text-sm hover:underline"
                title="Schreibgeschützt ansehen"
              >
                {entry.title}
              </Link>
              <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            </div>
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{timeFormat.format(new Date(entry.archivedAt))} Uhr</span>
              {entry.reason === 'cascade' ? (
                <Badge variant="outline" className="font-normal">
                  mit archiviert
                </Badge>
              ) : null}
              {entry.descendantCount > 0 ? (
                <span>
                  {entry.descendantCount === 1
                    ? '1 Unterseite'
                    : `${entry.descendantCount} Unterseiten`}
                </span>
              ) : null}
            </p>
          </div>

          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`„${entry.title}“ wiederherstellen`}
            disabled={restore.isPending}
            onClick={() => void restore.mutateAsync(entry.id)}
          >
            <RotateCcwIcon className="size-3.5" />
          </Button>
        </div>
        {entry.children.length > 0 ? (
          <ul>{entry.children.map((child) => renderEntry(child, depth + 1))}</ul>
        ) : null}
      </li>
    );
  };

  return (
    <Sheet open={open} onOpenChange={changeOpen}>
      <SheetContent side="right" className="w-full max-w-xl" data-testid="trash-sheet">
        <SheetHeader className="border-b border-border pr-10">
          <SheetTitle className="text-lg">Papierkorb</SheetTitle>
          <SheetDescription>
            {trash.data === undefined
              ? 'Archivierte Seiten'
              : `${trash.data.totalCount} archivierte Seite(n). Eingerückt heißt: hing darunter. Ein Klick auf den Titel zeigt die Seite schreibgeschützt.`}
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
          {trash.isPending ? <LoadingState label="Papierkorb wird geladen" /> : null}
          {trash.isError ? <ErrorState title="Papierkorb nicht lesbar" /> : null}
          {trash.data !== undefined && trash.data.totalCount === 0 ? (
            <EmptyState
              title="Der Papierkorb ist leer"
              description="Archivierte Seiten landen hier und bleiben, bis sie jemand wiederherstellt oder endgültig löscht."
            />
          ) : null}

          {groups.map(([day, dayEntries]) => (
            <section key={day} className="mb-3">
              <h3 className="px-2 py-1 text-xs font-medium text-muted-foreground">
                {dayFormat.format(new Date(day))} · {countEntries(dayEntries)} Seite(n)
              </h3>
              <ul>{dayEntries.map((entry) => renderEntry(entry, 0))}</ul>
            </section>
          ))}
        </div>

        {canDelete && selectionRoots.length > 0 ? (
          <div className="flex items-center justify-between gap-2 border-t border-border p-3">
            <span className="text-sm text-muted-foreground">
              {selectedPageCount === 1
                ? '1 Seite ausgewählt'
                : `${selectedPageCount} Seiten ausgewählt`}
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                Auswahl aufheben
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={openConfirmation}
                data-testid="trash-delete"
              >
                <Trash2Icon className="size-3.5" /> Endgültig löschen
              </Button>
            </div>
          </div>
        ) : null}

        <Dialog open={confirming} onOpenChange={(value) => !value && setConfirming(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Endgültig löschen?</DialogTitle>
              <DialogDescription>
                {previews.isPending
                  ? 'Wird geprüft, was dabei mitgeht …'
                  : `${previewTotals.documents === 1 ? 'Eine Seite' : `${previewTotals.documents} Seiten`} werden mit allem Inhalt, allen Versionsständen und allen Kommentaren gelöscht.` +
                    (previewTotals.attachments === 0
                      ? ''
                      : ` Dazu ${previewTotals.attachments} Anhang/Anhänge samt Dateien.`) +
                    (previewTotals.links === 0
                      ? ''
                      : ` ${previewTotals.links} Verweis(e) anderer Seiten zeigen darauf und werden danach als unaufgelöst angezeigt.`) +
                    ' Das lässt sich nicht rückgängig machen, auch nicht über einen Versionsstand.'}
              </DialogDescription>
            </DialogHeader>

            {remove.isError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {remove.error instanceof ApiError
                    ? messageForCode(remove.error.code)
                    : 'Löschen fehlgeschlagen.'}
                </AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(false)}>
                Abbrechen
              </Button>
              <Button
                variant="destructive"
                disabled={remove.isPending || previews.isPending}
                onClick={() => {
                  remove.mutate(selectionRoots, {
                    onSuccess: () => {
                      setSelected(new Set());
                      setConfirming(false);
                    },
                  });
                }}
                data-testid="trash-delete-confirm"
              >
                <Trash2Icon className={cn('size-3.5')} /> Unwiderruflich löschen
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
}
