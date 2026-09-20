import {
  type AutomationAction,
  type AutomationOutput,
  type AutomationRunOrigin,
  type AutomationRunStatus,
  type AutomationScheduleKind,
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
  SCHEDULE: 'Zeitplan',
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
  'SCHEDULE',
];

export const SCOPE_LABELS: Record<AutomationScope, string> = {
  WORKSPACE: 'Ganzer Arbeitsbereich',
  SUBTREE: 'Eine Seite samt Unterseiten',
  DATABASE: 'Eine Datenbank und ihre Zeilen',
};

export const ACTION_LABELS: Record<AutomationAction, string> = {
  WEBHOOK: 'Webhook (signierter POST)',
  AI_RUN: 'KI-Lauf gegen die geänderte Seite',
  EMAIL_SELF: 'E-Mail an dich selbst',
};

export const OUTPUT_LABELS: Record<AutomationOutput, string> = {
  COMMENT: 'Als Kommentar an der Seite',
  CHILD_PAGE: 'Als neue Unterseite',
};

export const SCHEDULE_KIND_LABELS: Record<AutomationScheduleKind, string> = {
  ONCE: 'Einmalig zu einem Zeitpunkt',
  DAILY: 'Täglich',
  WEEKLY: 'Wöchentlich',
  MONTHLY: 'Monatlich',
  CRON: 'Cron-Ausdruck',
};

/** Sunday first, the way `Date` counts, not the way a German calendar prints. */
export const WEEKDAY_LABELS: readonly string[] = [
  'Sonntag',
  'Montag',
  'Dienstag',
  'Mittwoch',
  'Donnerstag',
  'Freitag',
  'Samstag',
];

export const RUN_ORIGIN_LABELS: Record<AutomationRunOrigin, string> = {
  EVENT: 'Änderung',
  SCHEDULE: 'Zeitplan',
  MANUAL: 'Von Hand',
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

/**
 * A schedule in one German clause (issue #73).
 *
 * The zone is always printed, even when it is the reader's own: a rule that
 * says 07:00 without saying where is a rule two people read differently.
 */
export function describeSchedule(rule: {
  scheduleKind: AutomationScheduleKind | null;
  scheduleAt: string | null;
  scheduleTime: string | null;
  scheduleWeekday: number | null;
  scheduleDayOfMonth: number | null;
  scheduleCron: string | null;
  scheduleTimeZone: string | null;
}): string {
  const zone = rule.scheduleTimeZone ?? '?';
  const time = rule.scheduleTime ?? '?';
  switch (rule.scheduleKind) {
    case 'ONCE':
      return rule.scheduleAt === null ? 'Einmalig' : `Einmalig am ${formatMoment(rule.scheduleAt)}`;
    case 'DAILY':
      return `Täglich um ${time} (${zone})`;
    case 'WEEKLY':
      return `Jeden ${WEEKDAY_LABELS[rule.scheduleWeekday ?? 0]} um ${time} (${zone})`;
    case 'MONTHLY':
      return `Monatlich am ${String(rule.scheduleDayOfMonth ?? 1)}. um ${time} (${zone})`;
    case 'CRON':
      return `Cron „${rule.scheduleCron ?? ''}" (${zone})`;
    default:
      return 'Ohne Zeitplan';
  }
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
