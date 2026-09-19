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
  database_property_config_invalid:
    'Diese Spalte lässt sich so nicht berechnen. Prüfe Verknüpfung, Rollup oder Formel.',
  database_property_in_use: 'Eine Rollup- oder Formelspalte benutzt diese Spalte noch.',
  database_property_date_range_in_use:
    'Einige Einträge haben ein Enddatum. Entferne die Enddaten, bevor du den Zeitraum abschaltest.',
  collaboration_ticket_invalid: 'Die Verbindung zur Live-Bearbeitung wurde abgelehnt.',
  collaboration_ticket_expired: 'Die Verbindung zur Live-Bearbeitung ist abgelaufen.',
  collaboration_read_only: 'Diese Seite ist nur lesbar.',
  attachment_access_denied: 'Du hast keinen Zugriff auf diese Datei.',
  ai_provider_unavailable: 'Der KI-Anbieter ist gerade nicht erreichbar.',
  ai_no_eligible_provider:
    'Kein Anbieter dieses Modells kann diese Anfrage bedienen. Wähle ein Modell mit größerem Kontext oder starte eine neue Unterhaltung.',
  internal_error: 'Unerwarteter Fehler. Bitte versuche es erneut.',
  admin_required: 'Dafür brauchst du Administratorrechte.',
  api_token_invalid: 'Das API-Token ist ungültig.',
  api_token_expired: 'Das API-Token ist abgelaufen.',
  api_token_insufficient_scope: 'Diesem API-Token fehlen die nötigen Rechte.',
  ai_model_unknown: 'Dieses KI-Modell ist nicht bekannt.',
  ai_model_disabled: 'Dieses KI-Modell ist derzeit deaktiviert.',
  ai_tools_unavailable: 'Werkzeuge stehen für die KI gerade nicht bereit.',
  ai_image_unavailable:
    'Bilder erzeugen ist für diese Instanz nicht eingerichtet. Im Administrationsbereich lässt sich ein Bildmodell hinterlegen.',
  ai_tool_limit_exceeded: 'Die KI hat zu viele Werkzeugaufrufe gebraucht.',
  ai_conversation_locked: 'In dieser Unterhaltung läuft noch eine Antwort.',
  ai_conversation_cursor_invalid: 'Die Liste konnte nicht weitergeblättert werden.',
  document_content_conflict: 'Die Seite wurde zwischenzeitlich geändert.',
  document_content_lossy: 'Anhängen würde eingebettete Datenbanken auf dieser Seite verlieren.',
  attachment_text_unavailable: 'Der Text dieser Datei liegt noch nicht vor.',
  setting_unknown: 'Diese Einstellung gibt es nicht.',
  setting_not_overridable:
    'Diese Einstellung gilt für die ganze Installation und lässt sich nicht je Arbeitsbereich setzen.',
  setting_above_deployment_ceiling:
    'Dieser Wert liegt über dem, was die Installation erlaubt. Ein Arbeitsbereich darf darunter bleiben, nicht darüber.',
  credential_storage_unavailable:
    'Diese Installation kann keine eigenen Schlüssel speichern. Dafür fehlt der Schlüssel zum Verschlüsseln (CREDENTIAL_ENCRYPTION_KEY).',
  memory_unavailable:
    'Für dieses Konto ist noch kein Gedächtnisbereich festgelegt. In den Einstellungen eines Arbeitsbereichs lässt sich einer dazu erklären.',
  entity_layer_unavailable:
    'Für Entitäten ist noch keine Datenbank hinterlegt. Das lässt sich im Administrationsbereich nachholen.',
  entity_exists:
    'Eine Entität mit diesem Namen gibt es schon. Trag die neue Schreibweise dort als Alias ein.',
  entity_candidate_promoted: 'Aus diesem Vorschlag wurde bereits eine Entität.',
  workspace_slug_taken: 'Dieser Slug wird bereits von einem anderen Arbeitsbereich verwendet.',
  invitation_invalid: 'Diese Einladung gibt es nicht oder sie wurde zurückgezogen.',
  invitation_expired: 'Diese Einladung ist abgelaufen. Bitte lass dir eine neue schicken.',
  invitation_already_used: 'Diese Einladung wurde schon eingelöst. Melde dich einfach an.',
  invitation_email_taken: 'Für diese E-Mail-Adresse gibt es bereits ein Konto.',
  user_disabled: 'Dieses Konto ist deaktiviert.',
  user_has_content:
    'Dieses Konto hat Seiten, Kommentare oder Dateien angelegt und lässt sich deshalb nicht löschen. Deaktiviere es stattdessen.',
  project_file_not_found: 'Diese Datei gibt es im Projekt nicht.',
  project_file_exists: 'An dieser Stelle liegt schon eine Datei.',
  project_not_a_text_file:
    'Diese Datei ist keine Textdatei. Bilder, Schriften und PDFs kommen als Anhang ins Projekt.',
  project_patch_not_found: 'Der zu ersetzende Text kommt in der Datei nicht vor.',
  project_patch_not_unique:
    'Der zu ersetzende Text kommt mehrfach vor. Mit mehr Kontext eindeutig machen oder alle ersetzen.',
  project_too_many_files: 'Das Projekt hat die erlaubte Anzahl Dateien erreicht.',
  project_write_failed: 'Die Änderung am Projekt konnte nicht angewendet werden.',
  project_archive_unreadable: 'Diese Datei ist kein lesbares ZIP-Archiv.',
  project_archive_too_large: 'Das Archiv ist größer, als hier erlaubt ist.',
  project_empty: 'Das Projekt enthält noch keine Dateien.',
  collaboration_unavailable:
    'Der Kollaborationsdienst ist gerade nicht erreichbar. Die Änderung wurde nicht gespeichert.',
  web_research_unavailable:
    'Die Recherche im Web ist hier nicht eingeschaltet oder nicht eingerichtet.',
  web_address_refused:
    'Diese Adresse wird nicht geholt. Erlaubt sind nur http und https und nur öffentlich erreichbare Adressen.',
  web_fetch_failed: 'Die Seite ließ sich nicht laden.',
  template_exists: 'Diese Seite ist bereits eine Vorlage.',
  template_not_a_page:
    'Nur gewöhnliche Seiten können Vorlagen sein, keine Datenbanken und keine Projekte.',
  saved_query_invalid:
    'Diese gespeicherte Suche passt nicht mehr zu den Daten: die Datenbank oder eine Eigenschaft, nach der sie filtert, gibt es so nicht mehr. Bearbeite die Suche.',
  pinned_sources_disabled:
    'Quellen anheften ist in diesem Arbeitsbereich abgeschaltet. Das lässt sich in den Einstellungen unter KI wieder einschalten.',
  pinned_sources_limit_reached:
    'Diese Unterhaltung hat schon so viele Quellen angeheftet, wie erlaubt sind. Nimm eine weg oder hebe die Grenze in den Einstellungen an.',
  saved_query_access_denied: 'Diese gespeicherte Suche gehört nicht zu diesem Arbeitsbereich.',
  document_not_a_collection: 'Nur eine Datenbankseite hat Ansichten.',
};

/**
 * The German sentence for an error code, or the generic one.
 *
 * `Object.hasOwn` rather than `in`: the code comes out of a response body, and
 * `in` walks the prototype chain, so a body saying `"code": "toString"` would
 * hand the UI a function to render instead of a sentence.
 */
export function messageForCode(code: string | undefined): string {
  if (code !== undefined && Object.hasOwn(MESSAGES, code)) {
    return MESSAGES[code as ApiErrorCode];
  }
  return MESSAGES.internal_error;
}
