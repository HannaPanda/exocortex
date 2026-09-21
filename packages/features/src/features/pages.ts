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
    details: [
      'Es gibt keinen Speichern-Knopf und keinen Bearbeiten-Modus. Du klickst eine Seite in der Navigation an und schreibst; jeder Tastendruck geht als winzige Änderung an den Server und von dort an alle, die dieselbe Seite offen haben. Ein Absatz, eine Überschrift, ein Bild: alles ist ein Block, und Blöcke lassen sich am Griff links anfassen, umsortieren, umwandeln und löschen.',
      'Der Editor arbeitet auch weiter, wenn die Verbindung wegbricht. Deine Änderungen bleiben im Browser liegen und werden beim Wiederverbinden mit dem zusammengeführt, was in der Zwischenzeit woanders passiert ist. Weil das Zusammenführen pro Zeichen funktioniert und nicht pro Datei, entsteht dabei keine Konfliktkopie: zwei Leute können denselben Absatz anfassen, ohne dass einer den anderen überschreibt.',
      'Genau dieser Zustand ist das Original. Markdown, Nur-Text und die Suchfassung werden daraus abgeleitet und jederzeit neu gebaut, deshalb kann ein Agent über exo_page_write dieselbe Seite bearbeiten, an der du gerade sitzt, und du siehst die Änderung sofort im offenen Editor.',
    ],
    since: '2026-08-05',
    references: ['ADR-004', 'ADR-005'],
    ui: { where: 'Eine Seite in der Navigation anklicken.' },
    tools: ['exo_page_create', 'exo_page_read', 'exo_page_write', 'exo_page_rename'],
    claims: { screens: ['/arbeitsbereich/:x/seite/:x'] },
  }),
  defineFeature({
    id: 'seiten-teilweise-schreiben',
    area: 'seiten',
    title: 'Ein Agent ändert eine Stelle, nicht die ganze Seite',
    summary:
      'Ein Agent kann einen einzelnen Block austauschen, eine Textstelle ersetzen oder unter einer bestimmten Überschrift schreiben. Der Rest der Seite wird dabei nicht angefasst, auch nicht das, was du in derselben Minute getippt hast.',
    details: [
      'Bis dahin gab es nur den ganzen Weg: ein Agent, der eine Zeile korrigieren wollte, musste die komplette Seite lesen, sie im Kopf neu zusammensetzen und vollständig zurückschreiben. Auf einer langen Seite ist das teuer, und es überschreibt stillschweigend alles, was in der Zwischenzeit woanders geschrieben wurde.',
      'Jetzt gibt es drei genauere Wege. exo_page_block_update tauscht genau einen Block, adressiert über seine Kennung. exo_page_patch ersetzt eine Textstelle und schreibt gar nichts, wenn sie mehrfach oder gar nicht vorkommt. exo_page_section_write schreibt unter eine Überschrift, wobei die Überschrift stehen bleibt, weil sie die Adresse ist.',
      'Was dabei nicht angefasst wird, bleibt buchstäblich unangetastet: gleiche Blockkennungen, also halten Kommentare und Einbettungen, die daran hängen. Wer die Seite gerade offen hat, sieht nur die eine geänderte Stelle aufblinken statt eines neu geladenen Dokuments. Und mit expectedYjsUpdatedAt lehnt der Aufruf lieber ab, als eine fremde Änderung zu überschreiben.',
    ],
    since: '2026-09-21',
    references: ['#111', 'ADR-055'],
    tools: ['exo_page_block_update', 'exo_page_patch', 'exo_page_section_write'],
  }),
  defineFeature({
    id: 'grosse-seiten-karte-und-auslagern',
    area: 'seiten',
    title: 'Sehr große Seiten: erst die Gliederung, dann ein Abschnitt, dann eine eigene Seite',
    summary:
      'Eine Seite, die für einen Agenten zu groß geworden ist, antwortet ihm nicht mehr mit ihren ersten dreißigtausend Zeichen, sondern mit ihrer Gliederung: welche Abschnitte es gibt, wie groß jeder ist und wie er einzeln zu lesen ist. Und ein Abschnitt, der eine eigene Seite verdient hat, wird mit einem Aufruf eine.',
    details: [
      'Vorher las ein Agent eine lange Seite von vorne, bekam am Schnitt nur das Wort "gekürzt" zu sehen und suchte danach im Dunkeln weiter. Bei einer Seite mit 36.000 Zeichen hat das einen Lauf gekostet, ohne die gesuchte Stelle zu finden. Jetzt kommt bei einer großen Seite zuerst ihre Karte, und die ist gleich groß, ob die Seite 20.000 oder drei Millionen Zeichen hat.',
      'Aus der Karte wird ein Abschnitt einzeln gelesen. Ist der selbst zu groß, kommt wieder eine Karte, eine Ebene feiner. Hat ein Teil keine Überschriften mehr, nennt die Karte Blockfenster, die sich mit zwei Kennungen zusammen lesen lassen. Damit ist jede Stelle einer beliebig großen Seite in wenigen Schritten erreichbar, ohne alles davor zu lesen.',
      'Dieselben Adressen benutzt exo_page_extract_section: Abschnitt benennen, und er wandert auf eine neue Unterseite, die nach seiner Überschrift heißt. Auf der alten Seite bleibt die Überschrift stehen und darunter wahlweise ein Verweis, eine Einbettung (dann ändert sich für Lesende nichts) oder nichts. Vorher wurde vor der Änderung ein Snapshot angelegt, mit dem sich alles zurückrollen lässt.',
      'Damit eine Seite gar nicht erst so weit wächst, sagt ein Agent ab 15.000 Zeichen beim Schreiben dazu, wie groß die Seite jetzt ist und welche ihre größten Abschnitte sind, und schlägt für ein neues Thema eine Unterseite vor. Ab 50.000 Zeichen hängt er nichts mehr an und nennt stattdessen den Abschnitt, der eine eigene Seite verdient hätte. Beide Grenzen stehen in den Einstellungen und lassen sich je Arbeitsbereich strenger setzen.',
      'Das gilt nur für Agenten, die anhängen. Im Editor schreibst du weiter, was du willst; Web Clipper, Importe, der Eingang und das Gedächtnis der Agenten sind ausgenommen, eine Seite wird nie von selbst geteilt, und eine zu groß gewordene Seite lässt sich immer noch kürzen oder abschnittsweise ändern.',
    ],
    since: '2026-09-21',
    references: ['#118', 'ADR-056', 'ADR-045'],
    tools: ['exo_page_extract_section'],
  }),
  defineFeature({
    id: 'bloecke',
    area: 'seiten',
    title: 'Blöcke über das Schrägstrich-Menü',
    summary:
      'Ein Schrägstrich mitten im Text öffnet die Blockliste: Überschriften, Aufgabenlisten, Hinweiskästen, Spalten, Code, Formeln, Tabellen, Einbettungen, Inhaltsverzeichnis und einklappbare Abschnitte. Ein vorhandener Block lässt sich über sein Menü in einen anderen umwandeln.',
    details: [
      'Du tippst "/" und danach zwei, drei Buchstaben dessen, was du willst; die Liste filtert mit, und Eingabe setzt den Block. Die Auswahl umfasst Text, drei Überschriftenebenen, Zitat, Codeblock, Trennlinie, Aufzählung, nummerierte Liste, Aufgabenliste mit Kontrollkästchen, Tabelle, Bild, Video, Audio, beliebige Dateien, Lesezeichen, eingebettete Webseiten, Formeln in LaTeX, zwei Spalten nebeneinander, einklappbare Abschnitte, Inhaltsverzeichnis, Seitenpfad, Verweise auf andere Seiten und eingebettete Datenbanken.',
      'Hinweiskästen gibt es in fünf Farben mit eigener Bedeutung: Info, Notiz, Erfolg, Warnung und Gefahr. Sie sind der übliche Weg, eine Warnung so hinzuschreiben, dass sie beim Überfliegen auffällt.',
      'Ein Block, der schon dasteht, muss nicht gelöscht und neu getippt werden. Über den Griff links neben dem Block kommst du an "In anderen Block umwandeln": aus drei Absätzen wird eine Aufzählung, aus einer Aufzählung eine Aufgabenliste, aus einem Absatz eine Überschrift. Dieselbe Liste bedient das Schrägstrich-Menü, das Umwandeln-Menü und die Blockaktionen, damit sie nicht auseinanderlaufen.',
    ],
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
    details: [
      'Fahre mit der Maus über den Bereich oberhalb des Seitentitels: dort erscheinen die Schaltflächen für Symbol, Titelbild und Breite. Das Symbol ist ein Emoji aus der Auswahl oder ein hochgeladenes Bild und taucht überall wieder auf, wo die Seite genannt wird, also in der Navigation, in der Suche und in Verweisen. Für eine Seite, die du täglich suchst, ist ein Symbol schneller als ihr Titel.',
      'Die Breite hat zwei Stufen: schmal hält die Zeilen kurz genug, dass sich Fließtext gut liest, breit nutzt das Fenster aus und ist für Tabellen, Kalender und Datenbanken gedacht. Die Einstellung gehört zur Seite, nicht zu dir, also sieht sie jeder gleich.',
      'Ist ein Bildmodell eingerichtet, erzeugt "Titelbild erzeugen" eines aus dem Inhalt der Seite, statt dass du eines suchen musst. Ohne eingerichtetes Modell fehlt nur dieser eine Knopf; hochladen kannst du weiterhin.',
    ],
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
    details: [
      'Ein Arbeitsbereich ist die Grenze, an der Rechte gelten: wer Mitglied ist, sieht alles darin, wer es nicht ist, sieht nichts davon. Deshalb trennst du hier nicht nach Thema, sondern nach Publikum. Ein Bereich für dich allein, einer für ein gemeinsames Projekt, einer für das Gedächtnis der Agenten.',
      'Der Umschalter oben links listet alle Bereiche, in denen du Mitglied bist, und merkt sich den zuletzt benutzten. Suche, Navigation und Erfassen beziehen sich immer auf den Bereich, in dem du gerade bist.',
      'Viele Einstellungen lassen sich pro Arbeitsbereich überschreiben, etwa welches Modell antwortet oder ob Automationen laufen dürfen. Eine Seite darf außerdem in einen anderen Bereich verschoben werden, samt allem, was unter ihr hängt, falls sich später herausstellt, dass sie beim falschen Publikum lag.',
    ],
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
    details: [
      'Es gibt keine Ordner neben den Seiten: eine Seite ist beides zugleich, Text und Behälter. "Urlaub 2026" kann eine Packliste enthalten und selbst unter "Reisen" hängen. Dadurch beantwortet die Ablage schon die halbe Frage, worum es auf einer Seite geht, und du sparst dir Kategorien, die niemand pflegt.',
      'In der Navigation klappst du eine Seite mit dem Pfeil auf. Ziehen verschiebt: auf eine Seite fallen lassen hängt sie darunter, zwischen zwei Seiten fallen lassen sortiert sie an diese Stelle. Alles, was unter der gezogenen Seite hängt, geht mit, und Verweise auf sie bleiben heil, weil ein Verweis auf die Seite zeigt und nicht auf ihren Pfad.',
      'Strg+B blendet die Navigation aus, wenn du Platz zum Schreiben brauchst, und wieder ein. Auf dem Telefon liegt sie als Überlagerung über der Seite statt daneben.',
    ],
    since: '2026-08-05',
    ui: { where: 'Die Navigation links, mit der Maus.' },
    shortcuts: ['Strg+B blendet die Navigation ein und aus, außerhalb von Textfeldern'],
    tools: ['exo_page_tree', 'exo_page_move'],
  }),
  defineFeature({
    id: 'ablage-vorschlag',
    area: 'struktur',
    title: 'Vorschlag, wohin eine Seite gehört',
    summary:
      'Statt zu raten, wo eine neue Seite hingehört, fragst du danach: eXocortex durchsucht den Baum und nennt die passenden Elternseiten samt dem, was dort schon liegt. Das ist auch die Bremse gegen den häufigsten Fehler, eine Seite eine Ebene zu hoch abzulegen.',
    details: [
      'Der Vorschlag kommt aus dem, was schon da ist: Titel und Zusammenfassung werden gegen den Baum gehalten, und zurück kommen mehrere Kandidaten mit Pfad und mit den Seiten, die dort bereits liegen. Diese Nachbarn sind der eigentliche Wert, weil du an ihnen siehst, ob du das Richtige triffst, statt einem Titel zu vertrauen.',
      'Du benutzt es in zwei Richtungen: beim Anlegen für eine neue Seite, und über das Menü einer vorhandenen Seite, wenn du den Verdacht hast, dass sie falsch liegt. Der zweite Fall ist der häufigere, denn falsch abgelegt wird meistens erst im Nachhinein sichtbar. Verschoben wird danach ganz normal, per Ziehen oder über das Seitenmenü.',
      'Der Fehler, gegen den das gebaut ist, ist immer derselbe: die Seite landet direkt unter dem Oberbereich, obwohl darunter längst der Unterbereich liegt, in den sie gehört. Für Agenten ist dieselbe Bremse eingebaut, exo_page_create warnt, wenn eine Ebene zu hoch angelegt wird.',
    ],
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
    details: [
      'Archivieren nimmt eine Seite aus der Navigation und legt sie in den Papierkorb, zusammen mit allem, was unter ihr hängt. Das ist Absicht: unter einer archivierten Seite soll keine bearbeitbare Seite zurückbleiben. Willst du nur die eine Seite loswerden, verschiebst du die Unterseiten vorher woandershin.',
      'Der Papierkorb unten in der Navigation zeigt den Inhalt als Baum, eingerückt so, wie die Seiten zueinander standen. Daran siehst du, was beim Archivieren mitgegangen ist, und holst einen ganzen Ast mit einem Klick zurück.',
      'Nichts läuft von selbst ab. Endgültiges Löschen ist ein eigener Schritt mit eigener Rückfrage, und dabei verschwinden Inhalt, Versionsstände, Kommentare und Anhänge wirklich; das ist der einzige Vorgang hier, den kein Schnappschuss mehr auffängt. Den Papierkorb ganz zu leeren ist ein Aufruf und nicht hundert, damit ein Abbruch mittendrin nicht die Hälfte übrig lässt.',
    ],
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
    details: [
      'Eine Vorlage ist keine eigene Sorte Objekt, sondern eine ganz normale Seite mit einer Markierung daran. Du schreibst sie also wie jede andere Seite, mit Editor, Suche, Verweisen und Rechten, und erklärst sie danach zur Vorlage. Typische Fälle sind das Besprechungsprotokoll, der Wochenrückblick und die Projektakte mit immer denselben fünf Überschriften.',
      'Beim Anlegen einer Seite wählst du die Vorlage aus, und kopiert werden Inhalt, Symbol und Titelbild. Der Titel folgt einem Muster, in das Datumsangaben eingesetzt werden, zum Beispiel "Wochenrückblick KW 38" oder "Protokoll 2026-09-19", sodass du nicht jedes Mal dasselbe tippst.',
      'Die Kopie ist danach vollständig auf sich gestellt. Es gibt keine Rückverbindung, also verändert eine geänderte Vorlage nichts an dem, was du schon angelegt hast, und deine Änderungen in der Kopie wandern nie in die Vorlage zurück. Datenbankeigenschaften werden nur übernommen, wenn Vorlage und Kopie in derselben Datenbank liegen, weil eine Spalte woanders schlicht nichts bedeutet.',
    ],
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
    id: 'transklusion',
    area: 'seiten',
    title: 'Inhalt an mehreren Stellen zeigen, ohne ihn zu kopieren',
    summary:
      'Ein Abschnitt, den du an zwei Stellen brauchst, muss nicht zweimal existieren. Der Block "Inhalt einbetten" zeigt Text einer anderen Seite dort, wo du ihn brauchst; geändert wird er weiterhin nur an der einen Stelle, der er gehört, und die Einbettung zieht mit.',
    details: [
      'Im Schrägstrich-Menü wählst du "Inhalt einbetten" und danach die Quellseite. Zunächst zeigt der Block die ganze Seite; über "Ganze Seite" oben rechts im Block kommst du an die Liste ihrer Blöcke und wählst stattdessen einen einzelnen aus. Wählst du eine Überschrift, gehört der ganze Abschnitt darunter dazu, bis zur nächsten Überschrift derselben oder einer höheren Ebene. Ein Statusabschnitt, der auf der Projektseite gepflegt und auf der Übersichtsseite gezeigt wird, ist damit genau ein Abschnitt.',
      'Die eingebettete Stelle ist nur eine Anzeige: hier lässt sich nichts bearbeiten, und in deiner Seite steht keine Kopie des Textes, sondern ein Verweis. Das hat drei Folgen, die du merkst. Die Quelle darf umbenannt und verschoben werden, ohne dass etwas bricht. Wer die Quellseite nicht lesen darf, sieht hier, dass etwas eingebettet ist, aber nicht was. Und die Suche gewichtet denselben Absatz nicht mehrfach, egal an wie vielen Stellen er auftaucht.',
      'Verschwindet der eingebettete Block, weil jemand die Quelle umgeschrieben hat, sagt der Block das deutlich und bietet an, stattdessen die ganze Seite zu zeigen. Es verschwindet also nie stillschweigend Inhalt. Beim Export als Markdown entscheidest du, ob der Verweis stehen bleibt oder der Text an seine Stelle tritt: für eine Datei, die hier bleibt, das eine, für eine Datei, die diese Installation verlässt, das andere.',
    ],
    since: '2026-09-19',
    references: ['#78', 'ADR-045'],
    ui: { where: 'Im Editor "/" tippen und "Inhalt einbetten" wählen.' },
    tools: ['exo_page_block_read'],
  }),
  defineFeature({
    id: 'uebersichtsseiten',
    area: 'struktur',
    title: 'Übersichtsseiten, die sich selbst schreiben',
    summary:
      'Eine Seite lässt sich zur Übersicht erklären: darüber steht dann ein Text, der aus den Kurzfassungen der Unterseiten gebaut und bei Änderungen nachgeführt wird. Der Seitenkörper bleibt unangetastet, der abgeleitete Text steht daneben.',
    details: [
      'Gedacht ist das für die Seiten, die vor allem Eingang zu anderen Seiten sind: ein Themenbereich mit dreißig Unterseiten, an dessen Anfang eigentlich stehen müsste, was da unten alles liegt. Genau diesen Absatz schreibt die Übersicht, und sie schreibt ihn neu, wenn sich unten etwas ändert.',
      'Gebaut wird er nicht aus dem vollen Text der Unterseiten, sondern aus je einer Kurzfassung pro Seite. Das hält den Aufruf klein und sorgt dafür, dass eine geänderte Unterseite nur ihre eigene Kurzfassung neu braucht. Zwei Prüfsummen entscheiden außerdem, ob sich überhaupt etwas geändert hat; ist alles beim Alten, kostet ein Aufruf nichts.',
      'Der Text steht über dem Seitenkörper, nicht darin. Was du selbst auf die Seite geschrieben hast, wird nie überschrieben, und du kannst die Übersicht jederzeit wieder abschalten. Ist kein Modell erreichbar, zeigt die Seite schlicht die Liste ihrer Unterseiten, statt leer zu bleiben.',
    ],
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
    details: [
      'Strg+K öffnet ein Feld mitten im Bild, in dem du sofort tippen kannst. Gesucht wird in Titeln und im Volltext, mit deutscher Wortstammerkennung, sodass "Rechnungen" auch "Rechnung" findet. Die Treffer zeigen den Pfad, damit du zwei gleichnamige Seiten auseinanderhältst, und die Eingabetaste springt hin.',
      'Ist die semantische Suche eingeschaltet, kommt eine zweite Liste dazu: Seiten, die inhaltlich passen, ohne dass ein Wort übereinstimmt. "Was war mit dem Umzug der Datenbank" findet dann auch die Seite, auf der es "Migration" heißt. Beide Listen werden nach Rang verschmolzen, wie stark die semantische Hälfte zählt, ist eine Einstellung.',
      'Bei langen Seiten wird nicht nur die Seite gefunden, sondern die Stelle darin: lange Texte werden zusätzlich in Abschnitte von rund zweitausend Zeichen zerlegt, und der beste Abschnitt wird als Auszug angezeigt. Fällt das Modell hinter der semantischen Suche aus, bleibt die Volltextsuche, die Suche fällt also nie ganz aus.',
      'Ohne Eingabe ist das Feld nicht leer, sondern zeigt die zuletzt bearbeiteten Seiten: weitermachen, ohne sich an einen Titel zu erinnern. Dasselbe Feld ist die Befehlsliste. Erfassen, Navigation, Kontextbereich und Papierkorb stehen dort mit Namen, statt nur als Tastenkürzel zu existieren, und was du tippst, sucht in beidem.',
    ],
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
    details: [
      'Du tippst "[[" und danach ein paar Buchstaben; eine Liste passender Seiten erscheint, Eingabe setzt den Verweis. Gibt es die Seite noch nicht, legst du sie aus derselben Liste heraus an, ohne den Satz zu verlassen, an dem du gerade schreibst.',
      'Der Verweis zeigt auf die Seite selbst, nicht auf ihren Titel oder ihren Pfad. Wird die Zielseite umbenannt, ändert sich der angezeigte Text mit; wird sie verschoben, bleibt der Verweis heil. Genau deshalb kostet das Umsortieren des Baums nichts, und du kannst großzügig verlinken.',
      'Der Kontextbereich rechts (Strg+Punkt) zeigt zu jeder Seite zwei Listen: wer auf sie verweist, und welche Seiten inhaltlich verwandt sind, ohne dass jemand einen Verweis gesetzt hat. Die zweite Liste kommt aus der semantischen Nachbarschaft und ist der Weg, alte Notizen wiederzufinden, an die du beim Schreiben nicht gedacht hast.',
    ],
    since: '2026-08-09',
    ui: { where: 'Im Editor "[[" tippen; Rückverweise im Kontextbereich rechts.' },
    shortcuts: ['Strg+. öffnet den Kontextbereich'],
    tools: ['exo_page_backlinks', 'exo_page_related', 'exo_page_resolve_link'],
  }),
  defineFeature({
    id: 'gespeicherte-suchen',
    area: 'suche',
    title: 'Gespeicherte Suchen, Smart Views und Suchblöcke',
    summary:
      'Eine Suche muss keine einmalige Antwort bleiben. Im Suchbereich stellst du eine Abfrage aus Suchbegriff, Ort, Art, Eigenschaften, Entität und Zeitraum zusammen, speicherst sie unter einem Namen und bekommst sie jedes Mal neu beantwortet: als eigener Eintrag in der Navigation oder als lebende Liste mitten in einer Seite.',
    details: [
      'Über die Navigation unten oder Strg+K kommst du in den Suchbereich. Dort steht neben dem Suchbegriff alles, womit sich eingrenzen lässt: nur unterhalb einer bestimmten Seite, nur Seiten oder nur Datenbanken, nur Zeilen einer Datenbank mit einem Eigenschaftsfilter wie in einer Datenbankansicht, nur Seiten, die eine bestimmte Entität erwähnen, geändert oder angelegt in den letzten 30 Tagen. Die Trefferliste unten ändert sich beim Tippen mit, du siehst also vor dem Speichern, was du bekommst.',
      'Gespeichert wird die Frage, nie die Trefferliste. Beim nächsten Öffnen wird sie neu beantwortet, mit deinen Rechten und nicht mit denen der Person, die sie angelegt hat. Ein Zeitraum wie "die letzten 30 Tage" wandert deshalb mit, und ein Unterbaum wird jedes Mal frisch bestimmt: verschiebst du eine Seite hinein, taucht sie beim nächsten Blick auf. Setzt du beim Speichern den Schalter "in der Navigation zeigen", wird aus der Suche ein Smart View, den alle Mitglieder in der Seitenleiste sehen.',
      'Dieselbe gespeicherte Suche lässt sich als Block in eine Seite legen: Schrägstrich-Menü, "Gespeicherte Suche einbetten". Der Block zeigt die ersten Treffer und holt sie bei jedem Öffnen neu, eine Projektseite kann also "alles Offene in diesem Bereich" tragen, ohne dass jemand die Liste pflegt. Was der Block nicht ist: eine zweite Datenbank. Er besitzt keine Zeilen, er zeigt Seiten, die es ohnehin gibt, und löschst du die Suche, bleibt jede gefundene Seite unberührt.',
    ],
    since: '2026-09-19',
    references: ['#74', 'ADR-020', 'ADR-011'],
    ui: {
      where: 'Unten in der Navigation unter "Suche und gespeicherte Suchen", oder Strg+K.',
      path: '/arbeitsbereich',
    },
    shortcuts: ['Strg+K'],
    settings: ['search.semanticEnabled'],
    tools: [
      'exo_saved_query_list',
      'exo_saved_query_get',
      'exo_saved_query_preview',
      'exo_saved_query_run',
      'exo_saved_query_create',
      'exo_saved_query_update',
      'exo_saved_query_reorder',
      'exo_saved_query_delete',
    ],
    claims: { screens: ['/arbeitsbereich/:x/suche', '/arbeitsbereich/:x/suche/:x'] },
  }),
];
