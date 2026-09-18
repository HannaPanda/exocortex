import { defineFeature, type RegisteredFeature } from '../feature.js';

/** The built-in AI, and the rules that let it act on its own. */
export const AI_FEATURES: readonly RegisteredFeature[] = [
  defineFeature({
    id: 'ki-chat',
    area: 'ki',
    title: 'Mit einem Modell über deine Seiten reden',
    summary:
      'Der Chat läuft neben der Seite und kennt Titel und Pfad der offenen Seite. Welches Modell antwortet, steht in der Modellverwaltung; ohne eingerichteten Anbieter antwortet ein lokales Attrappenmodell, damit nichts davon abhängt.',
    since: '2026-08-05',
    ui: { where: 'Die Seite "Chats" in der Navigation.', path: '/chats' },
    settings: ['ai.enabled', 'ai.defaultModelSlug', 'ai.systemPrompt'],
    claims: { screens: ['/chats'] },
  }),
  defineFeature({
    id: 'chat-archiv',
    area: 'ki',
    title: 'Alte Gespräche wiederfinden',
    summary:
      'Jedes Gespräch bleibt erhalten und ist durchsuchbar, auch von einem Agenten aus. Damit ist ein Chat kein Wegwerfprodukt, sondern eine Quelle, auf die sich später verweisen lässt.',
    since: '2026-09-08',
    ui: { where: 'Die Liste links auf der Chats-Seite.', path: '/chats' },
    tools: ['exo_chat_list', 'exo_chat_read', 'exo_chat_search'],
  }),
  defineFeature({
    id: 'ki-werkzeuge',
    area: 'ki',
    title: 'Die KI darf selbst suchen, lesen und schreiben',
    summary:
      'Im Chat kann das Modell dieselben Werkzeuge aufrufen, die ein externer Agent bekommt: suchen, Seiten lesen, anlegen, verschieben, kommentieren. Das Schreiben lässt sich getrennt vom Lesen abschalten.',
    since: '2026-08-06',
    references: ['ADR-014', 'ADR-025'],
    ui: { where: 'Die Werkzeugaufrufe stehen aufgeklappt im Gesprächsverlauf.' },
    settings: ['ai.toolsEnabled', 'ai.mutatingToolsEnabled', 'ai.maxToolIterations'],
  }),
  defineFeature({
    id: 'seitenkontext',
    area: 'ki',
    title: 'Den Text der offenen Seite mitgeben',
    summary:
      'Standardmäßig bekommt das Modell nur Titel und Pfad der offenen Seite, nicht ihren Text. Wer will, dass der Inhalt automatisch mitgeht, schaltet das frei; eine markierte Stelle geht immer mit, weil du sie ausdrücklich übergibst.',
    since: '2026-08-06',
    references: ['ADR-015'],
    ui: { where: 'Verwaltung, Einstellungen, Abschnitt KI.' },
    settings: ['ai.pageContextEnabled', 'ai.pageContextMaxChars'],
  }),
  defineFeature({
    id: 'bilder-verstehen',
    area: 'ki',
    title: 'Bilder beschreiben lassen',
    summary:
      'Bilder auf einer Seite werden vor dem eigentlichen Aufruf beschrieben, sodass auch ein Modell ohne Augen weiß, was darauf zu sehen ist. Die Zahl der Bilder pro Lauf ist begrenzt, weil jedes davon kostet.',
    since: '2026-08-06',
    ui: { where: 'Verwaltung, Einstellungen, Abschnitt KI.' },
    settings: ['ai.visionEnabled', 'ai.visionMaxImagesPerRun'],
  }),
  defineFeature({
    id: 'web-recherche',
    area: 'ki',
    title: 'Im Web suchen und Seiten abrufen',
    summary:
      'Die KI kann über eine eigene Suchmaschine recherchieren und einzelne Seiten mit einem echten Browser abrufen, auch solche, die ohne JavaScript leer bleiben. Adressen im internen Netz werden vorher geprüft und abgelehnt, auch nach einer Weiterleitung.',
    since: '2026-09-18',
    references: ['#26', 'ADR-033'],
    ui: { where: 'Verwaltung, Einstellungen, Abschnitt KI.' },
    settings: [
      'ai.webResearchEnabled',
      'ai.webResearchMaxChars',
      'ai.webResearchMaxFetchesPerRun',
      'ai.webSearchMaxResults',
    ],
    tools: ['exo_web_search', 'exo_web_fetch'],
  }),
  defineFeature({
    id: 'fremdinhalte-sperre',
    area: 'ki',
    title: 'Nach fremdem Text schreibt die KI nichts mehr',
    summary:
      'Sobald ein Lauf Text gelesen hat, den jemand von außen geschrieben haben könnte (ein PDF, ein Bild, eine Webseite), sind Schreibvorgänge für den Rest des Laufs gesperrt. Das macht eine Anweisung, die in einem Dokument versteckt ist, wirkungslos.',
    since: '2026-09-16',
    references: ['#56', 'ADR-030'],
    ui: { where: 'Verwaltung, Einstellungen, Abschnitt KI.' },
    settings: ['ai.untrustedContentPolicy'],
  }),
  defineFeature({
    id: 'kompaktierung',
    area: 'ki',
    title: 'Lange Gespräche laufen weiter',
    summary:
      'Wird ein Gespräch länger als das Fenster des Modells, wird der ältere Teil zusammengefasst statt abgeschnitten. Verdichtet wird nur, wenn ein kürzerer Verlauf wirklich etwas ändert.',
    since: '2026-08-06',
    references: ['ADR-032'],
    ui: { where: 'Die Auslastungsanzeige unter dem Eingabefeld im Chat.' },
    settings: [
      'ai.compactionThresholdPercent',
      'ai.compactionKeepRecentMessages',
      'ai.compactionModelSlug',
    ],
  }),
  defineFeature({
    id: 'ki-regeln',
    area: 'ki',
    title: 'Dauerhafte Anweisungen als Regelseite',
    summary:
      'Eine Seite lässt sich zur Regel erklären: entweder gilt sie immer und steht im Systemprompt, oder sie nennt nur ihren Auslösersatz und wird bei Bedarf nachgeladen. So bleiben Vorgaben dort, wo sie jeder lesen und ändern kann, statt in einer Konfiguration.',
    since: '2026-08-06',
    ui: { where: 'Im Seitenmenü unter "Als KI-Regel führen".' },
    tools: ['exo_rules_list', 'exo_rules_load', 'exo_page_set_ai_rule'],
  }),
  defineFeature({
    id: 'ki-laeufe',
    area: 'ki',
    title: 'Laufende Antworten beobachten und abbrechen',
    summary:
      'Ein Lauf hat einen Zustand, den man abfragen kann, samt Werkzeugaufrufen und Fehlern, und er lässt sich abbrechen. Damit ist auch eine Antwort, die zehn Minuten arbeitet, nichts, worauf man nur warten kann.',
    since: '2026-08-06',
    ui: { where: 'Die Fortschrittsanzeige im Chat.' },
    settings: ['ai.maxRunMs', 'ai.timeoutMs', 'ai.budgetMicroUsdPerRun'],
    tools: ['exo_ai_run_get', 'exo_ai_run_cancel'],
  }),
  defineFeature({
    id: 'automationen',
    area: 'automationen',
    title: 'Regeln, die auf Änderungen reagieren',
    summary:
      'Eine Regel feuert, wenn eine Seite angelegt, geändert, verschoben, archiviert oder gelöscht wird oder sich eine Datenbankzeile ändert, wahlweise im ganzen Arbeitsbereich, unter einer Seite oder in einer Datenbank. Eine Regel löst sich nie selbst aus, und eine Kette endet nach drei Gliedern.',
    since: '2026-09-12',
    references: ['#50', 'ADR-024'],
    ui: { where: 'Automationen im Arbeitsbereich.' },
    settings: ['automations.enabled', 'automations.maxConsecutiveFailures'],
    tools: [
      'exo_automation_create',
      'exo_automation_update',
      'exo_automation_delete',
      'exo_automation_list',
      'exo_automation_runs',
      'exo_automation_trigger',
    ],
    claims: {
      screens: ['/arbeitsbereich/:x/automationen'],
      automationTriggers: [
        'DOCUMENT_CREATED',
        'DOCUMENT_UPDATED',
        'DOCUMENT_CONTENT_CHANGED',
        'DOCUMENT_MOVED',
        'DOCUMENT_ARCHIVED',
        'DOCUMENT_DELETED',
        'DATABASE_ROW_CHANGED',
      ],
    },
  }),
  defineFeature({
    id: 'automation-webhook',
    area: 'automationen',
    title: 'Eine Automation, die woanders anklopft',
    summary:
      'Als Aktion kann eine Regel einen Webhook aufrufen und damit einen anderen Dienst anstoßen. Der Zielhost muss vorher auf eine Positivliste, sonst wird der Aufruf abgelehnt.',
    since: '2026-09-12',
    references: ['ADR-024'],
    ui: { where: 'Beim Anlegen einer Automation als Aktion "Webhook".' },
    settings: ['automations.webhookAllowedHosts', 'automations.webhookTimeoutSeconds'],
    claims: { automationActions: ['WEBHOOK'] },
  }),
  defineFeature({
    id: 'automation-ki',
    area: 'automationen',
    title: 'Eine Automation, die die KI schreiben lässt',
    summary:
      'Als Aktion kann eine Regel ein Modell auf die geänderte Seite ansetzen, zum Beispiel für eine Zusammenfassung oder eine Prüfung. Das Ergebnis wird als Kommentar oder als Unterseite abgelegt und überschreibt nie den vorhandenen Inhalt.',
    since: '2026-09-12',
    references: ['ADR-024'],
    ui: { where: 'Beim Anlegen einer Automation als Aktion "KI-Lauf".' },
    settings: ['automations.runRetentionDays'],
    claims: { automationActions: ['AI_RUN'] },
  }),
  defineFeature({
    id: 'zeitplaene',
    area: 'automationen',
    title: 'Automationen nach der Uhr',
    summary:
      'Eine Regel kann statt auf eine Änderung auf die Uhr hören: einmalig, täglich, wöchentlich, monatlich oder nach einem Cron-Ausdruck. Stand die Installation still, wird einmal nachgeholt statt für jeden verpassten Termin.',
    since: '2026-09-18',
    references: ['#73', 'ADR-038'],
    ui: { where: 'Beim Anlegen einer Automation als Auslöser "Zeitplan".' },
    claims: { automationTriggers: ['SCHEDULE'] },
  }),
];
