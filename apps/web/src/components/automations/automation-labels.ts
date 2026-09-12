import {
  type AutomationAction,
  type AutomationOutput,
  type AutomationRunStatus,
  type AutomationScope,
  type AutomationTrigger,
} from '@exocortex/contracts';

/**
 * German names for the enums an automation is made of (issue #50, ADR-024).
 *
 * Their own file because three components need the same words: a list, a form
 * and a run log that disagreed about what `DOCUMENT_CONTENT_CHANGED` is called
 * would read like three different features.
 */

export const TRIGGER_LABELS: Record<AutomationTrigger, string> = {
  DOCUMENT_CREATED: 'Seite angelegt',
  DOCUMENT_UPDATED: 'Titel oder Eigenschaften geändert',
  DOCUMENT_CONTENT_CHANGED: 'Inhalt geändert',
  DOCUMENT_MOVED: 'Seite verschoben',
  DOCUMENT_ARCHIVED: 'Seite archiviert',
  DOCUMENT_DELETED: 'Seite endgültig gelöscht',
  DATABASE_ROW_CHANGED: 'Zeilenwert geändert',
};

/** The order the form offers them in: from "happens most" to "happens least". */
export const TRIGGER_ORDER: readonly AutomationTrigger[] = [
  'DOCUMENT_CONTENT_CHANGED',
  'DOCUMENT_CREATED',
  'DOCUMENT_UPDATED',
  'DOCUMENT_MOVED',
  'DOCUMENT_ARCHIVED',
  'DOCUMENT_DELETED',
  'DATABASE_ROW_CHANGED',
];

export const SCOPE_LABELS: Record<AutomationScope, string> = {
  WORKSPACE: 'Ganzer Arbeitsbereich',
  SUBTREE: 'Eine Seite samt Unterseiten',
  DATABASE: 'Eine Datenbank und ihre Zeilen',
};

export const ACTION_LABELS: Record<AutomationAction, string> = {
  WEBHOOK: 'Webhook (signierter POST)',
  AI_RUN: 'KI-Lauf gegen die geänderte Seite',
};

export const OUTPUT_LABELS: Record<AutomationOutput, string> = {
  COMMENT: 'Als Kommentar an der Seite',
  CHILD_PAGE: 'Als neue Unterseite',
};

export const RUN_STATUS_LABELS: Record<AutomationRunStatus, string> = {
  PENDING: 'wartet',
  RUNNING: 'läuft',
  SUCCEEDED: 'erledigt',
  FAILED: 'fehlgeschlagen',
  SKIPPED: 'übersprungen',
};

/** Badge colour per outcome. `SKIPPED` is deliberately not an error. */
export function runStatusVariant(
  status: AutomationRunStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'FAILED') return 'destructive';
  if (status === 'SUCCEEDED') return 'default';
  if (status === 'SKIPPED') return 'outline';
  return 'secondary';
}

/** A duration a person can read at a glance. */
export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return '';
  if (durationMs < 1_000) return `${String(durationMs)} ms`;
  return `${(durationMs / 1_000).toFixed(1)} s`;
}

/** A timestamp in the local zone, without the year most rows share. */
export function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
