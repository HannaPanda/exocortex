'use client';

import * as React from 'react';

import { type PageOutlineEntry } from '@exocortex/editor';

import { activeTickIndex, railTicks } from '@/components/editor/page-outline/outline-geometry';
import {
  OutlineHeader,
  OutlineList,
  OutlinePinNote,
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
      lead="Sobald eine Seite eine Überschrift hat, steht am rechten Rand eine Skala: ein Strich je Überschrift, die Länge sagt die Ebene, Bernstein sagt, wo du bist. Ein Klick öffnet die Liste daneben. Angepinnt nimmt sie sich in jeder Seitenbreite eine eigene Spalte, und der Text rückt zur Seite; ist das Fenster dafür zu schmal, sagt die Liste das an der Stelle der Nadel. Auf dem Handy wird die Skala zu einem kleinen Knopf unten rechts."
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
          <DsState label="Fenster zu schmal zum Anpinnen">
            <nav
              aria-label="Gliederung ohne Nadel (Beispiel)"
              className="flex w-72 flex-col gap-1 rounded-lg border border-border-strong bg-popover p-1.5 shadow-md"
            >
              <OutlineHeader pinned={false} canPin={false} onPinnedChange={() => undefined} />
              <OutlineList
                rows={rows.slice(0, 3)}
                activeIndex={active}
                onJump={(row) => setActive(row.index)}
              />
              <OutlinePinNote />
            </nav>
          </DsState>
          <DsState label="Angepinnt">
            <nav aria-label="Gliederung, angepinnt (Beispiel)" className="flex w-60 flex-col gap-1">
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
