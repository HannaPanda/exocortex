'use client';

import Link from 'next/link';
import * as React from 'react';

import { type ProjectBuild } from '@exocortex/contracts';
import { Badge, Button, cn, EmptyState } from '@exocortex/ui';

import { formatBytes, formatMoment } from '@/components/render/render-labels';
import { useProjectBuildArtifacts } from '@/lib/api/project-queries';

/**
 * The builds this project has had, and what each one left behind
 * (issue #43, ADR-027).
 *
 * The column to the right of the editor used to hold one build and forget it on
 * reload, while `exo_project_builds` handed an agent the whole list. That is
 * the read-side gap ADR-025 counts as a missing capability: the PDF still
 * existed, the endpoint still answered, and the only way to it was gone.
 *
 * Deleting is here for the same reason. A list of past builds you cannot prune
 * is half a feature -- the artifacts are ordinary attachments and they add up.
 */

const STATUS_LABEL: Record<ProjectBuild['status'], string> = {
  PENDING: 'wartet',
  RUNNING: 'läuft',
  COMPLETED: 'fertig',
  FAILED: 'fehlgeschlagen',
  CANCELLED: 'abgebrochen',
};

function statusVariant(
  status: ProjectBuild['status'],
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'FAILED') return 'destructive';
  if (status === 'COMPLETED') return 'default';
  if (status === 'CANCELLED') return 'outline';
  return 'secondary';
}

export function ProjectBuildHistory({
  builds,
  selectedBuildId,
  onSelect,
  onDelete,
}: {
  builds: readonly ProjectBuild[];
  selectedBuildId: string | null;
  onSelect: (buildId: string) => void;
  onDelete: (buildId: string) => void;
}) {
  if (builds.length === 0) {
    return (
      <EmptyState
        title="Noch keine Bauten"
        description="Was gebaut wurde, steht hier, auch nach einem Neuladen."
      />
    );
  }

  return (
    <ul className="flex flex-col gap-1" data-testid="project-build-history">
      {builds.map((build) => (
        <HistoryRow
          key={build.id}
          build={build}
          selected={build.id === selectedBuildId}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      ))}
    </ul>
  );
}

function HistoryRow({
  build,
  selected,
  onSelect,
  onDelete,
}: {
  build: ProjectBuild;
  selected: boolean;
  onSelect: (buildId: string) => void;
  onDelete: (buildId: string) => void;
}) {
  const running = build.status === 'PENDING' || build.status === 'RUNNING';

  return (
    <li
      data-testid="project-build-entry"
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-md border p-2',
        selected ? 'border-primary bg-accent' : 'border-border',
      )}
    >
      <button
        type="button"
        className="text-sm underline-offset-2 hover:underline"
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(build.id)}
        data-testid="project-build-select"
      >
        {formatMoment(build.createdAt)}
      </button>
      <Badge variant={statusVariant(build.status)}>{STATUS_LABEL[build.status]}</Badge>
      {build.stale ? <Badge variant="outline">Quellen geändert</Badge> : null}
      <span className="text-xs text-muted-foreground">
        {build.rootFile}
        {build.pageCount === null ? '' : ` · ${String(build.pageCount)} S.`}
        {build.attachmentByteSize === null ? '' : ` · ${formatBytes(build.attachmentByteSize)}`}
      </span>
      <div className="ms-auto flex items-center gap-2">
        {build.downloadPath === null ? null : (
          <Link
            href={build.downloadPath}
            target="_blank"
            rel="noreferrer"
            className="text-xs underline"
            data-testid="project-build-open"
          >
            PDF öffnen
          </Link>
        )}
        {/* A running build is cancelled, not deleted: the container is still
            going and the row is about to change under the reader. */}
        {running ? null : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete(build.id)}
            data-testid="project-build-delete"
          >
            Löschen
          </Button>
        )}
      </div>
      {selected ? <ArtifactLine buildId={build.id} /> : null}
    </li>
  );
}

/**
 * What the selected build produced, beyond the PDF link above.
 *
 * The SyncTeX map is the part worth showing: it is what a click in the PDF
 * would follow back to a source line one day, and today it is a file somebody
 * can fetch. `textStatus` is the other half and belongs to agents -- once it
 * says READY, `exo_attachment_read_text` reads back what the build printed.
 */
function ArtifactLine({ buildId }: { buildId: string }) {
  const artifacts = useProjectBuildArtifacts(buildId);
  const data = artifacts.data;
  if (data === undefined || (data.pdf === null && data.sourceMap === null)) return null;

  return (
    <p className="basis-full text-xs text-muted-foreground" data-testid="project-build-artifacts">
      {data.pdf === null ? null : (
        <span>
          {data.pdf.filename} · Textauszug {TEXT_STATUS_LABEL[data.pdf.textStatus]}
        </span>
      )}
      {data.sourceMap === null ? null : (
        <>
          {data.pdf === null ? null : ' · '}
          <Link
            href={data.sourceMap.downloadPath}
            target="_blank"
            rel="noreferrer"
            className="underline"
            data-testid="project-build-sourcemap"
          >
            SyncTeX-Datei
          </Link>
        </>
      )}
    </p>
  );
}

const TEXT_STATUS_LABEL: Record<'NOT_APPLICABLE' | 'PENDING' | 'READY' | 'FAILED', string> = {
  NOT_APPLICABLE: 'entfällt',
  PENDING: 'läuft',
  READY: 'fertig',
  FAILED: 'fehlgeschlagen',
};
