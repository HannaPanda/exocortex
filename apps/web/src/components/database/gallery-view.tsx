'use client';

import { ImageIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { type DatabaseProperty, type DatabaseView } from '@exocortex/contracts';
import { Button, EmptyState, LoadingState } from '@exocortex/ui';

import { useCreateDatabaseRow, useDatabaseRows } from '@/lib/api/database-queries';

import { PropertyValueDisplay } from './cells';

interface GalleryViewProps {
  workspaceId: string;
  documentId: string;
  view: DatabaseView;
  properties: DatabaseProperty[];
  readOnly: boolean;
}

/**
 * Card grid. Cover comes from `view.config.coverPropertyId` (a FILES
 * property, one attachment id used as an image `src` via the existing
 * download route) — same "honest minimal editor" scope as the FILES cell in
 * `cells.tsx`: no dedicated file picker yet, just the round-trip.
 */
export function GalleryView({
  workspaceId,
  documentId,
  view,
  properties,
  readOnly,
}: GalleryViewProps) {
  const rowsQuery = useDatabaseRows(documentId, { viewId: view.id, limit: 100 });
  const createRow = useCreateDatabaseRow(documentId);

  if (rowsQuery.isPending)
    return <LoadingState variant="skeleton" rows={4} label="Karten werden geladen" />;
  if (rowsQuery.isError)
    return <EmptyState title="Karten nicht geladen" description="Bitte versuche es erneut." />;

  const coverProperty = properties.find((property) => property.id === view.config.coverPropertyId);
  const otherProperties = properties
    .filter((property) => property.id !== coverProperty?.id)
    .slice(0, 3);
  const rows = rowsQuery.data.rows;

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
        {rows.map((row) => {
          const coverValue =
            coverProperty === undefined
              ? null
              : row.values.find((entry) => entry.propertyId === coverProperty.id)?.value;
          const coverAttachmentId = Array.isArray(coverValue) ? coverValue[0] : undefined;

          return (
            <Link
              key={row.document.id}
              href={`/arbeitsbereich/${workspaceId}/seite/${row.document.id}`}
              className="flex flex-col overflow-hidden rounded-lg border border-border bg-card hover:border-border-strong"
            >
              <div className="flex aspect-video items-center justify-center bg-surface text-muted-foreground">
                {coverAttachmentId !== undefined ? (
                  // eslint-disable-next-line @next/next/no-img-element -- attachment ids are arbitrary user uploads, not build-time-known assets next/image can optimize.
                  <img
                    // A grid of thumbnails is where the full-size originals hurt
                    // most; the route serves the original when no preview exists.
                    src={`/api/attachments/${coverAttachmentId}/download?variant=preview`}
                    alt=""
                    className="size-full object-cover"
                  />
                ) : (
                  <ImageIcon className="size-6" />
                )}
              </div>
              <div className="flex flex-col gap-1 p-2.5">
                <span className="truncate text-sm font-medium">{row.document.title}</span>
                {otherProperties.map((property) => {
                  const value =
                    row.values.find((entry) => entry.propertyId === property.id)?.value ?? null;
                  return (
                    <PropertyValueDisplay key={property.id} property={property} value={value} />
                  );
                })}
              </div>
            </Link>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Noch keine Zeilen"
          description="Lege die erste Karte für diese Galerie an."
        />
      ) : null}

      {readOnly ? null : (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 text-muted-foreground"
          onClick={() => createRow.mutate({ title: 'Unbenannt', values: [] })}
        >
          <PlusIcon /> Neue Karte
        </Button>
      )}
    </div>
  );
}
