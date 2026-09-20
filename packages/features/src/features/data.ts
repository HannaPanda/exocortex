import { defineFeature, type RegisteredFeature } from '../feature.js';

/** Databases, the inbox, and everything that arrives as a file. */
export const DATA_FEATURES: readonly RegisteredFeature[] = [
  defineFeature({
    id: 'datenbanken',
    area: 'datenbanken',
    title: 'Datenbanken mit Zeilen, die richtige Seiten sind',
    summary:
      'Eine Datenbank ist eine Seite, deren Kinder die Zeilen sind. Jede Zeile ist damit eine vollwertige Seite: sie kann Inhalt haben, verlinkt werden und selbst Unterseiten tragen, statt nur ein Eintrag in einer Tabelle zu sein.',
    details: [
      'Du legst eine neue Seite an und wählst "Datenbank". Die Seite zeigt dann eine Tabelle statt Fließtext, und jede Zeile darin ist wieder eine Seite, die unter ihr hängt. Klickst du eine Zeile an, öffnet sich eine Seite mit Editor, Kommentaren, Verlauf und allem anderen.',
      'Das ist der Unterschied zu einer Tabelle in einem Textdokument: eine Zeile "Vertrag Meier" kann den Vertragstext enthalten, auf die Entität Meier verweisen, selbst Unterseiten für die Korrespondenz tragen und aus jeder anderen Seite heraus verlinkt werden. Eine Aufgabenliste, ein Lesestapel, ein Ausgabenbuch, eine Kontaktliste: alles dasselbe Prinzip.',
      'Weil Zeilen Seiten sind, gilt für sie alles, was für Seiten gilt: Suche, Rechte, Papierkorb, Schnappschüsse, Automationen. Und weil Agenten dieselben Werkzeuge haben, kann ein Agent Zeilen anlegen und ändern, ohne dass es dafür einen zweiten Weg in die Daten bräuchte.',
    ],
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
      'Eine Datenbank bekommt Spalten vom Typ Text, Zahl, Auswahl, Mehrfachauswahl, Datum, Kontrollkästchen, Adresse, E-Mail, Telefon, Person und Dateien. Dazu kommen vier Spalten, die sich selbst füllen: angelegt am, geändert am, angelegt von, geändert von. Ein Datum darf ein Zeitraum sein. Verknüpfung, Rollup und Formel stehen als eigener Eintrag daneben.',
    details: [
      'Über den Spaltenkopf legst du eine Spalte an, benennst sie um, änderst ihren Typ oder wirfst sie weg; Ziehen sortiert die Spalten um. Bei Auswahl und Mehrfachauswahl gehören die möglichen Werte zur Spalte, mit eigener Farbe, sodass ein Status im Board sofort erkennbar ist.',
      'Ein Datum kann ein einzelner Tag, ein Tag mit Uhrzeit oder ein Zeitraum mit Anfang und Ende sein. Das ist die Spalte, an der später die Kalenderansicht und die Erinnerungen hängen. Eine Personen-Spalte verweist auf Mitglieder des Arbeitsbereichs, eine Dateien-Spalte nimmt Anhänge direkt in der Zeile auf.',
      'Vier Spalten füllen sich von selbst und lassen sich nicht von Hand ändern: angelegt am, geändert am, angelegt von, geändert von. Sie sind vor allem als Sortierung nützlich, etwa "was habe ich zuletzt angefasst", ohne dass jemand ein Datum pflegen muss.',
    ],
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
    id: 'datenbank-verknuepfungen',
    area: 'datenbanken',
    title: 'Verknüpfung, Rollup und Formel',
    summary:
      'Eine Spalte kann auf Zeilen einer anderen Datenbank zeigen (Verknüpfung), über diese Zeilen rechnen (Rollup: Anzahl, Summe, Durchschnitt, kleinster und größter Wert, frühestes und spätestes Datum) oder aus den eigenen Spalten einen Wert berechnen (Formel). Alle drei lassen sich filtern und sortieren wie jede andere Spalte.',
    details: [
      'Eine Verknüpfung zeigt auf eine Datenbank im selben Arbeitsbereich, auch auf sich selbst: so bekommt eine Aufgabe Unteraufgaben. In der Zelle wählst du Zeilen aus einer Liste, gespeichert werden nur deren Ids, nie Titel. Damit ein Projekt also weiß, welche Aufgaben zu ihm gehören, brauchst du keine zweite Tabelle, sondern eine Spalte.',
      'Ein Rollup rechnet über die verknüpften Zeilen: „wie viele Aufgaben hat dieses Projekt", „was kosten sie zusammen", „wann ist der erste Termin". Du wählst die Verknüpfungsspalte, die Berechnung und die Spalte in der verknüpften Datenbank. Eine leere Summe ist 0, ein fehlendes frühestes Datum bleibt leer, und eine Zeile im Papierkorb zählt nicht mit, kommt beim Wiederherstellen aber zurück.',
      'Eine Formel schreibst du als kleinen Ausdruck: prop("Budget") - prop("Ausgegeben"), oder if(prop("Rest") < 0; "überzogen"; "im Rahmen"). Es gibt Zahlen, Text, Ja/Nein und Datum, die üblichen Rechen- und Vergleichszeichen und rund zwanzig Funktionen. Eine Formel darf eine andere Formel und ein Rollup lesen; ein Kreis wird abgelehnt, nicht gerechnet.',
      'Rollup und Formel werden bei jedem Lesen frisch berechnet und nirgends gespeichert, können also nicht veralten. Beschreiben lässt sich eine solche Zelle nicht: du änderst die verknüpften Zeilen oder die Formel selbst. Benennst du eine Spalte um, ziehen die Formeln mit, die sie beim Namen nennen; löschen lässt sich eine Spalte erst, wenn keine Formel und kein Rollup sie mehr braucht.',
    ],
    since: '2026-09-19',
    references: ['ADR-041'],
    ui: {
      where: 'In der Tabellenansicht „+ Eigenschaft", dann Verknüpfung, Rollup oder Formel wählen.',
    },
  }),
  defineFeature({
    id: 'datenbank-ansichten',
    area: 'datenbanken',
    title: 'Gespeicherte Ansichten: Tabelle, Board, Galerie, Kalender',
    summary:
      'Dieselben Daten lassen sich als Tabelle, Kanban-Board, Galerie oder Kalender zeigen, jeweils mit eigenem Filter, eigener Sortierung und eigenen sichtbaren Spalten. Die Ansichten werden gespeichert, sodass jede Frage ihre eigene Sicht bekommt.',
    details: [
      'Über der Datenbank liegt eine Reiterleiste. Jeder Reiter ist eine gespeicherte Ansicht mit eigenem Typ, eigenem Filter, eigener Sortierung und eigener Spaltenauswahl. "Alles", "Diese Woche fällig", "Nach Status", "Erledigt": vier Reiter auf denselben Zeilen, statt eines Filters, den du jedes Mal neu einstellst.',
      'Die Tabelle ist die Arbeitsansicht mit direktem Bearbeiten in der Zelle. Das Board gruppiert nach einer Auswahlspalte, und Ziehen zwischen den Spalten ändert den Wert. Die Galerie zeigt Karten mit Titelbild, gut für alles Visuelle. Der Kalender ordnet nach einer Datumsspalte.',
      'Eine Ansicht gehört zur Datenbank, nicht zu dir, also sehen alle Mitglieder dieselben Reiter. Ansichten lassen sich umsortieren, und ein Agent kann sie über die Werkzeuge anlegen und ändern, was praktisch ist, wenn eine Auswertung eine eigene Sicht braucht.',
    ],
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
    details: [
      'Du legst eine Ansicht vom Typ Kalender an und sagst, welche Datumsspalte sie benutzt. Danach wechselst du zwischen fünf Darstellungen: Tag und Woche mit Zeitachse, Monat als Raster, Jahr als Überblick und Liste als schlichte Aufzählung des Kommenden. Welche zuletzt gewählt war, merkt sich die Ansicht.',
      'In Tag und Woche liegen Termine mit Uhrzeit auf der Zeitachse, überlappende Termine nebeneinander, Ganztagstermine in einer eigenen Zeile darüber, und eine Linie zeigt die aktuelle Minute. Ein Zeitraum wird über seine ganze Länge gezeichnet, nicht nur an seinem Anfangstag.',
      'Sind Erinnerungen eingeschaltet, meldet sich eXocortex vor einem Termin, bei Ganztagsterminen zu einer festgelegten Stunde. Vorlaufzeit und Zeitzone sind Einstellungen. Das ist der eigentliche Grund für den Kalender hier: nicht Termine zu organisieren, sondern nicht zu vergessen, was du dir notiert hast.',
    ],
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
    details: [
      'Im Editor tippst du "/" und wählst die Einbettung, danach die Datenbank und die Ansicht, die dort erscheinen soll. Der Block zeigt dieselben Daten wie die Datenbank selbst, also keine Kopie: was du in der Einbettung änderst, ist sofort überall geändert.',
      'Nützlich ist das überall dort, wo ein Text und eine Liste zusammengehören. Auf einer Projektseite stehen die offenen Aufgaben dieses Projekts direkt unter der Beschreibung, gefiltert über die Ansicht, statt dass jemand zwischen zwei Seiten hin und her springt.',
      'Weil die Ansicht mitgewählt wird, kann dieselbe Datenbank an mehreren Stellen ganz unterschiedlich aussehen: hier als Board nach Status, dort als Liste der nächsten Termine.',
    ],
    since: '2026-08-05',
    ui: { where: 'Im Editor "/" tippen und Datenbank einbetten wählen.' },
  }),
  defineFeature({
    id: 'eingang',
    area: 'erfassen',
    title: 'Eingang und Schnellerfassung',
    summary:
      'Strg+E öffnet ein kleines Feld, in das ein Gedanke sofort hineingeht, ohne dass du entscheiden musst, wohin er gehört. Er landet auf der Eingangsseite, und einsortiert wird später mit dem Ablagevorschlag.',
    details: [
      'Strg+E öffnet ein Feld über dem, was du gerade tust, du tippst und drückst Eingabe. Die Frage, wo das hingehört, wird dabei bewusst nicht gestellt: sie ist der Grund, warum Notizen ungeschrieben bleiben. Das Erfasste wird eine Seite unter dem Eingang, mit der ersten Zeile als Titel.',
      'Der Eingang ist selbst eine ganz normale Seite, erkennbar an einer Markierung, nicht an ihrem Titel. Sie entsteht bei der ersten Erfassung von selbst, du kannst sie umbenennen, verschieben und ihr ein Symbol geben, und es gibt genau eine pro Arbeitsbereich.',
      'Aufgeräumt wird später und mit den vorhandenen Mitteln: Ablagevorschlag fragen, verschieben, fertig. Agenten erfassen über exo_capture und lesen den Eingang über exo_inbox, was aus einer Notiz im Chat eine Seite macht, ohne dass jemand einen Ort nennen muss.',
    ],
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
    details: [
      'Am Telefon installierst du eXocortex als App über das Browsermenü; danach steht es im Teilen-Menü neben den anderen Apps, und ein geteilter Artikel landet als Seite im Eingang. Am Rechner legst du dir ein Lesezeichen auf dieselbe Adresse; ein Klick darauf nimmt Adresse, Titel und markierten Text der Seite mit, auf der du gerade bist.',
      'Der Clip ist eine gewöhnliche Erfassung mit einer Herkunftszeile obendrüber, also eine normale Seite. Standardmäßig wird nur gespeichert, was der Browser mitgeschickt hat, das ist das Lesezeichen mit deiner Markierung. Willst du den vollständigen Artikel, schaltest du das beim Clippen dazu; dann wird die Seite abgerufen und ihr Text mit abgelegt.',
      'Für das Abrufen gilt dieselbe Adressprüfung wie für die Web-Recherche, interne Adressen werden also abgelehnt, auch nach einer Weiterleitung. Und exo_clip trägt dieselbe Sperre wie gelesene Webinhalte, damit ein Lauf nicht erst clippt und den fremden Text danach an der Sperre vorbei zurückliest.',
    ],
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
    details: [
      'Du ziehst eine Datei in den Editor oder fügst sie über das Schrägstrich-Menü ein. Je nach Art wird sie passend dargestellt: Bilder als Bild, Video und Audio mit Abspieler, PDFs im eingebauten Betrachter, alles andere als Anhang mit Namen und Größe.',
      'Die Datei liegt im Objektspeicher dieser Installation. Nichts geht zu einem Fremdanbieter, und die Sicherung deckt sie mit ab. Bilder werden beim Hochladen verkleinert, damit eine Seite mit dreißig Fotos nicht minutenlang lädt.',
      'Welche Art Datei es ist, wird am Inhalt erkannt und nicht an der Endung, weil eine Endung nur eine Behauptung ist. Löschst du eine Seite endgültig, verschwinden ihre Anhänge mit, auch aus dem Speicher.',
    ],
    since: '2026-08-05',
    ui: { where: 'Datei in den Editor ziehen.' },
    tools: ['exo_attachment_upload'],
  }),
  defineFeature({
    id: 'texterkennung',
    area: 'dateien',
    title: 'Text aus PDFs, auch aus gescannten',
    summary:
      'Aus einem hochgeladenen PDF wird der Text herausgelesen, bei Scans lokal über Docling und notfalls über ein Modell. Der Text ist lesbar und von Hand korrigierbar, und eine Chipzeile am PDF zeigt Titel, Autor und Seitenzahl aus den Metadaten der Datei.',
    details: [
      'Lädst du ein PDF hoch, läuft die Texterkennung im Hintergrund an; du kannst weiterarbeiten. Zuerst versucht es Docling lokal auf diesem Server, das auch mit Scans und mit mehrspaltigem Satz zurechtkommt. Erst wenn das scheitert und die Rückfallebene eingeschaltet ist, geht die Datei an ein Modell.',
      'Unter dem PDF-Block liegt eine Leiste, über die du den erkannten Text liest, die Erkennung neu anstößt oder den Text von Hand korrigierst, wenn ein Scan Unsinn ergeben hat. Dass der Text auch in der Suche auftaucht, steht unter „Anhänge mitdurchsuchen".',
      'Eine Chipzeile am Block zeigt Titel, Autor und Seitenzahl aus den Metadaten der Datei. Die kommen von einem eigenen, lokalen Leser, weil keine der Erkennungsengines beides zugleich liefert. Wie groß eine Datei sein darf und ob die Erkennung überhaupt läuft, sind Einstellungen.',
    ],
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
  defineFeature({
    id: 'office-dateien-lesen',
    area: 'dateien',
    title: 'Text aus Word, Excel, PowerPoint und Co.',
    summary:
      'Lädst du ein Word-, Excel-, PowerPoint-, OpenDocument-, RTF-, EPUB- oder CSV-Dokument hoch, wird sein Text genauso herausgelesen wie bei einem PDF: du kannst ihn lesen, korrigieren, durchsuchen und der KI zeigen.',
    details: [
      'Zwölf Formate insgesamt, die alten .doc, .xls und .ppt eingeschlossen. Das Umwandeln passiert vollständig auf diesem Server, in Millisekunden und ohne Modellkosten; es geht nichts nach außen. Tabellen bleiben Tabellen, Überschriften bleiben Überschriften.',
      'Unter dem Dateiblock liegt dieselbe Leiste wie beim PDF: Text ansehen, neu einlesen, von Hand korrigieren. Ist eine Datei passwortgeschützt oder beschädigt, steht genau das da, statt dass es still im Hintergrund scheitert.',
      'Woran eine Datei erkannt wird, ist ihr Inhalt und nicht ihre Endung. Das war hier nötig, weil ein docx innen ein ZIP-Archiv ist: ohne einen Blick hinein wäre es als Archiv gelandet und hätte nie eine Texterkennung angeboten bekommen.',
    ],
    since: '2026-09-20',
    ui: { where: 'Die Leiste unter einem Dateiblock.' },
    settings: ['ai.officeExtractionEnabled', 'ai.officeMaxBytes'],
    tools: [
      'exo_attachment_read_text',
      'exo_attachment_reextract_text',
      'exo_attachment_correct_text',
    ],
  }),
  defineFeature({
    id: 'anhaenge-mitdurchsuchen',
    area: 'suche',
    title: 'Anhänge mitdurchsuchen',
    summary:
      'Die Suche findet eine Seite auch über einen Satz, der nur in einem angehängten PDF oder Office-Dokument steht, nicht bloß über den Dateinamen.',
    details: [
      'Sobald der Text einer Datei herausgelesen ist, wird er Teil dessen, was die Suche über die Seite weiß. Du suchst also nach einer Formulierung aus einem Kontoauszug und landest auf der Seite, an der er hängt.',
      'Hast du den erkannten Text von Hand korrigiert, sucht die Suche in deiner Fassung und nicht in dem, was die Maschine gelesen hatte. Wer einen verhunzten Scan repariert, repariert ihn damit auch für das Wiederfinden.',
      'Hochgeladene Dateien von vor dem 20. September 2026 werden nachgetragen: ein Aufräumlauf reicht sie nach und hört von selbst wieder auf, sobald alle drin sind.',
    ],
    since: '2026-09-20',
    ui: { where: 'Das Suchfeld oben, und Strg+K.' },
  }),
];
