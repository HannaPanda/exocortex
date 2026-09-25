import { defineFeature, type RegisteredFeature } from '../feature.js';

/** Databases, the inbox, and everything that arrives as a file. */
export const DATA_FEATURES: readonly RegisteredFeature[] = [
  defineFeature({
    id: 'datenbanken',
    area: 'datenbanken',
    since: '2026-08-05',
    references: ['ADR-011'],
    ui: {},
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
    since: '2026-08-05',
    ui: {},
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
    id: 'datenbank-verknuepfungen',
    area: 'datenbanken',
    since: '2026-09-19',
    references: ['ADR-041'],
    ui: {},
  }),
  defineFeature({
    id: 'datenbank-ansichten',
    area: 'datenbanken',
    since: '2026-08-05',
    ui: {},
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
    since: '2026-09-18',
    ui: {},
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
    since: '2026-08-05',
    ui: {},
  }),
  defineFeature({
    id: 'eingang',
    area: 'erfassen',
    since: '2026-09-18',
    references: ['#71', 'ADR-036'],
    ui: {},
    shortcuts: ['Strg+E'],
    tools: ['exo_capture', 'exo_inbox'],
  }),
  defineFeature({
    id: 'web-clipper',
    area: 'erfassen',
    since: '2026-09-18',
    references: ['#72', 'ADR-037'],
    ui: {
      path: '/teilen',
    },
    tools: ['exo_clip'],
    claims: { screens: ['/teilen'] },
  }),
  defineFeature({
    id: 'anhaenge',
    area: 'dateien',
    since: '2026-08-05',
    ui: {},
    tools: ['exo_attachment_upload', 'exo_attachment_upload_url'],
  }),
  defineFeature({
    id: 'texterkennung',
    area: 'dateien',
    since: '2026-08-06',
    ui: {},
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
  defineFeature({
    id: 'office-dateien-lesen',
    area: 'dateien',
    since: '2026-09-20',
    ui: {},
    settings: ['ai.officeExtractionEnabled', 'ai.officeMaxBytes'],
    // Kein eigener Werkzeugeintrag: es sind dieselben drei Werkzeuge wie beim
    // PDF (exo_attachment_read_text, _reextract_text, _correct_text), und die
    // gehören dort schon zu „texterkennung". Ein Werkzeug hat genau einen
    // Eintrag, sonst sagt die Hilfe zweimal dasselbe.
  }),
  defineFeature({
    id: 'anhaenge-mitdurchsuchen',
    area: 'suche',
    since: '2026-09-20',
    ui: {},
  }),
];
