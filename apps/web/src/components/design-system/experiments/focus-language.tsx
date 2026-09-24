'use client';

import { BoldIcon, ItalicIcon, LinkIcon, MoreHorizontalIcon, SearchIcon } from 'lucide-react';

import {
  Button,
  Checkbox,
  cn,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Toolbar,
  ToolbarButton,
  ToolbarSeparator,
} from '@exocortex/ui';

import { DsSection } from '../showcase';

import { DsExperimentBrief, DsVariant } from './frame';

/**
 * P11: one focus language instead of nine (inventory F-1, F-2).
 *
 * The same control group three times, built from the product's primitives
 * unchanged. The two candidate rules are written once, below, and scoped to a
 * container attribute: an unlayered rule wins over every Tailwind layer, so the
 * primitives' own `outline-none` and `focus-visible:ring-*` give way inside the
 * container and nowhere else. That is also how a decided rule would land: one
 * place, not a class per component.
 *
 * `data-ds-forced` paints the same rule without focus, for a screenshot. The
 * forced row is `inert`, so it adds no tab stops and nothing a screen reader
 * announces twice.
 */

type FocusVariant = 'current' | 'outline' | 'ring';

const FOCUS_RULES = `
[data-ds-focus='outline'] :focus-visible,
[data-ds-focus='outline'] [data-ds-forced] {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
  --tw-ring-shadow: 0 0 transparent;
}
[data-ds-focus='ring'] :focus-visible,
[data-ds-focus='ring'] [data-ds-forced] {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent);
}
`;

/** Today's treatment cannot be switched on by an attribute: it lives in each primitive. */
function forcedClass(variant: FocusVariant, kind: 'button' | 'field'): string | undefined {
  if (variant !== 'current') return undefined;
  return kind === 'field' ? 'border-ring ring-[3px] ring-ring/50' : 'ring-[3px] ring-ring/50';
}

function ControlGroup({ variant, forced }: { variant: FocusVariant; forced?: boolean }) {
  const id = `ds-p11-${variant}${forced === true ? '-forced' : ''}`;
  const mark = forced === true ? { 'data-ds-forced': '' } : {};
  const button = forced === true ? forcedClass(variant, 'button') : undefined;
  const field = forced === true ? forcedClass(variant, 'field') : undefined;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <Button {...mark} className={button}>
          Speichern
        </Button>
        <Button {...mark} variant="outline" className={button}>
          Verwerfen
        </Button>
        <Button
          {...mark}
          variant="ghost"
          size="icon"
          aria-label="Weitere Aktionen"
          className={button}
        >
          <MoreHorizontalIcon />
        </Button>
        <Button {...mark} variant="destructive" className={button}>
          Endgültig löschen
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-title`}>Titel</Label>
          <Input
            {...mark}
            id={`${id}-title`}
            defaultValue="Kapitel 2: Methoden"
            className={cn('w-52', field)}
          />
        </div>
        <Select defaultValue="list">
          <SelectTrigger {...mark} className={cn('w-40', button)} aria-label="Darstellung">
            <SelectValue>{(value: string) => (value === 'list' ? 'Liste' : 'Tafel')}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="list">Liste</SelectItem>
            <SelectItem value="board">Tafel</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 pb-2">
          <Checkbox {...mark} id={`${id}-check`} defaultChecked className={field} />
          <Label htmlFor={`${id}-check`}>Pfad zeigen</Label>
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex flex-col gap-1.5">
          <span className="text-meta text-muted-foreground">Enge Werkzeugleiste</span>
          <Toolbar aria-label="Formatierung" className="shadow-none">
            <ToolbarButton
              render={
                <Button
                  {...mark}
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Fett"
                  className={button}
                />
              }
            >
              <BoldIcon />
            </ToolbarButton>
            <ToolbarButton render={<Button variant="ghost" size="icon-sm" aria-label="Kursiv" />}>
              <ItalicIcon />
            </ToolbarButton>
            <ToolbarSeparator />
            <ToolbarButton render={<Button variant="ghost" size="icon-sm" aria-label="Link" />}>
              <LinkIcon />
            </ToolbarButton>
          </Toolbar>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-meta text-muted-foreground">In overflow: hidden, bündig</span>
          <div className="flex w-64 overflow-hidden rounded-md border border-border">
            <Input
              aria-label="Filter"
              placeholder="Filtern …"
              className="rounded-none border-0 shadow-none"
            />
            <Button
              {...mark}
              variant="ghost"
              size="icon"
              aria-label="Filtern"
              className={cn('rounded-none', button)}
            >
              <SearchIcon />
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-meta text-muted-foreground">Direkt nebeneinander</span>
          <div className="flex">
            <Button {...mark} variant="outline" size="sm" className={cn('rounded-r-none', button)}>
              Seiten
            </Button>
            <Button variant="outline" size="sm" className="-ml-px rounded-l-none">
              Datenbanken
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

const VARIANTS: readonly { key: FocusVariant; name: string; tradeoffs: readonly string[] }[] = [
  {
    key: 'current',
    name: '1. Heute, gemischt',
    tradeoffs: [
      'Knöpfe und Auswahl zeigen einen weichen 3-px-Ring, Feld und Checkbox zusätzlich einen farbigen Rand.',
      'Der Ring ist ein Schatten: ein Container mit overflow: hidden schneidet ihn ab, bündig am Rand fehlt er.',
      'Links und alles ohne eigene Regel zeigen die globale Kontur, also eine zweite Sprache daneben.',
      'Die Primitiven setzen outline-none: im Fenstermodus mit erzwungenen Farben fällt der Ring weg und nichts ersetzt ihn.',
    ],
  },
  {
    key: 'outline',
    name: '2. Eine Kontur',
    tradeoffs: [
      '2 px volle Kontur mit 2 px Abstand, dieselbe wie die globale Regel in styles.css; Links sehen aus wie Knöpfe.',
      'Kräftigster Kontrast der drei. In der engen Werkzeugleiste ragt sie in den Nachbarn hinein.',
      'Wird von overflow: hidden ebenfalls abgeschnitten, durch den Abstand sogar früher als der Ring.',
    ],
  },
  {
    key: 'ring',
    name: '3. Ein Ring',
    tradeoffs: [
      'Der heutige Ring der Knöpfe für alles, ohne Kontur. Weicher, liegt dicht am Element.',
      'Halbe Deckkraft: auf dem Bernstein-Knopf und dem destruktiven Knopf schwächer zu sehen als die Kontur.',
      'Als Schatten ebenfalls von overflow: hidden abgeschnitten; im Fenstermodus mit erzwungenen Farben unsichtbar.',
    ],
  },
];

export function FocusLanguageExperiment() {
  return (
    <DsSection id="experiment-p11" title="P11 Fokussprache">
      <style href="ds-p11-focus-rules" precedence="default">
        {FOCUS_RULES}
      </style>
      <DsExperimentBrief
        problem="Neun Fokusdarstellungen sind im Einsatz, und DESIGN.md beschreibt eine Kombination, die nirgends erscheint. Welche eine Darstellung gilt überall, auch in dichten Leisten und abgeschnittenen Containern?"
        width="Jede; die Härtefälle sind Dichte und Beschnitt, nicht die Breite"
        keyboard="Mit Tab durch alle drei Gruppen, in der Werkzeugleiste mit den Pfeiltasten. Der Fokus zeigt sich nur bei Tastaturbedienung (:focus-visible), nicht beim Klick."
        sources={[
          'packages/ui/src/styles.css (:focus-visible)',
          'packages/ui/src/components/ui/button.tsx',
          'packages/ui/src/components/ui/input.tsx',
          'docs/design-system-inventory.md, F-1 und F-2',
        ]}
      />
      <p className="max-w-measure text-sm text-muted-foreground">
        Die Randfarbe des Feldes wechselt in allen drei Varianten mit; sie gehört zum Feld, nicht
        zur Fokussprache. Unter jeder Gruppe steht derselbe Stand als fester Schnappschuss für
        Vergleichsbilder, nicht bedienbar.
      </p>
      {VARIANTS.map((variant) => (
        <DsVariant key={variant.key} name={variant.name} tradeoffs={variant.tradeoffs}>
          <div data-ds-focus={variant.key} className="flex flex-col gap-6">
            <ControlGroup variant={variant.key} />
            <div className="flex flex-col gap-2 border-t border-dashed border-border pt-4">
              <span className="text-meta text-muted-foreground">Schnappschuss mit Fokus</span>
              <div inert>
                <ControlGroup variant={variant.key} forced />
              </div>
            </div>
          </div>
        </DsVariant>
      ))}
    </DsSection>
  );
}
