'use client';

import {
  ExternalLinkIcon,
  FileTextIcon,
  KanbanIcon,
  MessageSquareIcon,
  SearchIcon,
  Trash2Icon,
} from 'lucide-react';
import * as React from 'react';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { DsExample, DsSection, DsState } from '../showcase';

/**
 * Patterns: components combined the way the product combines them. Only the
 * canonical ones are here; the undecided ones belong to the experiments.
 */

export function StatesPattern() {
  const [retries, setRetries] = React.useState(0);
  return (
    <DsSection
      id="zustaende"
      title="Laden, leer, Fehler"
      lead="Drei geteilte Zustände statt einer eigenen Lösung pro Liste. Ein leerer Zustand steht zentriert, das Icon zuerst, die Aktion als Umrissknopf unter dem Text (P9), überall in derselben Form."
    >
      <DsExample
        id="zustand-laden"
        title="Laden"
        source="packages/ui/src/components/states.tsx"
        note="Skelettzeilen, wo die Form des Inhalts bekannt ist, sonst der Kreisel. Beide melden sich als role=status."
      >
        <div className="grid gap-6 md:grid-cols-2">
          <DsState label="Kreisel">
            <LoadingState label="Seite wird geladen …" className="w-full" />
          </DsState>
          <DsState label="Skelett">
            <LoadingState
              variant="skeleton"
              rows={3}
              label="Seitenbaum wird geladen"
              className="w-full"
            />
          </DsState>
        </div>
      </DsExample>

      <DsExample
        id="zustand-leer"
        title="Leer"
        note="In einem Bereich von 260 px, der echten Mindestbreite des Kontextbereichs, und auf Seitenbreite. Ist der Ausweg kein einfacher Klick, etwa eine Auswahl, nimmt EmptyState ihn als Kind an die Stelle des Knopfs."
      >
        <div className="flex flex-wrap gap-6">
          <div className="w-[260px] rounded-md bg-surface">
            <EmptyState
              title="Noch keine Kommentare"
              description="Markiere Text, um einen Kommentar anzuhängen."
            />
          </div>
          <div className="min-w-64 flex-1 rounded-md bg-surface">
            <EmptyState
              icon={Trash2Icon}
              title="Der Papierkorb ist leer"
              description="Was du in den Papierkorb legst, bleibt hier, bis es jemand wiederherstellt oder endgültig löscht."
            />
          </div>
          <div className="w-full rounded-md bg-surface">
            <EmptyState
              icon={SearchIcon}
              title="Keine Treffer"
              description="Kein Eintrag passt zu dieser Suche."
              action={{ label: 'Suche zurücksetzen', onClick: () => undefined }}
            />
          </div>
          <div className="w-full rounded-md bg-surface">
            <EmptyState
              icon={KanbanIcon}
              title="Noch nicht gruppiert"
              description="Wähle eine Auswahl-Eigenschaft, nach der die Karten gruppiert werden."
            >
              <Select defaultValue={null}>
                <SelectTrigger className="w-56" aria-label="Gruppieren nach">
                  <SelectValue>
                    {(value: string | null) =>
                      value === null
                        ? 'Eigenschaft wählen'
                        : value === 'status'
                          ? 'Status'
                          : 'Bereich'
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="status">Status</SelectItem>
                  <SelectItem value="area">Bereich</SelectItem>
                </SelectContent>
              </Select>
            </EmptyState>
          </div>
        </div>
      </DsExample>

      <DsExample
        id="zustand-fehler"
        title="Fehler"
        note="Meldet sich als role=alert und bietet den nächsten Schritt an. Ein fehlgeschlagener Abruf ist ein Fehler, nie ein leerer Zustand."
      >
        <div className="rounded-md bg-surface">
          <ErrorState
            title="Seite nicht geladen"
            description={
              retries === 0
                ? 'Bitte versuche es erneut. Falls das Problem bleibt, prüfe die Verbindung.'
                : `Erneut versucht (${retries}). Der Server antwortet noch nicht.`
            }
            onRetry={() => setRetries((count) => count + 1)}
          />
        </div>
      </DsExample>
    </DsSection>
  );
}

export function ConfirmationPattern() {
  const [open, setOpen] = React.useState(false);
  return (
    <DsSection
      id="bestaetigung"
      title="Bestätigung"
      lead="Wer etwas Unwiderrufliches tut, bekommt eine Frage als Titel, die gezählten Folgen und zwei Antworten: die sichere zuerst, die destruktive zuletzt."
    >
      <DsExample
        id="bestaetigung-dialog"
        title="Endgültig löschen"
        source="shell/trash-sheet.tsx"
        note="Nach dem Muster des Papierkorbs, mit einem Wort für Auslöser und Antwort. Eine gemeinsame Komponente dafür gibt es noch nicht; vier Stellen fragen verschieden und vier gar nicht (Issue #129)."
      >
        <Button variant="destructive" onClick={() => setOpen(true)}>
          Endgültig löschen
        </Button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Endgültig löschen?</DialogTitle>
              <DialogDescription>
                3 Seiten, 2 Anhänge und 5 Verweise darauf werden gelöscht. Das lässt sich nicht
                rückgängig machen, auch nicht über einen Versionsstand.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Abbrechen
              </Button>
              <Button variant="destructive" onClick={() => setOpen(false)}>
                Endgültig löschen
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DsExample>
    </DsSection>
  );
}

const PARAGRAPH_BEFORE =
  'Die erste Messreihe lief an drei aufeinanderfolgenden Tagen, jeweils um neun Uhr, im selben Raum.';
const PARAGRAPH_COMMENTED =
  'Die zweite Messreihe wurde verworfen, weil die Raumtemperatur über 24 Grad lag und die Waage bei Wärme messbar abdriftet.';
const TRANSCLUDED =
  'Vor jeder Messung wird die Waage mit dem 100-Gramm-Prüfgewicht kalibriert. Weicht die Anzeige um mehr als 0,02 Gramm ab, wird die Messung nicht begonnen.';

/**
 * Blocks the editor marks (P13, decided 2026-09-24), with the product's own
 * classes and without an editor. The count is a ProseMirror widget in the
 * product (`comment-markers.tsx`); this is its markup, drawn by React.
 */
export function MarkedBlocksPattern() {
  return (
    <DsSection
      id="markierte-bloecke"
      title="Markierte Blöcke"
      lead="Der Editor markiert ohne linke Akzentränder. Ein kommentierter Block trägt eine leichte Warnfläche und rechts die Zahl seiner offenen Kommentare, ein eingebetteter Abschnitt denselben schlichten Rahmen wie eine eingebettete Datenbank."
    >
      <DsExample
        id="block-kommentiert"
        title="Kommentierter Block"
        source="apps/web/src/components/editor/comment-markers.tsx"
        note="Die Zahl zählt Kommentare und Antworten aller offenen Fäden am Block. Sie ist nicht fokussierbar: ein Klick auf den Absatz öffnet den Faden, die Tastatur erreicht ihn über den Kommentarbereich."
      >
        <div className="exocortex-editor max-w-measure pl-3">
          <p>{PARAGRAPH_BEFORE}</p>
          <p className="exocortex-commented">
            <span className="exocortex-comment-count">
              <MessageSquareIcon aria-hidden />2
              <span className="exocortex-sr-only"> Kommentare</span>
            </span>
            {PARAGRAPH_COMMENTED}
          </p>
        </div>
      </DsExample>

      <DsExample
        id="block-transklusion"
        title="Eingebetteter Abschnitt"
        source="apps/web/src/components/editor/transclusion-node-view.tsx"
        note="Rahmen und Kopfzeile sagen, dass der Inhalt von einer anderen Seite kommt und wo er endet."
      >
        <div className="exocortex-editor max-w-measure">
          <div className="exocortex-transclusion">
            <div className="embed-header">
              <FileTextIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="embed-title">Laborprotokoll: Kalibrierung</span>
              <div className="embed-actions">
                <a href="#block-transklusion" className="embed-action">
                  <ExternalLinkIcon aria-hidden />
                  Quelle öffnen
                </a>
              </div>
            </div>
            <div className="p-3">
              <p className="my-0">{TRANSCLUDED}</p>
            </div>
          </div>
        </div>
      </DsExample>
    </DsSection>
  );
}
