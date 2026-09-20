import { defineFeature, type RegisteredFeature } from '../feature.js';

/** Getting in, letting agents in, and running the deployment. */
export const PLATFORM_FEATURES: readonly RegisteredFeature[] = [
  defineFeature({
    id: 'funktionsuebersicht',
    area: 'hilfe',
    title: 'Diese Übersicht, und was seit deinem letzten Besuch dazukam',
    summary:
      'Die Seite, auf der du gerade bist: eine durchsuchbare Liste dessen, was eXocortex kann, in ganzen Sätzen statt als Endpunktliste. Was seit deinem letzten Besuch dazugekommen ist, steht oben und wird in der Navigation angezeigt, bis du es zur Kenntnis genommen hast.',
    details: [
      'Links stehen die Bereiche, rechts die Funktionen darin, jede mit einer ausführlichen Beschreibung: wie es funktioniert, wie du es benutzt und wo es aufhört. Die Suche oben durchsucht alle Bereiche auf einmal, über Titel, Beschreibung, Tastenkürzel, Werkzeugnamen und Einstellungsschlüssel.',
      'Das Problem, für das es die Seite gibt, ist nicht fehlende Dokumentation, sondern dass diese Installation schneller wächst als die Erinnerung an sie. Etwas wird gebaut, zweimal benutzt und vergessen, und ein Jahr später macht jemand von Hand, was längst auf Knopfdruck geht. Deshalb steht hier alles, auch das Alte.',
      'Was seit deinem letzten Besuch dazugekommen ist, ist als "Neu" markiert, und die Navigation trägt einen Punkt, bis du auf "Zur Kenntnis genommen" klickst. Ein frisches Konto hat nichts verpasst und sieht deshalb keine Markierungen, sondern ein Handbuch. Agenten fragen dieselbe Liste über exo_features ab, statt aus dem Gedächtnis zu erzählen, was diese Installation kann.',
    ],
    since: '2026-09-18',
    references: ['#80', 'ADR-040'],
    ui: { where: 'Das Fragezeichen oben in der Leiste.', path: '/hilfe' },
    tools: ['exo_features'],
    claims: { screens: ['/hilfe'] },
  }),
  defineFeature({
    id: 'mcp-server',
    area: 'agenten',
    title: 'Agenten greifen auf dieselben Fähigkeiten zu wie du',
    summary:
      'eXocortex spricht MCP, also können Claude Code, Hermes und andere Clients hier lesen und schreiben. Sie bekommen dieselben Fähigkeiten wie der Browser, weil beide über dieselbe API gehen; was ein Mensch kann, kann ein Agent auch.',
    details: [
      'MCP ist das Protokoll, über das ein Sprachmodell fremde Werkzeuge benutzt. eXocortex bringt einen solchen Server mit, also können Claude Code, Hermes, ChatGPT und andere hier suchen, lesen, schreiben, verschieben, kommentieren und bauen. Für dich heißt das: deine Notizen sind dort erreichbar, wo du ohnehin arbeitest, statt hinter einem Fenster, das du extra aufmachst.',
      'Alle drei Zugänge, Browser, eingebaute KI und externe Agenten, gehen über dieselbe API und teilen sich einen einzigen Werkzeugkatalog. Das ist keine Höflichkeit, sondern eine Regel im Bauprozess: kommt eine Funktion dazu, die ein Mensch bedienen kann, muss sie im selben Zug auch für Agenten erreichbar sein, sonst geht der Bau rot.',
      'Vor unwiderruflichen Aufrufen, etwa dem endgültigen Löschen, verlangt der Server eine zweite, gleichlautende Anfrage als Bestätigung. Das ist kein Fehler, sondern gewollt: derselbe Aufruf noch einmal, und er wird ausgeführt.',
    ],
    since: '2026-08-06',
    references: ['ADR-014', 'ADR-018', 'ADR-025'],
    ui: { where: 'Verwaltung, Einstellungen, Abschnitt MCP.' },
    settings: ['mcp.enabled', 'mcp.maxSearchResults', 'mcp.writeConfirmationRequired'],
  }),
  defineFeature({
    id: 'mcp-ueber-http',
    area: 'agenten',
    title: 'Clients anbinden, die nur eine Adresse kennen',
    summary:
      'Neben dem lokalen Prozess gibt es MCP über HTTP samt eigenem Anmeldeserver, für Clients wie ChatGPT, die keinen Token halten können. Bevor eine Verbindung zustande kommt, musst du sie auf einer Zustimmungsseite bestätigen.',
    details: [
      'Manche Clients laufen auf deinem Rechner und können einen lokalen Prozess starten, andere laufen in der Cloud und kennen nur eine Adresse. Für die zweite Sorte gibt es MCP über HTTP unter einer festen Adresse, mit einem eigenen Anmeldeserver davor.',
      'Beim Verbinden landest du auf einer Zustimmungsseite, auf der steht, wer sich verbinden will und worauf. Erst dein Klick erteilt den Zugang. Diese Seite ist die eigentliche Sperre, nicht das Protokoll: ohne sie käme jeder, der die Adresse kennt, wenigstens bis zur Anmeldung.',
      'Erteilte Verbindungen stehen danach in deiner Liste und lassen sich jederzeit kappen. Der HTTP-Zugang nimmt ausschließlich Zugangstoken an, nie dein Browser-Sitzungscookie, damit eine fremde Webseite nicht in deinem Namen mitreden kann.',
    ],
    since: '2026-08-11',
    references: ['ADR-018'],
    ui: { where: 'Die Zustimmungsseite erscheint beim Verbinden.', path: '/verbinden' },
    claims: { screens: ['/verbinden'] },
  }),
  defineFeature({
    id: 'mcp-abonnements',
    area: 'agenten',
    title: 'Ein Agent erfährt von einer Änderung, statt nachzufragen',
    summary:
      'Ein Client kann eine Seite abonnieren und wird benachrichtigt, wenn sie sich ändert. Jede Benachrichtigung wird in dem Moment gegen die Rechte geprüft, in dem sie geschrieben wird, sodass ein entzogener Zugang keine mehr zugestellt bekommt.',
    details: [
      'Ohne Abonnement bleibt einem Agenten nur, alle paar Sekunden nachzufragen, ob sich etwas geändert hat. Mit Abonnement meldet eXocortex sich von selbst, sobald die Seite sich ändert. Das spart Aufrufe und macht Zusammenarbeit möglich, bei der du schreibst und ein Agent darauf reagiert.',
      'Jede einzelne Benachrichtigung wird in dem Moment gegen die Rechte geprüft, in dem sie geschrieben wird, nicht in dem Moment, in dem das Abonnement angelegt wurde. Ein entzogener Zugang bekommt also nichts mehr, auch wenn die Leitung noch offen steht; der Entzug schließt sie.',
      'Es gibt dafür keinen Bildschirm, der Client macht das von sich aus. Ein Abonnement auf eine Seite, die es nicht gibt, wird angenommen statt abgelehnt, weil eine Ablehnung verraten würde, ob es diese Seite gibt.',
    ],
    since: '2026-09-18',
    references: ['#48', 'ADR-035'],
    ui: { where: 'Kein Bildschirm: der Client abonniert von sich aus.' },
  }),
  defineFeature({
    id: 'deep-research-connector',
    area: 'agenten',
    title: 'Eine kleine Oberfläche für Recherche-Connectoren',
    summary:
      'Für Clients, die genau zwei Werkzeuge namens search und fetch erwarten, gibt es einen bewusst winzigen Katalog. Er existiert getrennt, weil dieselben Clients mit hundertdreißig Werkzeugen schlecht umgehen.',
    details: [
      'Recherchefunktionen mancher Clients erwarten eine feste, kleine Oberfläche: ein Werkzeug namens search, eines namens fetch, mehr nicht. Bekommen sie den vollen Katalog mit über hundert Werkzeugen, benutzen sie ihn schlecht oder gar nicht.',
      'Deshalb gibt es diesen zweiten, winzigen Katalog daneben. Er greift auf dieselbe Suche und dieselben Seiten zu, zeigt aber nur zwei Türen. Damit kann eine Recherchefunktion deine Notizen als Quelle benutzen, so wie sie es mit einer Webseite täte.',
      'Einen Bildschirm gibt es dafür nicht, der Client wählt diesen Katalog selbst. Wer volle Fähigkeiten will, verbindet sich mit dem gewöhnlichen MCP-Zugang.',
    ],
    since: '2026-08-11',
    ui: { where: 'Kein Bildschirm: der Connector wählt diesen Katalog selbst.' },
    tools: ['search', 'fetch'],
  }),
  defineFeature({
    id: 'api-tokens',
    area: 'agenten',
    title: 'Eigene Zugangstoken mit abgestuften Rechten',
    summary:
      'Ein Token bekommt ausdrücklich Lese-, Schreib- oder Verwaltungsrechte, statt das ganze Konto zu sein. Die Seite zeigt auch die fertigen Anbindungsbefehle für die gängigen Clients.',
    details: [
      'Ein Token ist der Ausweis, mit dem ein Programm sich anmeldet, ohne dein Passwort zu kennen. Beim Anlegen sagst du, was es darf: nur lesen, auch schreiben, oder verwalten. Eine leere Auswahl erlaubt nichts, das ist der sichere Ausgangszustand.',
      'Ein Nur-Lese-Token für eine Auswertung kann also nichts kaputt machen, und du musst nicht das ganze Konto hergeben, nur weil ein Skript eine Liste braucht. Der Tokenwert wird genau einmal angezeigt, danach nie wieder, also gleich an den richtigen Ort kopieren.',
      'Unter der Liste stehen die fertigen Anbindungsbefehle für die gängigen Clients, mit eingesetzter Adresse und eingesetztem Token. Du kopierst eine Zeile und bist verbunden, statt eine Konfigurationsdatei zusammenzusuchen. Ein Token lässt sich jederzeit zurückziehen.',
    ],
    since: '2026-08-06',
    ui: { where: 'Einstellungen, Zugangstoken.', path: '/einstellungen/tokens' },
    claims: { screens: ['/einstellungen/tokens'] },
  }),
  defineFeature({
    id: 'token-seitenbereiche',
    area: 'agenten',
    title: 'Ein Token auf bestimmte Seiten begrenzen',
    summary:
      'Ein Zugangstoken lässt sich beim Anlegen auf eine Seite oder einen Seitenbereich festnageln. Danach kommt es an nichts anderes mehr heran: nicht über die Suche, nicht über Verweise, nicht über Listen, und der Rest existiert für dieses Token schlicht nicht.',
    details: [
      'Beim Anlegen eines Tokens gibt es unter den Rechten den Abschnitt „Auf Seiten beschränken“. Du wählst einen Arbeitsbereich, dann eine oder mehrere Seiten, und je Seite, ob nur sie gemeint ist oder alles darunter. Ohne Angabe bleibt das Token so breit wie dein Konto, wie es das immer war.',
      'Das ist für Agenten gedacht, die nur einen Ausschnitt kennen sollen: ein Schreibassistent für „Worldbuilding > Cyberpunk“ braucht deine Steuerunterlagen nicht zu sehen und soll auch nicht wissen, dass es sie gibt. Die Grenze gilt deshalb nicht nur beim direkten Öffnen einer Seite, sondern auch für Suche, Seitenbaum, Verweise, verwandte Seiten, Anhänge, den Papierkorb und die Ablagevorschläge. Ein Aufruf, der sich auf den ganzen Arbeitsbereich bezieht, wird abgelehnt statt gefiltert, damit nichts durchrutscht, woran niemand gedacht hat.',
      'Ein Token kann nie mehr dürfen als das Konto dahinter: beim Anlegen wird jede genannte Seite als Lesevorgang von dir geprüft, und bei jeder Anfrage gilt zusätzlich deine Mitgliedschaft von heute. Ein begrenztes Token kann auch kein unbegrenztes erzeugen. Wird die letzte Seite gelöscht, auf die ein Token beschränkt war, erreicht es nichts mehr, statt wieder alles zu erreichen.',
    ],
    since: '2026-09-19',
    references: ['#83', 'ADR-044'],
    ui: { where: 'Einstellungen, Verbindungen, beim Anlegen eines Tokens.' },
  }),
  defineFeature({
    id: 'push-benachrichtigungen',
    area: 'agenten',
    title: 'Benachrichtigungen auf dem Handy und am Rechner',
    summary:
      'eXocortex kann dich auf deinen Geräten anstupsen, wenn gerade niemand hinschaut: kurz vor einem Termin, bei einem Kommentar an deiner Seite, und wenn ein Agent dir absichtlich Bescheid gibt. Welches Gerät was hört, stellst du pro Gerät ein.',
    details: [
      'Unter Einstellungen → Benachrichtigungen meldest du das Gerät an, an dem du gerade sitzt. Der Browser fragt einmal um Erlaubnis, danach steht das Gerät in der Liste. Jedes Gerät hat eigene Schalter für die drei Arten, denn das Handy in der Tasche und der Rechner auf der Arbeit wollen selten dasselbe hören. Eine Testnachricht daneben zeigt sofort, ob es ankommt.',
      'Die drei Arten sind: kurz vor einem Termin aus deinem Kalender, ein Kommentar an einer Seite, die du geschrieben hast, oder eine Antwort in einem Gesprächsfaden, in dem du schon steckst, und Nachrichten von Agenten. Das Letzte ist der eigentliche Grund für die Funktion: ein langer Lauf ist fertig, etwas ist schiefgegangen, eine Frage blockiert, und Hermes oder eine Claude-Code-Sitzung erreicht dich über exo_push_send direkt auf dem Telefon, statt dass du nachschauen musst.',
      'Der Text der Benachrichtigung ist an dein Gerät verschlüsselt: der Push-Dienst dazwischen, also Google, Mozilla oder Apple, transportiert einen Umschlag, den er nicht aufmachen kann. Antippen öffnet die Seite, um die es geht, in einem schon offenen Fenster, statt ein zweites aufzumachen.',
      'Auf dem iPhone und dem iPad gibt es Benachrichtigungen nur, wenn eXocortex über „Zum Home-Bildschirm“ installiert ist, das ist eine Einschränkung von Safari. Meldest du ein Gerät ab oder entziehst im Browser die Erlaubnis, hört es sofort auf; ein Gerät, das der Push-Dienst nicht mehr kennt, fliegt von selbst aus der Liste.',
    ],
    since: '2026-09-20',
    references: ['#30', 'ADR-048'],
    ui: { where: 'Einstellungen, Benachrichtigungen, Abschnitt „Auf deinen Geräten“.' },
    tools: [
      'exo_push_devices',
      'exo_push_device_update',
      'exo_push_device_remove',
      'exo_push_send',
    ],
  }),
  defineFeature({
    id: 'benachrichtigungen-einstellen',
    area: 'agenten',
    title: 'Selbst entscheiden, worüber du Post bekommst',
    summary:
      'Unter Einstellungen → Benachrichtigungen steht an einer Stelle, wann eXocortex dich von sich aus erreicht: auf deinen Geräten und per E-Mail. Der Mail-Teil gilt fürs ganze Konto, der Geräte-Teil für jedes Gerät einzeln.',
    details: [
      'Die Seite trennt zwei Fragen, die leicht durcheinandergehen. Ein Gerät entscheidet für sich, weil dein Handy abends etwas anderes hören soll als der Rechner auf der Arbeit. Deine Adresse dagegen gehört dir und nicht einem Browser, deshalb gilt eine Mail-Einstellung überall gleich, egal wo du dich gerade anmeldest.',
      'Per Mail gibt es derzeit einen Schalter: geteilte Seiten. Er deckt alle drei Fälle ab, die dir jemand über eine Freigabe mitteilt, nämlich dass eine Seite neu bei dir ankommt, dass sich deine Rechte daran ändern und dass sie dir wieder entzogen wird. Er steht ab Werk an, weil eine Freigabe, von der du nichts erfährst, dir auch nichts nützt. Schaltest du ihn aus, wird gar keine Mail mehr in die Warteschlange gelegt, statt eine zu verschicken und wegzuwerfen.',
      'Angeboten wird nur, was diese Installation auch wirklich zustellt. Eine Kombination aus Anlass und Weg, für die es keinen Absender gibt, taucht weder als Schalter auf noch lässt sie sich über die Werkzeuge setzen: ein Schalter, der nichts tut, ist schlimmer als ein fehlender.',
      'Agenten sehen und setzen dieselben Einstellungen über exo_notification_preferences und exo_notification_preference_set. Für Push bleibt exo_push_device_update zuständig, weil dort das einzelne Gerät gemeint ist und nicht das Konto.',
    ],
    since: '2026-09-20',
    references: ['#105', 'ADR-052'],
    ui: {
      where: 'Einstellungen, Benachrichtigungen.',
      path: '/einstellungen/benachrichtigungen',
    },
    claims: { screens: ['/einstellungen/benachrichtigungen'] },
    tools: ['exo_notification_preferences', 'exo_notification_preference_set'],
  }),
  defineFeature({
    id: 'verbindungen',
    area: 'agenten',
    title: 'Verbundene Clients wieder loswerden',
    summary:
      'Jede erteilte Verbindung steht in einer Liste und lässt sich mit einem Klick kappen. Ein gekappter Zugang endet sofort, auch für eine gerade offene Verbindung.',
    details: [
      'Die Liste zeigt jeden Client, dem du Zugang erteilt hast, mit Namen, Zeitpunkt und Rechten. Damit ist "wer darf eigentlich alles in meine Notizen" eine Seite und keine Erinnerungsübung.',
      'Kappen wirkt sofort und nicht erst beim nächsten Anmelden. Eine gerade offene Verbindung wird getrennt statt nachträglich beschnitten, denn eine bestehende Leitung, der man Rechte wegnimmt, ist schwerer richtig hinzubekommen als eine, die neu aufgebaut werden muss.',
      'Dasselbe gilt in die andere Richtung: eine erweiterte Berechtigung kommt erst mit einer frischen Verbindung an. Zusätzlich wird regelmäßig nachgeprüft, ob die offenen Verbindungen noch berechtigt sind, falls eine Nachricht einmal verloren geht.',
    ],
    since: '2026-08-12',
    references: ['ADR-029'],
    ui: { where: 'Einstellungen, Verbindungen.', path: '/einstellungen/verbindungen' },
    claims: { screens: ['/einstellungen/verbindungen'] },
  }),
  defineFeature({
    id: 'anmeldung',
    area: 'verwaltung',
    title: 'Anmelden und Passwort zurücksetzen',
    summary:
      'Die Anmeldung läuft über E-Mail und Passwort, ein vergessenes Passwort über einen Link per Mail. Ein deaktiviertes Konto bleibt bestehen, kann aber nichts mehr tun, damit die Urheberangaben an den Seiten erhalten bleiben.',
    details: [
      'Angemeldet wird mit E-Mail und Passwort. Die Sitzung hält über das Schließen des Browsers hinweg, du musst dich also nicht jeden Morgen neu anmelden. Hast du das Passwort vergessen, schickst du dir über die Anmeldeseite einen Link per Mail und setzt ein neues.',
      'Ein Konto zu deaktivieren ist etwas anderes, als es zu löschen. Das deaktivierte Konto bleibt bestehen, kann sich aber nicht mehr anmelden, und alle seine Zugangsdaten sind sofort weg. So bleibt an den Seiten stehen, wer sie geschrieben hat, statt dass überall "unbekannt" auftaucht.',
      'Auf dem Telefon lässt sich eXocortex als App installieren, dann fehlt die Adressleiste und das Teilen-Menü kennt es.',
    ],
    since: '2026-08-05',
    ui: { where: 'Die Anmeldeseite.', path: '/anmelden' },
    claims: { screens: ['/anmelden', '/passwort-vergessen'] },
  }),
  defineFeature({
    id: 'einladungen',
    area: 'verwaltung',
    title: 'Nur auf Einladung',
    summary:
      'Es gibt keine offene Registrierung: ein Konto entsteht aus einer Einladung mit Ablaufdatum, die sich erneut senden oder zurückziehen lässt. Damit ist die Installation im Netz erreichbar, ohne allen offen zu stehen.',
    details: [
      'Es gibt kein Registrierungsformular. Ein Konto entsteht nur aus einer Einladung: du trägst in der Nutzerverwaltung eine E-Mail-Adresse ein, die eingeladene Person bekommt einen Link und setzt sich damit ihr Passwort.',
      'Eine Einladung läuft ab, lässt sich erneut senden, wenn die Mail im Spam gelandet ist, und zurückziehen, wenn du es dir anders überlegst. Die offenen Einladungen stehen in einer Liste, damit keine unbemerkt herumliegt.',
      'Das ist der Grund, warum diese Installation offen im Netz stehen kann, ohne allen offen zu stehen. Einladen geht auch über die Werkzeuge, also aus einem Agenten heraus.',
    ],
    since: '2026-08-12',
    references: ['#3'],
    ui: { where: 'Verwaltung, Nutzer, Schaltfläche "Einladen".' },
    tools: [
      'exo_invitation_create',
      'exo_invitation_list',
      'exo_invitation_resend',
      'exo_invitation_revoke',
    ],
    claims: { screens: ['/einladung/:x'] },
  }),
  defineFeature({
    id: 'nutzerverwaltung',
    area: 'verwaltung',
    title: 'Konten und Rollen',
    summary:
      'Die Nutzerverwaltung listet alle Konten, macht jemanden zur Verwaltung, deaktiviert ein Konto oder löscht es. Ein deaktiviertes Konto verliert sofort alle Zugangsdaten, statt bei jeder Anfrage neu geprüft zu werden.',
    details: [
      'Die Liste zeigt alle Konten mit Namen, E-Mail, Rolle und Zustand. Von hier aus lädst du jemanden ein, machst jemanden zur Verwaltung, nimmst dieses Recht wieder weg, deaktivierst ein Konto oder löschst es endgültig.',
      'Deaktivieren entzieht sofort alle Sitzungen und Token, statt bei jeder Anfrage nachzusehen, ob das Konto noch darf. Das ist ein Unterschied, der zählt: eine Prüfung, die jemand zu schreiben vergisst, hinterlässt ein Loch, ein entzogener Zugang nicht.',
      'Löschen ist der weitergehende Schritt und dafür gedacht, dass jemand wirklich verschwinden soll. Willst du nur, dass jemand nicht mehr hereinkommt, ist Deaktivieren das Richtige, weil die Urheberangaben an den Seiten erhalten bleiben. Beides geht auch über die Werkzeuge.',
    ],
    since: '2026-08-12',
    ui: { where: 'Verwaltung, Nutzer.', path: '/admin/nutzer' },
    tools: ['exo_user_list', 'exo_user_set_disabled', 'exo_user_delete'],
    claims: { screens: ['/admin', '/admin/nutzer'] },
  }),
  defineFeature({
    id: 'einstellungen-geltungsbereiche',
    area: 'verwaltung',
    title: 'Einstellungen für die Installation und je Arbeitsbereich',
    summary:
      'Die meisten Schalter gelten für die ganze Installation, viele davon lassen sich in einem einzelnen Arbeitsbereich überschreiben. Eine Obergrenze wirkt dabei nach unten durch: senkst du den Wert für die Installation, ziehen alle Arbeitsbereiche mit.',
    details: [
      'Eine Einstellung wird in Schichten aufgelöst: der eingebaute Standard, die Umgebung beim Start, der Wert für die Installation und, wenn es ihn gibt, der Wert des Arbeitsbereichs. Kein Eintrag im Arbeitsbereich heißt erben, nicht "aus". Geändert wird zur Laufzeit in der Verwaltung, ein Neustart ist nicht nötig.',
      'Nicht jeder Schlüssel ist überschreibbar, und das ist Absicht: welches Modell in einem Arbeitsbereich antwortet, ist dessen Sache, wie lange Protokolle aufgehoben werden, ist es nicht. Welche Schlüssel welcher Ebene gehören, steht fest.',
      'Manche Werte haben eine Obergrenze, die nach unten durchwirkt: senkst du für die Installation das Budget pro Lauf, ziehen alle Arbeitsbereiche mit, auch die, die vorher einen höheren Wert eingetragen hatten. Sonst wäre eine Grenze keine. Zugangsdaten sind bewusst keine Einstellung und stehen nie in dieser Liste.',
    ],
    since: '2026-09-12',
    references: ['ADR-013', 'ADR-023'],
    ui: {
      where: 'Verwaltung, Einstellungen, oder die Einstellungen eines Arbeitsbereichs.',
      path: '/admin/einstellungen',
    },
    claims: { screens: ['/admin/einstellungen', '/arbeitsbereich/:x/einstellungen'] },
  }),
  defineFeature({
    id: 'modell-registry',
    area: 'verwaltung',
    title: 'Modelle einrichten und je Anbieter zulassen',
    summary:
      'Welche Modelle es gibt, steht in einer Liste, die pro Anbieter Preis und Fenstergröße kennt. Eine Anfrage geht nur an die Anbieter, die sie auch bedienen können, statt an den nächstbesten.',
    details: [
      'Dasselbe Modell wird oft von mehreren Anbietern bereitgestellt, zu unterschiedlichen Preisen und mit unterschiedlich großem Fenster. Die Registrierung hält deshalb eine Zeile pro Anbieter und Modell, mit Preis, Fenstergröße und Fähigkeiten wie Bildverständnis oder Werkzeugaufrufen.',
      'Vor jeder Anfrage wird neu entschieden, welche Anbieter sie überhaupt bedienen können, und nur diese kommen in Frage. Ein Gespräch, das zu lang für das kleine Fenster eines billigen Anbieters ist, landet also nicht dort und scheitert nicht auf halbem Weg. Welcher der geeigneten Anbieter es am Ende macht, entscheidet die Vermittlung.',
      'In der Verwaltung legst du fest, welche Modelle es überhaupt gibt, welches der Standard ist und welche für Sonderaufgaben benutzt werden, etwa für Zusammenfassungen, Einbettungen oder Bilder. Was ein Modell gekostet hat, siehst du in der Nutzungsübersicht.',
    ],
    since: '2026-08-06',
    references: ['ADR-032'],
    ui: { where: 'Verwaltung, KI-Modelle.', path: '/admin/ki-modelle' },
    claims: { screens: ['/admin/ki-modelle'] },
  }),
  defineFeature({
    id: 'eigene-schluessel',
    area: 'verwaltung',
    title: 'Eigene Anbieter-Schlüssel je Arbeitsbereich',
    summary:
      'Ein Arbeitsbereich kann seinen eigenen Anbieter-Schlüssel hinterlegen, statt den der Installation zu benutzen. Der Schlüssel wird verschlüsselt abgelegt und ist danach nicht mehr auslesbar.',
    details: [
      'In den Einstellungen eines Arbeitsbereichs hinterlegst du einen eigenen Schlüssel für den Modellanbieter. Alle KI-Läufe dieses Bereichs gehen dann über dieses Konto und tauchen auf dessen Rechnung auf, statt auf der der Installation.',
      'Gedacht ist das für den Fall, dass mehrere Leute oder mehrere Projekte sich eine Installation teilen und jede Seite ihre eigenen Kosten trägt. Ohne eigenen Schlüssel wird stillschweigend der der Installation benutzt, es muss also niemand etwas einrichten.',
      'Der Schlüssel wird verschlüsselt abgelegt und ist danach nicht mehr auslesbar, auch nicht von der Verwaltung; du kannst ihn nur ersetzen oder entfernen. Der Schlüssel zum Entschlüsseln liegt in der Serverkonfiguration und nicht in der Datenbank.',
    ],
    since: '2026-09-12',
    ui: { where: 'Die Einstellungen eines Arbeitsbereichs.' },
  }),
  defineFeature({
    id: 'kosten',
    area: 'verwaltung',
    title: 'Was die KI gekostet hat',
    summary:
      'Jeder Lauf wird mit Modell, Token und Kosten verbucht, aufgeschlüsselt nach Arbeitsbereich und Zeitraum. Damit ist "was kostet mich das eigentlich" eine Seite und keine Schätzung.',
    details: [
      'Jeder Lauf wird verbucht: welches Modell, welcher Anbieter, wie viele Token hinein und hinaus, was es gekostet hat und wozu er gehörte. Die Übersicht fasst das nach Arbeitsbereich und Zeitraum zusammen.',
      'Damit beantwortest du die Fragen, die sonst nur eine Anbieterrechnung am Monatsende beantwortet: welcher Arbeitsbereich verbraucht das meiste, welche Automation ist teurer als gedacht, hat sich der Wechsel auf ein kleineres Modell gelohnt.',
      'Die Zahlen sind Buchungen und keine Schätzung, sie stammen aus der Abrechnung des Anbieters pro Aufruf. Die vollständigen Anfragen und Antworten werden nur eine einstellbare Zeit lang aufgehoben, die Zahlen bleiben.',
    ],
    since: '2026-08-06',
    ui: { where: 'Verwaltung, Nutzung.', path: '/admin/nutzung' },
    settings: ['ai.runPayloadRetentionDays'],
    tools: ['exo_ai_usage'],
    claims: { screens: ['/admin/nutzung'] },
  }),
];
