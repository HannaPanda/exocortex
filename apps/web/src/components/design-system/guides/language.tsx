'use client';

import * as React from 'react';

import {
  Badge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TruncatedText,
} from '@exocortex/ui';

import { formatRelativeTime } from '@/lib/relative-time';

import { DsExample, DsSection, DsSource, DsState, DsStates } from '../showcase';

/**
 * The interface's language. The counts are the audit's
 * (`docs/design-system-inventory.md` §2.7), and a pair of words that still
 * competes is shown as competing: choosing between them is a decision for
 * #129, not for this page.
 */

interface Word {
  use: string;
  word: string;
  note: string;
  settled: boolean;
}

const ACTIONS: readonly Word[] = [
  { use: 'Vorgang verwerfen', word: 'Abbrechen', note: '39 Stellen', settled: true },
  {
    use: 'Änderungen sichern',
    word: 'Speichern',
    note: '17 Stellen, einmal „Sichern“',
    settled: false,
  },
  {
    use: 'Fenster zumachen',
    word: 'Schließen',
    note: '10 Stellen, zweimal „Fertig“',
    settled: false,
  },
  {
    use: 'Etwas Neues anlegen',
    word: 'Anlegen',
    note: '8 Stellen, einmal „Erstellen“',
    settled: false,
  },
  {
    use: 'Weg für immer',
    word: 'Löschen',
    note: 'für Blöcke, Kommentare, Ansichten',
    settled: false,
  },
  {
    use: 'Aus einer Beziehung nehmen',
    word: 'Entfernen',
    note: 'für Verweise, Titelbilder, Eigenschaften, Filter, Mitglieder',
    settled: false,
  },
  {
    use: 'Zugang beenden',
    word: 'Widerrufen',
    note: 'Tokens; Freigaben sagen „Zurückziehen“, Agentensitzungen „zurücknehmen“',
    settled: false,
  },
];

const TERMS: readonly Word[] = [
  { use: 'Das Dokument', word: 'Seite', note: 'einheitlich', settled: true },
  { use: 'Der Raum für Seiten', word: 'Arbeitsbereich', note: 'einmal „Workspace“', settled: true },
  { use: 'Die eingebaute KI', word: 'KI', note: 'einheitlich', settled: true },
  { use: 'Die Kopiervorlage', word: 'Vorlage', note: 'einheitlich', settled: true },
  { use: 'Ein Link auf eine Seite', word: 'Verweis', note: 'einheitlich', settled: true },
  { use: 'Die Tabelle aus Seiten', word: 'Datenbank', note: 'einmal „Sammlung“', settled: false },
  {
    use: 'Ein Gespräch mit der KI',
    word: 'Chat',
    note: 'im Leser und in Fehlern „Unterhaltung“',
    settled: false,
  },
  {
    use: 'Wohin archivierte Seiten gehen',
    word: 'Papierkorb',
    note: 'die Handlung heißt „Archivieren“, die Seiten „Archiviert“; offen',
    settled: false,
  },
];

function WordTable({ caption, words }: { caption: string; words: readonly Word[] }) {
  return (
    <Table>
      <TableCaption className="exocortex-sr-only">{caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Wofür</TableHead>
          <TableHead>Wort</TableHead>
          <TableHead>Stand</TableHead>
          <TableHead>Im Bestand</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {words.map((entry) => (
          <TableRow key={entry.use}>
            <TableCell>{entry.use}</TableCell>
            <TableCell className="font-medium">{entry.word}</TableCell>
            <TableCell>
              <Badge variant={entry.settled ? 'secondary' : 'outline'}>
                {entry.settled ? 'einheitlich' : 'uneinheitlich'}
              </Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">{entry.note}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const MINUTE = 60_000;
const AGES: readonly { label: string; minutes: number }[] = [
  { label: 'gerade', minutes: 0 },
  { label: 'vor Minuten', minutes: 12 },
  { label: 'vor Stunden', minutes: 5 * 60 },
  { label: 'gestern', minutes: 24 * 60 },
  { label: 'vor Tagen', minutes: 9 * 24 * 60 },
  { label: 'vor Monaten', minutes: 80 * 24 * 60 },
];

function RelativeTimes() {
  // Read once, so the six labels are measured from the same moment.
  const [now] = React.useState(() => Date.now());
  return (
    <DsStates>
      {AGES.map((age) => (
        <DsState key={age.label} label={age.label}>
          <span className="text-sm">
            {formatRelativeTime(new Date(now - age.minutes * MINUTE).toISOString())}
          </span>
        </DsState>
      ))}
    </DsStates>
  );
}

export function LanguageSection() {
  return (
    <DsSection
      id="sprache"
      title="Sprache"
      lead="Deutsch, du, kurz. Ein Knopf sagt, was er tut, mit einem Verb. Ein Ding hat einen Namen, überall derselbe."
    >
      <DsExample
        id="sprache-handlungen"
        title="Handlungen"
        note="Auslöser und Bestätigung benutzen dasselbe Wort: wer „Endgültig löschen“ drückt, bestätigt mit „Endgültig löschen“. Heute antwortet der Papierkorb darauf mit „Unwiderruflich löschen“ (Issue #129)."
      >
        <WordTable caption="Wörter für Handlungen" words={ACTIONS} />
      </DsExample>

      <DsExample id="sprache-begriffe" title="Begriffe">
        <WordTable caption="Begriffe der Anwendung" words={TERMS} />
      </DsExample>

      <DsExample
        id="sprache-bestaetigung-fehler"
        title="Bestätigung, Fehler, leere Zustände"
        note="Wie diese Sätze gebaut sind, zeigen die Muster Bestätigung und Laden, leer, Fehler."
      >
        <ul className="flex max-w-measure flex-col gap-3 text-sm">
          <li>
            <span className="font-medium">Bestätigung:</span>{' '}
            <span className="text-muted-foreground">
              Der Titel ist eine Frage („Endgültig löschen?“), die Beschreibung zählt die Folgen und
              sagt, ob es sich rückgängig machen lässt. Keine unechten Plurale wie „Seite(n)“: die
              Zahl entscheidet die Form.
            </span>
          </li>
          <li>
            <span className="font-medium">Fehler:</span>{' '}
            <span className="text-muted-foreground">
              Was nicht ging, dann der nächste Schritt. Jeder API-Fehlercode hat einen deutschen
              Satz in <DsSource path="apps/web/src/lib/api/error-messages.ts" />; ein lokales „…
              fehlgeschlagen.“ ist die Ausnahme, nicht die Regel.
            </span>
          </li>
          <li>
            <span className="font-medium">Leer:</span>{' '}
            <span className="text-muted-foreground">
              „Noch keine …“, wenn es etwas geben kann, „… nicht geladen“, wenn der Abruf
              scheiterte. Für einen Zustand gibt es heute teils zwei Titel („Nichts gefunden“ und
              „Keine Treffer“).
            </span>
          </li>
        </ul>
      </DsExample>

      <DsExample
        id="sprache-zeit-zahlen"
        title="Zeit und Zahlen"
        source="apps/web/src/lib/relative-time.ts"
        note="Wie lange etwas her ist, sagt eine gemeinsame Funktion. Für absolute Daten und für Zahlen gibt es noch keine: fünfzehn Dateien bauen ihr eigenes Datumsformat, acht ihr eigenes Zahlenformat, alle mit de-DE (Inventar Lücke 5)."
      >
        <RelativeTimes />
      </DsExample>

      <DsExample
        id="sprache-kuerzen"
        title="Kürzen"
        source="packages/ui/src/components/truncated-text.tsx"
        note="Abgeschnitten wird mit …, und wo der ganze Text erreichbar bleiben muss, zeigt ihn ein Tooltip, sobald er wirklich abgeschnitten ist. Zeige auf die Zeile oder tippe sie an."
      >
        <div className="w-56 rounded-md bg-surface px-2 py-1 text-sm">
          <TruncatedText text="Kapitel 2: Methoden und Material der Voruntersuchung" />
        </div>
      </DsExample>
    </DsSection>
  );
}
