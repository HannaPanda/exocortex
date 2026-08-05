import { type ApiErrorCode } from '@exocortex/contracts';

/**
 * German user-facing messages for machine-readable API error codes.
 *
 * The API always returns English developer messages; this map is the only place
 * that turns them into UI copy.
 */
const MESSAGES: Record<ApiErrorCode, string> = {
  validation_failed: 'Die Eingaben sind nicht gültig.',
  unauthenticated: 'Bitte melde dich an.',
  session_expired: 'Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.',
  forbidden: 'Dafür fehlen dir die Rechte.',
  not_found: 'Nicht gefunden.',
  conflict: 'Das steht im Widerspruch zum aktuellen Stand.',
  rate_limited: 'Zu viele Anfragen. Bitte kurz warten.',
  payload_too_large: 'Die Datei ist zu groß.',
  unsupported_media_type: 'Dieser Dateityp wird nicht unterstützt.',
  workspace_access_denied: 'Du hast keinen Zugriff auf diesen Arbeitsbereich.',
  document_access_denied: 'Du hast keinen Zugriff auf diese Seite.',
  document_archived: 'Archivierte Seiten können nicht bearbeitet werden.',
  document_move_cycle: 'Eine Seite kann nicht in sich selbst verschoben werden.',
  document_cross_workspace: 'Seiten können nicht in einen anderen Arbeitsbereich verschoben werden.',
  database_property_reserved: 'Dieser Eigenschaftstyp ist noch nicht verfügbar.',
  collaboration_ticket_invalid: 'Die Verbindung zur Live-Bearbeitung wurde abgelehnt.',
  collaboration_ticket_expired: 'Die Verbindung zur Live-Bearbeitung ist abgelaufen.',
  collaboration_read_only: 'Diese Seite ist nur lesbar.',
  attachment_access_denied: 'Du hast keinen Zugriff auf diese Datei.',
  ai_provider_unavailable: 'Der KI-Anbieter ist gerade nicht erreichbar.',
  internal_error: 'Unerwarteter Fehler. Bitte versuche es erneut.',
};

export function messageForCode(code: string | undefined): string {
  if (code !== undefined && code in MESSAGES) {
    return MESSAGES[code as ApiErrorCode];
  }
  return MESSAGES.internal_error;
}
