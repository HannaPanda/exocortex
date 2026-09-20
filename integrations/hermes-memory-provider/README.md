# eXocortex als Hermes Memory Provider

Hermes verdichtet einen langen Gesprächsverlauf, indem es den alten Teil
zusammenfasst und den Wortlaut wegwirft. Dieses Paket hängt sich in genau diesen
Moment: bevor verdichtet wird, legt es den betroffenen Teil in eXocortex ab und
gibt erst zurück, wenn die Notiz geschrieben ist. Schlägt das fehl und läuft
Hermes mit `checkpoint_required: true`, unterbleibt das Verdichten und der
Wortlaut bleibt erhalten.

Hintergrund und die Entscheidungen dahinter:
[ADR-046](../../docs/adr/ADR-046-a-checkpoint-is-a-receipt-not-an-archive.md),
Issue #92.

## Installieren

In **dasselbe** Python-Environment, in dem Hermes läuft:

```bash
~/.hermes/hermes-agent/venv/bin/python -m pip install \
  /var/www/exocortex/integrations/hermes-memory-provider
```

Das Paket hat keine Laufzeitabhängigkeiten, auch nicht Hermes selbst: es läuft
im Hermes-Prozess, darf dort scheitern dürfen, und ein Abhängigkeitsbaum wäre
ein zweiter Weg, kaputtzugehen. `urllib` reicht für einen POST.

Gefunden wird es über den Eintragspunkt `hermes_agent.memory_providers`, ein
Patch am Hermes-Upstream ist nicht nötig. Prüfen, ob Hermes es sieht:

```bash
~/.hermes/hermes-agent/venv/bin/python -c "
import sys; sys.path.insert(0, '$HOME/.hermes/hermes-agent')
from plugins.memory import load_memory_provider
p = load_memory_provider('exocortex')
print(p.name, p.pre_compress_checkpoint_api_version, p.is_available(), p.unavailable_reason())
"
```

## Einrichten

Das Token kommt aus der Umgebung, nicht aus `config.yaml`. In `~/.hermes/.env`:

```bash
EXOCORTEX_API_TOKEN=exo_…
```

Alles andere steht unter `memory.exocortex` in `~/.hermes/config.yaml`:

```yaml
memory:
  provider: exocortex
  exocortex:
    base_url: http://127.0.0.1:3211 # oder https://exocortex.app von außerhalb
    project: hermes
    prefetch_enabled: false

compression:
  checkpoint_required: true
  idle_compact_after_seconds: 7200
  proactive_prune_tokens: 48000
  tail_mode: lean
```

`hermes memory setup` fragt dieselben Felder ab und schreibt das Token von
selbst nach `.env`, weil es im Schema als `secret` markiert ist.

Das Token braucht `write`, und das Konto dahinter muss Mitglied im
Gedächtnis-Arbeitsbereich sein: was ein Agent darf, entscheidet seine
Mitgliedschaft und nicht sein Token
([ADR-019](../../docs/adr/ADR-019-agent-memory-in-its-own-workspace.md)). Ein
passendes Token anlegen:

```bash
pnpm --filter @exocortex/api token:create -- \
  --email agent-memory@exocortex.app --name "Hermes memory provider" --scopes read,write
```

**`checkpoint_required` erst einschalten, wenn der Rest läuft.** Der Schalter tut
genau das, was er verspricht: ist eXocortex nicht erreichbar, kann Hermes nicht
mehr verdichten. Ohne ihn werden die Checkpoints trotzdem bei jeder Verdichtung
geschrieben, nur ohne Sperre.

Mit funktionierendem Checkpoint darf Hermes den alten Kontext deutlich
aggressiver räumen. Zwei Stunden Leerlauf sind für einen persönlichen
Messenger-Agenten ein brauchbarer Anfang: während einer laufenden Unterhaltung
bleibt der Wortlaut, nach einer längeren Pause darf verdichtet werden.
`proactive_prune_tokens` räumt alte, große Werkzeugausgaben ohne zusätzlichen
Modellaufruf weg; vollständig bleiben sie im Hermes Session Store.

## Was passiert

| Hermes ruft         | Der Provider tut                                                                        |
| ------------------- | --------------------------------------------------------------------------------------- |
| `is_available`      | prüft nur die Konfiguration, kein Netz: das steht vor jeder Auflistung                  |
| `initialize`        | merkt sich Sitzungskennung und Agentenkontext                                           |
| `on_pre_compress`   | `POST /api/memory/checkpoint`, wartet auf die Notiz, wirft bei Fehlschlag               |
| `on_session_switch` | bindet neu, wenn `/resume`, `/branch` oder eine Verdichtung die Kennung tauscht         |
| `on_session_end`    | ein letzter Checkpoint, der nie wirft: es gibt nichts mehr aufzuhalten                  |
| `queue_prefetch`    | holt im Hintergrund `GET /api/memory/recall`, standardmäßig aus                         |
| `prefetch`          | gibt zurück, was der Hintergrundlauf fand, und leert den Puffer                         |
| `get_tool_schemas`  | nichts: der `exo_*`-Katalog über MCP ist der Weg, auf dem ein Modell eXocortex erreicht |

`on_pre_compress` gibt eine Zeile zurück, die Hermes in den
Zusammenfassungs-Prompt faltet („eXocortex checkpoint: … · Titel · Adresse"),
damit der verdichtete Verlauf selbst sagt, wohin die Einzelheiten gegangen sind.

## Zweimal dasselbe kostet nichts

Hermes schickt keine Wiederholungen, es schickt längere Anfänge: beim zweiten
Verdichten stehen die Nachrichten des ersten wieder mit drin. Deshalb schickt
der Provider Nachrichten als Liste, und die API destilliert nur, was neu ist.
Ist alles schon gesichert, antwortet sie mit dem alten Checkpoint und
`deduplicated: true`, ohne ein Modell zu fragen. Das ist ein Erfolg: verdichtet
werden darf.

Gespeichert wird dabei nie der Wortlaut, sondern die Verdichtung plus ein Beleg
aus Prüfsummen und Zahlen. Das Gespräch selbst landet in keiner Datenbank.

## Nicht nur für Hermes

Der Endpunkt ist eine gewöhnliche authentifizierte REST-Route hinter demselben
nginx wie alles andere. Jede Agentenlaufzeit, die ein Bearer-Token halten kann,
checkpointet darüber, auch über das öffentliche Netz:

```bash
curl -X POST https://exocortex.app/api/memory/checkpoint \
  -H "authorization: Bearer $EXOCORTEX_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"project":"mein-agent","client":"other","sessionId":"abc-123",
       "messages":[{"role":"user","text":"…"},{"role":"assistant","text":"…"}]}'
```

Dieses Paket ist ein Client davon, nicht die Schnittstelle.

## Tests

```bash
pip install -e '.[dev]'
pytest
```

Die Tests brauchen weder Hermes noch eine erreichbare eXocortex-Instanz. Wo
Hermes fehlt, tritt der Platzhalter aus `base.py` an die Stelle der
Basisklasse; geladen wird er nie, er sorgt nur dafür, dass das Modul importiert.
