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

Das Skript prüft drei Dinge und endet mit `Ergebnis:`. Es gibt das Token nie
aus, nur die ersten und letzten Zeichen. Gib du es auch nicht aus, selbst wenn
du es aus einer Datei lesen könntest.

## 2. Antworten

**Steht alles:** eine Zeile, dass die Verbindung sitzt, mit der Anzahl der
Werkzeuge. Dann aufhören.

**Fehlt die Konfiguration:** das ist der Normalfall bei einer frischen
Installation. Sag diese drei Schritte, in dieser Reihenfolge:

1. In eXocortex unter **Einstellungen, Verbindungen** ein Token anlegen, Recht
   **Lesen und schreiben**. Es wird genau einmal angezeigt.
2. Hier `/plugin` aufrufen, **eXocortex** auswählen, **Konfigurieren**.
3. Adresse (die aus der Browser-Zeile, ohne Pfad) und Token eintragen, dann
   `/exocortex:einrichten` noch einmal.

**Sonst:** das Skript nennt die Ursache im Klartext, gib sie weiter und nenne
den einen Schritt, der sie behebt. Rate nichts dazu.

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
