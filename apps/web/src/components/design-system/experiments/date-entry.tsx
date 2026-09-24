'use client';

import { CalendarIcon } from 'lucide-react';
import * as React from 'react';

import {
  Button,
  Calendar,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@exocortex/ui';

import { FIXTURE_DATE } from '../fixtures';
import { DsSection } from '../showcase';

import { DsExperimentBrief, DsVariant, DsVariants } from './frame';

/**
 * The open decision "Kalender-Baustein": is `Calendar` the way a date is
 * entered, or does it leave the repository?
 *
 * Variant A is what the product does today in every date field. Variant B is
 * the installed `Calendar` behind a button in a `Popover`, which exists
 * nowhere in the product; if it wins, it becomes one shared date field in
 * `packages/ui` rather than nine hand-made popovers. Both variants start on
 * the same day and name the same field.
 */

const FIELD = 'Fällig am';

/** `YYYY-MM-DD` read as a local day, never as UTC midnight. */
function fromIso(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

const LONG_DATE = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

function NativeDate() {
  const [value, setValue] = React.useState(FIXTURE_DATE);
  return (
    <div className="flex max-w-xs flex-col gap-1.5">
      <Label htmlFor="ds-date-native">{FIELD}</Label>
      <Input
        id="ds-date-native"
        type="date"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">Gewählt: {value || 'nichts'}</p>
    </div>
  );
}

function CalendarDate() {
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState<Date | undefined>(() => fromIso(FIXTURE_DATE));
  return (
    <div className="flex max-w-xs flex-col gap-1.5">
      <Label id="ds-date-calendar-label">{FIELD}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              className="justify-start font-normal"
              aria-labelledby="ds-date-calendar-label ds-date-calendar-value"
            />
          }
        >
          <CalendarIcon />
          <span id="ds-date-calendar-value">
            {value === undefined ? 'Datum wählen' : LONG_DATE.format(value)}
          </span>
        </PopoverTrigger>
        {/* The day picker focuses the chosen day itself; the popover's own
            initial focus would land on "previous month" instead. */}
        <PopoverContent align="start" className="w-auto p-0" initialFocus={false}>
          <Calendar
            autoFocus
            mode="single"
            selected={value}
            defaultMonth={value}
            onSelect={(day) => {
              setValue(day);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      <p className="text-xs text-muted-foreground">
        Gewählt: {value === undefined ? 'nichts' : LONG_DATE.format(value)}
      </p>
    </div>
  );
}

export function DateEntryExperiment() {
  return (
    <DsSection
      id="experiment-datum"
      title="Datumseingabe"
      lead="Offene Entscheidung Kalender-Baustein: das Datumsfeld des Browsers, wie überall in der Anwendung, oder der eigene Kalender in einem Popover."
    >
      <DsExperimentBrief
        problem="Neun Stellen nehmen heute ein Datum entgegen, alle mit dem Feld des Browsers. Der Baustein Calendar ist installiert und nirgends benutzt. Entweder er wird das eine Datumsfeld der Anwendung, oder er fliegt raus."
        width="Desktop und 390 px; auf dem Telefon öffnet A das Datumsrad des Systems"
        keyboard="A: Tab ins Feld, Pfeil hoch und runter ändern Tag, Monat, Jahr, Alt+Pfeil runter öffnet den Aufklapper. B: Enter öffnet, Pfeiltasten wandern durch die Tage, Bild auf und ab wechseln den Monat, Enter wählt, Escape schließt."
        sources={[
          'packages/ui/src/components/ui/input.tsx',
          'packages/ui/src/components/ui/calendar.tsx',
          'apps/web/src/components/database/cells.tsx',
        ]}
      />
      <DsVariants>
        <DsVariant
          name="A · Feld des Browsers"
          tradeoffs={[
            'Tippen und Wählen in einem: 05.10.2026 lässt sich direkt eintippen.',
            'Auf dem Telefon das Datumsrad des Systems, das jeder kennt.',
            'Der Aufklapper gehört dem Browser: in Chrome, Firefox und Safari sieht er jeweils anders aus und folgt nicht den Farben der Anwendung.',
            'Kein Code, keine Abhängigkeit; Calendar und react-day-picker würden entfernt.',
          ]}
        >
          <NativeDate />
        </DsVariant>
        <DsVariant
          name="B · Kalender im Popover"
          tradeoffs={[
            'Sieht überall gleich aus, in den Farben und mit dem Fokusring der Anwendung.',
            'Der Wochentag steht im Knopf; ein Monat ist auf einen Blick zu sehen.',
            'Kein Eintippen: ein Datum in drei Jahren braucht viele Klicks, außer man baut Monats- und Jahresauswahl dazu.',
            'Uhrzeit fehlt; für Datum und Uhrzeit bräuchte es ein zweites Feld daneben.',
            'Neun Stellen umbauen, dazu Tests und Vergleichsbilder, etwa ein halber Tag.',
          ]}
        >
          <CalendarDate />
        </DsVariant>
      </DsVariants>
    </DsSection>
  );
}
