'use client';

import { type UseQueryResult } from '@tanstack/react-query';
import { BookmarkPlusIcon, SaveIcon, Trash2Icon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  DEFAULT_SAVED_QUERY_DISPLAY,
  EMPTY_SAVED_QUERY_DEFINITION,
  isNarrowedSavedQuery,
  type SavedQueryDefinition,
  type SavedQueryDisplay,
  type SavedQueryLayout,
  type SavedQueryResultsResponse,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  AppPage,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  Input,
  Label,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import {
  useCreateSavedQuery,
  useDeleteSavedQuery,
  useSavedQuery,
  useSavedQueryPreview,
  useUpdateSavedQuery,
} from '@/lib/api/saved-query-queries';

import { SavedQueryBuilder } from './saved-query-builder';
import { SavedQueryResults } from './saved-query-results';

/**
 * The search area (issue #74).
 *
 * Two screens, one component, because they are the same screen with a name on
 * it: `/suche` is a question nobody has stored yet, `/suche/<id>` is one that
 * has been. Splitting them would mean keeping two copies of the builder, the
 * result list and the save flow in step, and the only difference between them
 * is which buttons the header offers.
 *
 * The results always come from the *local* definition, even for a stored
 * query, so editing a filter changes the list under it immediately instead of
 * after a save. That is also what makes "Änderungen speichern" honest: what is
 * on screen is exactly what will be stored.
 */

const LAYOUT_LABELS: Readonly<Record<SavedQueryLayout, string>> = {
  LIST: 'Liste',
  TABLE: 'Tabelle',
  CARDS: 'Karten',
};

export interface SavedQueryPageProps {
  workspaceId: string;
  /** Absent for a fresh search in the search area. */
  savedQueryId?: string;
}

export function SavedQueryPage({ workspaceId, savedQueryId }: SavedQueryPageProps) {
  const router = useRouter();
  const stored = useSavedQuery(savedQueryId);
  const createSavedQuery = useCreateSavedQuery(workspaceId);
  const updateSavedQuery = useUpdateSavedQuery(workspaceId);
  const deleteSavedQuery = useDeleteSavedQuery(workspaceId);

  const [definition, setDefinition] = React.useState<SavedQueryDefinition>(
    EMPTY_SAVED_QUERY_DEFINITION,
  );
  const [display, setDisplay] = React.useState<SavedQueryDisplay>(DEFAULT_SAVED_QUERY_DISPLAY);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  // Whatever the server has is the starting point, and only the starting
  // point: after that the form belongs to the reader. Keyed on the id and the
  // stored timestamp so another member's edit is picked up, but a keystroke is
  // not overwritten by a background refetch of unchanged data.
  const loadedFrom = React.useRef<string | null>(null);
  const savedQuery = stored.data?.savedQuery;
  React.useEffect(() => {
    if (savedQuery === undefined) return;
    const stamp = `${savedQuery.id}:${savedQuery.updatedAt}`;
    if (loadedFrom.current === stamp) return;
    loadedFrom.current = stamp;
    setDefinition(savedQuery.definition);
    setDisplay(savedQuery.display);
  }, [savedQuery]);

  // A question that narrows nothing would answer with the whole workspace on
  // every keystroke. For a stored query it is still run, because somebody
  // deliberately saved "alles, neueste zuerst" and deserves to see it.
  const worthRunning = savedQueryId !== undefined || isNarrowedSavedQuery(definition);
  const preview = useSavedQueryPreview(workspaceId, definition, worthRunning);

  const dirty =
    savedQuery !== undefined &&
    (JSON.stringify(savedQuery.definition) !== JSON.stringify(definition) ||
      JSON.stringify(savedQuery.display) !== JSON.stringify(display));

  const mutationError = [createSavedQuery.error, updateSavedQuery.error, deleteSavedQuery.error]
    .filter((error): error is Error => error !== null)
    .at(0);

  if (savedQueryId !== undefined && stored.isPending) {
    return <LoadingState variant="skeleton" rows={6} label="Gespeicherte Suche wird geladen" />;
  }
  if (savedQueryId !== undefined && stored.isError) {
    return (
      <ErrorState title="Gespeicherte Suche nicht geladen" onRetry={() => void stored.refetch()} />
    );
  }

  return (
    <AppPage maxWidth="max-w-4xl" className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="exocortex-page-title">{savedQuery?.name ?? 'Suche'}</h1>
          <p className="mt-1 max-w-measure text-sm text-muted-foreground">
            {savedQuery?.description ??
              (savedQueryId === undefined
                ? 'Suche über alle Seiten dieses Arbeitsbereichs, mit Filtern nach Ort, Art, Eigenschaften, Entitäten und Zeitraum. Was sich lohnt, lässt sich speichern.'
                : 'Eine gespeicherte Suche. Die Treffer werden bei jedem Öffnen neu ermittelt.')}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {savedQueryId === undefined ? (
            <Button
              data-testid="saved-query-save"
              disabled={!isNarrowedSavedQuery(definition)}
              onClick={() => setSaveOpen(true)}
            >
              <BookmarkPlusIcon /> Suche speichern
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                data-testid="saved-query-delete"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2Icon /> Löschen
              </Button>
              <Button
                data-testid="saved-query-update"
                disabled={!dirty || updateSavedQuery.isPending}
                onClick={() => {
                  void updateSavedQuery.mutateAsync({
                    savedQueryId,
                    request: { definition, display },
                  });
                }}
              >
                <SaveIcon /> Änderungen speichern
              </Button>
            </>
          )}
        </div>
      </div>

      {mutationError === undefined ? null : (
        <Alert variant="destructive" data-testid="saved-query-error">
          <AlertDescription>
            {messageForCode(mutationError instanceof ApiError ? mutationError.code : undefined)}
          </AlertDescription>
        </Alert>
      )}

      <SavedQueryBuilder workspaceId={workspaceId} value={definition} onChange={setDefinition} />

      {savedQuery === undefined ? null : (
        <DisplayOptions
          display={display}
          inSidebar={savedQuery.inSidebar}
          onDisplayChange={setDisplay}
          onSidebarChange={(inSidebar) => {
            void updateSavedQuery.mutateAsync({
              savedQueryId: savedQuery.id,
              request: { inSidebar },
            });
          }}
        />
      )}

      <ResultsSection preview={preview} display={display} worthRunning={worthRunning} />

      <SaveDialog
        open={saveOpen}
        pending={createSavedQuery.isPending}
        onOpenChange={setSaveOpen}
        onSave={(input) => {
          void createSavedQuery
            .mutateAsync({
              name: input.name,
              description: input.description.length === 0 ? null : input.description,
              definition,
              display,
              inSidebar: input.inSidebar,
            })
            .then((response) => {
              setSaveOpen(false);
              router.push(`/arbeitsbereich/${workspaceId}/suche/${response.savedQuery.id}`);
            });
        }}
      />

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Gespeicherte Suche löschen</DialogTitle>
            <DialogDescription>
              Gelöscht wird nur die Frage. Die Seiten, die sie gefunden hat, bleiben unverändert
              liegen, wo sie sind.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              data-testid="saved-query-delete-confirm"
              onClick={() => {
                if (savedQueryId === undefined) return;
                void deleteSavedQuery.mutateAsync(savedQueryId).then(() => {
                  setConfirmDelete(false);
                  router.push(`/arbeitsbereich/${workspaceId}/suche`);
                });
              }}
            >
              Löschen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppPage>
  );
}

/**
 * How the answer is laid out, and whether the query is a smart view.
 *
 * Only for a stored query: an unsaved one has nowhere to keep either answer,
 * and offering the switch before there is a row to switch would promise
 * something the Save dialog has to ask for again anyway.
 */
function DisplayOptions({
  display,
  inSidebar,
  onDisplayChange,
  onSidebarChange,
}: {
  display: SavedQueryDisplay;
  inSidebar: boolean;
  onDisplayChange: (next: SavedQueryDisplay) => void;
  onSidebarChange: (next: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-4 border-t border-border pt-4">
      <div className="grid gap-1.5">
        <Label htmlFor="saved-query-layout">Darstellung</Label>
        <Select
          value={display.layout}
          onValueChange={(next) =>
            onDisplayChange({ ...display, layout: (next ?? 'LIST') as SavedQueryLayout })
          }
        >
          <SelectTrigger id="saved-query-layout" data-testid="saved-query-layout">
            <SelectValue>{() => LAYOUT_LABELS[display.layout]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(LAYOUT_LABELS) as SavedQueryLayout[]).map((layout) => (
              <SelectItem key={layout} value={layout}>
                {LAYOUT_LABELS[layout]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Label htmlFor="saved-query-sidebar" className="gap-2 pb-2 text-sm font-normal">
        <Switch id="saved-query-sidebar" checked={inSidebar} onCheckedChange={onSidebarChange} />
        In der Navigation zeigen
      </Label>
    </div>
  );
}

/** The live answer, with the readout the search palette also carries. */
function ResultsSection({
  preview,
  display,
  worthRunning,
}: {
  preview: UseQueryResult<SavedQueryResultsResponse>;
  display: SavedQueryDisplay;
  worthRunning: boolean;
}) {
  return (
    <section className="flex flex-col gap-2 border-t border-border pt-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium">Treffer</h2>
        {preview.data === undefined ? null : (
          <span className="exocortex-numeric text-xs text-muted-foreground">
            {`${preview.data.results.length} · ${preview.data.tookMs} ms · ${preview.data.adapter}`}
          </span>
        )}
      </div>

      {!worthRunning ? (
        <EmptyState
          title="Noch keine Abfrage"
          description="Gib einen Suchbegriff ein oder grenze oben ein, wo gesucht werden soll."
        />
      ) : preview.isPending ? (
        <LoadingState variant="skeleton" rows={5} label="Treffer werden ermittelt" />
      ) : preview.isError ? (
        <ErrorState
          title="Abfrage nicht ausgeführt"
          description={
            preview.error instanceof ApiError ? messageForCode(preview.error.code) : undefined
          }
          onRetry={() => void preview.refetch()}
        />
      ) : (
        <SavedQueryResults
          hits={preview.data.results}
          display={display}
          truncated={preview.data.truncated}
        />
      )}
    </section>
  );
}

function SaveDialog({
  open,
  pending,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (input: { name: string; description: string; inSidebar: boolean }) => void;
}) {
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [inSidebar, setInSidebar] = React.useState(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Suche speichern</DialogTitle>
          <DialogDescription>
            Gespeichert wird die Frage, nicht die Trefferliste. Beim nächsten Öffnen wird sie neu
            beantwortet.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="saved-query-name">Name</Label>
            <Input
              id="saved-query-name"
              autoFocus
              value={name}
              data-testid="saved-query-name"
              placeholder="Offene Aufgaben mit hoher Priorität"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="saved-query-description">Beschreibung</Label>
            <Textarea
              id="saved-query-description"
              rows={2}
              value={description}
              placeholder="Optional: wofür diese Suche da ist"
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <Label htmlFor="saved-query-new-sidebar" className="gap-2 text-sm font-normal">
            <Switch
              id="saved-query-new-sidebar"
              checked={inSidebar}
              onCheckedChange={setInSidebar}
            />
            Als Smart View in die Navigation aufnehmen
          </Label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            data-testid="saved-query-save-submit"
            disabled={name.trim().length === 0 || pending}
            onClick={() =>
              onSave({ name: name.trim(), description: description.trim(), inSidebar })
            }
          >
            Speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
