'use client';

import { InboxIcon, PanelLeftIcon, PanelRightIcon, PlusIcon, SearchIcon } from 'lucide-react';
import * as React from 'react';

import type { SettingKey, Settings } from '@exocortex/contracts';
import {
  AppBody,
  AppHeader,
  AppPage,
  AppShell,
  Badge,
  Button,
  ExocortexWordmark,
  Input,
  Leader,
  ResizablePanel,
  SectionRule,
  Sheet,
  SheetContent,
  SheetTitle,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  useIsMobile,
} from '@exocortex/ui';

import { OverviewCards } from '@/components/admin/overview-cards';
import { SavedQueryResults } from '@/components/search/saved-query-results';
import { SettingGroupNav } from '@/components/settings/setting-group-nav';
import { SettingRow } from '@/components/settings/setting-row';
import { PresenceStack } from '@/components/shell/presence-avatars';

import {
  FIXTURE_HITS,
  FIXTURE_OVERVIEW,
  FIXTURE_PRESENCE,
  FIXTURE_SETTING_GROUPS,
} from '../fixtures';
import { FixtureTree, OPEN_BRANCH } from '../patterns/rows';
import { DsExample, DsSection } from '../showcase';

/**
 * Layouts: whole screens put together from the product's layout primitives and
 * components, with fixtures where the data would be.
 *
 * Each sits in a frame of fixed height, because the primitives fill whatever
 * they are given (`AppShell` is a viewport, `AppPage` scrolls itself), and
 * responds to the real window, not to the frame: the shell switches its panels
 * to sheets below 768 px through the same hook the product uses, so a phone
 * shows the narrow shell.
 *
 * A page title is an `h4` here and an `h1` in the product. The class draws it;
 * the level keeps this page's outline in order.
 */

const FRAME = 'h-[32rem] overflow-hidden p-0 sm:p-0';

function PageHeader({ title, lead }: { title: string; lead: string }) {
  return (
    <>
      <h4 className="exocortex-page-title">{title}</h4>
      <p className="mt-1 max-w-measure text-sm text-muted-foreground">{lead}</p>
    </>
  );
}

function SampleContextPanel() {
  return (
    <aside aria-label="Kontextbereich (Beispiel)" className="flex flex-col gap-3 p-3">
      <SectionRule as="h3" trailing="3">
        Verweise hierher
      </SectionRule>
      <ul className="flex flex-col gap-1 text-sm">
        <li>Kapitel 1: Einleitung</li>
        <li>Laborbuch März</li>
        <li>Leseliste</li>
      </ul>
    </aside>
  );
}

function SamplePage() {
  return (
    <AppPage maxWidth="max-w-3xl">
      <PageHeader
        title="Kapitel 2: Methoden"
        lead="Die Seite ist die hellste Fläche. Navigation und Kontextbereich sitzen eine Stufe darüber und treten zurück."
      />
      <p className="mt-6 max-w-measure text-sm">
        Die Messreihe wurde an drei Tagen wiederholt, jeweils zur selben Uhrzeit. Abweichungen über
        zwei Prozent sind im Laborbuch vermerkt.
      </p>
    </AppPage>
  );
}

export function ShellLayout() {
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  const [contextOpen, setContextOpen] = React.useState(true);
  const [sidebarWidth, setSidebarWidth] = React.useState(240);
  const [contextWidth, setContextWidth] = React.useState(260);
  const [sheet, setSheet] = React.useState<'left' | 'right' | null>(null);

  const tree = (
    <nav aria-label="Seitennavigation (Beispiel)" className="flex min-h-0 flex-1 flex-col p-1">
      <FixtureTree label="Seiten im Beispiel" expandedInitially={OPEN_BRANCH} className="" />
    </nav>
  );

  return (
    <DsSection
      id="huelle"
      title="Hülle"
      lead="Kopfzeile, Navigation links, Seite in der Mitte, Kontextbereich rechts. Unter 768 px werden beide Seitenbereiche zu Sheets, die über die Kopfzeile aufgehen."
    >
      <DsExample
        id="huelle-rahmen"
        title={isMobile ? 'Schmale Hülle' : 'Breite Hülle'}
        source="apps/web/src/components/shell/app-shell.tsx"
        note="Aus denselben Bausteinen wie die Anwendung, mit Beispielinhalt. Die echte Kopfzeile braucht eine Sitzung und steht deshalb nur als Nachbau ihrer Knöpfe hier. Die Bereiche lassen sich mit den Pfeiltasten auf ihrem Rand verbreitern; Ziehen rechnet in Fensterkoordinaten und springt im Rahmen. Auf dem Handy zeigt diese Stelle die schmale Hülle."
        stageClassName={FRAME}
      >
        <AppShell className="h-full">
          <AppHeader>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Navigation ein- oder ausblenden"
              aria-pressed={isMobile ? sheet === 'left' : sidebarOpen}
              onClick={() => (isMobile ? setSheet('left') : setSidebarOpen((open) => !open))}
            >
              <PanelLeftIcon />
            </Button>
            <ExocortexWordmark className="h-6" />
            <Button variant="outline" size="sm" aria-label="Suchen">
              <SearchIcon />
              <span className="hidden sm:inline">Suchen</span>
            </Button>
            <Button variant="outline" size="sm" aria-label="Erfassen">
              <InboxIcon />
              <span className="hidden sm:inline">Erfassen</span>
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <PresenceStack presence={FIXTURE_PRESENCE} />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Kontextbereich ein- oder ausblenden"
                aria-pressed={isMobile ? sheet === 'right' : contextOpen}
                onClick={() => (isMobile ? setSheet('right') : setContextOpen((open) => !open))}
              >
                <PanelRightIcon />
              </Button>
            </div>
          </AppHeader>
          <AppBody>
            {isMobile ? null : sidebarOpen ? (
              <ResizablePanel
                width={sidebarWidth}
                onWidthChange={setSidebarWidth}
                handle="right"
                minWidth={200}
                maxWidth={420}
                label="Breite der Navigation"
                className="border-r border-border bg-surface"
              >
                {tree}
              </ResizablePanel>
            ) : null}
            {/* The product's `AppMain` is the one `<main>` of a page, and this
                page already has one. */}
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <SamplePage />
            </div>
            {isMobile ? null : contextOpen ? (
              <ResizablePanel
                width={contextWidth}
                onWidthChange={setContextWidth}
                handle="left"
                minWidth={260}
                maxWidth={520}
                label="Breite des Kontextbereichs"
                className="border-l border-border bg-surface"
              >
                <SampleContextPanel />
              </ResizablePanel>
            ) : null}
          </AppBody>
        </AppShell>
        <Sheet open={sheet !== null} onOpenChange={(open) => (open ? null : setSheet(null))}>
          <SheetContent side={sheet ?? 'left'}>
            <SheetTitle className="exocortex-sr-only">
              {sheet === 'right' ? 'Kontextbereich' : 'Navigation'}
            </SheetTitle>
            {sheet === 'right' ? <SampleContextPanel /> : tree}
          </SheetContent>
        </Sheet>
      </DsExample>
    </DsSection>
  );
}

const RECENT = [
  { title: 'Kapitel 2: Methoden', when: 'vor 2 Stunden' },
  { title: 'Laborbuch März', when: 'gestern' },
  { title: 'Umzug', when: 'vor 4 Tagen' },
];

export function ContentPageLayout() {
  return (
    <DsSection
      id="inhaltsseite"
      title="Inhaltsseite"
      lead="Jede Seite außerhalb des Editors: ein zentrierter Streifen, der selbst scrollt, darin Titel, Einleitung und Abschnitte unter Abschnittsmarken."
    >
      <DsExample
        id="inhaltsseite-rahmen"
        title="Übersicht eines Arbeitsbereichs"
        source="packages/ui/src/components/layout.tsx"
        note="AppPage hält auch auf dem Handy 24 px Rand (Inventar 2.4). Titel und Einleitung stehen heute in rund zwanzig Dateien einzeln, eine gemeinsame Kopfzeile fehlt (Lücke 6)."
        stageClassName={FRAME}
      >
        <div className="flex h-full flex-col">
          <AppPage maxWidth="max-w-3xl">
            <PageHeader
              title="Forschung"
              lead="Was sich hier zuletzt bewegt hat und was offen ist."
            />
            <section className="mt-8 flex flex-col gap-3">
              <SectionRule as="h3" trailing={RECENT.length}>
                Zuletzt geändert
              </SectionRule>
              <ul className="flex flex-col gap-2">
                {RECENT.map((entry) => (
                  <li key={entry.title} className="flex items-baseline gap-2 text-sm">
                    <span className="truncate">{entry.title}</span>
                    <Leader />
                    <span className="shrink-0 text-muted-foreground">{entry.when}</span>
                  </li>
                ))}
              </ul>
            </section>
          </AppPage>
        </div>
      </DsExample>
    </DsSection>
  );
}

type GroupName = keyof typeof FIXTURE_SETTING_GROUPS;
const GROUP_NAMES = Object.keys(FIXTURE_SETTING_GROUPS) as GroupName[];
const NO_GROUPS: ReadonlySet<string> = new Set();

export function SettingsLayout() {
  const [group, setGroup] = React.useState<GroupName>('ai');
  const [values, setValues] = React.useState<Partial<Settings>>({
    ...FIXTURE_SETTING_GROUPS.ai,
    ...FIXTURE_SETTING_GROUPS.search,
  });
  return (
    <DsSection
      id="einstellungen-layout"
      title="Einstellungen"
      lead="Die Gruppen sind die Navigation, eine Gruppe steht auf dem Bildschirm. Ab 768 px links als Liste, darunter als umbrechende Reihe."
    >
      <DsExample
        id="einstellungen-rahmen"
        title="Einstellungen eines Arbeitsbereichs"
        source="apps/web/src/components/settings/workspace-settings-form.tsx"
        note="Die Kontoeinstellungen sind eigene Seiten ohne diese Navigation (Inventar 2.4, P-12)."
        stageClassName={FRAME}
      >
        <div className="flex h-full flex-col">
          <AppPage maxWidth="max-w-5xl">
            <PageHeader
              title="Einstellungen"
              lead="Ohne eigenen Wert gilt hier, was für die ganze Installation eingestellt ist."
            />
            <Tabs
              value={group}
              onValueChange={(next) => {
                if (next === 'ai' || next === 'search') setGroup(next);
              }}
              orientation="vertical"
              className="mt-6 flex flex-col gap-6 md:flex-row md:gap-8"
            >
              <SettingGroupNav
                groups={GROUP_NAMES}
                pending={NO_GROUPS}
                invalid={NO_GROUPS}
                testIdPrefix="ds-setting-group"
              />
              {GROUP_NAMES.map((name) => (
                <TabsContent key={name} value={name} className="flex min-w-0 flex-1 flex-col gap-4">
                  {(Object.keys(FIXTURE_SETTING_GROUPS[name]) as SettingKey[]).map((key) => (
                    <SettingRow
                      key={key}
                      settingKey={key}
                      value={values[key] ?? null}
                      onChange={(value) => setValues((current) => ({ ...current, [key]: value }))}
                      models={[]}
                    />
                  ))}
                </TabsContent>
              ))}
            </Tabs>
          </AppPage>
        </div>
      </DsExample>
    </DsSection>
  );
}

export function AdminLayout() {
  return (
    <DsSection
      id="verwaltung"
      title="Verwaltung"
      lead="Zahlen als Ablesewerte mit Leitlinie, gruppiert unter Abschnittsmarken, keine Kacheln. Bernstein nur bei den Werten, die gerade passieren."
    >
      <DsExample
        id="verwaltung-rahmen"
        title="Übersicht der Installation"
        source="apps/web/src/components/admin/overview-cards.tsx"
        note="Die Bereichsnavigation darüber liest die Adresse und fehlt deshalb hier."
        stageClassName={FRAME}
      >
        <div className="flex h-full flex-col">
          <AppPage maxWidth="max-w-5xl">
            <PageHeader
              title="Verwaltung"
              lead="Einstellungen, KI-Modelle und Nutzerverwaltung dieser Installation."
            />
            <div className="mt-6">
              <OverviewCards overview={FIXTURE_OVERVIEW} />
            </div>
          </AppPage>
        </div>
      </DsExample>
    </DsSection>
  );
}

export function SearchLayout() {
  const [query, setQuery] = React.useState('Messreihe');
  const hits = query.trim().length === 0 ? [] : FIXTURE_HITS;
  return (
    <DsSection
      id="suche-layout"
      title="Suche"
      lead="Eingabe oben, Treffer darunter in der gewählten Darstellung. Ohne Treffer der leere Zustand, der sagt, dass die Abfrage gespeichert bleibt."
    >
      <DsExample
        id="suche-rahmen"
        title="Suchbereich"
        source="apps/web/src/components/search/saved-query-page.tsx"
        note="Leere das Feld, um den leeren Zustand zu sehen."
        stageClassName={FRAME}
      >
        <div className="flex h-full flex-col">
          <AppPage maxWidth="max-w-4xl">
            <PageHeader
              title="Suche"
              lead="Volltext und Bedeutung, über alle Seiten, die du lesen darfst."
            />
            <Input
              type="search"
              aria-label="Suchbegriff"
              className="mt-6"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="mt-4">
              <SavedQueryResults
                hits={hits}
                display={{ layout: 'LIST', showPath: true, showSnippet: true, showUpdatedAt: true }}
                truncated={false}
              />
            </div>
          </AppPage>
        </div>
      </DsExample>
    </DsSection>
  );
}

const TOKENS = [
  { name: 'Hermes', scope: 'Lesen, Schreiben', created: '12.08.2026', used: 'vor 3 Minuten' },
  { name: 'Claude Code', scope: 'Lesen, Schreiben', created: '16.09.2026', used: 'gestern' },
  { name: 'Backup-Prüfung', scope: 'Lesen', created: '02.09.2026', used: 'nie' },
];

export function TableLayout() {
  return (
    <DsSection
      id="tabellenansicht"
      title="Tabellenansicht"
      lead="Eine Tabelle unter einer Abschnittsmarke mit Aktion. Auf schmalen Bildschirmen scrollt sie heute seitwärts und die Zeilenaktionen liegen rechts außerhalb; wie dichte Flächen schmal aussehen sollen, ist offen (P12)."
    >
      <DsExample
        id="tabellenansicht-rahmen"
        title="Zugangstokens"
        source="apps/web/src/components/settings/api-token-panel.tsx"
        note="Zeilenaktionen stehen als kleine Knöpfe in der Zeile; nur die Modelltabelle nimmt ein ⋯-Menü (Inventar P-9). Die Datenbank-Tabelle hat eigene Regeln (angeheftete Namensspalte, veränderbare Breiten) und braucht eine echte Datenbank; sie fehlt hier."
        stageClassName={FRAME}
      >
        <div className="flex h-full flex-col">
          <AppPage maxWidth="max-w-5xl">
            <PageHeader
              title="Zugangstokens"
              lead="Tokens für Werkzeuge, die in deinem Namen auf diese Installation zugreifen."
            />
            <section className="mt-8 flex flex-col gap-3">
              <SectionRule
                as="h3"
                trailing={TOKENS.length}
                action={
                  <Button size="sm" variant="outline">
                    <PlusIcon /> Token anlegen
                  </Button>
                }
              >
                Aktive Tokens
              </SectionRule>
              <Table>
                <TableCaption className="exocortex-sr-only">Aktive Zugangstokens</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Rechte</TableHead>
                    <TableHead>Angelegt</TableHead>
                    <TableHead>Zuletzt benutzt</TableHead>
                    <TableHead className="text-right">Aktionen</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {TOKENS.map((token) => (
                    <TableRow key={token.name}>
                      <TableCell className="font-medium">{token.name}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{token.scope}</Badge>
                      </TableCell>
                      <TableCell className="exocortex-numeric">{token.created}</TableCell>
                      <TableCell>{token.used}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm">
                          Widerrufen
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          </AppPage>
        </div>
      </DsExample>
    </DsSection>
  );
}
