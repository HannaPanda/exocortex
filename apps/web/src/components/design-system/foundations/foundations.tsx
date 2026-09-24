'use client';

import * as React from 'react';

import {
  Button,
  Checkbox,
  Input,
  Label,
  Readout,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import type { CustomProperty, TypeRung } from '@/lib/design-tokens';

import { DsExample, DsSection, DsSource } from '../showcase';

import { TOKEN_GROUPS, type TokenGroup } from './token-catalog';

/**
 * The foundations: every token, shown with its name, its value and what it
 * does. Names and values arrive parsed from the stylesheets (the page reads
 * them at build time); the role comes from `token-catalog.ts`.
 *
 * Swatches and specimens are painted through `var(--token)`, never through a
 * copied value, so what is on screen is the token the product uses.
 */

function valueOf(tokens: readonly CustomProperty[], name: string): string {
  return tokens.find((token) => token.name === name)?.value ?? '';
}

function TokenMeta({ name, value, role }: { name: string; value: string; role: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="exocortex-numeric text-meta break-words text-foreground">{name}</span>
      <span className="exocortex-numeric text-micro break-words text-muted-foreground">
        {value}
      </span>
      <span className="text-meta text-muted-foreground">{role}</span>
    </div>
  );
}

function Specimen({ group, name }: { group: TokenGroup; name: string }) {
  const variable = `var(${name})`;
  switch (group.kind) {
    case 'colour':
      return (
        <span
          className="block h-12 w-full rounded-md border border-border"
          style={{ backgroundColor: variable }}
          aria-hidden
        />
      );
    case 'radius':
      return (
        <span
          className="block size-14 border border-border-strong bg-card"
          style={{ borderRadius: variable }}
          aria-hidden
        />
      );
    case 'shadow':
      return (
        <span
          className="block h-14 w-full rounded-lg bg-popover"
          style={{ boxShadow: variable }}
          aria-hidden
        />
      );
    default:
      return null;
  }
}

function TokenGroupGrid({
  group,
  tokens,
}: {
  group: TokenGroup;
  tokens: readonly CustomProperty[];
}) {
  return (
    <DsExample id={`token-${group.id}`} title={group.title} note={group.description}>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-4 gap-y-6">
        {Object.entries(group.tokens).map(([name, role]) => (
          <li key={name} className="flex flex-col gap-2">
            <Specimen group={group} name={name} />
            <TokenMeta name={name} value={valueOf(tokens, name)} role={role} />
          </li>
        ))}
      </ul>
    </DsExample>
  );
}

export function ColourSection({ tokens }: { tokens: readonly CustomProperty[] }) {
  return (
    <DsSection
      id="farben"
      title="Farben"
      lead="Schiefer und Signal: eine Rampe aus Schiefer, eine Tinte, ein Bernstein. Alle Werte in OKLCH, alle aus tokens.css gelesen."
    >
      <p className="max-w-measure text-sm text-muted-foreground">
        Quelle: <DsSource path="packages/ui/src/tokens.css" />, Regeln in{' '}
        <DsSource path="DESIGN.md" /> §2.
      </p>
      {TOKEN_GROUPS.filter((group) => group.kind === 'colour').map((group) => (
        <TokenGroupGrid key={group.id} group={group} tokens={tokens} />
      ))}
    </DsSection>
  );
}

const RUNG_USE: Readonly<Record<string, string>> = {
  title: 'Seitentitel: der Name dessen, was du ansiehst',
  section: 'H1 im Dokument',
  subsection: 'H2',
  body: 'Fließtext, Editor (H3 mit Gewicht 600)',
  ui: 'Knöpfe, Beschriftungen, Navigation',
  meta: 'Zeitstempel, Zähler, Hinweise',
  micro: 'Abschnittsmarken, Tasten, Zähler in Chips',
  nano: 'Initialen im Avatar, Zahl im Punkt',
};

function rungStyle(rung: TypeRung): React.CSSProperties {
  return {
    fontSize: rung.fontSize,
    lineHeight: rung.lineHeight,
    fontWeight: rung.fontWeight,
    letterSpacing: rung.letterSpacing,
  };
}

export function TypographySection({ ladder }: { ladder: readonly TypeRung[] }) {
  return (
    <DsSection
      id="typografie"
      title="Typografie"
      lead="Inter Variable für alles, JetBrains Mono nur für Werte. Eine Stufe wird über ihre Rolle gewählt, nie über eine erfundene Größe."
    >
      <DsExample
        title="Die Leiter"
        source="packages/ui/src/styles.css"
        note="Die oberen drei Stufen tragen Größe, Zeilenhöhe, Gewicht und Laufweite. Die übrigen nur Größe und Zeilenhöhe, damit eine Stufe nie still ein Gewicht ändert."
      >
        <ul className="flex flex-col divide-y divide-border">
          {ladder.map((rung) => (
            <li
              key={rung.name}
              className="grid gap-2 py-4 first:pt-0 last:pb-0 md:grid-cols-[12rem_1fr]"
            >
              <div className="flex flex-col gap-0.5">
                <span className="exocortex-numeric text-meta text-foreground">
                  text-{rung.name}
                </span>
                <span className="exocortex-numeric text-micro text-muted-foreground">
                  {[rung.fontSize, rung.lineHeight, rung.fontWeight, rung.letterSpacing]
                    .filter((part) => part !== undefined)
                    .join(' · ')}
                </span>
                <span className="text-meta text-muted-foreground">{RUNG_USE[rung.name] ?? ''}</span>
              </div>
              <p className="min-w-0" style={rungStyle(rung)}>
                Schiefer und Signal, ein Instrument zum Denken
              </p>
            </li>
          ))}
        </ul>
      </DsExample>

      <DsExample
        title="Seitentitel"
        source=".exocortex-page-title"
        note="Die Stufe text-title plus zwei Dinge, die ein Titel braucht: er bricht in einem langen Wort um und gleicht beim Umbruch die Zeilen aus."
      >
        <h3 className="exocortex-page-title max-w-sm">
          Protokoll_Arbeitsgruppe_Infrastruktur_2026-09-24
        </h3>
      </DsExample>

      <DsExample
        title="Werte in Mono"
        source=".exocortex-numeric"
        note="Zahlen und Kennungen mit Tabellenziffern, damit ein Zähler beim Wechsel seine Breite hält. Beschriftungen und Fließtext bleiben in der Grotesk."
      >
        <div className="flex flex-col gap-2 text-sm">
          <Readout label="Seiten" value={<span>1.284</span>} />
          <Readout label="Zuletzt gespeichert" value="09:41:07" />
          <Readout label="Kennung" value="vi26cktojtuqb2grzj11i5fs" />
        </div>
      </DsExample>
    </DsSection>
  );
}

export function RadiusElevationSection({ tokens }: { tokens: readonly CustomProperty[] }) {
  const surfaces = TOKEN_GROUPS.find((group) => group.id === 'oberflaechen');
  return (
    <DsSection
      id="radien-und-ebenen"
      title="Radien und Ebenen"
      lead="Die Ebene sagt die Oberflächenrampe, nicht der Schatten. Ein Radius sagt, wie groß das Ding ist, das ihn trägt."
    >
      {surfaces === undefined ? null : (
        <DsExample
          title="Die Rampe als Stapel"
          note="Von der Vertiefung bis zum Block. Popover liegt unter der Seite und schwebt trotzdem: durch Rand und Schatten."
          stageClassName="p-0 sm:p-0 overflow-hidden"
        >
          <ol className="flex flex-col">
            {Object.entries(surfaces.tokens)
              .filter(([name]) => name !== '--overlay')
              .map(([name, role]) => (
                <li
                  key={name}
                  className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3 sm:px-6"
                  style={{ backgroundColor: `var(${name})` }}
                >
                  <span className="exocortex-numeric w-32 shrink-0 text-meta">{name}</span>
                  <span className="text-meta text-muted-foreground">{role}</span>
                </li>
              ))}
          </ol>
        </DsExample>
      )}
      {TOKEN_GROUPS.filter((group) => group.kind === 'radius' || group.kind === 'shadow').map(
        (group) => (
          <TokenGroupGrid key={group.id} group={group} tokens={tokens} />
        ),
      )}
    </DsSection>
  );
}

export function MotionSection({ tokens }: { tokens: readonly CustomProperty[] }) {
  const motion = TOKEN_GROUPS.find((group) => group.id === 'bewegung');
  const [beat, setBeat] = React.useState(0);
  return (
    <DsSection
      id="bewegung"
      title="Bewegung"
      lead="Jede Animation meldet eine Zustandsänderung. Nichts bewegt sich, um lebendig zu wirken. Reduzierte Bewegung verliert den Takt und sonst nichts."
    >
      {motion === undefined ? null : (
        <DsExample
          title="Kurve und Dauern"
          source="packages/ui/src/tokens.css"
          note={motion.description}
        >
          <div className="flex flex-col gap-2">
            {Object.entries(motion.tokens).map(([name, role]) => (
              <Readout key={name} label={role} value={valueOf(tokens, name)} note={name} />
            ))}
          </div>
        </DsExample>
      )}
      <DsExample
        title="Drücken und Herzschlag"
        source="packages/ui/src/styles.css"
        note="Ein Knopf sinkt beim Drücken um einen Pixel. Der Speicher-Herzschlag feuert voll in Bernstein und klingt über duration-settle aus; sein Endzustand ist der Ruhezustand."
      >
        <div className="flex flex-wrap items-center gap-6">
          <Button variant="outline" onClick={() => setBeat((count) => count + 1)}>
            Herzschlag auslösen
          </Button>
          <span className="flex items-center gap-2 text-meta text-muted-foreground">
            <span
              key={beat}
              className={
                beat === 0
                  ? 'size-2 rounded-full bg-muted-foreground/50'
                  : 'exocortex-beat size-2 rounded-full'
              }
              aria-hidden
            />
            Gespeichert
          </span>
        </div>
      </DsExample>
    </DsSection>
  );
}

export function FocusSection() {
  return (
    <DsSection
      id="fokus"
      title="Fokus"
      lead="Fokus ist immer sichtbar, und er sieht überall gleich aus: ein weicher Ring von 3 px in ring/50, keine Kontur (P11). Wo ein Container abschneidet, liegt der Ring innen."
    >
      <DsExample
        title="Ein Ring"
        source="packages/ui/src/styles.css (:focus-visible)"
        note="Mit der Tabulatortaste durchgehen. Knopf, Feld, Auswahl, Checkbox und Link zeigen denselben Ring; das Feld färbt zusätzlich seinen Rand, das gehört zum Feld. Bei erzwungenen Farben ersetzt eine Kontur in der Systemfarbe den Ring."
      >
        <div className="flex flex-wrap items-end gap-6">
          <Button variant="outline">Knopf</Button>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ds-focus-input">Feld</Label>
            <Input id="ds-focus-input" placeholder="Text" className="w-44" />
          </div>
          <Select defaultValue="a">
            <SelectTrigger className="w-40" aria-label="Auswahl">
              <SelectValue>
                {(value: string) => (value === 'a' ? 'Erste Wahl' : 'Zweite Wahl')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="a">Erste Wahl</SelectItem>
              <SelectItem value="b">Zweite Wahl</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <Checkbox id="ds-focus-checkbox" />
            <Label htmlFor="ds-focus-checkbox">Checkbox</Label>
          </div>
          <a href="#fokus" className="text-sm text-primary-text underline-offset-4 hover:underline">
            Ein Link
          </a>
        </div>
      </DsExample>
      <DsExample
        title="In einem abschneidenden Container"
        source="apps/web/src/components/shell/page-tree-row.tsx"
        note="Die Zeilen sitzen bündig in einem Container mit overflow: hidden, wie der Seitenbaum in seinem Scrollbereich. ring-inset legt den Ring nach innen, statt ihn abschneiden zu lassen."
      >
        <ul className="flex w-64 flex-col overflow-hidden rounded-md border border-border">
          {['Forschung', 'Laborprotokolle', 'Kalibrierung'].map((title) => (
            <li key={title}>
              <a
                href="#fokus"
                className="block px-3 py-1.5 text-sm hover:bg-accent focus-visible:ring-inset"
              >
                {title}
              </a>
            </li>
          ))}
        </ul>
      </DsExample>
    </DsSection>
  );
}

/**
 * Which of Tailwind's breakpoints hold right now, read from the compiled CSS
 * rather than typed out: each probe is visible only from its breakpoint up, so
 * the answer is whatever the stylesheet actually does at this width.
 */
function BreakpointProbe() {
  return (
    <span className="exocortex-numeric text-sm font-medium text-primary-text">
      <span className="sm:hidden">unter sm</span>
      <span className="hidden sm:inline md:hidden">sm</span>
      <span className="hidden md:inline lg:hidden">sm, md</span>
      <span className="hidden lg:inline xl:hidden">sm, md, lg</span>
      <span className="hidden xl:inline">sm, md, lg, xl</span>
    </span>
  );
}

function useViewportWidth(): number | null {
  const [width, setWidth] = React.useState<number | null>(null);
  React.useEffect(() => {
    const read = (): void => setWidth(window.innerWidth);
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);
  return width;
}

export function MeasuresSection({
  tokens,
  measure,
}: {
  tokens: readonly CustomProperty[];
  measure: string;
}) {
  const shell = TOKEN_GROUPS.find((group) => group.id === 'masse');
  const width = useViewportWidth();
  return (
    <DsSection
      id="masse"
      title="Maße und Breiten"
      lead="Langer Text endet bei 68 Zeichen, egal wie breit das Fenster ist. Die Hülle hat drei feste Maße; unter 768 px werden die Seitenbereiche zu Sheets."
    >
      <DsExample title="Lesebreite" source="--container-measure, max-w-measure">
        <div className="flex flex-col gap-3">
          <Readout label="Lesebreite" value={measure} />
          <p className="max-w-measure border-x border-signal-line px-3 text-body">
            Ein Absatz in der Lesebreite. Die Zeile endet dort, wo das Auge den Anfang der nächsten
            noch sicher findet, und das hängt an der Zeichenzahl, nicht an der Fensterbreite.
            Deshalb ist die Editorspalte nie randlos.
          </p>
        </div>
      </DsExample>
      {shell === undefined ? null : (
        <DsExample title="Hülle" source="packages/ui/src/tokens.css">
          <div className="flex flex-col gap-2">
            {Object.entries(shell.tokens).map(([name, role]) => (
              <Readout key={name} label={role} value={valueOf(tokens, name)} note={name} />
            ))}
          </div>
        </DsExample>
      )}
      <DsExample
        title="Breakpoints, jetzt"
        source="packages/ui/src/hooks/use-mobile.ts"
        note="Die Stufen sind Tailwinds Standard und werden hier live aus dem Browser gelesen. Die eine Grenze in JavaScript ist useIsMobile bei 768 px."
      >
        <div className="flex flex-col gap-2">
          <Readout label="Fensterbreite" tone="live" value={width === null ? '…' : `${width} px`} />
          <Readout label="Aktive Stufen" value={<BreakpointProbe />} />
        </div>
      </DsExample>
    </DsSection>
  );
}
