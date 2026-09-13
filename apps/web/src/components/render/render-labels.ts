import {
  type RenderJobStatus,
  type RenderSource,
  type RenderVariableOrigin,
} from '@exocortex/contracts';

/**
 * German names for the enums a render is made of (issue #44, ADR-026).
 *
 * Their own file for the reason `automation-labels.ts` has one: a dialog, a
 * template form and a list of past builds that disagreed about what `SUBTREE`
 * is called would read like three different features.
 */

export const RENDER_STATUS_LABELS: Record<RenderJobStatus, string> = {
  PENDING: 'wartet',
  RUNNING: 'wird gebaut',
  COMPLETED: 'fertig',
  FAILED: 'fehlgeschlagen',
  CANCELLED: 'abgebrochen',
};

export function renderStatusVariant(
  status: RenderJobStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'FAILED') return 'destructive';
  if (status === 'COMPLETED') return 'default';
  if (status === 'CANCELLED') return 'outline';
  return 'secondary';
}

export const RENDER_SOURCE_LABELS: Record<RenderSource, string> = {
  DOCUMENT: 'Nur diese Seite',
  SUBTREE: 'Seite samt Unterseiten, mit Inhaltsverzeichnis',
};

export const VARIABLE_ORIGIN_LABELS: Record<RenderVariableOrigin, string> = {
  MANUAL: 'Wird vor dem Bau eingetippt',
  TITLE: 'Titel der Seite',
  PATH: 'Pfad der Seite',
  AUTHOR: 'Wer den Bau startet',
  TODAY: 'Heutiges Datum',
  PROPERTY: 'Eigenschaft der Datenbankzeile',
};

/** A file size a person reads at a glance. */
export function formatBytes(byteSize: number | null): string {
  if (byteSize === null) return '';
  if (byteSize < 1024) return `${String(byteSize)} B`;
  if (byteSize < 1024 * 1024) return `${(byteSize / 1024).toFixed(0)} kB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}
