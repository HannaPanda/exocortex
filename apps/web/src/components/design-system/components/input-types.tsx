'use client';

import * as React from 'react';

import { Input, Label } from '@exocortex/ui';

import { FIXTURE_DATE, FIXTURE_DATE_TIME } from '../fixtures';
import { DsExample } from '../showcase';

/**
 * Every `type` the product gives an `<input>`, drawn through the same `Input`.
 *
 * The browser owns most of what these look like: the date and time pickers,
 * the spin buttons of a number, the reveal of a password. What the product
 * owns is the frame around them, and `color-scheme: dark` in `tokens.css`,
 * which is what turns the native popups dark. This example is where both are
 * seen together, and where the native date picker is judged against the
 * `Calendar` experiment. The file inputs are left out on purpose: the product
 * never shows one, every upload is a button that opens a hidden input.
 */

interface InputType {
  type: string;
  label: string;
  /** Where the product uses it, so the example can be checked against it. */
  usedIn: string;
  value?: string;
  placeholder?: string;
}

const INPUT_TYPES: readonly InputType[] = [
  {
    type: 'number',
    label: 'Zahl',
    usedIn: 'Datenbankzellen, Einstellungen, Modelle',
    value: '2400',
  },
  {
    type: 'date',
    label: 'Datum',
    usedIn: 'Datenbankzellen, Filter, Kalender, gespeicherte Suchen',
    value: FIXTURE_DATE,
  },
  {
    type: 'datetime-local',
    label: 'Datum und Uhrzeit',
    usedIn: 'Datenbankzellen mit Uhrzeit, einmalige Zeitpläne',
    value: FIXTURE_DATE_TIME,
  },
  { type: 'time', label: 'Uhrzeit', usedIn: 'Zeitpläne von Automationen', value: '07:30' },
  {
    type: 'email',
    label: 'E-Mail',
    usedIn: 'Anmeldung, Einladungen, Freigaben',
    placeholder: 'name@beispiel.de',
  },
  {
    type: 'password',
    label: 'Passwort',
    usedIn: 'Anmeldung, Einladung annehmen, API-Schlüssel',
    value: 'geheim-123',
  },
  { type: 'search', label: 'Suche', usedIn: 'Hilfe, eigene Freigaben', value: 'Messreihe' },
  {
    type: 'url',
    label: 'Adresse',
    usedIn: 'Schnell erfassen',
    placeholder: 'https://',
  },
];

export function InputTypesExample() {
  const [position, setPosition] = React.useState(40);
  return (
    <DsExample
      id="feld-typen"
      title="Eingabetypen"
      source="packages/ui/src/components/ui/input.tsx"
      note="Alle Typen, die die Anwendung einem Feld gibt. Die Aufklapper für Datum und Uhrzeit, die Pfeile der Zahl und das Auge am Passwort zeichnet der Browser; dunkel sind sie über color-scheme in tokens.css. Dateifelder zeigt die Anwendung nie, jeder Upload ist ein Knopf."
    >
      <div className="grid gap-6 sm:grid-cols-2">
        {INPUT_TYPES.map((entry) => {
          const id = `ds-input-type-${entry.type}`;
          return (
            <div key={entry.type} className="flex flex-col gap-1.5">
              <Label htmlFor={id}>
                {entry.label}{' '}
                <span className="font-normal text-muted-foreground">· {entry.type}</span>
              </Label>
              <Input
                id={id}
                type={entry.type}
                defaultValue={entry.value}
                placeholder={entry.placeholder}
                aria-describedby={`${id}-used`}
              />
              <p id={`${id}-used`} className="text-xs text-muted-foreground">
                {entry.usedIn}
              </p>
            </div>
          );
        })}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ds-input-type-range">
            Schieberegler <span className="font-normal text-muted-foreground">· range</span>
          </Label>
          <input
            id="ds-input-type-range"
            type="range"
            min={0}
            max={100}
            value={position}
            onChange={(event) => setPosition(Number(event.target.value))}
            aria-describedby="ds-input-type-range-used"
          />
          <p id="ds-input-type-range-used" className="text-xs text-muted-foreground">
            Bildausschnitt des Titelbilds. Ohne Input-Rahmen, wie im Produkt: {position} %
          </p>
        </div>
      </div>
    </DsExample>
  );
}
