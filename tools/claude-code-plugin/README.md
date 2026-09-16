# eXocortex für Claude Code

Ein Plugin, das Claude Code an deinen eXocortex hängt. Zwei Dinge stecken darin:

| Teil       | Was er tut                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP-Server | Die Werkzeuge deines eXocortex (`exo_search`, `exo_page_read`, `exo_page_write` und die übrigen) über HTTP, ohne eigenen Prozess auf deinem Rechner.         |
| Zwei Hooks | `SessionStart` holt die Erinnerungen zum Arbeitsverzeichnis in den Kontext, `SessionEnd` schickt die beendete Sitzung an eXocortex und lässt sie verdichten. |

Die Hooks scheitern leise. Wer keine Konfiguration findet, tut nichts und
beendet sich mit 0. Eine kaputte Verbindung darf keine Arbeitssitzung blockieren.

## Installieren

```
/plugin marketplace add HannaPanda/exocortex
/plugin install exocortex@exocortex
```

Beim Aktivieren fragt Claude Code nach zwei Werten:

| Wert                     | Woher                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Adresse deines eXocortex | Die aus der Browser-Zeile, ohne Pfad. Für die öffentliche Instanz `https://exocortex.app`.                                      |
| API-Token                | In der Oberfläche unter **Einstellungen, Verbindungen** anlegen, Recht **Lesen und schreiben**. Es wird genau einmal angezeigt. |

Danach:

```
/exocortex:einrichten
```

Das prüft Konfiguration, Werkzeuge und Gedächtnis und sagt im Klartext, was noch
fehlt. Läuft alles, bist du fertig.

**Der Token liegt nie im Plugin.** Das Plugin ist öffentlich und für alle
gleich; Claude Code nimmt das Token verdeckt entgegen und legt es in seinen
Zugangsdaten ab, nicht in `settings.json`.

## Ohne Plugin, nur die Hooks

Die drei `.mjs`-Dateien unter `hooks/` laufen auch allein. Dann gehören sie in
`~/.claude/settings.json` (alle Projekte) oder `.claude/settings.json` (nur
dieses Projekt):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /var/www/exocortex/tools/claude-code-plugin/hooks/session-start.mjs",
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
            "command": "node /var/www/exocortex/tools/claude-code-plugin/hooks/session-end.mjs",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

Der Pfad zeigt auf dieses Verzeichnis auf dem jeweiligen Rechner. Auf einer
Maschine ohne eXocortex-Repo reicht es, den Ordner `hooks/` zu kopieren.

## Wo die Zugangsdaten herkommen

Die Hooks suchen in dieser Reihenfolge und nehmen das erste vollständige Paar:

1. `EXOCORTEX_API_URL` und `EXOCORTEX_API_TOKEN` aus der Umgebung
2. die Konfiguration des Plugins (`CLAUDE_PLUGIN_OPTION_API_URL`, `CLAUDE_PLUGIN_OPTION_API_TOKEN`)
3. `~/.claude/exocortex-memory.json` (`{"apiUrl": "…", "token": "exo_…"}`)
4. `mcpServers.exocortex.env` in `~/.claude.json`

Vier Quellen für zwei Werte sieht nach zu viel aus, ist aber der Grund, warum
für die meisten nichts einzurichten ist: wer den MCP-Server früher von Hand
eingetragen hat, hat die Werte längst irgendwo stehen.

## Ausprobieren

```bash
node tools/claude-code-plugin/skills/einrichten/pruefen.mjs
```

Derselbe Bericht, den `/exocortex:einrichten` liest. Oder nur der Start-Hook:

```bash
echo '{"cwd":"/var/www/exocortex"}' | node tools/claude-code-plugin/hooks/session-start.mjs
```

Kommt JSON mit `additionalContext` zurück, sitzt die Verbindung. Kommt nichts,
gibt es (noch) keine Erinnerungen zu diesem Verzeichnis, oder die Konfiguration
wurde nicht gefunden.

## Abschalten

Die Option **Sitzungen als Erinnerung ablegen** in der Plugin-Konfiguration
(`/plugin`, eXocortex, Konfigurieren) nimmt den Mitschrieb weg und lässt den
MCP-Server stehen. Ohne Plugin geht `EXOCORTEX_MEMORY_DISABLED=1` in der
Umgebung oder `"disabled": true` in `~/.claude/exocortex-memory.json`. Alles
drei wirkt sofort und braucht keinen Eingriff in `settings.json`.

## Was gespeichert wird

Der Mitschrieb geht ausschließlich in den **Memory-Arbeitsbereich**, nie ins
Second Brain: das eine ist Werkzeug der Agenten und darf aufgeräumt werden, das
andere ist ein gepflegtes Gedächtnis für Menschen. Welcher Arbeitsbereich das
ist, entscheidet `isMemory` an der Arbeitsbereichszeile selbst (ADR-023), nicht
eine Einstellung.

Vor dem Senden fallen Werkzeugaufrufe und deren Ausgaben raus. Was ankommt,
wird nicht gespeichert, sondern von einem Modell zu wenigen Stichpunkten
verdichtet; nur die landen als Seite. Sitzungen unterhalb von
`memory.captureMinChars` Zeichen werden gar nicht erst angenommen, und das
Modell darf antworten, dass es nichts zu merken gibt.

## Wann mitgeschrieben wird

Bei jedem Ende einer Sitzung, `/clear` eingeschlossen. Das ist Absicht: `/clear`
sieht nach Unterbrechung aus, ist aber für die meisten der Punkt, an dem ein
Stück Arbeit fertig ist und das nächste anfängt, also genau die Grenze, die eine
Erinnerung haben will. Ausgenommen ist nur `logout`, weil dort niemand in einer
Sitzung war.

Wer viel und kurz `/clear` drückt, dreht `memory.captureMinChars` hoch: alles
darunter wird gar nicht erst angenommen.

Das Datum der Notiz kommt aus dem Mitschrieb (`endedAt`), nicht aus der Uhr.
Wer eine alte Mitschrift von Hand nachspielt, bekommt sie deshalb unter dem Tag
der Sitzung abgelegt und nicht unter dem des Nachlaufs.
