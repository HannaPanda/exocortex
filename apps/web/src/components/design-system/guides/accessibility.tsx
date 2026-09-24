'use client';

import { BoldIcon, ItalicIcon, UnderlineIcon } from 'lucide-react';
import * as React from 'react';

import {
  Button,
  Input,
  Label,
  Readout,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Toggle,
  ToggleGroup,
} from '@exocortex/ui';

import { UnsavedChangesNotice } from '@/components/settings/unsaved-changes-guard';

import { DsExample, DsSection } from '../showcase';

/**
 * Accessibility, shown as behaviour rather than described: every example here
 * is something to try with the keyboard, a screen reader or a phone.
 */

/** Whether a media query holds in this browser, read after mount. */
function useMediaQuery(query: string): boolean | null {
  const [matches, setMatches] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = (): void => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

function yesNo(value: boolean | null): string {
  return value === null ? '…' : value ? 'ja' : 'nein';
}

function FieldAssociation() {
  const [title, setTitle] = React.useState('');
  const [touched, setTouched] = React.useState(false);
  const invalid = touched && title.trim().length === 0;
  return (
    <div className="flex max-w-sm flex-col gap-1.5">
      <Label htmlFor="ds-a11y-title">Titel der Vorlage</Label>
      <Input
        id="ds-a11y-title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => setTouched(true)}
        aria-invalid={invalid}
        aria-describedby={invalid ? 'ds-a11y-title-help ds-a11y-title-error' : 'ds-a11y-title-help'}
      />
      <p id="ds-a11y-title-help" className="text-meta text-muted-foreground">
        So heißt die Vorlage in der Auswahl beim Anlegen.
      </p>
      {invalid ? (
        <p id="ds-a11y-title-error" className="text-meta text-destructive">
          Ohne Titel lässt sich die Vorlage nicht finden.
        </p>
      ) : null}
    </div>
  );
}

function LiveRegion() {
  const [count, setCount] = React.useState(0);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setCount((value) => value + 1)}>
          Eine Änderung mehr
        </Button>
        <Button variant="ghost" size="sm" disabled={count === 0} onClick={() => setCount(0)}>
          Alles gespeichert
        </Button>
      </div>
      <UnsavedChangesNotice changedCount={count} testId="ds-a11y-live" />
    </div>
  );
}

function CompositeWidgets() {
  return (
    <div className="flex flex-col gap-6">
      <ToggleGroup multiple aria-label="Auszeichnung">
        <Toggle value="bold" aria-label="Fett">
          <BoldIcon />
        </Toggle>
        <Toggle value="italic" aria-label="Kursiv">
          <ItalicIcon />
        </Toggle>
        <Toggle value="underline" aria-label="Unterstrichen">
          <UnderlineIcon />
        </Toggle>
      </ToggleGroup>
      <Tabs defaultValue="text">
        <TabsList aria-label="Ansicht">
          <TabsTrigger value="text">Text</TabsTrigger>
          <TabsTrigger value="verlauf">Verlauf</TabsTrigger>
          <TabsTrigger value="verweise">Verweise</TabsTrigger>
        </TabsList>
        <TabsContent value="text" className="pt-3 text-sm text-muted-foreground">
          Die Reiter sind eine Tabulatorposition, ← und → wechseln.
        </TabsContent>
        <TabsContent value="verlauf" className="pt-3 text-sm text-muted-foreground">
          Der Verlauf dieser Seite.
        </TabsContent>
        <TabsContent value="verweise" className="pt-3 text-sm text-muted-foreground">
          Seiten, die hierher verweisen.
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function AccessibilitySection() {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const coarsePointer = useMediaQuery('(pointer: coarse)');
  const canHover = useMediaQuery('(hover: hover)');
  return (
    <DsSection
      id="barrierefreiheit"
      title="Barrierefreiheit"
      lead="Alles, was mit der Maus geht, geht mit der Tastatur, und alles, was ein Hover zeigt, gibt es auch ohne. Die Beispiele sind zum Ausprobieren gedacht, mit Tastatur, Screenreader oder Handy."
    >
      <DsExample
        id="a11y-tastatur"
        title="Tastatur"
        note="Das erste Tab auf jeder Seite zeigt „Zum Inhalt springen“, auch auf dieser. Danach folgt der Fokus der Lesereihenfolge. Wie der Fokus aussieht, ist noch uneinheitlich; der Abschnitt Fokus zeigt den Stand (P11)."
        source="packages/ui/src/components/layout.tsx"
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline">Erster Halt</Button>
          <Input aria-label="Zweiter Halt" placeholder="Zweiter Halt" className="w-48" />
          <a
            href="#barrierefreiheit"
            className="text-ui text-primary-text underline-offset-4 hover:underline"
          >
            Dritter Halt
          </a>
        </div>
      </DsExample>

      <DsExample
        id="a11y-feld"
        title="Feld, Hilfetext und Fehler"
        note="Verlasse das Feld leer. Die Ablehnung bekommt eine Kennung, das Feld nennt sie in aria-describedby nach dem Hilfetext und trägt aria-invalid. Ein Screenreader liest beim nächsten Fokus beides vor. Heute tun das nur die Einstellungszeile und der Eigenschaften-Dialog (Inventar P-5)."
      >
        <FieldAssociation />
      </DsExample>

      <DsExample
        id="a11y-live"
        title="Live-Region"
        source="apps/web/src/components/settings/unsaved-changes-guard.tsx"
        note="role=status für das, was sich ergibt, role=alert nur für Fehler. Die Zeile meldet sich, wenn sich die Zahl ändert, nicht bei jedem Tastendruck."
      >
        <LiveRegion />
      </DsExample>

      <DsExample
        id="a11y-zusammengesetzt"
        title="Zusammengesetzte Bausteine"
        note="Werkzeugleiste, Reiter, Seitenbaum und Befehlspalette haben eine Tabulatorposition und innen Pfeiltasten. Der Dateibaum in Projekten hält sich noch nicht daran, dort ist jede Datei ein eigener Halt (Inventar 2.6)."
      >
        <CompositeWidgets />
      </DsExample>

      <DsExample
        id="a11y-bewegung-zeiger"
        title="Bewegung und Zeiger"
        note="Bei reduzierter Bewegung schrumpft jede Animation auf null, der Puls endet im Ruhezustand. Bei grobem Zeiger sind die Knöpfe sichtbar, die sonst erst beim Überfahren erscheinen, und Menüs gehen auch mit langem Druck auf. Vier Stellen erscheinen auf Touch noch gar nicht (Issue #129)."
        source="packages/ui/src/styles.css"
      >
        <div className="grid max-w-2xl gap-x-8 gap-y-3 md:grid-cols-3">
          <Readout label="Reduzierte Bewegung" value={yesNo(reducedMotion)} />
          <Readout label="Grober Zeiger" value={yesNo(coarsePointer)} />
          <Readout label="Hover möglich" value={yesNo(canHover)} />
        </div>
      </DsExample>
    </DsSection>
  );
}
