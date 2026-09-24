'use client';

import { BoldIcon, ItalicIcon, LinkIcon } from 'lucide-react';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ExocortexLogo,
  ExocortexWordmark,
  Leader,
  Progress,
  Readout,
  ScrollArea,
  SectionRule,
  Separator,
  Skeleton,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Toggle,
  Toolbar,
  ToolbarButton,
  ToolbarSeparator,
  TruncatedText,
} from '@exocortex/ui';

import { DsExample, DsSection, DsState, DsStates } from '../showcase';

/** Tables, feedback, the instrument marks and the smaller building blocks. */

const MEMBERS = [
  { name: 'Johanna', role: 'Verwaltung', since: '05.08.2026', selected: false },
  { name: 'Stefan', role: 'Mitarbeit', since: '12.08.2026', selected: true },
  { name: 'Agenten-Gedächtnis', role: 'Nur lesen', since: '12.08.2026', selected: false },
];

export function TablesSection() {
  return (
    <DsSection
      id="tabellen"
      title="Tabellen"
      lead="Jede Kopfzelle sagt, was sie überschreibt (scope). Zellen brechen nicht um; auf schmalen Bildschirmen scrollt die Tabelle heute seitwärts, eine Entscheidung dazu steht aus (P12)."
    >
      <DsExample
        id="tabelle"
        title="Tabelle mit Aktionen"
        source="packages/ui/src/components/ui/table.tsx"
        note="Die Aktionsspalte hat eine nur für Screenreader sichtbare Überschrift. Die mittlere Zeile zeigt den Auswahlzustand."
      >
        <Table>
          <TableCaption>Mitglieder des Arbeitsbereichs</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Rolle</TableHead>
              <TableHead>Dabei seit</TableHead>
              <TableHead>
                <span className="sr-only">Aktionen</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {MEMBERS.map((member) => (
              <TableRow key={member.name} data-state={member.selected ? 'selected' : undefined}>
                <TableCell className="font-medium">{member.name}</TableCell>
                <TableCell>{member.role}</TableCell>
                <TableCell className="exocortex-numeric">{member.since}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm">
                    Entfernen
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DsExample>
    </DsSection>
  );
}

export function FeedbackSection() {
  return (
    <DsSection
      id="rueckmeldung"
      title="Rückmeldung"
      lead="Status trägt immer ein Wort oder ein Icon, nie nur eine Farbe. Warnung, Erfolg und Hinweis haben Tokens, aber noch keine Variante in den Komponenten (Inventar, Lücke 3)."
    >
      <DsExample
        id="hinweis"
        title="Hinweisbox"
        source="packages/ui/src/components/ui/alert.tsx"
        note="Jede Variante trägt role=alert, auch eine Erfolgsmeldung."
      >
        <div className="flex max-w-lg flex-col gap-3">
          <Alert>
            <AlertTitle>Gespeichert</AlertTitle>
            <AlertDescription>Die Einstellungen gelten ab dem nächsten Lauf.</AlertDescription>
          </Alert>
          <Alert variant="destructive">
            <AlertDescription>
              Speichern fehlgeschlagen. Die Verbindung zum Server ist unterbrochen.
            </AlertDescription>
          </Alert>
        </div>
      </DsExample>

      <DsExample id="marke" title="Marken" source="packages/ui/src/components/ui/badge.tsx">
        <DsStates>
          <DsState label="default">
            <Badge>Neu</Badge>
          </DsState>
          <DsState label="secondary">
            <Badge variant="secondary">Entwurf</Badge>
          </DsState>
          <DsState label="outline">
            <Badge variant="outline">Geteilt</Badge>
          </DsState>
          <DsState label="muted">
            <Badge variant="muted">Archiviert</Badge>
          </DsState>
          <DsState label="destructive">
            <Badge variant="destructive">Fehlgeschlagen</Badge>
          </DsState>
        </DsStates>
      </DsExample>

      <DsExample
        id="fortschritt"
        title="Fortschritt und Skelett"
        source="packages/ui/src/components/ui/progress.tsx, skeleton.tsx"
      >
        <div className="flex max-w-sm flex-col gap-4">
          <Progress value={12} label="Materialisierung" />
          <Progress value={64} label="PDF wird gerendert" />
          <Progress value={100} label="Suchindex" />
          <div className="flex flex-col gap-2" aria-hidden>
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-2/3" />
          </div>
        </div>
      </DsExample>
    </DsSection>
  );
}

export function InstrumentSection() {
  return (
    <DsSection
      id="instrument"
      title="Instrumentmarken"
      lead="Das eigene Vokabular der Anwendung: eine Abschnittsmarke statt einer Kartenüberschrift, eine Leitlinie statt einer Kachel. Beide in signal-line, der Unterschied ist die Masse."
    >
      <DsExample
        id="abschnittsmarke"
        title="Abschnittsmarke"
        source="packages/ui/src/components/instrument.tsx"
        note="Mit Zähler (nie null) und mit Aktion."
      >
        <div className="flex max-w-sm flex-col gap-4">
          <SectionRule>Zuletzt bearbeitet</SectionRule>
          <SectionRule trailing={12}>Offene Enden</SectionRule>
          <SectionRule
            action={
              <Button variant="ghost" size="sm">
                Einladen
              </Button>
            }
          >
            Mitglieder
          </SectionRule>
        </div>
      </DsExample>

      <DsExample
        id="messwerte"
        title="Messwerte"
        note="Readout ist die Zeile, für die Leader gezeichnet wurde. tone=live markiert, was gerade passiert, statt was gespeichert ist."
      >
        <div className="flex max-w-sm flex-col gap-4">
          <SectionRule>Betrieb</SectionRule>
          <Readout label="Nutzer" value="4" />
          <Readout label="Seiten" value="1.284" note="davon 38 im Papierkorb" />
          <Readout label="KI-Läufe (24 h)" value="17" tone="live" />
          <span className="flex items-baseline gap-2 text-sm">
            <span>Eigene Zeile mit Leader</span>
            <Leader />
            <span className="exocortex-numeric">3,2 GB</span>
          </span>
        </div>
      </DsExample>
    </DsSection>
  );
}

export function MiscSection() {
  return (
    <DsSection
      id="weitere"
      title="Weitere Bausteine"
      lead="Werkzeugleiste, Avatar, Karte, Trenner, Scrollbereich, gekürzter Text und das Logo."
    >
      <DsExample
        id="werkzeugleiste"
        title="Werkzeugleiste"
        source="packages/ui/src/components/ui/toolbar.tsx"
        note="Ein Tabstopp für die ganze Leiste, die Pfeiltasten wandern darin."
        stageClassName="flex"
      >
        <Toolbar aria-label="Formatierung">
          <ToolbarButton render={<Toggle aria-label="Fett" size="sm" />}>
            <BoldIcon />
          </ToolbarButton>
          <ToolbarButton render={<Toggle aria-label="Kursiv" size="sm" />}>
            <ItalicIcon />
          </ToolbarButton>
          <ToolbarSeparator />
          <ToolbarButton render={<Button variant="ghost" size="sm" />}>
            <LinkIcon />
            Link
          </ToolbarButton>
        </Toolbar>
      </DsExample>

      <DsExample
        id="avatar"
        title="Avatar"
        source="packages/ui/src/components/ui/avatar.tsx"
        note="Der Baustein allein, mit Initialen. Eingefärbt mit der Präsenzfarbe wird er in shell/presence-avatars.tsx."
      >
        <div className="flex gap-2">
          {['JO', 'ST', 'AG'].map((initials) => (
            <Avatar key={initials}>
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
          ))}
        </div>
      </DsExample>

      <DsExample
        id="karte"
        title="Karte"
        source="packages/ui/src/components/ui/card.tsx"
        note="Nur für wirklich abtrennbare Blöcke: die Anmeldung und die Einrichtungsrezepte. Nie verschachtelt, nie als Listenzeile."
      >
        <Card className="max-w-sm">
          <CardHeader>
            <CardTitle>Anmelden</CardTitle>
            <CardDescription>Mit der Adresse, zu der die Einladung kam.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full">Weiter</Button>
          </CardContent>
        </Card>
      </DsExample>

      <DsExample
        id="trenner-scroll"
        title="Trenner und Scrollbereich"
        source="packages/ui/src/components/ui/separator.tsx, scroll-area.tsx"
      >
        <div className="flex max-w-sm flex-col gap-3">
          <span className="text-sm">Oben</span>
          <Separator />
          <ScrollArea className="h-32 rounded-md border border-border">
            <ul className="flex flex-col p-3 text-sm">
              {Array.from({ length: 12 }, (_, index) => (
                <li key={index} className="py-1">
                  Eintrag {index + 1}
                </li>
              ))}
            </ul>
          </ScrollArea>
        </div>
      </DsExample>

      <DsExample
        id="gekuerzt"
        title="Gekürzter Text"
        source="packages/ui/src/components/truncated-text.tsx"
        note="Der Tooltip erscheint nur, wenn wirklich gekürzt wurde, und als einziger auch auf Touch."
      >
        <div className="w-48 text-sm">
          <TruncatedText text="Protokoll der Arbeitsgruppe Infrastruktur vom 24. September" />
        </div>
      </DsExample>

      <DsExample
        id="logo"
        title="Logo"
        source="packages/ui/src/components/logo.tsx"
        note="Die Wortmarke steht einmal pro Bildschirm oben links, das Zeichen allein nur, wo kein Name passt. Die eine erlaubte feste Farbe."
      >
        <div className="flex flex-wrap items-center gap-8">
          <ExocortexWordmark className="h-7" />
          <ExocortexLogo className="size-10" />
        </div>
      </DsExample>
    </DsSection>
  );
}
