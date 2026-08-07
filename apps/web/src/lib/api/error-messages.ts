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
  document_cross_workspace: 'Das übergeordnete Element gehört nicht zu diesem Arbeitsbereich.',
  database_property_reserved: 'Dieser Eigenschaftstyp ist noch nicht verfügbar.',
  collaboration_ticket_invalid: 'Die Verbindung zur Live-Bearbeitung wurde abgelehnt.',
  collaboration_ticket_expired: 'Die Verbindung zur Live-Bearbeitung ist abgelaufen.',
  collaboration_read_only: 'Diese Seite ist nur lesbar.',
  attachment_access_denied: 'Du hast keinen Zugriff auf diese Datei.',
  ai_provider_unavailable: 'Der KI-Anbieter ist gerade nicht erreichbar.',
  internal_error: 'Unerwarteter Fehler. Bitte versuche es erneut.',
  admin_required: 'Dafür brauchst du Administratorrechte.',
  api_token_invalid: 'Das API-Token ist ungültig.',
  api_token_expired: 'Das API-Token ist abgelaufen.',
  ai_model_unknown: 'Dieses KI-Modell ist nicht bekannt.',
  ai_model_disabled: 'Dieses KI-Modell ist derzeit deaktiviert.',
  ai_tools_unavailable: 'Werkzeuge stehen für die KI gerade nicht bereit.',
  ai_image_unavailable:
    'Bilder erzeugen ist für diese Instanz nicht eingerichtet. Im Administrationsbereich lässt sich ein Bildmodell hinterlegen.',
  ai_tool_limit_exceeded: 'Die KI hat zu viele Werkzeugaufrufe gebraucht.',
  ai_conversation_locked: 'In dieser Unterhaltung läuft noch eine Antwort.',
  document_content_conflict: 'Die Seite wurde zwischenzeitlich geändert.',
  document_content_lossy: 'Anhängen würde eingebettete Datenbanken auf dieser Seite verlieren.',
  attachment_text_unavailable: 'Der Text dieser Datei liegt noch nicht vor.',
  setting_unknown: 'Diese Einstellung gibt es nicht.',
  workspace_slug_taken: 'Dieser Slug wird bereits von einem anderen Arbeitsbereich verwendet.',
};

export function messageForCode(code: string | undefined): string {
  if (code !== undefined && code in MESSAGES) {
    return MESSAGES[code as ApiErrorCode];
  }
  return MESSAGES.internal_error;
}
