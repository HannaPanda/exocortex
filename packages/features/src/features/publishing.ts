import { defineFeature, type RegisteredFeature } from '../feature.js';

/** Turning what is written here into a file somebody else can read. */
export const PUBLISHING_FEATURES: readonly RegisteredFeature[] = [
  defineFeature({
    id: 'pdf-veroeffentlichen',
    area: 'veroeffentlichen',
    title: 'Eine Seite als PDF setzen lassen',
    summary:
      'Eine Seite geht durch Pandoc und xelatex und kommt als gesetztes PDF zurück, das als ganz normaler Anhang an der Seite hängt. Ändert sich die Seite, zeigt das PDF, dass es veraltet ist; ändert sich nichts, kostet ein erneuter Aufruf nichts.',
    since: '2026-09-13',
    references: ['#44', 'ADR-026'],
    ui: { where: 'Im Seitenmenü unter "Als PDF veröffentlichen".' },
    settings: ['render.enabled', 'render.image', 'render.timeoutSeconds'],
    tools: [
      'exo_render_start',
      'exo_render_status',
      'exo_render_artifact',
      'exo_render_jobs',
      'exo_render_log',
      'exo_render_cancel',
      'exo_render_delete',
    ],
  }),
  defineFeature({
    id: 'render-vorlagen',
    area: 'veroeffentlichen',
    title: 'Eigene Layouts für das PDF',
    summary:
      'Wie das PDF aussieht, steht in einer Vorlage, die sich anlegen und bearbeiten lässt: Schrift, Ränder, Kopfzeilen, Titelblatt. Damit sieht ein Brief anders aus als ein Bericht, ohne dass an der Seite selbst etwas anders ist.',
    since: '2026-09-13',
    references: ['#44'],
    ui: { where: 'Verwaltung, Einstellungen, Abschnitt Veröffentlichen.' },
    tools: [
      'exo_render_template_create',
      'exo_render_template_read',
      'exo_render_template_update',
      'exo_render_template_delete',
      'exo_render_template_list',
    ],
  }),
  defineFeature({
    id: 'projekte',
    area: 'veroeffentlichen',
    title: 'LaTeX-Projekte mit echtem Dateibaum',
    summary:
      'Ein Projekt ist eine Seite, deren Inhalt kein Fließtext ist, sondern ein Dateibaum: .tex, .bib, Bilder, Unterordner. Bearbeitet wird im Browser, gemeinsam und in Echtzeit wie eine normale Seite.',
    since: '2026-09-13',
    references: ['#43', 'ADR-027'],
    ui: { where: 'Neue Seite anlegen und als Projekt anlegen wählen.' },
    tools: [
      'exo_project_create',
      'exo_project_read',
      'exo_project_update',
      'exo_project_list',
      'exo_project_list_files',
      'exo_project_read_file',
      'exo_project_write_file',
      'exo_project_patch_file',
      'exo_project_move_file',
      'exo_project_delete_file',
      'exo_project_add_asset',
    ],
    claims: { screens: ['/arbeitsbereich/:x/projekt/:x'] },
  }),
  defineFeature({
    id: 'projekt-bauen',
    area: 'veroeffentlichen',
    title: 'Bauen mit latexmk, samt Fehlerliste',
    summary:
      'Der Bau läuft mit latexmk in einem Container auf dem Server, ohne dass irgendetwas lokal installiert sein muss. Fehler und Warnungen kommen als Liste zurück statt als Logwüste, und ein Bau lässt sich abbrechen.',
    since: '2026-09-13',
    references: ['#43'],
    ui: { where: 'Die Schaltfläche "Bauen" in der Projektansicht.' },
    tools: [
      'exo_project_build',
      'exo_project_build_status',
      'exo_project_builds',
      'exo_project_build_log',
      'exo_project_build_artifacts',
      'exo_project_build_diagnostics',
      'exo_project_build_cancel',
      'exo_project_build_delete',
    ],
  }),
  defineFeature({
    id: 'synctex',
    area: 'veroeffentlichen',
    title: 'Vom Quelltext ins PDF springen und zurück',
    summary:
      'Ein Klick im Quelltext springt an die passende Stelle im PDF, ein Klick im PDF zurück in den Quelltext. Bei einem langen Dokument ist das der Unterschied zwischen Suchen und Finden.',
    since: '2026-09-17',
    references: ['#53', '#70'],
    ui: { where: 'Doppelklick im Editor oder im PDF der Projektansicht.' },
    tools: ['exo_project_build_position_of', 'exo_project_build_source_at'],
  }),
  defineFeature({
    id: 'projekt-archive',
    area: 'veroeffentlichen',
    title: 'Ein Projekt als ZIP ein- und ausspielen',
    summary:
      'Ein ganzes Projekt geht als ZIP heraus und kommt als ZIP wieder herein, zum Umziehen oder als Übergabe an jemanden ohne Zugang. Vorhandene Dateien werden dabei nur überschrieben, wenn du das ausdrücklich verlangst.',
    since: '2026-09-17',
    references: ['#54'],
    ui: { where: 'Das Menü der Projektansicht.' },
    tools: ['exo_project_export', 'exo_project_import'],
  }),
];
