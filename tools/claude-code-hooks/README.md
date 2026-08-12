# eXocortex als Gedächtnis für Claude Code

Zwei Hooks, die eine Claude-Code-Sitzung an das Gedächtnis in eXocortex hängen:

| Hook | Wann | Was er tut |
| --- | --- | --- |
| `session-start.mjs` | `SessionStart` | Holt die Erinnerungen zum aktuellen Arbeitsverzeichnis und legt sie in den Kontext der neuen Sitzung. |
| `session-end.mjs` | `SessionEnd` | Schickt die beendete Sitzung an eXocortex. Dort destilliert ein Modell daraus eine Notiz, der Wortlaut wird nicht gespeichert. |

Beide scheitern leise. Wer keine Konfiguration findet, tut nichts und beendet
sich mit 0. Eine kaputte Verbindung darf keine Arbeitssitzung blockieren.

## Einrichten

### 1. Token

Auf `https://exocortex.app/einstellungen/verbindungen` ein Token mit **Lesen und
schreiben** anlegen. Wer den MCP-Server dort schon eingerichtet hat, braucht
nichts Neues: die Hooks lesen denselben Eintrag aus `~/.claude.json`.

Die Reihenfolge, in der gesucht wird:

1. `EXOCORTEX_API_URL` und `EXOCORTEX_API_TOKEN` aus der Umgebung
2. `~/.claude/exocortex-memory.json` (`{"apiUrl": "…", "token": "exo_…"}`)
3. `mcpServers.exocortex.env` in `~/.claude.json`

### 2. Hooks eintragen

In `~/.claude/settings.json` (gilt für alle Projekte) oder
`.claude/settings.json` (nur dieses Projekt):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /var/www/exocortex/tools/claude-code-hooks/session-start.mjs",
            "timeout": 10
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /var/www/exocortex/tools/claude-code-hooks/session-end.mjs",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

Der Pfad zeigt auf dieses Verzeichnis auf dem jeweiligen Rechner. Auf einer
Maschine ohne eXocortex-Repo reicht es, die drei `.mjs`-Dateien zu kopieren.

### 3. Ausprobieren

```bash
echo '{"cwd":"/var/www/exocortex"}' | node tools/claude-code-hooks/session-start.mjs
```

Kommt JSON mit `additionalContext` zurück, sitzt die Verbindung. Kommt nichts,
gibt es (noch) keine Erinnerungen zu diesem Verzeichnis, oder die Konfiguration
wurde nicht gefunden.

## Abschalten

`EXOCORTEX_MEMORY_DISABLED=1` in der Umgebung, oder `"disabled": true` in
`~/.claude/exocortex-memory.json`. Beides wirkt sofort und braucht keinen
Eingriff in `settings.json`.

## Was gespeichert wird

Der Mitschrieb geht ausschließlich in den **Memory-Arbeitsbereich**, nie ins
Second Brain: das eine ist Werkzeug der Agenten und darf aufgeräumt werden, das
andere ist ein gepflegtes Gedächtnis für Menschen. Welcher Arbeitsbereich das
ist, steht in der Einstellung `memory.workspaceId` im Administrationsbereich.

Vor dem Senden fallen Werkzeugaufrufe und deren Ausgaben raus. Was ankommt,
wird nicht gespeichert, sondern von einem Modell zu wenigen Stichpunkten
verdichtet; nur die landen als Seite. Sitzungen unterhalb von
`memory.captureMinChars` Zeichen werden gar nicht erst angenommen, und das
Modell darf antworten, dass es nichts zu merken gibt.
