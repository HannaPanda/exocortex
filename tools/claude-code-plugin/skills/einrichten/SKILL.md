---
description: Richtet die Verbindung zu eXocortex ein und prüft sie. Nutze das, wenn jemand eXocortex verbinden, einrichten oder testen will, oder wenn die eXocortex-Werkzeuge oder das Gedächtnis nicht zu funktionieren scheinen.
allowed-tools: Bash, Read
---

# eXocortex einrichten

Deine Aufgabe: herausfinden, was der Verbindung noch fehlt, und genau das sagen.
Nicht mehr. Der Prüfbericht unten ist die Antwort, du fasst ihn zusammen.

## 1. Prüfen

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/einrichten/pruefen.mjs"
```

Das Skript prüft die Kette Glied für Glied (Konfiguration, Hooks, MCP,
Gedächtnis-API) und endet mit `Ergebnis:`. Es gibt das Token nie aus, nur die
ersten und letzten Zeichen. Gib du es auch nicht aus, selbst wenn du es aus
einer Datei lesen könntest.

Ein Token aus der Plugin-Konfiguration sieht das Skript nicht: das bekommen nur
Hooks und MCP-Server. Dann sagt der Abschnitt **Hooks**, was die Hooks bei ihrem
letzten echten Lauf erlebt haben, und das ist die maßgebliche Auskunft.

**Die Werkzeuge prüfst du selbst**, unabhängig vom Skript: ruf einmal
`exo_list_workspaces` auf. Antwortet es, steht der MCP-Server. Das ist eine
eigene Prüfung, weil MCP und Gedächtnis getrennt kaputt sein können.

Wenn jemand ausdrücklich einen vollständigen Test will und das Skript das Token
lesen kann (Quelle ist nicht die Plugin-Konfiguration):

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/einrichten/pruefen.mjs" --ende-zu-ende
```

Das schickt eine markierte Testsitzung unter dem Projekt `exocortex-selbsttest`,
wartet bis zu zwei Minuten auf die Verarbeitung, prüft den Abruf und archiviert
die Testnotiz wieder. Es kostet einen Modellaufruf, also nur auf Nachfrage.

## 2. Antworten

**Steht alles:** eine Zeile, dass die Verbindung sitzt, mit der Anzahl der
Werkzeuge. Dann aufhören.

**Fehlt die Konfiguration:** das ist der Normalfall bei einer frischen
Installation. Sag diese drei Schritte, in dieser Reihenfolge:

1. In eXocortex unter **Einstellungen, Verbindungen** ein Token anlegen, Recht
   **Lesen und schreiben**. Es wird genau einmal angezeigt.
2. Hier `/plugin` aufrufen, **eXocortex** auswählen, **Konfigurieren**.
3. Adresse (die aus der Browser-Zeile, ohne Pfad) und Token eintragen, Claude
   Code neu starten, dann `/exocortex:einrichten` noch einmal.

**Hat noch kein Hook-Lauf stattgefunden:** Claude Code mit `/exit` beenden, neu
starten und `/exocortex:einrichten` noch einmal. Erst dann gibt es etwas zu
berichten.

**Sonst:** das Skript nennt das Glied der Kette, an dem es hängt, im Klartext.
Gib genau das weiter und nenne den einen Schritt, der es behebt. Rate nichts
dazu. Für mehr Einzelheiten gibt es das Diagnoseprotokoll (Plugin-Option
**Diagnoseprotokoll schreiben**, oder `EXOCORTEX_MEMORY_DEBUG=1`), siehe README.

## Wenn jemand die Werte lieber in einer Datei hätte

Statt der Plugin-Konfiguration geht auch `~/.claude/exocortex-memory.json`:

```json
{ "apiUrl": "https://exocortex.app", "token": "exo_…" }
```

Das ist der Weg für alle, die die Hooks ohne Plugin benutzen, und der einzige,
bei dem du die Datei selbst schreibst. Frag vorher nach dem Token, lies es nicht
aus einer anderen Datei zusammen.

## Was hier sonst noch hängt

Das Plugin bringt zwei Dinge mit, die nach dem Einrichten von selbst laufen:

- den MCP-Server `exocortex` mit den Werkzeugen (`exo_search`, `exo_page_read`,
  `exo_page_write` und den übrigen),
- das Gedächtnis: beim Start kommen die Erinnerungen zum Arbeitsverzeichnis in
  den Kontext, beim Ende wird die Sitzung verdichtet abgelegt.

Den Mitschrieb schaltet die Option **Sitzungen als Erinnerung ablegen** in der
Plugin-Konfiguration ab, der MCP-Server bleibt dann.
