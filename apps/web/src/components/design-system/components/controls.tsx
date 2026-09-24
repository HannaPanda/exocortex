'use client';

import { BoldIcon, ItalicIcon, PlusIcon, TrashIcon, UnderlineIcon } from 'lucide-react';
import * as React from 'react';

import {
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Toggle,
  ToggleGroup,
} from '@exocortex/ui';

import { DsExample, DsSection, DsState, DsStates } from '../showcase';

/**
 * Buttons, form fields, toggles and tabs: the controls a person touches, each
 * in the states it actually implements. Hover, focus and press are left to the
 * pointer and the keyboard rather than painted on, because a painted state is
 * a picture of a control and not the control (the P11 experiment will add a
 * forced-focus snapshot for the screenshot gate).
 */

const BUTTON_VARIANTS = [
  'default',
  'outline',
  'ghost',
  'destructive',
  'secondary',
  'link',
] as const;

const VARIANT_NOTE: Readonly<Record<(typeof BUTTON_VARIANTS)[number], string>> = {
  default: 'Primär: eine pro Bereich',
  outline: 'Zweitrangig',
  ghost: 'Werkzeugleisten, Icons',
  destructive: 'Nur Unwiderrufliches',
  secondary: 'Ungenutzt',
  link: 'Ungenutzt',
};

export function ButtonsSection() {
  return (
    <DsSection
      id="knoepfe"
      title="Knöpfe"
      lead="Ein Knopf, sechs Varianten, fünf Größen. Die Hülle der Anwendung besteht fast nur aus ghost-Knöpfen; primär ist höchstens einer pro Bereich."
    >
      <DsExample
        id="knopf-varianten"
        title="Varianten"
        source="packages/ui/src/components/ui/button.tsx"
        note="secondary und link sind definiert, aber nirgends im Einsatz; an ihrer Stelle stehen heute handgebaute Knöpfe (Inventar F-7)."
      >
        <DsStates>
          {BUTTON_VARIANTS.map((variant) => (
            <DsState key={variant} label={`${variant} · ${VARIANT_NOTE[variant]}`}>
              <Button variant={variant}>Speichern</Button>
            </DsState>
          ))}
        </DsStates>
      </DsExample>

      <DsExample
        id="knopf-groessen"
        title="Größen"
        note="lg ist definiert und ungenutzt. icon-sm (28 px) ist das kleinste Tippziel der Anwendung."
      >
        <DsStates>
          <DsState label="sm · 32 px">
            <Button size="sm" variant="outline">
              Anlegen
            </Button>
          </DsState>
          <DsState label="default · 36 px">
            <Button variant="outline">Anlegen</Button>
          </DsState>
          <DsState label="lg · 40 px">
            <Button size="lg" variant="outline">
              Anlegen
            </Button>
          </DsState>
          <DsState label="icon · 36 px">
            <Button size="icon" variant="ghost" aria-label="Seite anlegen">
              <PlusIcon />
            </Button>
          </DsState>
          <DsState label="icon-sm · 28 px">
            <Button size="icon-sm" variant="ghost" aria-label="Seite anlegen">
              <PlusIcon />
            </Button>
          </DsState>
        </DsStates>
      </DsExample>

      <DsExample
        id="knopf-zustaende"
        title="Zustände"
        note="Hover, Fokus und Drücken mit Maus und Tastatur ausprobieren. Einen Ladezustand hat der Knopf nicht; laufende Aktionen ändern heute die Beschriftung."
      >
        <DsStates>
          <DsState label="Mit Icon">
            <Button variant="outline">
              <PlusIcon />
              Unterseite
            </Button>
          </DsState>
          <DsState label="Deaktiviert">
            <Button disabled>Speichern</Button>
          </DsState>
          <DsState label="Deaktiviert, outline">
            <Button variant="outline" disabled>
              Speichern
            </Button>
          </DsState>
          <DsState label="Läuft (Beschriftung)">
            <Button disabled>Wird gespeichert …</Button>
          </DsState>
          <DsState label="Destruktiv mit Icon">
            <Button variant="destructive">
              <TrashIcon />
              Endgültig löschen
            </Button>
          </DsState>
        </DsStates>
      </DsExample>
    </DsSection>
  );
}

export function FormsSection() {
  const [name, setName] = React.useState('Wochenplanung');
  const [slug, setSlug] = React.useState('Mein Bereich!');
  return (
    <DsSection
      id="formulare"
      title="Formularfelder"
      lead="Ein Feld besitzt seinen Hilfetext und seine Ablehnung: beide haben eine Kennung, und das Feld verweist mit aria-describedby darauf. Ein ungültiges Feld trägt aria-invalid, das färbt auch den Rand."
    >
      <DsExample
        id="feld-text"
        title="Textfeld"
        source="packages/ui/src/components/ui/input.tsx"
        note="Ein Lesezustand (read-only) hat kein eigenes Aussehen."
      >
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ds-input-default">Leer</Label>
            <Input id="ds-input-default" placeholder="Titel der Seite" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ds-input-value">Mit Wert und Hilfetext</Label>
            <Input
              id="ds-input-value"
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-describedby="ds-input-value-help"
            />
            <p id="ds-input-value-help" className="text-xs text-muted-foreground">
              Erscheint im Seitenbaum und im Pfad.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ds-input-invalid">Ungültig</Label>
            <Input
              id="ds-input-invalid"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              aria-invalid
              aria-describedby="ds-input-invalid-error"
            />
            <p id="ds-input-invalid-error" className="text-xs text-destructive-text">
              Nur Kleinbuchstaben, Ziffern und Bindestriche.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ds-input-disabled">Deaktiviert</Label>
            <Input id="ds-input-disabled" value="exocortex.app" disabled readOnly />
          </div>
        </div>
      </DsExample>

      <DsExample
        id="feld-mehrzeilig"
        title="Mehrzeilig"
        source="packages/ui/src/components/ui/textarea.tsx"
      >
        <div className="flex max-w-md flex-col gap-1.5">
          <Label htmlFor="ds-textarea">Beschreibung</Label>
          <Textarea id="ds-textarea" defaultValue="Was diese Automation tut, in einem Satz." />
        </div>
      </DsExample>

      <DsExample
        id="feld-auswahl"
        title="Auswahl"
        source="packages/ui/src/components/ui/select.tsx"
      >
        <DsStates>
          <DsState label="default">
            <Select defaultValue="medium">
              <SelectTrigger className="w-44" aria-label="Denkstufe">
                <SelectValue>{(value: string) => THINKING[value] ?? value}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(THINKING).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </DsState>
          <DsState label="sm">
            <Select defaultValue="low">
              <SelectTrigger size="sm" className="w-36" aria-label="Denkstufe, klein">
                <SelectValue>{(value: string) => THINKING[value] ?? value}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(THINKING).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </DsState>
          <DsState label="Deaktiviert">
            <Select defaultValue="high" disabled>
              <SelectTrigger className="w-36" aria-label="Denkstufe, deaktiviert">
                <SelectValue>{(value: string) => THINKING[value] ?? value}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="high">Hoch</SelectItem>
              </SelectContent>
            </Select>
          </DsState>
          <DsState label="Ungültig">
            <Select>
              <SelectTrigger className="w-44" aria-label="Modell" aria-invalid>
                <SelectValue placeholder="Modell wählen">{(value: string) => value}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="a">Erstes Modell</SelectItem>
              </SelectContent>
            </Select>
          </DsState>
        </DsStates>
      </DsExample>

      <DsExample
        id="feld-ankreuzen"
        title="Checkbox und Schalter"
        source="packages/ui/src/components/ui/checkbox.tsx, switch.tsx"
        note="Der Schalter kennt keinen ungültigen Zustand, die Checkbox schon."
      >
        <DsStates>
          <DsState label="Checkbox aus">
            <div className="flex items-center gap-2">
              <Checkbox id="ds-cb-off" />
              <Label htmlFor="ds-cb-off">Unterseiten mitnehmen</Label>
            </div>
          </DsState>
          <DsState label="Checkbox an">
            <div className="flex items-center gap-2">
              <Checkbox id="ds-cb-on" defaultChecked />
              <Label htmlFor="ds-cb-on">Unterseiten mitnehmen</Label>
            </div>
          </DsState>
          <DsState label="Checkbox deaktiviert">
            <div className="flex items-center gap-2">
              <Checkbox id="ds-cb-disabled" disabled />
              <Label htmlFor="ds-cb-disabled">Nicht verfügbar</Label>
            </div>
          </DsState>
          <DsState label="Checkbox ungültig">
            <div className="flex items-center gap-2">
              <Checkbox id="ds-cb-invalid" aria-invalid />
              <Label htmlFor="ds-cb-invalid">Bedingungen gelesen</Label>
            </div>
          </DsState>
          <DsState label="Schalter aus">
            <div className="flex items-center gap-2">
              <Switch id="ds-sw-off" />
              <Label htmlFor="ds-sw-off">Automationen</Label>
            </div>
          </DsState>
          <DsState label="Schalter an">
            <div className="flex items-center gap-2">
              <Switch id="ds-sw-on" defaultChecked />
              <Label htmlFor="ds-sw-on">Automationen</Label>
            </div>
          </DsState>
          <DsState label="Schalter deaktiviert">
            <div className="flex items-center gap-2">
              <Switch id="ds-sw-disabled" disabled defaultChecked />
              <Label htmlFor="ds-sw-disabled">Vom Admin gesperrt</Label>
            </div>
          </DsState>
        </DsStates>
      </DsExample>
    </DsSection>
  );
}

const THINKING: Readonly<Record<string, string>> = {
  low: 'Niedrig',
  medium: 'Mittel',
  high: 'Hoch',
};

export function TogglesSection() {
  const [mode, setMode] = React.useState('month');
  return (
    <DsSection
      id="umschalter"
      title="Umschalter und Tabs"
      lead="Ein gedrückter Umschalter und ein gewählter Tab tragen accent-strong, dieselbe Auswahlfläche wie die offene Seite im Baum."
    >
      <DsExample
        id="umschalter-einzeln"
        title="Umschalter"
        source="packages/ui/src/components/ui/toggle.tsx"
        note="Höhe und Radius liegen eine Stufe unter dem Knopf (Inventar F-9)."
      >
        <DsStates>
          <DsState label="Aus">
            <Toggle variant="outline" aria-label="Fett">
              <BoldIcon />
            </Toggle>
          </DsState>
          <DsState label="Gedrückt">
            <Toggle variant="outline" aria-label="Kursiv" defaultPressed>
              <ItalicIcon />
            </Toggle>
          </DsState>
          <DsState label="Deaktiviert">
            <Toggle variant="outline" aria-label="Unterstrichen" disabled>
              <UnderlineIcon />
            </Toggle>
          </DsState>
          <DsState label="Gruppe">
            <ToggleGroup
              aria-label="Ansicht"
              value={[mode]}
              onValueChange={(next: string[]) => {
                const chosen = next[0];
                if (chosen !== undefined) setMode(chosen);
              }}
            >
              {Object.entries(CALENDAR_MODES).map(([value, label]) => (
                <Toggle key={value} value={value} variant="outline" size="sm">
                  {label}
                </Toggle>
              ))}
            </ToggleGroup>
          </DsState>
        </DsStates>
      </DsExample>

      <DsExample id="tabs-waagerecht" title="Tabs" source="packages/ui/src/components/ui/tabs.tsx">
        <Tabs defaultValue="allgemein">
          <TabsList>
            <TabsTrigger value="allgemein">Allgemein</TabsTrigger>
            <TabsTrigger value="mitglieder">Mitglieder</TabsTrigger>
            <TabsTrigger value="ki">KI</TabsTrigger>
          </TabsList>
          <TabsContent value="allgemein" className="pt-4 text-sm text-muted-foreground">
            Name und Adresse des Arbeitsbereichs.
          </TabsContent>
          <TabsContent value="mitglieder" className="pt-4 text-sm text-muted-foreground">
            Wer hier mitarbeitet, mit welcher Rolle.
          </TabsContent>
          <TabsContent value="ki" className="pt-4 text-sm text-muted-foreground">
            Modell und Denkstufe für diesen Bereich.
          </TabsContent>
        </Tabs>
      </DsExample>

      <DsExample
        id="tabs-senkrecht"
        title="Tabs, senkrecht"
        note="Die Einstellungsgruppen und die Hilfe nutzen die senkrechte Form ab md."
      >
        <Tabs defaultValue="ki" orientation="vertical" className="flex gap-6">
          <TabsList>
            <TabsTrigger value="ki">KI</TabsTrigger>
            <TabsTrigger value="suche">Suche</TabsTrigger>
            <TabsTrigger value="mail">Mail</TabsTrigger>
          </TabsList>
          <TabsContent value="ki" className="text-sm text-muted-foreground">
            Einstellungen der eingebauten KI.
          </TabsContent>
          <TabsContent value="suche" className="text-sm text-muted-foreground">
            Volltext und semantische Suche.
          </TabsContent>
          <TabsContent value="mail" className="text-sm text-muted-foreground">
            Versand und Absender.
          </TabsContent>
        </Tabs>
      </DsExample>
    </DsSection>
  );
}

const CALENDAR_MODES: Readonly<Record<string, string>> = {
  month: 'Monat',
  week: 'Woche',
  agenda: 'Agenda',
};
