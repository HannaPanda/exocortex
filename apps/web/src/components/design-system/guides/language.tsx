'use client';

import * as React from 'react';

import { Badge, TruncatedText } from '@exocortex/ui';

import { formatRelativeTime } from '@/lib/relative-time';

import { DsExample, DsSection, DsSource, DsState, DsStates } from '../showcase';

/**
 * The interface's language. The counts are the audit's
 * (`docs/design-system-inventory.md` §2.7), and #129 settled every pair.
 * A pair that starts competing again is shown as competing, not quietly
 * decided here.
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
    note: 'überall, auch beim Chat, der als Seite gespeichert wird',
    settled: true,
  },
  {
    use: 'Fenster zumachen',
    word: 'Schließen',
    note: 'überall; „Fertig“ gibt es nicht mehr',
    settled: true,
  },
  {
    use: 'Etwas Neues anlegen',
    word: 'Anlegen',
    note: 'überall, auch für Tokens',
    settled: true,
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
    word: 'Zurückziehen',
    note: 'Freigaben, Einladungen, Tokens. „Zurücknehmen“ ist etwas anderes: es macht die Schreibvorgänge einer Agentensitzung rückgängig',
    settled: true,
  },
];

const TERMS: readonly Word[] = [
  { use: 'Das Dokument', word: 'Seite', note: 'einheitlich', settled: true },
  { use: 'Der Raum für Seiten', word: 'Arbeitsbereich', note: 'einmal „Workspace“', settled: true },
  { use: 'Die eingebaute KI', word: 'KI', note: 'einheitlich', settled: true },
  { use: 'Die Kopiervorlage', word: 'Vorlage', note: 'einheitlich', settled: true },
  { use: 'Ein Link auf eine Seite', word: 'Verweis', note: 'einheitlich', settled: true },
  { use: 'Die Tabelle aus Seiten', word: 'Datenbank', note: 'einheitlich', settled: true },
  {
    use: 'Ein Gespräch mit der KI',
    word: 'Chat',
    note: 'einheitlich, auch in Fehlern und Einstellungen',
    settled: true,
  },
  {
    use: 'Wohin weggeräumte Seiten gehen',
    word: 'Papierkorb',
    note: '„In den Papierkorb“, „Im Papierkorb“. „Archivieren“ gibt es nur bei Chats, die aufbewahrt und ausgeblendet werden',
    settled: true,
  },
];

/**
 * A list rather than a table: a reference is read on a phone too, and a table
 * there scrolls sideways with the column that explains the word off screen,
 * which is exactly the open question P12 is about.
 */
function WordList({ label, words }: { label: string; words: readonly Word[] }) {
  return (
    <ul aria-label={label} className="flex flex-col divide-y divide-border text-sm">
      {words.map((entry) => (
        <li
          key={entry.use}
          className="grid gap-x-6 gap-y-1 py-2.5 sm:grid-cols-[minmax(0,14rem)_8rem_minmax(0,1fr)] sm:items-baseline"
        >
          <span className="text-muted-foreground">{entry.use}</span>
          <span className="flex items-center gap-2 font-medium sm:block">
            {entry.word}
            <Badge variant={entry.settled ? 'secondary' : 'outline'} className="sm:hidden">
              {entry.settled ? 'einheitlich' : 'uneinheitlich'}
            </Badge>
          </span>
          <span className="flex flex-wrap items-baseline gap-2 text-muted-foreground">
            <Badge
              variant={entry.settled ? 'secondary' : 'outline'}
              className="hidden sm:inline-flex"
            >
              {entry.settled ? 'einheitlich' : 'uneinheitlich'}
            </Badge>
            {entry.note}
          </span>
        </li>
      ))}
    </ul>
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
        note="Auslöser und Bestätigung benutzen dasselbe Wort: wer „Endgültig löschen“ drückt, bestätigt mit „Endgültig löschen“, wer „Zurückziehen“ drückt, mit „Zurückziehen“."
      >
        <WordList label="Wörter für Handlungen" words={ACTIONS} />
      </DsExample>

      <DsExample id="sprache-begriffe" title="Begriffe">
        <WordList label="Begriffe der Anwendung" words={TERMS} />
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
              Was nicht ging, dann der nächste Schritt. Jeder API-Fehlercode hat einen Satz in{' '}
              <DsSource path="packages/i18n/src/messages/de/errors.json" />; ein lokales „…
              fehlgeschlagen.“ ist die Ausnahme, nicht die Regel.
            </span>
          </li>
          <li>
            <span className="font-medium">Leer:</span>{' '}
            <span className="text-muted-foreground">
              „Noch keine …“, wenn es etwas geben kann, „… nicht geladen“, wenn der Abruf
              scheiterte, und „Nichts gefunden“, wenn eine Suche leer ausgeht. Ein Zustand, ein
              Titel.
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
