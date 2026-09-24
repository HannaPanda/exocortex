'use client';

import { type LucideIcon, SearchIcon, Trash2Icon } from 'lucide-react';
import * as React from 'react';

import { Button, EmptyState, Input, SheetHeader } from '@exocortex/ui';

import { DsSection } from '../showcase';

import { DsExperimentBrief, DsVariant, DsVariants } from './frame';

/**
 * P9: the shape of an empty state, in two places the product really shows one.
 *
 * Variant A is `EmptyState` itself. Variant B is drawn here from the same
 * tokens and the same `Button`, and exists nowhere in the product; if it wins,
 * it becomes a `density` option on `EmptyState` rather than a second
 * component. Both variants get the identical words, icon and action, taken
 * from the product where the product has them.
 */

interface EmptyCopy {
  icon: LucideIcon;
  title: string;
  description: string;
  action: string;
}

/** Wording from `shell/trash-sheet.tsx`. The product offers no action there; both variants get the same one. */
const TRASH: EmptyCopy = {
  icon: Trash2Icon,
  title: 'Der Papierkorb ist leer',
  description:
    'Was du in den Papierkorb legst, bleibt hier, bis es jemand wiederherstellt oder endgültig löscht.',
  action: 'Papierkorb schließen',
};

/** Wording from `search/saved-query-results.tsx`, with the action the search layout offers. */
const NO_HITS: EmptyCopy = {
  icon: SearchIcon,
  title: 'Nichts gefunden',
  description:
    'Zu dieser Abfrage gibt es gerade nichts. Das kann sich morgen ändern, die Suche bleibt gespeichert.',
  action: 'Suche zurücksetzen',
};

type Shape = 'centred' | 'dense';

function DenseEmpty({ copy, onAction }: { copy: EmptyCopy; onAction: () => void }) {
  const Icon = copy.icon;
  return (
    <div className="flex items-start gap-3 px-3 py-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex min-w-0 flex-col items-start gap-1">
        <p className="text-sm font-medium">{copy.title}</p>
        <p className="max-w-measure text-xs text-muted-foreground">{copy.description}</p>
        <Button size="sm" className="mt-2" onClick={onAction}>
          {copy.action}
        </Button>
      </div>
    </div>
  );
}

function Empty({ shape, copy }: { shape: Shape; copy: EmptyCopy }) {
  const [used, setUsed] = React.useState(false);
  const onAction = (): void => setUsed(true);
  return (
    <>
      {shape === 'centred' ? (
        <EmptyState
          icon={copy.icon}
          title={copy.title}
          description={copy.description}
          action={{ label: copy.action, onClick: onAction }}
        />
      ) : (
        <DenseEmpty copy={copy} onAction={onAction} />
      )}
      <p className="exocortex-sr-only" role="status">
        {used ? `${copy.action}: im Beispiel ohne Wirkung.` : ''}
      </p>
    </>
  );
}

/** The trash sheet's frame: its header and body classes, without the modal around it. */
function TrashPanel({ shape }: { shape: Shape }) {
  return (
    <div className="ml-auto flex h-80 w-full max-w-xl flex-col border-l border-border bg-background">
      <SheetHeader className="border-b border-border pr-10">
        <h4 className="text-lg font-semibold text-foreground">Papierkorb</h4>
        <p className="text-sm text-muted-foreground">Keine Seite im Papierkorb.</p>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
        <Empty shape={shape} copy={TRASH} />
      </div>
    </div>
  );
}

/** The search screen's column: title, the query, then the result list. */
function SearchColumn({ shape }: { shape: Shape }) {
  return (
    <div className="flex flex-col p-4 sm:p-6">
      <h4 className="exocortex-page-title">Suche</h4>
      <p className="mt-1 max-w-measure text-sm text-muted-foreground">
        Volltext und Bedeutung, über alle Seiten, die du lesen darfst.
      </p>
      <Input
        type="search"
        aria-label={`Suchbegriff (${shape === 'centred' ? 'A' : 'B'})`}
        className="mt-6"
        defaultValue="Messreihe Juli Kellerraum"
      />
      <div className="mt-4">
        <Empty shape={shape} copy={NO_HITS} />
      </div>
    </div>
  );
}

const TRADEOFFS: Record<Shape, readonly string[]> = {
  centred: [
    'Ruhig und eindeutig als Zustand erkennbar, auch aus dem Augenwinkel.',
    'Steht in der Mitte der Fläche, weit weg von Überschrift und Suchfeld, auf die sich der Satz bezieht.',
    'Die Aktion ist ein Umrissknopf und damit schwächer als der Text darüber.',
    'Braucht etwa 180 px Höhe; in dichten Bereichen gibt es dafür keine Variante.',
  ],
  dense: [
    'Beginnt an derselben Kante wie Überschrift und Liste; man liest weiter, statt zu springen.',
    'Die Aktion ist ein gefüllter Knopf, also die einzige Bernstein-Fläche im Bereich.',
    'Etwa halb so hoch; dieselbe Form passt in den 260 px breiten Kontextbereich.',
    'Auf einer großen leeren Fläche wirkt sie klein und kann wie ein Hinweis statt wie ein Zustand aussehen.',
  ],
};

export function EmptyStatesExperiment() {
  return (
    <DsSection id="experiment-p9" title="P9 Leere Zustände">
      <DsExperimentBrief
        problem="63 leere Zustände haben eine Form: zentriert, Icon zuerst, Aktion als Umrissknopf. Dazu kommen drei von Hand gebaute, weil die Form in dichten Bereichen nicht passt. Zentriert mit Icon zuerst, oder linksbündig mit der Handlung zuerst?"
        width="Papierkorb als Seitenleiste bis 576 px, Suche auf Seitenbreite; beide schrumpfen mit dem Fenster"
        keyboard="Tab erreicht die Aktion; sie meldet im Beispiel nur, dass sie gedrückt wurde."
        sources={[
          'packages/ui/src/components/states.tsx (EmptyState)',
          'apps/web/src/components/shell/trash-sheet.tsx',
          'apps/web/src/components/search/saved-query-results.tsx',
        ]}
      />
      <DsVariants wide>
        <DsVariant
          name="A: zentriert, Icon zuerst (heute)"
          tradeoffs={TRADEOFFS.centred}
          stageClassName="p-0 sm:p-0"
        >
          <TrashPanel shape="centred" />
        </DsVariant>
        <DsVariant
          name="B: linksbündig, Handlung zuerst"
          tradeoffs={TRADEOFFS.dense}
          stageClassName="p-0 sm:p-0"
        >
          <TrashPanel shape="dense" />
        </DsVariant>
      </DsVariants>
      <DsVariants wide>
        <DsVariant
          name="A: Suche ohne Treffer, zentriert"
          tradeoffs={TRADEOFFS.centred}
          stageClassName="p-0 sm:p-0"
        >
          <SearchColumn shape="centred" />
        </DsVariant>
        <DsVariant
          name="B: Suche ohne Treffer, linksbündig"
          tradeoffs={TRADEOFFS.dense}
          stageClassName="p-0 sm:p-0"
        >
          <SearchColumn shape="dense" />
        </DsVariant>
      </DsVariants>
    </DsSection>
  );
}
