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

```bash
pip install ./integrations/hermes-memory-provider
```

Das Paket hat bewusst keine Laufzeitabhängigkeiten. Es läuft im Hermes-Prozess,
darf dort scheitern dürfen, und ein Abhängigkeitsbaum wäre ein zweiter Weg,
kaputtzugehen.

## Einrichten

Der Eintragspunkt `hermes_agent.memory_providers` meldet den Provider unter dem
Namen `exocortex` an, ein Patch an Hermes ist nicht nötig.

```yaml
memory:
  provider: exocortex
  options:
    project: hermes # unter welcher Seite die Notizen landen
    base_url: https://exocortex.app
    prefetch_enabled: false

compression:
  checkpoint_required: true
  idle_compact_after_seconds: 7200
  proactive_prune_tokens: 48000
  tail_mode: lean
```

Das Token kommt aus der Umgebung, nicht aus dieser Datei:

```bash
export EXOCORTEX_API_TOKEN=exo_…
```

`EXOCORTEX_BASE_URL` und `EXOCORTEX_MEMORY_PROJECT` gehen ebenfalls über die
Umgebung, falls `options` leer bleiben soll. Das Token braucht `write`, und das
Konto dahinter muss Mitglied im Gedächtnis-Arbeitsbereich sein: was ein Agent
darf, entscheidet seine Mitgliedschaft und nicht sein Token
([ADR-019](../../docs/adr/ADR-019-agent-memory-in-its-own-workspace.md)).

Mit einem funktionierenden Checkpoint darf Hermes den alten Kontext deutlich
aggressiver räumen. Zwei Stunden Leerlauf sind für einen persönlichen
Messenger-Agenten ein brauchbarer Anfang: während einer laufenden Unterhaltung
bleibt der Wortlaut, nach einer längeren Pause darf verdichtet werden.
`proactive_prune_tokens` räumt alte, große Werkzeugausgaben ohne zusätzlichen
Modellaufruf weg; vollständig bleiben sie im Hermes Session Store.

## Was passiert

| Hermes ruft        | Der Provider tut                                                                       |
| ------------------ | -------------------------------------------------------------------------------------- |
| `on_session_start` | merkt sich die Sitzungskennung, nach der Checkpoints gruppiert werden                  |
| `on_pre_compress`  | `POST /api/memory/checkpoint`, wartet auf die geschriebene Notiz, wirft bei Fehlschlag |
| `on_session_end`   | ein letzter Checkpoint, der nie wirft: es gibt nichts mehr aufzuhalten                 |
| `prefetch`         | `GET /api/memory/recall` mit fester Zeichenobergrenze, standardmäßig aus               |

`on_pre_compress` gibt eine Zeile zurück, die Hermes im verdichteten Verlauf
behalten kann („eXocortex checkpoint: … · Titel · Adresse"), damit das Gespräch
selbst sagt, wohin die Einzelheiten gegangen sind.

## Zweimal dasselbe kostet nichts

Hermes schickt keine Wiederholungen, es schickt längere Anfänge: beim zweiten
Verdichten stehen die Nachrichten des ersten wieder mit drin. Deshalb schickt
der Provider Nachrichten als Liste, und die API destilliert nur, was neu ist.
Ist alles schon gesichert, antwortet sie mit dem alten Checkpoint und
`deduplicated: true`, ohne ein Modell zu fragen. Das ist ein Erfolg: verdichtet
werden darf.

Gespeichert wird dabei nie der Wortlaut, sondern die Verdichtung plus ein Beleg
aus Prüfsummen und Zahlen. Das Gespräch selbst landet in keiner Datenbank.

## Tests

```bash
pip install -e '.[dev]'
pytest
```

Die Tests brauchen weder Hermes noch eine erreichbare eXocortex-Instanz: der
Provider erbt bewusst von keiner Hermes-Basisklasse, weil die Plugin-API
duck-typed ist und eine Vererbung das Paket überall dort unimportierbar machen
würde, wo Hermes fehlt.
