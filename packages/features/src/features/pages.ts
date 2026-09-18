import { defineFeature, type RegisteredFeature } from '../feature.js';

/**
 * Pages, the structure they hang in, and finding them again.
 *
 * `since` is the day the capability went live on this deployment, which for
 * everything dated 2026-08-05 is the day the repository started: the editor and
 * the page tree were the first thing there was.
 */
export const PAGE_FEATURES: readonly RegisteredFeature[] = [
  defineFeature({
    id: 'seiten-editor',
    area: 'seiten',
    title: 'Seiten schreiben, zu zweit gleichzeitig',
    summary:
      'Jede Seite ist ein Blockeditor, den mehrere Leute gleichzeitig bearbeiten können. Der Text wird laufend gespeichert, auch wenn die Verbindung kurz weg ist, und läuft danach von selbst wieder zusammen.',
    since: '2026-08-05',
    references: ['ADR-004', 'ADR-005'],
    ui: { where: 'Eine Seite in der Navigation anklicken.' },
    tools: ['exo_page_create', 'exo_page_read', 'exo_page_write', 'exo_page_rename'],
    claims: { screens: ['/arbeitsbereich/:x/seite/:x'] },
  }),
  defineFeature({
    id: 'bloecke',
    area: 'seiten',
    title: 'Blöcke über das Schrägstrich-Menü',
    summary:
      'Ein Schrägstrich mitten im Text öffnet die Blockliste: Überschriften, Aufgabenlisten, Hinweiskästen, Spalten, Code, Formeln, Tabellen, Einbettungen, Inhaltsverzeichnis und einklappbare Abschnitte. Ein vorhandener Block lässt sich über sein Menü in einen anderen umwandeln.',
    since: '2026-08-05',
    ui: { where: 'Im Editor "/" tippen, oder das Menü links neben einem Block öffnen.' },
    claims: { screens: ['/arbeitsbereich/:x/seite/:x'] },
  }),
  defineFeature({
    id: 'seiten-layout',
    area: 'seiten',
    title: 'Symbol, Titelbild und Seitenbreite',
    summary:
      'Eine Seite bekommt ein Emoji oder Symbol, ein Titelbild und eine Breite (schmal für Fließtext, breit für Tabellen). Das Titelbild kann auch von einem Bildmodell erzeugt werden, wenn eines eingerichtet ist.',
    since: '2026-08-05',
    ui: { where: 'Über dem Seitentitel erscheinen die Schaltflächen beim Überfahren.' },
    settings: ['ai.imageGenerationEnabled', 'ai.imageModelSlug'],
    tools: ['exo_page_set_cover', 'exo_page_set_layout', 'exo_page_generate_cover'],
  }),
  defineFeature({
    id: 'arbeitsbereiche',
    area: 'struktur',
    title: 'Mehrere Arbeitsbereiche',
    summary:
      'Seiten liegen in Arbeitsbereichen, die getrennte Mitgliedschaften und getrennte Rechte haben. Der Wechsel oben links zeigt alle, in denen du Mitglied bist.',
    since: '2026-08-05',
    ui: { where: 'Der Umschalter oben links in der Navigation.', path: '/arbeitsbereich' },
    tools: ['exo_list_workspaces', 'exo_workspace_overview', 'exo_workspace_rename'],
    claims: { screens: ['/arbeitsbereich', '/arbeitsbereich/:x'] },
  }),
  defineFeature({
    id: 'seitenbaum',
    area: 'struktur',
    title: 'Verschachtelte Seiten und Verschieben per Ziehen',
    summary:
      'Seiten hängen beliebig tief ineinander, und wo eine Seite hängt, ist Teil ihrer Aussage. Eine Seite lässt sich mit der Maus an eine andere Stelle ziehen, samt allem, was darunter liegt, und sogar in einen anderen Arbeitsbereich.',
    since: '2026-08-05',
    ui: { where: 'Die Navigation links, mit der Maus.' },
    shortcuts: ['Strg+B blendet die Navigation ein und aus'],
    tools: ['exo_page_tree', 'exo_page_move'],
  }),
  defineFeature({
    id: 'ablage-vorschlag',
    area: 'struktur',
    title: 'Vorschlag, wohin eine Seite gehört',
    summary:
      'Statt zu raten, wo eine neue Seite hingehört, fragst du danach: eXocortex durchsucht den Baum und nennt die passenden Elternseiten samt dem, was dort schon liegt. Das ist auch die Bremse gegen den häufigsten Fehler, eine Seite eine Ebene zu hoch abzulegen.',
    since: '2026-09-16',
    ui: { where: 'Im Seitenmenü unter "Ablage vorschlagen".' },
    tools: ['exo_page_suggest_parent'],
  }),
  defineFeature({
    id: 'papierkorb',
    area: 'struktur',
    title: 'Archiv und Papierkorb',
    summary:
      'Eine Seite wird archiviert oder in den Papierkorb gelegt, statt sofort zu verschwinden, und lässt sich von dort zurückholen. Endgültig gelöscht wird nur, was ausdrücklich endgültig gelöscht wird.',
    since: '2026-08-12',
    ui: { where: 'Der Papierkorb unten in der Navigation.' },
    tools: ['exo_page_archive', 'exo_page_restore', 'exo_page_trash', 'exo_page_delete'],
  }),
  defineFeature({
    id: 'vorlagen',
    area: 'struktur',
    title: 'Seitenvorlagen',
    summary:
      'Eine Seite, die du öfter in derselben Form brauchst, wird zur Vorlage. Beim Anlegen wählst du sie aus, und die Kopie bekommt Inhalt, Symbol, Titelbild und einen Titel nach Muster, zum Beispiel mit dem heutigen Datum. Die Kopie behält keine Verbindung zur Vorlage.',
    since: '2026-09-18',
    references: ['#79', 'ADR-039'],
    ui: { where: 'Vorlagen verwalten im Arbeitsbereich, benutzen beim Anlegen einer Seite.' },
    tools: [
      'exo_template_create',
      'exo_template_update',
      'exo_template_delete',
      'exo_template_list',
      'exo_template_use',
    ],
    claims: { screens: ['/arbeitsbereich/:x/vorlagen'] },
  }),
  defineFeature({
    id: 'uebersichtsseiten',
    area: 'struktur',
    title: 'Übersichtsseiten, die sich selbst schreiben',
    summary:
      'Eine Seite lässt sich zur Übersicht erklären: darüber steht dann ein Text, der aus den Kurzfassungen der Unterseiten gebaut und bei Änderungen nachgeführt wird. Der Seitenkörper bleibt unangetastet, der abgeleitete Text steht daneben.',
    since: '2026-09-15',
    references: ['ADR-028'],
    ui: { where: 'Im Seitenmenü unter "Als Übersicht führen".' },
    settings: ['overview.enabled', 'overview.modelSlug', 'overview.generateCovers'],
    tools: ['exo_page_set_overview', 'exo_page_overview_read', 'exo_page_overview_refresh'],
  }),
  defineFeature({
    id: 'suche',
    area: 'suche',
    title: 'Suche über alles, auch ohne die richtigen Wörter',
    summary:
      'Strg+K öffnet die Suche über Titel und Volltext. Ist die semantische Suche eingeschaltet, findet sie zusätzlich Seiten, deren Wortlaut du nicht mehr weißt, und bei langen Seiten die passende Stelle statt nur die Seite.',
    since: '2026-08-05',
    references: ['ADR-020', 'ADR-034'],
    ui: { where: 'Die Lupe oben in der Navigation.' },
    shortcuts: ['Strg+K'],
    settings: [
      'search.semanticEnabled',
      'search.embeddingModelSlug',
      'search.semanticWeightPercent',
    ],
    tools: ['exo_search'],
  }),
  defineFeature({
    id: 'verweise',
    area: 'suche',
    title: 'Verweise, Rückverweise und verwandte Seiten',
    summary:
      'Zwei eckige Klammern verlinken eine andere Seite, und der Verweis hält auch dann, wenn die Zielseite später umbenannt oder verschoben wird. Jede Seite zeigt, wer auf sie zeigt, und dazu inhaltlich verwandte Seiten, die niemand verlinkt hat.',
    since: '2026-08-09',
    ui: { where: 'Im Editor "[[" tippen; Rückverweise im Kontextbereich rechts.' },
    shortcuts: ['Strg+. öffnet den Kontextbereich'],
    tools: ['exo_page_backlinks', 'exo_page_related', 'exo_page_resolve_link'],
  }),
];
