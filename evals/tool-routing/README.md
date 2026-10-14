# Goldstandard für die Werkzeugauswahl (#206)

`gold.json` ist der Prüfsatz, gegen den jede Auswahl der Werkzeugdomänen des
eingebauten Agenten gemessen wird: die heutige Stichwortauswahl, eine um
Kontextsignale erweiterte, und semantische Kandidaten wie Jev (#108).

## Aufbau

Eine **Gruppe** ist eine Bedeutung. Sie trägt die erwarteten Domänen von Hand,
einmal, und darunter dieselbe Aufgabe in mehreren Sprachen. Die Labels hängen
an der Gruppe und nie an einer Übersetzung, deshalb kann eine schlechte
Übersetzung eine Messung verfälschen, aber nie die Wahrheit verschieben.

| Feld         | Bedeutung                                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `split`      | `dev` darf zum Abstimmen von Fragen und Schwellen benutzt werden, `holdout` nur für die abschließende Auswahl. Wer am Holdout stimmt, hat keinen Holdout. |
| `kind`       | `direct`, `synonym`, `indirect`, `colloquial`, `multi`, `context`, `negative`, `mixed`                                                                    |
| `expected`   | optionale Domänen, ohne die die Aufgabe nicht lösbar ist. `core` und `pages` fehlen immer, sie werden jedem Lauf angeboten.                               |
| `acceptable` | Domänen, deren Angebot nicht falsch ist (zählt nicht als unnötig).                                                                                        |
| `context`    | was ein Lauf ohne Modellaufruf schon weiß: `databaseViewOpen`, `pageAttachments` (`image`, `pdf`)                                                         |
| `texts`      | Sprache → Aufgabe. `mixed` ist eine Liste sprachgemischter Fassungen.                                                                                     |

Sprachen: die acht Oberflächensprachen (`de en fr es it nl pl pt-BR`) und
`zh ja ar` als Robustheitsfälle ohne eigene Oberfläche.

Die Übersetzungen sind von einem Modell geschrieben (Claude, 2026-10-14) und
nicht von Muttersprachlern geprüft. Sie sind als natürliche Formulierungen
gedacht, nicht als wörtliche Übertragungen, damit Synonyme vorkommen. Wer
eine Sprache spricht und eine Fassung unnatürlich findet: korrigieren, die
Gruppe bleibt dieselbe.

Ausführen: `node scripts/tool-routing-eval.mjs --help`.
