import { defineFeature, type RegisteredFeature } from '../feature.js';

/** Turning what is written here into a file somebody else can read. */
export const PUBLISHING_FEATURES: readonly RegisteredFeature[] = [
  defineFeature({
    id: 'pdf-veroeffentlichen',
    area: 'veroeffentlichen',
    title: 'Eine Seite als PDF setzen lassen',
    summary:
      'Eine Seite geht durch Pandoc und xelatex und kommt als gesetztes PDF zurück, das als ganz normaler Anhang an der Seite hängt. Ändert sich die Seite, zeigt das PDF, dass es veraltet ist; ändert sich nichts, kostet ein erneuter Aufruf nichts.',
    details: [
      'Über das Seitenmenü stößt du die Veröffentlichung an, der Satz läuft im Hintergrund auf dem Server, und du bekommst ein PDF, das nach Buch aussieht und nicht nach Bildschirmausdruck: richtige Absatzumbrüche, Silbentrennung, Kopfzeilen, Inhaltsverzeichnis, Formeln im Satz statt als Bild.',
      'Das fertige PDF hängt als gewöhnlicher Anhang an der Seite. Das heißt: herunterladbar, löschbar, im Verlauf sichtbar, durchsuchbar wie jede andere Datei. Auch ein Agent kann es lesen, was der Weg ist, auf dem er prüft, ob sein Ergebnis wirklich so aussieht, wie es soll.',
      'Aus dem Inhalt wird eine Prüfsumme gebildet, und die ist beides zugleich: Zwischenspeicher und Veraltet-Anzeige. Änderst du nichts, kostet ein zweiter Aufruf nichts und liefert dieselbe Datei. Änderst du die Seite, ist am PDF zu sehen, dass es nicht mehr zum Text passt. Ein Lauf lässt sich verfolgen, abbrechen und im Fehlerfall über sein Protokoll nachlesen.',
    ],
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
    details: [
      'Eine Vorlage ist die Satzanweisung für das PDF: Schriftart und -größe, Seitenränder, Kopf- und Fußzeilen, Titelblatt, Nummerierung, Sprache der Silbentrennung. Beim Veröffentlichen wählst du, welche benutzt wird, an der Seite selbst ändert sich dabei nichts.',
      'Du legst so viele an, wie du Sorten Dokument hast. Ein Brief mit Anschriftenfeld, ein Bericht mit Deckblatt und Inhaltsverzeichnis, ein Handzettel ohne alles: dieselbe Seite, drei Ergebnisse. Vorlagen lassen sich bearbeiten und löschen, und Agenten können sie über die Werkzeuge verwalten.',
      'Die Schriften müssen im Satz-Container vorhanden sein. Deshalb benutzt diese Installation ein eigenes Abbild mit den gewünschten Schriften; sonst fällt xelatex auf eine Ersatzschrift zurück, und das Ergebnis sieht anders aus, als die Vorlage sagt.',
    ],
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
    details: [
      'Für eine Diplomarbeit, ein Buch oder einen Artikel mit Literaturverzeichnis reicht eine Seite nicht: da braucht es mehrere .tex-Dateien, eine .bib, Abbildungen und Unterordner. Ein Projekt ist genau das, und es liegt trotzdem im Baum wie jede andere Seite, mit denselben Rechten und derselben Suche.',
      'Links steht der Dateibaum, rechts der Quelltext mit Syntaxhervorhebung, daneben das gebaute PDF. Bearbeitet wird gemeinsam und in Echtzeit, genau wie bei einer normalen Seite, denn darunter liegt derselbe Mechanismus. Dateien lassen sich anlegen, umbenennen, verschieben, löschen, und Bilder oder andere Beigaben lädst du dazu.',
      'Agenten können denselben Baum bearbeiten, inklusive gezielter Änderungen an einzelnen Stellen einer Datei. Eine Änderung von außen geht dabei über denselben Weg wie das Tippen im Browser, damit sie sofort im offenen Editor steht und nicht nur in der Datenbank.',
    ],
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
    details: [
      'Ein Klick auf "Bauen" schickt das Projekt an latexmk in einem Container auf dem Server. Auf deinem Rechner muss nichts installiert sein, auch nicht die zwei Gigabyte TeX Live, und auf einem fremden Rechner funktioniert es genauso.',
      'Zurück kommen das PDF und eine Liste von Fehlern und Warnungen mit Datei und Zeile, anklickbar. Das ist der praktische Unterschied zu einem Terminal: statt zweitausend Zeilen Protokoll nach der einen fehlenden Klammer zu durchsuchen, klickst du den Fehler an und landest an der Stelle.',
      'Das vollständige Protokoll gibt es weiterhin, falls die Liste nicht reicht. Ein Bau lässt sich abbrechen, ältere Bauten bleiben mit ihren Ergebnissen abrufbar, und alles davon gibt es auch als Werkzeug, sodass ein Agent bauen, den Fehler lesen, ihn beheben und neu bauen kann.',
    ],
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
    details: [
      'Doppelklick im Quelltext scrollt das PDF an die Stelle, die dieser Zeile entspricht, und hebt sie kurz hervor. Doppelklick im PDF öffnet die zugehörige Datei an der richtigen Zeile, auch wenn der Absatz aus einer eingebundenen Datei stammt, von der du gar nicht mehr wusstest, dass es sie gibt.',
      'Die Zuordnung kommt aus der Karte, die der Satzlauf mitschreibt. Beide Richtungen gibt es auch als Werkzeug, ein Agent kann also fragen, wo eine Quelltextzeile im PDF landet oder welche Zeile hinter einer Stelle im PDF steckt.',
      'Angezeigt wird das PDF im eingebauten Betrachter auf Basis von pdf.js. Einen fremden Betrachter einzubetten verbietet die Sicherheitsregel dieser Installation, und das ist auch gut so: so bleibt das PDF in derselben Seite und nicht in einem fremden Rahmen.',
    ],
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
    details: [
      'Der Export packt den ganzen Dateibaum in ein ZIP, mit Ordnern und Beigaben. Das ist der Weg nach draußen: an eine Verlagsredaktion schicken, in ein anderes System umziehen, oder einfach eine Kopie in die Hand nehmen, die ohne eXocortex funktioniert.',
      'Der Import geht in dieselbe Richtung zurück und nimmt ein ZIP von woanders an, etwa eine Vorlage einer Hochschule. Die Dateien werden in einem Zug eingespielt, nicht einzeln, damit ein Abbruch nicht ein halbes Projekt hinterlässt.',
      'Vorhandene Dateien werden dabei nicht angefasst, es sei denn, du verlangst das Überschreiben ausdrücklich. Die Bytes reisen als gewöhnlicher Anhang, es gibt also keinen zweiten Übertragungsweg neben dem, der für Dateien ohnehin da ist.',
    ],
    since: '2026-09-17',
    references: ['#54'],
    ui: { where: 'Das Menü der Projektansicht.' },
    tools: ['exo_project_export', 'exo_project_import'],
  }),
];
