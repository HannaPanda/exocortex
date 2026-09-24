'use client';

import Link from 'next/link';

import {
  ExocortexWordmark,
  sectionLabelClassName,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  SkipToContentLink,
} from '@exocortex/ui';

import type { CustomProperty, TypeRung } from '@/lib/design-tokens';

import { DESIGN_SYSTEM_CATALOG, DESIGN_SYSTEM_ENTRIES } from './catalog';
import { ButtonsSection, FormsSection, TogglesSection } from './components/controls';
import {
  FeedbackSection,
  InstrumentSection,
  MiscSection,
  TablesSection,
} from './components/display';
import { DialogsSection, MenusSection } from './components/overlays';
import {
  ColourSection,
  FocusSection,
  MeasuresSection,
  MotionSection,
  RadiusElevationSection,
  TypographySection,
} from './foundations/foundations';
import { ConfirmationPattern, StatesPattern } from './patterns/patterns';
import { DsSection, DsSource } from './showcase';

/**
 * The living styleguide (issue #125): the product's visual vocabulary, drawn by
 * the product's own components.
 *
 * Public and outside the application shell on purpose. It shows fixtures only
 * and reaches no API, so there is nothing to sign in for, and a shell around it
 * would put the navigation and the context panel between the reader and the
 * component being shown. It is linked from nowhere in the product.
 */

export interface DesignSystemPageProps {
  tokens: readonly CustomProperty[];
  ladder: readonly TypeRung[];
  measure: string;
}

function Navigation() {
  return (
    <nav aria-label="Designsystem" className="flex flex-col gap-6">
      {DESIGN_SYSTEM_CATALOG.map((group) => (
        <div key={group.title} className="flex flex-col gap-1">
          <h2 className={sectionLabelClassName}>{group.title}</h2>
          <ul className="flex flex-col">
            {group.entries.map((entry) => (
              <li key={entry.id}>
                <a
                  href={`#${entry.id}`}
                  className="block rounded-sm px-2 py-1 text-ui text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                >
                  {entry.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** The phone's door into the same list: fourteen links would push the content off screen. */
function JumpSelect() {
  return (
    <Select
      onValueChange={(value: string | null) => {
        if (value !== null) window.location.hash = value;
      }}
    >
      <SelectTrigger className="w-full lg:hidden" aria-label="Zu Abschnitt springen">
        <SelectValue placeholder="Zu Abschnitt springen">
          {(value: string | null) =>
            DESIGN_SYSTEM_ENTRIES.find((entry) => entry.id === value)?.title ??
            'Zu Abschnitt springen'
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {DESIGN_SYSTEM_CATALOG.map((group) => (
          <SelectGroup key={group.title}>
            <SelectLabel>{group.title}</SelectLabel>
            {group.entries.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.title}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

function PrinciplesSection() {
  return (
    <DsSection
      id="grundsaetze"
      title="Grundsätze"
      lead="eXocortex ist ein Präzisionsinstrument zum Denken. Die Seite ist die hellste Fläche, die Hülle tritt zurück, und Bernstein erscheint nur, wo etwas bedienbar ist oder gerade passiert."
    >
      <ul className="flex max-w-measure flex-col gap-3 text-sm">
        <li>
          <span className="font-medium">Ein Signal.</span>{' '}
          <span className="text-muted-foreground">
            Bernstein auf höchstens einem Zehntel des Bildschirms, nie als Dekoration.
          </span>
        </li>
        <li>
          <span className="font-medium">Dichte vor Polsterung.</span>{' '}
          <span className="text-muted-foreground">
            Abschnittsmarken statt Karten, Leitlinien statt Kacheln, Listen statt Kartenraster.
          </span>
        </li>
        <li>
          <span className="font-medium">Nie nur Farbe.</span>{' '}
          <span className="text-muted-foreground">
            Status, Gültigkeit, Präsenz und Unterschiede tragen immer auch ein Icon oder ein Wort.
          </span>
        </li>
        <li>
          <span className="font-medium">Bewegung ist Zustand.</span>{' '}
          <span className="text-muted-foreground">Nichts bewegt sich, um lebendig zu wirken.</span>
        </li>
      </ul>
      <p className="max-w-measure text-sm text-muted-foreground">
        Die Begründungen stehen in <DsSource path="DESIGN.md" /> und <DsSource path="PRODUCT.md" />,
        der Bestand mit Status in <DsSource path="docs/design-system-inventory.md" />. Diese Seite
        zeigt nur echte Komponenten aus <DsSource path="@exocortex/ui" /> mit Beispieldaten; wo eine
        Entscheidung offen ist, steht es dabei.
      </p>
    </DsSection>
  );
}

export function DesignSystemPage({ tokens, ladder, measure }: DesignSystemPageProps) {
  return (
    <div className="min-h-dvh">
      <SkipToContentLink />
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex h-12 max-w-7xl items-center gap-4 px-4 sm:px-6">
          <ExocortexWordmark className="h-7" />
          <span className="hidden text-ui text-muted-foreground sm:inline">Designsystem</span>
          <Link
            href="/"
            className="ml-auto text-ui whitespace-nowrap text-primary-text underline-offset-4 hover:underline"
          >
            Zur Anwendung
          </Link>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl gap-10 px-4 py-8 sm:px-6">
        <aside className="sticky top-6 hidden max-h-[calc(100dvh-3rem)] w-52 shrink-0 self-start overflow-y-auto lg:block">
          <Navigation />
        </aside>

        <main id="exocortex-main" className="flex min-w-0 flex-1 flex-col gap-10">
          <div className="flex flex-col gap-4">
            <h1 className="exocortex-page-title">Designsystem</h1>
            <p className="max-w-measure text-sm text-muted-foreground">
              Das sichtbare Vokabular von eXocortex: Grundlagen, Komponenten und Muster, jeweils mit
              den Zuständen, die sie wirklich haben.
            </p>
            <JumpSelect />
          </div>

          <PrinciplesSection />
          <ColourSection tokens={tokens} />
          <TypographySection ladder={ladder} />
          <RadiusElevationSection tokens={tokens} />
          <MotionSection tokens={tokens} />
          <FocusSection />
          <MeasuresSection tokens={tokens} measure={measure} />
          <ButtonsSection />
          <FormsSection />
          <TogglesSection />
          <MenusSection />
          <DialogsSection />
          <TablesSection />
          <FeedbackSection />
          <InstrumentSection />
          <MiscSection />
          <StatesPattern />
          <ConfirmationPattern />
        </main>
      </div>
    </div>
  );
}
