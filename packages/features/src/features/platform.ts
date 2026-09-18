import { defineFeature, type RegisteredFeature } from '../feature.js';

/** Getting in, letting agents in, and running the deployment. */
export const PLATFORM_FEATURES: readonly RegisteredFeature[] = [
  defineFeature({
    id: 'funktionsuebersicht',
    area: 'hilfe',
    title: 'Diese Übersicht, und was seit deinem letzten Besuch dazukam',
    summary:
      'Die Seite, auf der du gerade bist: eine durchsuchbare Liste dessen, was eXocortex kann, in ganzen Sätzen statt als Endpunktliste. Was seit deinem letzten Besuch dazugekommen ist, steht oben und wird in der Navigation angezeigt, bis du es zur Kenntnis genommen hast.',
    since: '2026-09-18',
    references: ['#80', 'ADR-040'],
    ui: { where: 'Der Punkt "Funktionen" in der Navigation.', path: '/hilfe' },
    tools: ['exo_features'],
    claims: { screens: ['/hilfe'] },
  }),
  defineFeature({
    id: 'mcp-server',
    area: 'agenten',
    title: 'Agenten greifen auf dieselben Fähigkeiten zu wie du',
    summary:
      'eXocortex spricht MCP, also können Claude Code, Hermes und andere Clients hier lesen und schreiben. Sie bekommen dieselben Fähigkeiten wie der Browser, weil beide über dieselbe API gehen; was ein Mensch kann, kann ein Agent auch.',
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
    since: '2026-08-06',
    ui: { where: 'Einstellungen, Zugangstoken.', path: '/einstellungen/tokens' },
    claims: { screens: ['/einstellungen/tokens'] },
  }),
  defineFeature({
    id: 'verbindungen',
    area: 'agenten',
    title: 'Verbundene Clients wieder loswerden',
    summary:
      'Jede erteilte Verbindung steht in einer Liste und lässt sich mit einem Klick kappen. Ein gekappter Zugang endet sofort, auch für eine gerade offene Verbindung.',
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
    since: '2026-09-12',
    ui: { where: 'Die Einstellungen eines Arbeitsbereichs.' },
  }),
  defineFeature({
    id: 'kosten',
    area: 'verwaltung',
    title: 'Was die KI gekostet hat',
    summary:
      'Jeder Lauf wird mit Modell, Token und Kosten verbucht, aufgeschlüsselt nach Arbeitsbereich und Zeitraum. Damit ist "was kostet mich das eigentlich" eine Seite und keine Schätzung.',
    since: '2026-08-06',
    ui: { where: 'Verwaltung, Nutzung.', path: '/admin/nutzung' },
    settings: ['ai.runPayloadRetentionDays'],
    tools: ['exo_ai_usage'],
    claims: { screens: ['/admin/nutzung'] },
  }),
];
