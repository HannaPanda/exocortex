import { Badge, SectionRule } from '@exocortex/ui';

import { DsSection, DsSource } from '../showcase';

/**
 * The one part of the styleguide that is not canonical.
 *
 * An undecided variant lives here and nowhere else, and product code never
 * imports from this directory (`docs/design-system-inventory.md` §6). The list
 * below is the audit's list of open decisions, §5; a variant is added under its
 * decision by #126, and a decided one leaves this section by the five steps
 * written out here.
 */

interface OpenDecision {
  id: string;
  title: string;
  question: string;
  evidence: string;
}

const OPEN_DECISIONS: readonly OpenDecision[] = [
  {
    id: 'experiment-p9',
    title: 'P9 Form des leeren Zustands',
    question: 'Zentriert mit Icon zuerst, oder linksbündig mit der Handlung zuerst?',
    evidence:
      '63 EmptyState, 3 von Hand gebaut, keine kompakte Variante. Stand: Muster Laden, leer, Fehler.',
  },
  {
    id: 'experiment-p11',
    title: 'P11 Fokussprache',
    question:
      'Eine Kontur oder ein Ring, und was machen dichte Zeilen und abgeschnittene Container damit?',
    evidence:
      'Neun Behandlungen (F-1), DESIGN.md widerspricht den Primitiven (F-2). Stand: Grundlagen Fokus.',
  },
  {
    id: 'experiment-p12',
    title: 'P12 Dichte Flächen auf schmalen Bildschirmen',
    question: 'Seitwärts scrollen, Karten, oder eine angeheftete Schlüsselspalte?',
    evidence: 'Inventar 2.5. Stand: Layout Tabellenansicht.',
  },
  {
    id: 'experiment-p13',
    title: 'P13 Linke Akzentränder',
    question:
      'Den Kommentarrand als begründete Ausnahme behalten, den der Transklusion streichen, oder beide ändern?',
    evidence:
      'Zwei Ränder, die DESIGN.md verbietet (F-3). Transklusion und kommentierter Text stehen deshalb nicht bei den Mustern.',
  },
  {
    id: 'experiment-papierkorb',
    title: 'Archiv oder Papierkorb',
    question: 'Ein Wort für den Ort und die Handlung.',
    evidence: 'Eine Wortentscheidung, kein Experiment nötig. Stand: Sprache, Begriffe.',
  },
  {
    id: 'experiment-kalender',
    title: 'Kalender-Baustein',
    question: 'Calendar für die Datumseingabe übernehmen oder entfernen?',
    evidence: 'Eine Produktentscheidung. Der Baustein hat heute keine Aufrufstelle.',
  },
];

const STEPS = [
  'Die gewählte Variante wird in der Anwendung umgesetzt oder bestätigt.',
  'Ihr Beispiel zieht in den passenden kanonischen Abschnitt um.',
  'Die verworfenen Varianten werden gelöscht, nicht versteckt.',
  'DESIGN.md hält die Entscheidung fest.',
  'Die Vergleichsbilder der Regressionstests werden neu abgenommen.',
];

export function ExperimentsSection() {
  return (
    <DsSection
      id="experimente"
      title="Experimente"
      lead="Alles hier ist nicht entschieden. Nichts davon ist ein Vorbild, und Code der Anwendung importiert nichts aus diesem Bereich."
    >
      <div className="flex flex-col gap-3">
        <SectionRule as="h3">Offene Entscheidungen</SectionRule>
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-dashed border-border">
          {OPEN_DECISIONS.map((decision) => (
            <li
              key={decision.id}
              id={decision.id}
              className="flex scroll-mt-6 flex-col gap-1.5 p-4 sm:p-5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-subsection">{decision.title}</h4>
                <Badge variant="outline">offen</Badge>
              </div>
              <p className="max-w-measure text-sm">{decision.question}</p>
              <p className="max-w-measure text-meta text-muted-foreground">{decision.evidence}</p>
            </li>
          ))}
        </ul>
        <p className="max-w-measure text-sm text-muted-foreground">
          Die Varianten dazu gehören zu Issue #126. Quelle der Liste:{' '}
          <DsSource path="docs/design-system-inventory.md" />, Abschnitt 5.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <SectionRule as="h3">Wenn entschieden ist</SectionRule>
        <ol className="flex max-w-measure list-decimal flex-col gap-1.5 pl-5 text-sm">
          {STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>
    </DsSection>
  );
}
