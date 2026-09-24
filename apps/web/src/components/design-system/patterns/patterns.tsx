'use client';

import { SearchIcon, Trash2Icon } from 'lucide-react';
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
      lead="Drei geteilte Zustände statt einer eigenen Lösung pro Liste. Die Form des leeren Zustands ist offen: zentriert und Icon zuerst, oder linksbündig und Handlung zuerst (P9)."
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
        note="In einem Bereich von 260 px, der echten Mindestbreite des Kontextbereichs, und auf Seitenbreite."
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
