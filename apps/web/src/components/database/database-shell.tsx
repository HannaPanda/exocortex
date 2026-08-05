'use client';

import * as React from 'react';

import { EmptyState, LoadingState } from '@exocortex/ui';

import { useCreateDatabaseView, useDatabaseProperties, useDatabaseViews } from '@/lib/api/database-queries';

import { BoardView } from './board-view';
import { CalendarView } from './calendar-view';
import { FilterSortBar } from './filter-sort-bar';
import { GalleryView } from './gallery-view';
import { TableView } from './table-view';
import { ViewTabs } from './view-tabs';

interface DatabaseShellProps {
  workspaceId: string;
  documentId: string;
  readOnly: boolean;
  /**
   * Controls which view is shown, for a caller that needs to persist the
   * choice itself (the database embed node view stores it in the Tiptap node
   * attribute, so it survives a reload). Omit both for the default,
   * uncontrolled behaviour (the full-page database view keeps its own state).
   */
  activeViewId?: string;
  onActiveViewChange?: (viewId: string) => void;
}

/**
 * Renders a `Document` with `type: 'COLLECTION'`: view tabs, a filter/sort
 * bar for the active view, and the view itself (Table/Board/Gallery/Calendar
 * — all four share the same query engine via `useDatabaseRows`, differing
 * only in how they lay the same rows out).
 */
export function DatabaseShell({
  workspaceId,
  documentId,
  readOnly,
  activeViewId: controlledActiveViewId,
  onActiveViewChange,
}: DatabaseShellProps) {
  const properties = useDatabaseProperties(documentId);
  const views = useDatabaseViews(documentId);
  const createView = useCreateDatabaseView(documentId);
  const [uncontrolledActiveViewId, setUncontrolledActiveViewId] = React.useState<
    string | undefined
  >(undefined);
  const activeViewId = controlledActiveViewId ?? uncontrolledActiveViewId;
  const setActiveViewId = onActiveViewChange ?? setUncontrolledActiveViewId;

  // Every database needs at least one view to be usable; create a default one
  // the first time a COLLECTION document is opened with none, the same way
  // Notion never shows a database without a view.
  const ensuredDefaultView = React.useRef(false);
  React.useEffect(() => {
    if (readOnly || views.data === undefined || views.data.length > 0 || ensuredDefaultView.current) return;
    ensuredDefaultView.current = true;
    createView.mutate({ type: 'TABLE', name: 'Tabelle' });
  }, [readOnly, views.data, createView]);

  if (properties.isPending || views.isPending) {
    return <LoadingState variant="skeleton" rows={5} label="Datenbank wird geladen" />;
  }
  if (properties.isError || views.isError) {
    return <EmptyState title="Datenbank nicht geladen" description="Bitte versuche es erneut." />;
  }

  // Derived, not state: falls back to the first view whenever the explicitly
  // selected one is missing (initial load, or it was just deleted), without an
  // effect to keep the two in sync.
  const activeView =
    (activeViewId !== undefined ? views.data.find((view) => view.id === activeViewId) : undefined) ??
    views.data[0];

  if (activeView === undefined) {
    return <LoadingState variant="skeleton" rows={5} label="Ansicht wird angelegt" />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="database-shell">
      <ViewTabs
        documentId={documentId}
        views={views.data}
        activeViewId={activeView.id}
        onSelect={setActiveViewId}
        readOnly={readOnly}
      />
      <FilterSortBar documentId={documentId} view={activeView} properties={properties.data} readOnly={readOnly} />

      {activeView.type === 'TABLE' ? (
        <TableView
          workspaceId={workspaceId}
          documentId={documentId}
          view={activeView}
          properties={properties.data}
          readOnly={readOnly}
        />
      ) : null}
      {activeView.type === 'BOARD' ? (
        <BoardView
          workspaceId={workspaceId}
          documentId={documentId}
          view={activeView}
          properties={properties.data}
          readOnly={readOnly}
        />
      ) : null}
      {activeView.type === 'GALLERY' ? (
        <GalleryView
          workspaceId={workspaceId}
          documentId={documentId}
          view={activeView}
          properties={properties.data}
          readOnly={readOnly}
        />
      ) : null}
      {activeView.type === 'CALENDAR' ? (
        <CalendarView
          workspaceId={workspaceId}
          documentId={documentId}
          view={activeView}
          properties={properties.data}
          readOnly={readOnly}
        />
      ) : null}
    </div>
  );
}
