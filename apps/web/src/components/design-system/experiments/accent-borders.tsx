import { ExternalLinkIcon, FileTextIcon, MessageSquareIcon } from 'lucide-react';

import { DsSection } from '../showcase';

import { DsExperimentBrief, DsVariant, DsVariants } from './frame';

/**
 * P13: the two left accent borders DESIGN.md forbids (inventory F-3).
 *
 * Variant A is the product's own stylesheet: the classes below are the ones the
 * editor decoration and the transclusion node view put on the page, rendered
 * here without an editor. Variant B is the same markup with the rule taken off
 * by utilities, which win over the `components` layer the product rules live
 * in. Nothing else changes between the two, so the only question left on the
 * screen is whether the rule carries information.
 */

const PARAGRAPH_BEFORE =
  'Die erste Messreihe lief an drei aufeinanderfolgenden Tagen, jeweils um neun Uhr, im selben Raum.';
const PARAGRAPH_COMMENTED =
  'Die zweite Messreihe wurde verworfen, weil die Raumtemperatur über 24 Grad lag und die Waage bei Wärme messbar abdriftet.';
const PARAGRAPH_AFTER =
  'Für die dritte Reihe wurde deshalb der Kellerraum genutzt, in dem die Temperatur über den Tag um weniger als ein Grad schwankt.';
const TRANSCLUDED =
  'Vor jeder Messung wird die Waage mit dem 100-Gramm-Prüfgewicht kalibriert. Weicht die Anzeige um mehr als 0,02 Gramm ab, wird die Messung nicht begonnen.';

function CommentedSample({ marked }: { marked: 'rule' | 'marker' }) {
  return (
    <div className="exocortex-editor max-w-measure pl-3">
      <p>{PARAGRAPH_BEFORE}</p>
      {marked === 'rule' ? (
        <p className="exocortex-commented">{PARAGRAPH_COMMENTED}</p>
      ) : (
        <p className="exocortex-commented relative border-l-0 pl-3 pr-9">
          {PARAGRAPH_COMMENTED}
          <span className="absolute top-0.5 right-1 inline-flex items-center gap-0.5 text-meta text-muted-foreground">
            <MessageSquareIcon className="size-3.5" aria-hidden />2
            <span className="exocortex-sr-only">Kommentare</span>
          </span>
        </p>
      )}
      <p>{PARAGRAPH_AFTER}</p>
    </div>
  );
}

function TransclusionSample({ ruled }: { ruled: boolean }) {
  return (
    <div className="exocortex-editor max-w-measure">
      <p>{PARAGRAPH_BEFORE}</p>
      <div
        className={
          ruled ? 'exocortex-transclusion' : 'exocortex-transclusion border-l border-l-border'
        }
      >
        <div className="embed-header">
          <FileTextIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="embed-title">Laborprotokoll: Kalibrierung</span>
          <div className="embed-actions">
            <a href="#experiment-p13" className="embed-action">
              <ExternalLinkIcon aria-hidden />
              Quelle öffnen
            </a>
          </div>
        </div>
        <div className="p-3">
          <p className="my-0">{TRANSCLUDED}</p>
        </div>
      </div>
      <p>{PARAGRAPH_AFTER}</p>
    </div>
  );
}

export function AccentBordersExperiment() {
  return (
    <DsSection id="experiment-p13" title="P13 Linke Akzentränder">
      <DsExperimentBrief
        problem="Kommentierter Text und eingebettete Abschnitte tragen einen linken Rand, obwohl DESIGN.md linke Akzentränder verbietet. Trägt der Rand eine Information, oder verdoppelt er, was Fläche und Rahmen schon sagen?"
        width="Seitenspalte (max-w-measure), auf jeder Breite gleich"
        keyboard="Nur der Link „Quelle öffnen“ ist bedienbar; der Kommentar öffnet sich im Produkt per Klick auf den Absatz."
        sources={[
          'apps/web/src/app/globals.css (.exocortex-commented, .exocortex-transclusion)',
          'apps/web/src/components/editor/comment-markers.tsx',
          'apps/web/src/components/editor/transclusion-node-view.tsx',
        ]}
      />

      <DsVariants>
        <DsVariant
          name="Kommentar A: linker Warnrand (heute)"
          tradeoffs={[
            'Der Rand ist auch ohne Farbsehen als Form erkennbar.',
            'Er steht am linken Rand, wo das Auge beim Zeilenanfang ohnehin vorbeikommt.',
            'Verstößt gegen die Regel in DESIGN.md und müsste dort als Ausnahme stehen.',
          ]}
        >
          <CommentedSample marked="rule" />
        </DsVariant>
        <DsVariant
          name="Kommentar B: Fläche und Zähler, ohne Rand"
          tradeoffs={[
            'Kein linker Rand; Form und Zahl sagen, dass und wie viele Kommentare es gibt.',
            'Der Zähler braucht rechts Platz und kostet eine Zeilenlänge von etwa zwei Zeichen.',
            'Bei vielen kommentierten Absätzen wiederholt sich das Symbol am rechten Rand.',
          ]}
        >
          <CommentedSample marked="marker" />
        </DsVariant>
      </DsVariants>

      <DsVariants>
        <DsVariant
          name="Transklusion A: Rahmen mit linkem Akzentrand (heute)"
          tradeoffs={[
            'Der breitere linke Rand markiert zusätzlich, wo der fremde Inhalt anfängt und endet.',
            'Rahmen, Kopfzeile und Titel sagen dasselbe schon; der Rand ist die dritte Markierung.',
            'Verstößt gegen die Regel in DESIGN.md.',
          ]}
        >
          <TransclusionSample ruled />
        </DsVariant>
        <DsVariant
          name="Transklusion B: nur der Blockrahmen"
          tradeoffs={[
            'Derselbe Rahmen wie Lesezeichen und Datenbank-Einbettung, also eine Form weniger.',
            'Unterscheidet sich von einer eingebetteten Datenbank nur noch durch Kopfzeile und Inhalt.',
          ]}
        >
          <TransclusionSample ruled={false} />
        </DsVariant>
      </DsVariants>
    </DsSection>
  );
}
