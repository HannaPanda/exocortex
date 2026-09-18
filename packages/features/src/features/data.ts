import { defineFeature, type RegisteredFeature } from '../feature.js';

/** Databases, the inbox, and everything that arrives as a file. */
export const DATA_FEATURES: readonly RegisteredFeature[] = [
  defineFeature({
    id: 'datenbanken',
    area: 'datenbanken',
    title: 'Datenbanken mit Zeilen, die richtige Seiten sind',
    summary:
      'Eine Datenbank ist eine Seite, deren Kinder die Zeilen sind. Jede Zeile ist damit eine vollwertige Seite: sie kann Inhalt haben, verlinkt werden und selbst Unterseiten tragen, statt nur ein Eintrag in einer Tabelle zu sein.',
    since: '2026-08-05',
    references: ['ADR-011'],
    ui: { where: 'Neue Seite anlegen und als Datenbank anlegen wählen.' },
    tools: [
      'exo_database_create',
      'exo_database_schema',
      'exo_database_query',
      'exo_database_row_create',
      'exo_database_row_get',
      'exo_database_row_update',
    ],
  }),
  defineFeature({
    id: 'datenbank-eigenschaften',
    area: 'datenbanken',
    title: 'Spalten: Text, Zahl, Auswahl, Datum, Person, Dateien',
    summary:
      'Eine Datenbank bekommt Spalten vom Typ Text, Zahl, Auswahl, Mehrfachauswahl, Datum, Kontrollkästchen, Adresse, E-Mail, Telefon, Person und Dateien. Dazu kommen vier Spalten, die sich selbst füllen: angelegt am, geändert am, angelegt von, geändert von. Ein Datum darf ein Zeitraum sein.',
    since: '2026-08-05',
    ui: { where: 'In der Tabellenansicht auf den Spaltenkopf klicken.' },
    tools: [
      'exo_database_property_create',
      'exo_database_property_update',
      'exo_database_property_delete',
      'exo_database_property_reorder',
      'exo_database_option_create',
      'exo_database_option_update',
      'exo_database_option_delete',
    ],
  }),
  defineFeature({
    id: 'datenbank-ansichten',
    area: 'datenbanken',
    title: 'Gespeicherte Ansichten: Tabelle, Board, Galerie, Kalender',
    summary:
      'Dieselben Daten lassen sich als Tabelle, Kanban-Board, Galerie oder Kalender zeigen, jeweils mit eigenem Filter, eigener Sortierung und eigenen sichtbaren Spalten. Die Ansichten werden gespeichert, sodass jede Frage ihre eigene Sicht bekommt.',
    since: '2026-08-05',
    ui: { where: 'Die Reiterleiste über einer Datenbank.' },
    tools: [
      'exo_database_view_create',
      'exo_database_view_update',
      'exo_database_view_delete',
      'exo_database_view_reorder',
    ],
  }),
  defineFeature({
    id: 'kalenderansicht',
    area: 'datenbanken',
    title: 'Kalender mit Tag, Woche, Monat, Jahr und Liste',
    summary:
      'Eine Datumsspalte macht aus einer Datenbank einen Kalender, wahlweise als Tag, Woche, Monat, Jahr oder Liste. Termine mit Datum können eine Erinnerung auslösen, wenn die Erinnerungen eingeschaltet sind.',
    since: '2026-09-18',
    ui: { where: 'Eine Ansicht vom Typ Kalender anlegen und die Datumsspalte wählen.' },
    settings: [
      'calendar.remindersEnabled',
      'calendar.reminderLeadMinutes',
      'calendar.reminderAllDayHour',
      'calendar.timeZone',
    ],
  }),
  defineFeature({
    id: 'datenbank-einbettung',
    area: 'datenbanken',
    title: 'Eine Datenbank mitten in einer Seite',
    summary:
      'Eine vorhandene Datenbank lässt sich als Block in eine andere Seite einbetten, mit einer bestimmten Ansicht. Damit steht die Tabelle dort, wo der Text über sie spricht, statt hinter einem Link.',
    since: '2026-08-05',
    ui: { where: 'Im Editor "/" tippen und Datenbank einbetten wählen.' },
  }),
  defineFeature({
    id: 'eingang',
    area: 'erfassen',
    title: 'Eingang und Schnellerfassung',
    summary:
      'Strg+E öffnet ein kleines Feld, in das ein Gedanke sofort hineingeht, ohne dass du entscheiden musst, wohin er gehört. Er landet auf der Eingangsseite, und einsortiert wird später mit dem Ablagevorschlag.',
    since: '2026-09-18',
    references: ['#71', 'ADR-036'],
    ui: { where: 'Die Schaltfläche "Erfassen" oben in der Navigation.' },
    shortcuts: ['Strg+E'],
    tools: ['exo_capture', 'exo_inbox'],
  }),
  defineFeature({
    id: 'web-clipper',
    area: 'erfassen',
    title: 'Seiten aus dem Browser clippen und teilen',
    summary:
      'Über /teilen nimmt eXocortex Adresse, Titel und markierten Text einer Webseite entgegen, wahlweise als Lesezeichen oder mit dem vollständigen abgerufenen Artikel. Auf Android taucht eXocortex direkt im Teilen-Menü auf, wenn die App als PWA installiert ist.',
    since: '2026-09-18',
    references: ['#72', 'ADR-037'],
    ui: {
      where: 'Das Teilen-Menü des Telefons, oder ein Lesezeichen mit der Clipper-Adresse.',
      path: '/teilen',
    },
    tools: ['exo_clip'],
    claims: { screens: ['/teilen'] },
  }),
  defineFeature({
    id: 'anhaenge',
    area: 'dateien',
    title: 'Dateien, Bilder, Video und Audio auf einer Seite',
    summary:
      'Dateien werden per Ziehen oder über das Blockmenü hochgeladen und liegen im Objektspeicher dieser Installation, nicht bei einem Fremdanbieter. Bilder werden beim Hochladen verkleinert, und der Dateityp wird am Inhalt geprüft, nicht an der Endung.',
    since: '2026-08-05',
    ui: { where: 'Datei in den Editor ziehen.' },
    tools: ['exo_attachment_upload'],
  }),
  defineFeature({
    id: 'texterkennung',
    area: 'dateien',
    title: 'Text aus PDFs, auch aus gescannten',
    summary:
      'Aus einem hochgeladenen PDF wird der Text herausgelesen, bei Scans lokal über Docling und notfalls über ein Modell. Der Text ist durchsuchbar, lesbar und von Hand korrigierbar, und eine Chipzeile am PDF zeigt Titel, Autor und Seitenzahl aus den Metadaten der Datei.',
    since: '2026-08-06',
    ui: { where: 'Die Leiste unter einem PDF-Block.' },
    settings: [
      'ai.pdfExtractionEnabled',
      'ai.pdfExtractor',
      'ai.pdfExtractorFallbackEnabled',
      'ai.pdfMaxBytes',
    ],
    tools: [
      'exo_attachment_read_text',
      'exo_attachment_reextract_text',
      'exo_attachment_correct_text',
    ],
  }),
];
