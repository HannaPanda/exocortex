import { type SettingKey } from '@exocortex/contracts';

/**
 * What every setting is called and what it does, in the words of somebody who
 * has to decide about it.
 *
 * Its own file because it is data, not a component: the form beside it stayed
 * readable while this table grew past four hundred lines, and the two have
 * nothing to say to each other beyond the key.
 */
export const GROUP_LABELS: Record<string, string> = {
  ai: 'KI',
  memory: 'Gedächtnis',
  entities: 'Entitäten',
  search: 'Suche',
  mcp: 'MCP',
  calendar: 'Kalender',
  notifications: 'Benachrichtigungen',
  activity: 'Aktivität',
  automations: 'Automationen',
  overview: 'Übersichtsseiten',
  render: 'Veröffentlichen',
  projects: 'Projekte',
  agents: 'Agenten',
};

/** German label and help text for every setting key. Written in the same voice. */
export const SETTING_COPY: Record<SettingKey, { label: string; help: string }> = {
  'ai.enabled': {
    label: 'KI aktiviert',
    help: 'Schaltet die eingebaute KI für diese Installation vollständig ein oder aus.',
  },
  'ai.defaultModelSlug': {
    label: 'Standardmodell',
    help: 'Wird verwendet, wenn eine Anfrage kein eigenes Modell angibt.',
  },
  'ai.systemPrompt': {
    label: 'Basis-Systemprompt',
    help: 'Wird jedem Lauf vorangestellt, noch vor etwaigen KI-Regelseiten.',
  },
  'ai.maxOutputTokens': {
    label: 'Maximale Antwortlänge (Tokens)',
    help: 'Obergrenze für die Länge einer einzelnen KI-Antwort.',
  },
  'ai.timeoutMs': {
    label: 'Zeitlimit pro Modellantwort (ms)',
    help: 'Bricht eine einzelne Antwort des Modells ab. Werkzeugaufrufe und Folgeantworten haben ihre eigene Zeit, siehe „Gesamtzeit pro Lauf".',
  },
  'ai.maxRunMs': {
    label: 'Gesamtzeit pro Lauf (ms)',
    help: 'Nach dieser Zeit endet ein Lauf insgesamt, auch wenn er noch Werkzeuge aufruft. Kann nie kürzer sein als das Zeitlimit pro Modellantwort.',
  },
  'ai.budgetMicroUsdPerRun': {
    label: 'Kostenlimit pro Anfrage (µUSD)',
    help: 'Ein Lauf stoppt, sobald dieses Kostenlimit erreicht ist.',
  },
  'ai.toolsEnabled': {
    label: 'Werkzeuge erlauben',
    help: 'Erlaubt der KI, Werkzeuge wie Suche oder Seiten lesen aufzurufen.',
  },
  'ai.mutatingToolsEnabled': {
    label: 'Schreibende Werkzeuge erlauben',
    help: 'Erlaubt der KI zusätzlich, Daten zu verändern statt sie nur zu lesen.',
  },
  'ai.untrustedContentPolicy': {
    label: 'Schreiben nach Fremdinhalten',
    help: 'Texte aus hochgeladenen Dokumenten und aus Bildbeschreibungen können Anweisungen an die KI enthalten, die niemand hier geschrieben hat. Standardmäßig darf ein Lauf nach dem Lesen solcher Inhalte nichts mehr verändern; er sagt dann, was er geschrieben hätte. „Immer erlaubt“ braucht man nur für Abläufe, die fremde Dokumente lesen und daraus selbst schreiben sollen.',
  },
  'ai.maxToolIterations': {
    label: 'Maximale Werkzeugdurchläufe',
    help: 'Obergrenze für Werkzeugaufrufe innerhalb eines Laufs.',
  },
  'ai.visionEnabled': {
    label: 'Bildbeschreibung aktivieren',
    help: 'Lässt ein Sichtmodell Bilder beschreiben, bevor das Hauptmodell antwortet.',
  },
  'ai.visionMaxImagesPerRun': {
    label: 'Bilder pro Anfrage',
    help: 'Obergrenze für die Anzahl beschriebener Bilder je Lauf.',
  },
  'ai.pageContextEnabled': {
    label: 'Text der geöffneten Seite mitschicken',
    help: 'Aus: Die KI erfährt nur Titel und Pfad der offenen Seite und lädt den Text selbst, wenn eine Frage ihn braucht. An: Der Text geht bei jeder Frage mit, auch wenn sie nichts damit zu tun hat. Nötig für Modelle ohne Werkzeuge, sonst zusätzlicher Datenabfluss zum Anbieter.',
  },
  'ai.pageContextMaxChars': {
    label: 'Zeichen der geöffneten Seite',
    help: 'Obergrenze für den mitgeschickten Seitentext. Was darüber liegt, wird gekürzt, und die Kürzung steht sichtbar im Text.',
  },
  'ai.maxPinnedSources': {
    label: 'Angeheftete Quellen je Unterhaltung',
    help: 'Wie viele Seiten, Datenbankansichten und gespeicherte Suchen an eine Unterhaltung geheftet werden dürfen. Null schaltet das Anheften für diesen Arbeitsbereich ab.',
  },
  'ai.pinnedContextMaxChars': {
    label: 'Zeichen aller eingebetteten Quellen',
    help: 'Obergrenze für alle angehefteten Quellen zusammen, die ihren Text mitschicken. Das Budget wird gleichmäßig auf sie aufgeteilt, und jede Kürzung steht sichtbar im Text.',
  },
  'ai.compactionThresholdPercent': {
    label: 'Zusammenfassen ab (% des Kontextfensters)',
    help: 'Ab diesem Füllstand werden ältere Nachrichten zu einer Zusammenfassung verdichtet.',
  },
  'ai.compactionKeepRecentMessages': {
    label: 'Letzte Nachrichten behalten',
    help: 'So viele der jüngsten Nachrichten bleiben von einer Zusammenfassung unberührt.',
  },
  'ai.compactionModelSlug': {
    label: 'Modell für Zusammenfassungen',
    help: 'Automatisch verwendet dasselbe Modell wie die Unterhaltung.',
  },
  'ai.runPayloadRetentionDays': {
    label: 'KI-Texte aufbewahren (Tage)',
    help: 'Bei älteren KI-Läufen werden Frage und Antwort geleert, die Zahlen für die Nutzungsansicht bleiben stehen. 0 bedeutet: nie aufräumen. Verläufe in Unterhaltungen bleiben davon unberührt.',
  },
  'ai.pdfExtractionEnabled': {
    label: 'PDF-Text extrahieren',
    help: 'Extrahiert den Text aus hochgeladenen PDF-Dateien, damit die KI ihn lesen kann.',
  },
  'ai.pdfExtractor': {
    label: 'PDF-Verfahren',
    help: 'Docling läuft lokal, kostet nichts pro Dokument und liest auch Scans per Texterkennung. OpenRouter braucht keinen eigenen Dienst, wird aber pro Seite abgerechnet und kann keine Scans lesen. Titel, Autor und Datum werden in beiden Fällen direkt aus der Datei gelesen.',
  },
  'ai.pdfExtractorFallbackEnabled': {
    label: 'Zweites Verfahren als Rückfallebene',
    help: 'Findet oder erreicht das gewählte Verfahren nichts, versucht es das jeweils andere. Wirkungslos, wenn nur eines von beiden eingerichtet ist.',
  },
  'ai.pdfExtractionModelSlug': {
    label: 'Modell für PDF-Text',
    help: 'Automatisch verwendet das Standardmodell.',
  },
  'ai.pdfMaxBytes': {
    label: 'Maximale PDF-Größe (Bytes)',
    help: 'PDFs über dieser Größe werden nicht für die Textextraktion angenommen.',
  },
  'ai.officeExtractionEnabled': {
    label: 'Text aus Office-Dateien lesen',
    help: 'Liest Word, Excel, PowerPoint, OpenDocument, RTF, EPUB und CSV direkt auf diesem Server aus, ohne Container und ohne Modellkosten.',
  },
  'ai.officeMaxBytes': {
    label: 'Maximale Office-Dateigröße (Bytes)',
    help: 'Office-Dateien über dieser Größe werden nicht für die Textextraktion angenommen.',
  },
  'ai.imageGenerationEnabled': {
    label: 'Titelbilder erzeugen',
    help: 'Erlaubt es, das Titelbild einer Seite von der KI malen zu lassen. Jedes Bild ist ein kostenpflichtiger Aufruf.',
  },
  'ai.imageModelSlug': {
    label: 'Modell für Bilder',
    help: 'Ein Modell, das Bilder ausgeben kann, zum Beispiel google/gemini-2.5-flash-image. Ohne Eintrag bleibt die Bilderzeugung aus, auch wenn der Schalter darüber an ist.',
  },
  'ai.webResearchEnabled': {
    label: 'Im Web recherchieren',
    help: 'Erlaubt der KI, im Web zu suchen und einzelne Seiten zu lesen. Aus, solange es niemand einschaltet: dabei gehen Anfragen von diesem Server an Adressen, die das Modell aussucht. Eine gelesene Seite gilt als Fremdinhalt, danach greift „Schreiben nach Fremdinhalten“.',
  },
  'ai.webResearchMaxChars': {
    label: 'Zeichen je geholter Seite',
    help: 'Obergrenze für den Text einer einzelnen Webseite. Was darüber liegt, wird gekürzt, und die Kürzung steht sichtbar im Text.',
  },
  'ai.webResearchMaxFetchesPerRun': {
    label: 'Seiten pro Anfrage',
    help: 'So viele Webseiten darf ein einzelner Lauf holen. 0 schaltet das Holen aus und lässt das Suchen stehen.',
  },
  'ai.webSearchMaxResults': {
    label: 'Treffer je Suche',
    help: 'Obergrenze für die Trefferliste einer Websuche.',
  },
  'memory.enabled': {
    label: 'Gedächtnis aktiviert',
    help: 'Erlaubt Agenten, Sitzungen mitzuschreiben und Erinnerungen abzulegen. Aus: es wird nichts mehr geschrieben, gelesen werden kann weiter.',
  },
  'memory.captureModelSlug': {
    label: 'Modell fürs Verdichten',
    help: 'Fasst eine beendete Sitzung zu wenigen Stichpunkten zusammen. Ohne Eintrag wird das Modell für die Verdichtung von Verläufen genommen, sonst das Standardmodell.',
  },
  'memory.captureMinChars': {
    label: 'Kürzeste Sitzung (Zeichen)',
    help: 'Kürzere Sitzungen werden gar nicht erst angenommen. Kleinkram im Gedächtnis verschlechtert das Wiederfinden.',
  },
  'memory.recallMaxChars': {
    label: 'Obergrenze pro Abruf (Zeichen)',
    help: 'So viel Text darf ein Abruf höchstens zurückgeben. Ein Gedächtnis, das den Kontext auffrisst, den es verbessern soll, hilft nicht.',
  },
  'memory.recallMaxResults': {
    label: 'Obergrenze pro Abruf (Treffer)',
    help: 'Wie viele Erinnerungen ein Abruf höchstens zurückgibt, egal wonach gefragt wurde.',
  },
  'memory.retentionDays': {
    label: 'Notizen aufbewahren (Tage)',
    help: 'Ältere Sitzungsnotizen werden im Gedächtnis-Arbeitsbereich gelöscht. 0 bedeutet: nie aufräumen. Projektseiten bleiben immer stehen, andere Arbeitsbereiche werden nie angefasst.',
  },
  'memory.consolidationEnabled': {
    label: 'Erinnerungen verdichten',
    help: 'Fasst nachts wiederkehrende Aussagen aus den Sitzungsnotizen zu Fakten zusammen, die ein Abruf voranstellt. Kostet einen Modellaufruf je Projekt und Nacht. Aus: es bleibt beim reinen Mitschrieb.',
  },
  'memory.consolidationModelSlug': {
    label: 'Modell fürs Verdichten zu Fakten',
    help: 'Urteilt, ob eine Notiz einen bekannten Fakt bestätigt, ersetzt oder ihm widerspricht. Ohne Eintrag wird das Modell fürs Verdichten von Sitzungen genommen.',
  },
  'memory.consolidationProjectsPerRun': {
    label: 'Projekte je Durchlauf',
    help: 'Wie viele Projekte eine Nacht abarbeitet. Begrenzt, was ein Durchlauf höchstens kostet; der Rest kommt in der nächsten Nacht dran.',
  },
  'memory.consolidationNotesPerProject': {
    label: 'Notizen je Projekt',
    help: 'Wie viele noch ungelesene Notizen ein Projektdurchlauf dem Modell vorlegt.',
  },
  'memory.factHalfLifeDays': {
    label: 'Halbwertszeit eines Fakts (Tage)',
    help: 'Ein Fakt, den niemand mehr bestätigt, verliert über diese Spanne die Hälfte seines Gewichts, dann wieder die Hälfte. Er verschwindet nicht, er wird leiser. 0 schaltet den Verfall ab.',
  },
  'memory.factConfidenceFloor': {
    label: 'Untere Schwelle für Fakten',
    help: 'Unter diesem Gewicht gilt ein Fakt nicht mehr als aktuell und wandert in den Papierkorb. Zwischen 0 und 1.',
  },
  'memory.recallFactLimit': {
    label: 'Fakten vor der Trefferliste',
    help: 'Wie viele verdichtete Fakten ein Abruf dem Rest voranstellt. 0 stellt keine voran.',
  },
  'memory.mailboxEnabled': {
    label: 'Postfach zwischen Agenten',
    help: 'Agenten können einander Nachrichten hinterlassen, die beim nächsten Sitzungsstart des Empfängers zuoberst stehen. Aus: Senden wird abgelehnt, und ein Abruf trägt keine Post mehr.',
  },
  'memory.messageExpiryDays': {
    label: 'Nachrichten verfallen nach',
    help: 'Nach wie vielen Tagen eine Nachricht nicht mehr zugestellt wird, wenn der Absender nichts anderes angibt. Ohne Verfall würde das Postfach zur Halde.',
  },
  'memory.recallMessageLimit': {
    label: 'Nachrichten vor der Trefferliste',
    help: 'Wie viele ungelesene Nachrichten ein Abruf allem anderen voranstellt. 0 lässt Post aus Abrufen heraus; lesbar bleibt sie über das Werkzeug.',
  },
  'entities.enabled': {
    label: 'Entitäten aktiviert',
    help: 'Erfasst beim Speichern einer Seite, über welche bekannten Personen, Hosts, Dienste oder Projekte sie spricht. Aus: es wird nichts erfasst, vorhandene Verknüpfungen bleiben lesbar.',
  },
  'entities.databaseId': {
    label: 'Datenbank der Entitäten',
    help: 'Die Id der Datenbank, deren Zeilen die Entitäten sind. Sie steht in der Adresszeile hinter /seite/. Ohne Eintrag gibt es keine Namen, nach denen gesucht werden könnte. Eine je Installation: eine Entität ist ein Ding in der Welt und soll nicht in jedem Arbeitsbereich neu erfunden werden.',
  },
  'entities.minAliasLength': {
    label: 'Kürzester Aliasname (Zeichen)',
    help: 'Kürzere Namen werden beim Abgleich übersprungen. Ein Name aus zwei Buchstaben steckt in jeder zweiten Seite, und das Ergebnis sieht aus wie ein Defekt.',
  },
  'entities.maxMentionsPerDocument': {
    label: 'Entitäten je Seite',
    help: 'Mit wie vielen Entitäten eine einzelne Seite höchstens verknüpft wird. Begrenzt, was eine Glossarseite anrichtet, auf der jeder Name einmal vorkommt.',
  },
  'entities.candidatesEnabled': {
    label: 'Neue Namen vorschlagen',
    help: 'Sammelt Namen, die wiederholt vorkommen und zu denen es noch keine Entität gibt. Angelegt wird nichts von allein, nur vorgeschlagen. Aus: es bleibt bei der gepflegten Liste.',
  },
  'entities.candidateThreshold': {
    label: 'Schwelle für einen Vorschlag (Seiten)',
    help: 'Auf so vielen verschiedenen Seiten muss ein Name stehen, bevor er als Vorschlag auftaucht. Eine Seite, die einen Namen einmal nennt, ist kein Beleg.',
  },
  'entities.recallProfileEnabled': {
    label: 'Profil beim Abruf voranstellen',
    help: 'Erkennt ein Abruf einen Entitätsnamen in der Frage, kommt zuerst das Profil und danach erst die Treffer. Das ist der eigentliche Zweck der Entitäten; es kostet eine zusätzliche Abfrage je Abruf.',
  },
  'search.semanticEnabled': {
    label: 'Semantische Suche',
    help: 'Sucht zusätzlich nach Bedeutung statt nur nach Wörtern, damit eine Seite auch dann auftaucht, wenn niemand mehr weiß, wie sie formuliert war. Jede indexierte Seite wird dafür einmal von einem Modell in einen Vektor übersetzt, das kostet ein paar Cent pro Arbeitsbereich.',
  },
  'search.embeddingModelSlug': {
    label: 'Modell für Vektoren',
    help: 'Muss 1536 Dimensionen liefern, so breit ist die Spalte. openai/text-embedding-3-small tut das von sich aus, openai/text-embedding-3-large kürzt auf Wunsch darauf. Ein Modell mit anderer Länge wird abgelehnt statt falsch gespeichert.',
  },
  'search.semanticWeightPercent': {
    label: 'Gewicht der Bedeutung (%)',
    help: 'Wie stark die semantische Trefferliste gegenüber der Volltextliste zählt. 0 ist reiner Volltext, 100 ist reine Bedeutung, 50 wiegt beides gleich.',
  },
  'mcp.enabled': {
    label: 'MCP-Server aktiviert',
    help: 'Erlaubt externen Programmen wie dem MCP-Server den Zugriff auf diese Installation.',
  },
  'mcp.maxSearchResults': {
    label: 'Maximale Suchtreffer',
    help: 'Obergrenze für die Anzahl Ergebnisse einer MCP-Suche.',
  },
  'mcp.writeConfirmationRequired': {
    label: 'Jeden Schreibzugriff bestätigen lassen',
    help: 'Aus: Nur was nichts rückgängig macht (Seite endgültig löschen, Datenbankspalte, Kommentar, Konto) verlangt eine zweistufige Bestätigung; alles andere schützt der Snapshot vor jedem Schreibvorgang. An: Jedes MCP-Werkzeug, das Daten verändert, muss zweimal identisch aufgerufen werden. Das bremst Agenten spürbar aus.',
  },
  'calendar.remindersEnabled': {
    label: 'Terminerinnerungen senden',
    help: 'Schickt vor einem gespiegelten Termin eine Nachricht. Braucht zusätzlich einen eingerichteten Versandweg auf dem Server.',
  },
  'calendar.reminderLeadMinutes': {
    label: 'Vorlauf in Minuten',
    help: 'Wie lange vor einem Termin mit Uhrzeit die Erinnerung rausgeht. 0 bedeutet genau zum Beginn.',
  },
  'calendar.reminderAllDayHour': {
    label: 'Uhrzeit für ganztägige Termine',
    help: 'Zu welcher Stunde ganztägige Termine wie Geburtstage angekündigt werden. Sie haben keine Startzeit, von der aus man zurückrechnen könnte.',
  },
  'calendar.timeZone': {
    label: 'Zeitzone',
    help: 'In welcher Zone die beiden Angaben darüber gelesen werden, zum Beispiel Europe/Berlin.',
  },
  'notifications.digestHour': {
    label: 'Uhrzeit der Tageszusammenfassung',
    help: 'Zu welcher Stunde die tägliche Kommentar-Zusammenfassung rausgeht, für alle, die sie eingeschaltet haben. Morgens, weil so eine Mail einmal gelesen und nicht sofort beantwortet werden soll.',
  },
  'notifications.digestTimeZone': {
    label: 'Zeitzone der Zusammenfassung',
    help: 'In welcher Zone die Uhrzeit darüber gelesen wird, zum Beispiel Europe/Berlin. Bewusst eine eigene Angabe statt der Zeit des Servers, der in UTC läuft.',
  },
  'notifications.commentMailDebounceMinutes': {
    label: 'Sammelzeit für sofortige Kommentar-Mails (Minuten)',
    help: 'Wie lange auf weitere Kommentare gewartet wird, bevor eine sofortige Mail rausgeht. So wird aus vier Antworten in einem Faden eine Mail statt vier. 0 bedeutet: ohne Warten.',
  },
  'activity.editSessionSnapshotsEnabled': {
    label: 'Bearbeitungssitzungen aufzeichnen',
    help: 'Sichert eine aktiv bearbeitete Seite in regelmäßigen Abständen, damit der Aktivitäts-Reiter echte Zeitspannen zeigen kann ("14:20 bis 14:45 bearbeitet") statt nur des letzten Standes. Aus: es entstehen keine zusätzlichen Sicherungen.',
  },
  'activity.editSessionSnapshotIntervalMinutes': {
    label: 'Abstand zwischen Sitzungs-Sicherungen (Minuten)',
    help: 'So oft darf eine aktiv bearbeitete Seite höchstens neu gesichert werden. Wirkt nur, wenn die Zeile darüber an ist.',
  },
  'activity.snapshotRetentionFullDays': {
    label: 'Volle Aufbewahrung (Tage)',
    help: 'So lange bleiben alle Sicherungen einer Seite erhalten, unabhängig vom Grund.',
  },
  'activity.snapshotRetentionDailyDays': {
    label: 'Tägliche Ausdünnung bis (Tage)',
    help: 'Zwischen der vollen Aufbewahrung und diesem Alter bleibt höchstens eine Sicherung pro Kalendertag übrig, danach höchstens eine pro Woche. Manuell benannte Sicherungen sind davon ausgenommen.',
  },
  'activity.snapshotRetentionDryRun': {
    label: 'Ausdünnung nur simulieren (Trockenlauf)',
    help: 'An: die tägliche Aufräumung berechnet und protokolliert, was sie löschen würde, löscht aber nichts. Vor dem ersten scharfen Lauf empfohlen; danach bewusst ausschalten.',
  },
  'agents.journalRetentionDays': {
    label: 'Agenten-Sitzungen aufbewahren (Tage)',
    help: 'So lange bleibt im Bereich „Agenten“ nachvollziehbar, welche Sitzung was geschrieben hat, und so lange lässt sich eine Sitzung am Stück zurücknehmen. Danach verschwindet nur die Zuordnung; die gesicherten Stände der Seiten bleiben davon unberührt. 0 bedeutet: für immer.',
  },
  'agents.largePageChars': {
    label: 'Seite gilt ab (Zeichen) als groß',
    help: 'Schreibt ein Agent auf eine Seite, die danach länger ist als das, nennt die Antwort die neue Größe und die größten Abschnitte und schlägt für ein neues Thema eine Unterseite vor. Abgelehnt wird nichts. Gedacht gegen Seiten, auf denen mit der Zeit alles landet, weil kein Agent sie je ganz sieht.',
  },
  'agents.oversizedPageChars': {
    label: 'Agenten hängen nichts mehr an ab (Zeichen)',
    help: 'Darüber lehnt eine Agentenanfrage ab, die die Seite noch größer machen würde, und nennt die größten Abschnitte samt dem Werkzeug, das einen davon auf eine eigene Seite verschiebt. Kleiner schreiben, umschreiben und einzelne Abschnitte ändern bleiben erlaubt, sonst wäre eine zu große Seite nicht mehr zu reparieren. Der Editor, Web Clipper, Importe und das Agentengedächtnis sind ausgenommen.',
  },
  'automations.enabled': {
    label: 'Automationen aktiviert',
    help: 'Der Hauptschalter für Regeln, die auf Änderungen an Seiten reagieren. Standardmäßig aus: eine Automation schickt Daten nach außen oder gibt Geld für ein Modell aus, und das soll nicht durch eine Aktualisierung anfangen. Ein Arbeitsbereich darf sie für sich abschalten, aber nicht gegen diese Einstellung wieder einschalten.',
  },
  'automations.webhookAllowedHosts': {
    label: 'Erlaubte Webhook-Hosts',
    help: 'Kommagetrennt, ohne Schema und Port (etwa „hooks.example.org, 127.0.0.1“). Ein Unterbereich zählt mit. Leer bedeutet: keine Webhook-Regel kann angelegt werden und keine bestehende läuft. Geprüft wird beim Speichern und noch einmal beim Auslösen, damit ein Kürzen dieser Liste auch die Regeln stoppt, die es schon gibt.',
  },
  'automations.maxConsecutiveFailures': {
    label: 'Fehlschläge bis zur Selbstabschaltung',
    help: 'So oft darf eine Regel hintereinander scheitern, bevor sie sich selbst abschaltet. Eine Regel, die ins Leere zeigt, wird durch Wiederholen nicht besser, sie füllt nur das Protokoll.',
  },
  'automations.webhookTimeoutSeconds': {
    label: 'Zeitlimit für einen Webhook (Sekunden)',
    help: 'So lange darf der empfangende Server brauchen. Danach gilt der Lauf als fehlgeschlagen.',
  },
  'automations.runRetentionDays': {
    label: 'Lauf-Protokoll aufbewahren (Tage)',
    help: 'So lange bleibt sichtbar, was die Automationen getan haben. Die Regeln selbst bleiben unberührt. 0 bedeutet: für immer.',
  },
  'overview.enabled': {
    label: 'Übersichtsseiten pflegen',
    help: 'Ob für Seiten, die als Übersicht markiert sind, ein Vorspann und Steckbriefe erzeugt werden. Die Liste der Unterseiten steht unabhängig davon immer da, sie kostet nichts. Aus bedeutet: Navigation ohne Modellaufrufe. Ein Arbeitsbereich darf das für sich abschalten, aber nicht gegen diese Einstellung wieder einschalten.',
  },
  'overview.modelSlug': {
    label: 'Modell für Übersichten',
    help: 'Leer verwendet das Standardmodell. Hier lohnt ein kleines Modell: es geht jedes Mal um zwei bis fünf Sätze, dafür oft.',
  },
  'overview.debounceSeconds': {
    label: 'Ruhezeit vor dem Neuschreiben (Sekunden)',
    help: 'So lange muss es um eine Seite still sein, bevor die Übersicht darüber neu geschrieben wird. Deutlich länger als bei Automationen: auf einen Vorspann wartet niemand, und ein Nachmittag Arbeit an einer Seite soll einen Lauf kosten, nicht zwanzig.',
  },
  'overview.maxChildren': {
    label: 'Unterseiten je Vorspann',
    help: 'Ab wie vielen Unterseiten kein Vorspann mehr erzeugt wird. Die Liste bleibt vollständig; nur der einordnende Absatz entfällt, weil er bei hundert Einträgen nichts mehr sagt, was die Liste nicht schon sagt.',
  },
  'overview.maxPageChars': {
    label: 'Zeichen je Seite für den Steckbrief',
    help: 'So viel Text einer Seite fließt in ihren Steckbrief ein. Der Anfang einer Seite sagt fast immer, worum es geht.',
  },
  'overview.generateCovers': {
    label: 'Titelbilder für Übersichtsseiten',
    help: 'Eine Übersichtsseite ohne Titelbild bekommt eines aus ihrem eigenen Vorspann gemalt, einmal. Braucht ein eingerichtetes Bildmodell, sonst passiert nichts. Ein von Hand entferntes Titelbild bleibt entfernt.',
  },
  'render.enabled': {
    label: 'PDF-Ausgabe aktiviert',
    help: 'Erlaubt, bestehende Seiten mit einer Vorlage als PDF zu erzeugen. Standardmäßig an: dabei verlassen keine Daten die Installation und es kostet kein Geld, nur Rechenzeit auf diesem Rechner. Ein Arbeitsbereich darf die Ausgabe für sich abschalten, aber nicht gegen diese Einstellung wieder einschalten.',
  },
  'render.image': {
    label: 'Container-Abbild für den Bau',
    help: 'Darin stecken Pandoc, TeX Live und die Schriften; auf dem Rechner selbst wird nichts installiert. Ein anderes Abbild ändert, worauf sich jede Vorlage verlassen kann, und wird von der Wiederverwendung fertiger PDFs nicht bemerkt: danach einmal mit „neu erzeugen“ bauen.',
  },
  'render.timeoutSeconds': {
    label: 'Zeitlimit für einen Bau (Sekunden)',
    help: 'Danach wird der Container abgebrochen. Ein LaTeX-Lauf, der nach drei Minuten nicht fertig ist, wartet meist auf eine Eingabe, die niemand machen kann.',
  },
  'render.maxArtifactBytes': {
    label: 'Größtes erzeugtes PDF (Bytes)',
    help: 'Obergrenze für die Datei, die ein Bau abliefern darf. Darüber gilt der Lauf als fehlgeschlagen, statt den Speicher zu füllen.',
  },
  'render.jobRetentionDays': {
    label: 'Bau-Protokoll aufbewahren (Tage)',
    help: 'So lange bleiben abgeschlossene Bauten samt Protokoll sichtbar. Die erzeugten PDFs bleiben als Anhänge erhalten. 0 bedeutet: für immer.',
  },
  'projects.enabled': {
    label: 'Projekte bauen',
    help: 'Ob dieser Arbeitsbereich seine LaTeX-Projekte übersetzen darf. Bearbeiten geht weiter, wenn das aus ist; nur der Übersetzer schweigt.',
  },
  'projects.image': {
    label: 'Container-Abbild für Projekt-Bauten',
    help: 'Darin stecken TeX Live, latexmk, biber und die Schriften. Ohne dieses Abbild schlägt jeder Bau mit einer klaren Meldung fehl.',
  },
  'projects.timeoutSeconds': {
    label: 'Zeitgrenze je Bau (Sekunden)',
    help: 'Danach wird der Container abgebrochen. Eine Abschlussarbeit mit Literaturverzeichnis braucht mehrere Durchläufe.',
  },
  'projects.maxArtifactBytes': {
    label: 'Größtes erzeugtes PDF (Bytes)',
    help: 'Ein größeres Ergebnis lässt den Bau scheitern, statt die Platte zu füllen.',
  },
  'projects.maxFileChars': {
    label: 'Größte Textdatei im Projekt (Zeichen)',
    help: 'Gilt je Datei, nicht für das ganze Projekt.',
  },
  'projects.maxFiles': {
    label: 'Dateien je Projekt',
    help: 'Pfade insgesamt, Anhänge eingerechnet.',
  },
  'projects.buildRetentionDays': {
    label: 'Bau-Protokolle aufbewahren (Tage)',
    help: 'So lange bleiben abgeschlossene Bauten samt Protokoll und Fehlerliste sichtbar. Die PDFs bleiben als Anhänge erhalten. 0 bedeutet: für immer.',
  },
};
