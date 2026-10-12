# eXocortex für Claude Code

Ein Plugin, das Claude Code an deinen eXocortex hängt. Zwei Dinge stecken darin:

| Teil       | Was er tut                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP-Server | Die Werkzeuge deines eXocortex (`exo_search`, `exo_page_read`, `exo_page_write` und die übrigen) über HTTP, ohne eigenen Prozess auf deinem Rechner.         |
| Zwei Hooks | `SessionStart` holt die Erinnerungen zum Arbeitsverzeichnis in den Kontext, `SessionEnd` schickt die beendete Sitzung an eXocortex und lässt sie verdichten. |

Die Hooks scheitern leise. Wer keine Konfiguration findet, tut nichts und
beendet sich mit 0. Eine kaputte Verbindung darf keine Arbeitssitzung blockieren.
Was passiert ist, schreiben sie stattdessen in einen kleinen Zustandsbericht,
den `/exocortex:einrichten` liest (siehe [Fehlersuche](#fehlersuche)).

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

Die `.mjs`-Dateien unter `hooks/` laufen auch allein. Dann gehören sie in
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

## Aktualisieren

Claude Code holt eine neue Version nur, wenn sich `version` in
`.claude-plugin/plugin.json` ändert. Neue Commits ohne neue Versionsnummer
kommen bei niemandem an, der das Plugin schon installiert hat; deshalb bekommt
jede Änderung an Hooks, Skill oder Manifest eine neue Version.

Automatische Updates sind für Marktplätze außerhalb von Anthropic
**standardmäßig aus**. Zwei Wege:

- **Von Hand:** in der Shell
  `claude plugin marketplace update exocortex` und dann
  `claude plugin update exocortex@exocortex`, danach Claude Code neu starten.
  In einer Sitzung geht dasselbe über `/plugin`, Reiter **Installed**,
  eXocortex, **Update now**.
- **Automatisch:** `/plugin`, Reiter **Marketplaces**, `exocortex` auswählen,
  **Enable auto-update**. Dann aktualisiert Claude Code beim Start selbst; die
  laufende Sitzung behält die alte Version, die nächste lädt die neue.

Welche Version läuft, sagt `claude plugin list` oder der Abschnitt **Hooks** in
`/exocortex:einrichten`.

**Version 1.0.0 verliert den Mitschrieb beim Beenden** (siehe unten). Wer sie
installiert hat, aktualisiert auf 1.1.0 oder neuer.

## Fehlersuche

### Der erste Schritt

```
/exocortex:einrichten
```

Der Bericht geht die Kette Glied für Glied durch und sagt, wo sie reißt:
Konfiguration, Hooks (registriert und zuletzt wirklich gelaufen), MCP-Werkzeuge,
Gedächtnis-API. Hat noch kein Hook-Lauf stattgefunden: einmal mit `/exit`
beenden, neu starten, erneut prüfen. Der Bericht über das Sitzungsende sagt
dann, ob die Sitzung angenommen, verarbeitet und als Notiz geschrieben wurde,
und der über den nächsten Start, ob genau diese Notiz zurückkam.

Liegt das Token in der Umgebung oder in einer Datei (nicht in der
Plugin-Konfiguration), geht zusätzlich ein vollständiger Test:

```bash
node tools/claude-code-plugin/skills/einrichten/pruefen.mjs --ende-zu-ende
```

Er schickt eine markierte Testsitzung unter dem Projekt `exocortex-selbsttest`,
wartet auf die Verarbeitung, prüft den Abruf und archiviert die Testnotiz
wieder. Ein HTTP 200 allein zählt dabei nicht als Erfolg.

### Was die Stufen bedeuten

| Stufe im Bericht                                                                              | Bedeutung                                                                                                                | Was tun                                                                      |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| noch nie beobachtet                                                                           | Der Hook ist nie gelaufen.                                                                                               | Plugin aktiviert? Claude Code neu gestartet? `claude plugin list`            |
| `no_config`                                                                                   | Hook lief, fand aber Adresse oder Token nicht. Der Bericht sagt, welche Variable gefehlt hat.                            | `/plugin`, eXocortex, Konfigurieren                                          |
| `recall_failed`, `capture_failed`                                                             | Server nicht erreicht oder Statuscode ungleich 2xx (401/403: Token, 5xx: Server).                                        | Adresse und Token prüfen; bei 5xx das Log von `exocortex-api`                |
| `capture_rejected`                                                                            | Server hat die Sitzung nicht angenommen: zu kurz (`memory.captureMinChars`), Gedächtnis aus, kein Memory-Arbeitsbereich. | Die genannte Einstellung prüfen. Zu kurz ist bei Mini-Sitzungen gewollt.     |
| `queued`, `still_pending`                                                                     | Angenommen, aber noch kein Ergebnis aus dem Worker.                                                                      | Läuft `exocortex-worker`? Ist die Warteschlange voll?                        |
| `processed` mit `nothing_to_remember`                                                         | Kette steht, das Modell fand nichts Merkenswertes.                                                                       | Nichts. Kurze Plauder-Sitzungen bleiben absichtlich leer.                    |
| `processed` mit `distill_failed`, `write_failed`, `service_token_missing`, `feature_disabled` | Der Worker ist gescheitert, der Grund steht dabei.                                                                       | Serverseitig: Modell, `SERVICE_TOKEN_SECRET`, `ai.enabled`, `memory.enabled` |
| `processed` mit `written`                                                                     | Notiz geschrieben. Der nächste Start meldet, ob sie beim Abruf zurückkam.                                                | Nichts.                                                                      |

### Warum 1.0.0 extern nichts gespeichert hat

Claude Code gibt allen `SessionEnd`-Hooks zusammen **1,5 Sekunden** und bricht
sie dann ab. Ein `timeout` in `settings.json` hebt dieses Budget an, ein
`timeout` in der `hooks.json` eines Plugins nicht. Gemessen mit Claude Code
2.1.296: derselbe Hook lief aus `--settings` zehn Sekunden durch und wurde als
Plugin-Hook nach 1,5 Sekunden beendet. Node starten, die Mitschrift lesen und
hochladen passte nicht verlässlich hinein. Auf Rechnern mit Handbetrieb
(Hooks in `settings.json`, `timeout: 15`) fiel das nie auf.

Seit 1.1.0 startet der Hook die Übertragung als eigenen, abgekoppelten Prozess
(`hooks/capture.mjs`) und beendet sich sofort. Das Token reist dabei nur in der
Prozessumgebung, nie in einer Datei.

Der zweite Verdacht von damals, dass das verdeckt gespeicherte Token die Hooks
nicht erreicht, hat sich nicht bestätigt: Claude Code reicht jede
Plugin-Option, auch eine verdeckte, als `CLAUDE_PLUGIN_OPTION_<KEY>` an Hooks
weiter. Einem Bash-Befehl, also auch `pruefen.mjs`, gibt es sie nicht; deshalb
liest die Prüfung den Bericht der Hooks.

### Zustandsbericht und Diagnoseprotokoll

Beide liegen in `~/.claude/exocortex-memory/` (unter `CLAUDE_CONFIG_DIR`, wenn
gesetzt), Verzeichnis `0700`, Dateien `0600`.

- **`state.json`** wird immer geschrieben: je ein Eintrag für den letzten Start
  und das letzte Ende, jedes Mal überschrieben, ein paar hundert Bytes.
- **`debug.log`** nur auf Wunsch: Plugin-Option **Diagnoseprotokoll schreiben**
  (`/plugin`, eXocortex, Konfigurieren) oder `EXOCORTEX_MEMORY_DEBUG=1` in der
  Umgebung, für Plugin-Nutzer am einfachsten unter `env` in
  `~/.claude/settings.json`. Eine Zeile pro Schritt, ab 256 KiB rotiert nach
  `debug.log.1`, beide zusammen also höchstens ein halbes MiB.

Was darin steht: Zeitpunkt, Ereignis, Hook-Version, die **Quelle** der
Konfiguration (nicht ihre Werte), ob die Plugin-Variablen gesetzt waren (ja oder
nein), welche Eingabefelder Claude Code geliefert hat, ob die Mitschrift lesbar
war und wie viele Zeichen nach dem Filtern übrig blieben, eine Projektkennung
(ein Hash des Verzeichnisses, nicht der Pfad), Statuscodes und Zeitüberschreitungen,
Annahme oder Ablehnung samt Grund, Job-Ergebnis und Trefferzahl.

Was nie darin steht: Token, Authorization-Header, Adressen, Pfade,
Nachrichten, Mitschriften. Das erzwingt eine Positivliste in
`hooks/diagnostics.mjs`: ein Feld, das nicht auf ihr steht, fällt weg, und
alles, was wie ein Token aussieht, wird ersetzt.

### Diagnose weitergeben

`state.json` und `debug.log` sind so gebaut, dass man sie weitergeben kann. Vor
dem Schicken trotzdem einmal hineinschauen: es sind Textdateien. Gut zum
Weitergeben sind außerdem die Ausgabe von `/exocortex:einrichten` (das Token
steht dort nur gekürzt) und `claude plugin list`. Nicht weitergeben:
`~/.claude.json`, `~/.claude/settings.json` und `.credentials.json`.

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
