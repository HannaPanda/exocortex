'use client';

import * as React from 'react';

import { type PageOutlineEntry } from '@exocortex/editor';

import { activeTickIndex, railTicks } from '@/components/editor/page-outline/outline-geometry';
import {
  OutlineHeader,
  OutlineList,
  OutlineRail,
  outlineRows,
} from '@/components/editor/page-outline/outline-view';

import { DsExample, DsSection, DsState, DsStates } from '../showcase';

function heading(
  level: number,
  text: string,
  extra: Partial<Pick<PageOutlineEntry, 'collapsed' | 'hiddenUnder'>> = {},
): PageOutlineEntry {
  return {
    level,
    text,
    blockId: `ds-${text.length > 0 ? text : 'leer'}`,
    collapsed: false,
    hiddenUnder: null,
    ...extra,
  };
}

/** A technical page of realistic length: two levels, one long title, one folded section. */
const ENTRIES: readonly PageOutlineEntry[] = [
  heading(2, 'Überblick'),
  heading(3, 'Wofür der Dienst da ist'),
  heading(2, 'Architektur'),
  heading(
    3,
    'Vier systemd-Units und der Container-Broker, der als einziger den Docker-Socket hält',
  ),
  heading(3, 'Kollaboration'),
  heading(2, 'Betrieb', { collapsed: true }),
  heading(3, 'Ausrollen', { hiddenUnder: 'ds-Betrieb' }),
  heading(3, 'Backups', { hiddenUnder: 'ds-Betrieb' }),
  heading(2, 'Sicherheit'),
  heading(3, ''),
  heading(2, 'Offene Fragen'),
];
const ACTIVE = 3;

/**
 * The floating outline (issue #194), drawn by the product's own parts from a
 * fixture outline. The container that measures the page and runs the scroll
 * spy lives in `page-outline.tsx`; what it chooses between is shown here.
 */
export function PageOutlinePattern() {
  const rows = outlineRows(ENTRIES);
  const ticks = railTicks(ENTRIES);
  const [active, setActive] = React.useState(ACTIVE);
  const [pinned, setPinned] = React.useState(true);
  return (
    <DsSection
      id="seitengliederung"
      title="Seitengliederung"
      lead="Ab vier Überschriften und anderthalb Bildschirmen Länge steht am rechten Rand der Seite eine Skala: ein Strich je Überschrift, die Länge sagt die Ebene, Bernstein sagt, wo du bist. Ein Klick öffnet die Liste daneben. Ist neben der Textspalte Platz, lässt sie sich anpinnen; auf dem Handy wird die Skala zu einem kleinen Knopf unten rechts."
    >
      <DsExample
        id="seitengliederung-zustaende"
        title="Eingeklappt und offen"
        source="apps/web/src/components/editor/page-outline/outline-view.tsx"
        note="Die Skala ist ein einziger Knopf, keine dreißig winzigen Ziele. Strukturstriche in signal-line, der aktuelle Abschnitt in primary. In der Liste trägt der aktuelle Abschnitt dieselbe Markierung wie die offene Seite im Seitenbaum. Ein eingeklappter Abschnitt steht einmal da, mit der Zahl der Überschriften darin, denn ein Sprung klappt ihn nicht auf. Lange Titel brechen nach zwei Zeilen ab, der volle Text steht im Tooltip und im Namen für Screenreader."
      >
        <DsStates>
          <DsState label="Skala">
            <div className="rounded-lg bg-background p-2">
              <OutlineRail
                ticks={ticks}
                activeTick={activeTickIndex(ticks, active)}
                aria-label="Gliederung öffnen"
              />
            </div>
          </DsState>
          <DsState label="Liste (↑ ↓, Eingabe springt)">
            <nav
              aria-label="Gliederung (Beispiel)"
              className="flex w-72 flex-col gap-1 rounded-lg border border-border-strong bg-popover p-1.5 shadow-md"
            >
              <OutlineHeader pinned={false} canPin onPinnedChange={() => undefined} />
              <OutlineList
                rows={rows}
                activeIndex={active}
                onJump={(row) => setActive(row.index)}
              />
            </nav>
          </DsState>
          <DsState label="Angepinnt">
            <nav aria-label="Gliederung, angepinnt (Beispiel)" className="flex w-56 flex-col gap-1">
              <OutlineHeader pinned={pinned} canPin onPinnedChange={setPinned} />
              <OutlineList
                rows={rows}
                activeIndex={active}
                onJump={(row) => setActive(row.index)}
              />
            </nav>
          </DsState>
        </DsStates>
      </DsExample>
    </DsSection>
  );
}
