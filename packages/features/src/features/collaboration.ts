import { defineFeature, type RegisteredFeature } from '../feature.js';

/** Working together, what happened before, and what the agents remember. */
export const COLLABORATION_FEATURES: readonly RegisteredFeature[] = [
  defineFeature({
    id: 'echtzeit',
    area: 'zusammenarbeit',
    title: 'Wer gerade mitliest, und wo',
    summary:
      'Oben rechts stehen die Leute, die dieselbe Seite offen haben, und ihre Schreibmarke ist im Text zu sehen. Fällt die Verbindung aus, schreibst du weiter und die Änderungen laufen beim Wiederverbinden zusammen.',
    since: '2026-08-05',
    references: ['ADR-004', 'ADR-008'],
    ui: { where: 'Die Kreise oben rechts über dem Editor.' },
  }),
  defineFeature({
    id: 'kommentare',
    area: 'zusammenarbeit',
    title: 'Kommentare an einer Textstelle',
    summary:
      'Ein Kommentar hängt an der markierten Stelle und wandert mit ihr mit, wenn der Text darüber wächst. Ein Gespräch lässt sich als erledigt markieren, statt gelöscht zu werden.',
    since: '2026-08-05',
    ui: { where: 'Text markieren, dann das Sprechblasen-Symbol; Liste im Kontextbereich rechts.' },
    shortcuts: ['Strg+. öffnet den Kontextbereich'],
    tools: [
      'exo_comment_create',
      'exo_comment_list',
      'exo_comment_update',
      'exo_comment_resolve',
      'exo_comment_delete',
    ],
  }),
  defineFeature({
    id: 'verlauf',
    area: 'zusammenarbeit',
    title: 'Versionen zurückholen',
    summary:
      'Vor jedem Schreibvorgang von außen und in regelmäßigen Abständen beim Tippen entsteht ein Schnappschuss. Der Aktivitätsbereich listet sie mit Zeit und Urheber, und ein Klick stellt einen davon wieder her.',
    since: '2026-08-09',
    ui: { where: 'Der Reiter "Aktivität" im Kontextbereich rechts.' },
    settings: [
      'activity.editSessionSnapshotsEnabled',
      'activity.snapshotRetentionFullDays',
      'activity.snapshotRetentionDailyDays',
    ],
    tools: ['exo_page_activity', 'exo_page_snapshots', 'exo_page_restore_snapshot'],
  }),
  defineFeature({
    id: 'agenten-journal',
    area: 'zusammenarbeit',
    title: 'Was ein Agent in einer Sitzung geändert hat',
    summary:
      'Schreibvorgänge eines Agenten werden zu einer Sitzung gebündelt und im Journal festgehalten, jeweils mit dem Schnappschuss von vor der Änderung. Damit lässt sich nachlesen, was ein Lauf angefasst hat, und einzelne Seiten gezielt zurückrollen.',
    since: '2026-09-13',
    references: ['ADR-022'],
    ui: { where: 'Verwaltung, Bereich Agenten.' },
    settings: ['agents.journalRetentionDays'],
    tools: ['exo_agent_session_list', 'exo_agent_session_get'],
    claims: { screens: ['/admin/agenten'] },
  }),
  defineFeature({
    id: 'agenten-gedaechtnis',
    area: 'gedaechtnis',
    title: 'Ein Gedächtnis, das die Agenten selbst führen',
    summary:
      'Claude Code, Hermes und andere Clients legen ihre Sitzungsnotizen in einem eigenen Arbeitsbereich ab und bekommen sie beim nächsten Mal zum passenden Verzeichnis zurück. Das ist bewusst vom kuratierten Wissen getrennt: Mitschrieb darf aufgeräumt und verworfen werden.',
    since: '2026-08-12',
    references: ['ADR-019', 'ADR-023'],
    ui: { where: 'Ein Arbeitsbereich wird in seinen Einstellungen zum Gedächtnis erklärt.' },
    settings: ['memory.enabled', 'memory.captureModelSlug', 'memory.retentionDays'],
    tools: ['recall', 'remember'],
  }),
  defineFeature({
    id: 'gedaechtnis-fakten',
    area: 'gedaechtnis',
    title: 'Verdichtete Fakten über den Notizen',
    summary:
      'Aus vielen Sitzungsnotizen destilliert ein nächtlicher Lauf einzelne Aussagen, die über den Notizen stehen und bei jedem Abruf zuerst kommen. Eine Aussage, die niemand mehr bestätigt, verliert langsam an Gewicht, und ein Widerspruch wird markiert statt aufgelöst.',
    since: '2026-09-08',
    references: ['ADR-021'],
    ui: { where: 'Die Seite "Gedächtnis" in der Navigation.', path: '/gedaechtnis' },
    settings: [
      'memory.consolidationEnabled',
      'memory.factHalfLifeDays',
      'memory.factConfidenceFloor',
    ],
    tools: ['exo_memory_facts', 'exo_memory_fact_promote'],
    claims: { screens: ['/gedaechtnis'] },
  }),
  defineFeature({
    id: 'entitaeten',
    area: 'gedaechtnis',
    title: 'Personen, Orte und Dinge über Seiten hinweg',
    summary:
      'Eine Entität ist eine Zeile in einer Datenbank, die ihre Schreibweisen kennt. Taucht eine davon in einer Seite auf, wird die Seite mit ihr verknüpft, und das Profil sammelt alles, was über sie geschrieben wurde. Wiederkehrende, noch unbekannte Namen werden als Kandidaten vorgeschlagen.',
    since: '2026-09-08',
    references: ['#47'],
    ui: { where: 'Die Seite "Entitäten" in der Navigation.', path: '/entitaeten' },
    settings: ['entities.enabled', 'entities.databaseId', 'entities.candidatesEnabled'],
    tools: [
      'exo_entity_create',
      'exo_entity_update',
      'exo_entity_list',
      'exo_entity_profile',
      'exo_entity_link_page',
      'exo_entity_unlink_page',
      'exo_entity_candidates',
      'exo_entity_candidate_confirm',
      'exo_entity_candidate_dismiss',
    ],
    claims: { screens: ['/entitaeten'] },
  }),
];
