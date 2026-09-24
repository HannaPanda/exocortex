'use client';

import * as React from 'react';

import type { DocumentTreeNode, SavedQueryDisplay } from '@exocortex/contracts';
import { Button } from '@exocortex/ui';

import { RunActivity } from '@/components/ai/run-activity';
import { SavedQueryResults } from '@/components/search/saved-query-results';
import {
  inputId,
  invalidMessage,
  SETTING_LIST_CLASS,
  SettingRow,
} from '@/components/settings/setting-row';
import {
  SettingsActionBar,
  UnsavedChangesNotice,
} from '@/components/settings/unsaved-changes-guard';
import { PageTreeRow, type PageTreeRowContext } from '@/components/shell/page-tree-row';
import { type DropZone, type ExpandedState } from '@/components/shell/page-tree-state';
import { PresenceStack } from '@/components/shell/presence-avatars';
import { useTreeKeyboard } from '@/components/shell/use-tree-keyboard';

import {
  FIXTURE_ACTIVE_ID,
  FIXTURE_CROWD,
  FIXTURE_HITS,
  FIXTURE_PRESENCE,
  FIXTURE_TREE,
  FIXTURE_WORKSPACE_ID,
} from '../fixtures';
import { DsNarrowFrame } from '../narrow/narrow-frame';
import { NARROW_PROBE_TITLES } from '../narrow/probes';
import { DsExample, DsSection, DsState, DsStates } from '../showcase';

/**
 * Patterns that are rows of something: a page in the tree, a setting, a search
 * hit, a person on the page, a run. Each is the product's own component fed
 * with fixtures; the callbacks that would reach the API do nothing here.
 */

const noop = (): void => undefined;

/**
 * Everything a tree row needs, with the parts that change data switched off.
 * Moving is refused rather than faked, so the move commands in the row's menu
 * show their disabled state.
 */
function useFixtureTree({
  expandedInitially,
  dropTarget = null,
}: {
  expandedInitially: ExpandedState;
  dropTarget?: { id: string; zone: DropZone } | null;
}) {
  const treeRef = React.useRef<HTMLUListElement | null>(null);
  const [expanded, setExpanded] = React.useState<ExpandedState>(expandedInitially);
  const [activeId, setActiveId] = React.useState<string>(FIXTURE_ACTIVE_ID);
  const [iconPickerFor, setIconPickerFor] = React.useState<string | null>(null);

  const toggle = React.useCallback((documentId: string) => {
    setExpanded((current) => ({ ...current, [documentId]: current[documentId] !== true }));
  }, []);

  const keyboard = useTreeKeyboard({
    containerRef: treeRef,
    nodes: FIXTURE_TREE,
    expanded,
    activeDocumentId: activeId,
    toggle,
    nudge: noop,
    openDocument: setActiveId,
  });

  const context: PageTreeRowContext = {
    workspaceId: FIXTURE_WORKSPACE_ID,
    activeDocumentId: activeId,
    tabStopId: keyboard.tabStopId,
    onRowKeyDown: keyboard.onRowKeyDown,
    onRowFocus: keyboard.onRowFocus,
    expanded,
    draggedId: null,
    dropTarget,
    iconPickerFor,
    setIconPickerFor,
    setDraggedId: noop,
    setDropTarget: noop,
    cancelSpringOpen: noop,
    onRowDragOver: noop,
    onRowDrop: noop,
    toggle,
    nudge: noop,
    canNudge: () => false,
    createChild: noop,
    createProject: noop,
    setIcon: noop,
    archive: noop,
    startWorkspaceMove: noop,
    suggestParent: noop,
  };

  /** A click on a title selects it instead of following a link into nowhere. */
  const onClickCapture = (event: React.MouseEvent<HTMLElement>): void => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest('a') === null) return;
    event.preventDefault();
    const item = target.closest<HTMLElement>('[data-tree-item]');
    const id = item?.dataset.treeItem;
    if (id !== undefined) setActiveId(id);
  };

  return { treeRef, context, onClickCapture };
}

export function FixtureTree({
  label,
  expandedInitially,
  dropTarget,
  nodes = FIXTURE_TREE,
  className = 'w-64 max-w-full rounded-md bg-surface p-1',
}: {
  label: string;
  expandedInitially: ExpandedState;
  dropTarget?: { id: string; zone: DropZone } | null;
  nodes?: readonly DocumentTreeNode[];
  /** The tree's own surface and width by default: the sidebar is `bg-surface` and at least 200 px wide. */
  className?: string;
}) {
  const { treeRef, context, onClickCapture } = useFixtureTree({ expandedInitially, dropTarget });
  return (
    <div className={className} onClickCapture={onClickCapture}>
      <ul ref={treeRef} role="tree" aria-label={label}>
        {nodes.map((node) => (
          <PageTreeRow key={node.id} node={node} depth={0} context={context} />
        ))}
      </ul>
    </div>
  );
}

export const OPEN_BRANCH: ExpandedState = { dsprojekte: true, dsdiss: true };

export function PageTreePattern() {
  const projects = FIXTURE_TREE.slice(0, 1);
  return (
    <DsSection
      id="seitenbaum"
      title="Seitenbaum"
      lead="Ein Baum nach WAI-ARIA: eine Tabulatorposition, dann Pfeiltasten. Wo du bist, zeigt die Zeile dreifach, mit Fläche, Schriftgewicht und bernsteinfarbenem Symbol."
    >
      <DsExample
        id="seitenbaum-bedienen"
        title="Zum Ausprobieren"
        source="apps/web/src/components/shell/page-tree-row.tsx"
        note="Tab führt hinein, ↑ ↓ bewegen, → und ← klappen auf und zu, Pos1 und Ende springen, Eingabe öffnet. Das Menü kommt mit Rechtsklick, Umschalt+F10 oder langem Druck. Verschieben ist hier abgeschaltet, deshalb sind die vier Befehle dafür ausgegraut."
      >
        <FixtureTree label="Beispielseiten" expandedInitially={OPEN_BRANCH} />
      </DsExample>

      <DsExample
        id="seitenbaum-zustaende"
        title="Ablegen"
        note="Beim Ziehen zeigt eine Linie die Kante, an der die Seite landet; auf der Zeile selbst wird sie zur Unterseite. Bernstein, weil es das ist, was gleich passiert."
      >
        <DsStates>
          <DsState label="Davor ablegen">
            <FixtureTree
              label="Ablegen davor"
              nodes={projects}
              expandedInitially={OPEN_BRANCH}
              dropTarget={{ id: 'dskap1', zone: 'before' }}
            />
          </DsState>
          <DsState label="Hinein ablegen">
            <FixtureTree
              label="Ablegen hinein"
              nodes={projects}
              expandedInitially={OPEN_BRANCH}
              dropTarget={{ id: 'dsumzug', zone: 'inside' }}
            />
          </DsState>
        </DsStates>
      </DsExample>
    </DsSection>
  );
}

export function SettingRowPattern() {
  // What is stored, and the draft on screen. The draft starts with one edit
  // the last save refused, because that is the state worth seeing.
  const [stored, setStored] = React.useState({ enabled: true, results: 5 });
  const [enabled, setEnabled] = React.useState(true);
  const [results, setResults] = React.useState(40);
  const refused = results > 20;
  const changed = (enabled === stored.enabled ? 0 : 1) + (results === stored.results ? 0 : 1);
  return (
    <DsSection
      id="einstellungszeile"
      title="Einstellungszeile"
      lead="Beschriftung links, Steuerung rechts, der Hilfetext gehört zur Steuerung. Unter 640 px stapelt sich die Zeile, ein Schalter bleibt auf der Zeile seiner Beschriftung, Linien trennen die Zeilen, und die Knöpfe der Leiste teilen sich die volle Breite (P12)."
    >
      <DsExample
        id="einstellungszeile-fehler"
        title="Mit abgelehntem Wert"
        source="apps/web/src/components/settings/setting-row.tsx"
        note="Hilfetext und Fehler hängen über aria-describedby an der Steuerung, aria-invalid markiert sie. Kein role=alert: beim Speichern springt der Fokus auf das erste abgelehnte Feld und liest beides vor. Die Leiste darunter heftet sich an den unteren Rand, solange etwas ungespeichert ist."
        stageClassName="p-6 sm:p-6"
      >
        <div className="flex flex-col gap-4">
          <div className={SETTING_LIST_CLASS}>
            <div className="max-sm:py-4">
              <SettingRow
                settingKey="memory.enabled"
                value={enabled}
                onChange={(value) => setEnabled(value === true)}
                models={[]}
              />
            </div>
            <div className="max-sm:py-4">
              <SettingRow
                settingKey="memory.recallMaxResults"
                value={results}
                onChange={(value) => {
                  if (typeof value === 'number') setResults(value);
                }}
                models={[]}
                error={refused ? invalidMessage('memory.recallMaxResults') : undefined}
              />
            </div>
          </div>
          <SettingsActionBar dirty={changed > 0}>
            <Button
              disabled={changed === 0}
              onClick={() => {
                if (refused) {
                  document.getElementById(inputId('memory.recallMaxResults'))?.focus();
                  return;
                }
                setStored({ enabled, results });
              }}
            >
              Speichern
            </Button>
            <UnsavedChangesNotice changedCount={changed} testId="ds-unsaved-notice" />
          </SettingsActionBar>
        </div>
      </DsExample>

      <DsExample
        id="einstellungszeile-schmal"
        title="Auf dem Telefon"
        source="apps/web/src/components/settings/setting-row.tsx"
        note="In einem eigenen Fenster von 390 px: ein Schalter, eine Auswahl mit langen Einträgen, eine Zahl mit abgelehntem Wert, ein langer Text. Die Leiste steht, wie bei einer ungespeicherten Änderung, am unteren Rand."
        stageClassName="flex justify-center p-2 sm:p-3"
      >
        <DsNarrowFrame probe="einstellungen" title={NARROW_PROBE_TITLES.einstellungen} />
      </DsExample>
    </DsSection>
  );
}

const DISPLAY_LIST: SavedQueryDisplay = {
  layout: 'LIST',
  showPath: true,
  showSnippet: true,
  showUpdatedAt: true,
};

export function SearchResultsPattern() {
  return (
    <DsSection
      id="suchtreffer"
      title="Suchtreffer"
      lead="Ein Treffer ist eine Seite irgendwo im Arbeitsbereich: Symbol und Titel zuerst, dann der Ort, dann die Stelle. Die Befehlspalette zeichnet ihre Zeilen noch selbst (Inventar P-6)."
    >
      <DsExample
        id="suchtreffer-liste"
        title="Liste"
        source="apps/web/src/components/search/saved-query-results.tsx"
        note="Dieselbe Komponente dient Suche, intelligenter Ansicht und Abfrageblock. Treffer im Papierkorb sagen es mit einem Badge."
      >
        <SavedQueryResults hits={FIXTURE_HITS} display={DISPLAY_LIST} truncated={false} />
      </DsExample>
      <DsExample id="suchtreffer-karten" title="Karten">
        <SavedQueryResults
          hits={FIXTURE_HITS}
          display={{ ...DISPLAY_LIST, layout: 'CARDS' }}
          truncated={false}
        />
      </DsExample>
      <DsExample id="suchtreffer-tabelle" title="Tabelle">
        <SavedQueryResults
          hits={FIXTURE_HITS}
          display={{ ...DISPLAY_LIST, layout: 'TABLE' }}
          truncated
        />
      </DsExample>
    </DsSection>
  );
}

export function PresencePattern() {
  return (
    <DsSection
      id="praesenz"
      title="Präsenz"
      lead="Du bist immer bernsteinfarben, alle anderen bekommen eine der fünf übrigen Präsenzfarben, auf jedem Gerät dieselbe. Die Farbe steht nie allein: Initialen und Name im Tooltip sagen, wer es ist."
    >
      <DsExample
        id="praesenz-stapel"
        title="Stapel in der Kopfzeile"
        source="apps/web/src/components/shell/presence-avatars.tsx"
        note="Ab der sechsten Person zählt der Stapel nur noch."
      >
        <DsStates>
          <DsState label="Drei Personen">
            <PresenceStack presence={FIXTURE_PRESENCE} />
          </DsState>
          <DsState label="Sieben Personen">
            <PresenceStack presence={FIXTURE_CROWD} />
          </DsState>
        </DsStates>
      </DsExample>
    </DsSection>
  );
}

export function RunProgressPattern() {
  const [cancelling, setCancelling] = React.useState(false);
  return (
    <DsSection
      id="ki-fortschritt"
      title="KI-Lauf in Arbeit"
      lead="Solange ein Lauf aktiv ist, sagt eine Zeile, was er gerade tut und seit wann. Nach längerer Stille wird aus dem Puls ein Hinweis, dass der Lauf weiter erlaubt und abbrechbar ist."
    >
      <DsExample
        id="ki-fortschritt-zeile"
        title="Aktivitätszeile"
        source="apps/web/src/components/ai/run-activity.tsx"
        note="Bewusst außerhalb der Live-Region des Verlaufs: ein Zähler, der sich jede Sekunde ändert, würde sich sonst jede Sekunde vorlesen. Im Kontextbereich, also 260 px breit."
      >
        <DsStates>
          <DsState label="Läuft">
            <div className="w-[260px] rounded-md bg-surface">
              <RunActivity
                phaseLabel="Seite „Kapitel 2“ wird gelesen"
                elapsedMs={12_000}
                quiet={false}
                gapDetected={false}
                onCancel={() => setCancelling(true)}
                cancelling={cancelling}
              />
            </div>
          </DsState>
          <DsState label="Lange still">
            <div className="w-[260px] rounded-md bg-surface">
              <RunActivity
                phaseLabel="Werkzeug exo_web_fetch wird ausgeführt"
                elapsedMs={95_000}
                quiet
                gapDetected={false}
                onCancel={() => setCancelling(true)}
                cancelling={cancelling}
              />
            </div>
          </DsState>
        </DsStates>
        {cancelling ? (
          <Button variant="ghost" size="sm" className="mt-4" onClick={() => setCancelling(false)}>
            Zurücksetzen
          </Button>
        ) : null}
      </DsExample>
    </DsSection>
  );
}
