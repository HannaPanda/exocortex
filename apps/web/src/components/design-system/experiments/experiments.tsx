import { Badge, SectionRule } from '@exocortex/ui';

import { DsSection, DsSource } from '../showcase';

/**
 * The one part of the styleguide that is not canonical.
 *
 * An undecided variant lives here and nowhere else, and product code never
 * imports from this directory (`docs/design-system-inventory.md` §6). The list
 * below is the audit's list of open decisions, §5; each with a variant set has
 * a section of its own below this one (#126), and a decided one leaves by the
 * steps written out here.
 */

interface OpenDecision {
  id: string;
  title: string;
  question: string;
  evidence: string;
  /** The experiment's own section, when the decision has one. */
  experiment?: string;
}

const OPEN_DECISIONS: readonly OpenDecision[] = [
  {
    id: 'offen-p13',
    title: 'P13 Linke Akzentränder',
    question:
      'Den Kommentarrand als begründete Ausnahme behalten, den der Transklusion streichen, oder beide ändern?',
    evidence: 'Zwei Ränder, die DESIGN.md verbietet (F-3).',
    experiment: 'experiment-p13',
  },
  {
    id: 'offen-p11',
    title: 'P11 Fokussprache',
    question:
      'Eine Kontur oder ein Ring, und was machen dichte Zeilen und abgeschnittene Container damit?',
    evidence: 'Neun Behandlungen (F-1), DESIGN.md widerspricht den Primitiven (F-2).',
    experiment: 'experiment-p11',
  },
  {
    id: 'offen-p9',
    title: 'P9 Form des leeren Zustands',
    question: 'Zentriert mit Icon zuerst, oder linksbündig mit der Handlung zuerst?',
    evidence: '63 EmptyState, 3 von Hand gebaut, keine kompakte Variante.',
    experiment: 'experiment-p9',
  },
  {
    id: 'offen-p12',
    title: 'P12 Dichte Flächen auf schmalen Bildschirmen',
    question: 'Seitwärts scrollen, eine Liste, oder angeheftete Spalten?',
    evidence: 'Inventar 2.5.',
    experiment: 'experiment-p12',
  },
  {
    id: 'offen-kalender',
    title: 'Kalender-Baustein',
    question: 'Calendar für die Datumseingabe übernehmen oder entfernen?',
    evidence:
      'Eine Produktentscheidung, kein Experiment. Der Baustein hat heute keine Aufrufstelle.',
  },
];

/** Issue #126, "Entscheidungsworkflow": what happens once a variant is chosen. */
const STEPS = [
  'Die Entscheidung wird im Issue der Entscheidung festgehalten, mit der gewählten Variante.',
  'Der Code der Anwendung wird angepasst, an einer Stelle statt pro Aufrufstelle, wo das geht.',
  'DESIGN.md bekommt die Regel, docs/ui-system.md und das Inventar den neuen Stand.',
  'Das Beispiel der gewählten Variante zieht in den passenden kanonischen Abschnitt um.',
  'Die verworfenen Varianten werden gelöscht, nicht versteckt, und mit ihnen das Experiment.',
  'Die Vergleichsbilder der Regressionstests werden neu abgenommen, und impeccable detect läuft noch einmal.',
];

export function ExperimentsSection() {
  return (
    <DsSection
      id="experimente"
      title="Experimente"
      lead="Alles hier ist nicht entschieden. Nichts davon ist ein Vorbild, und Code der Anwendung importiert nichts aus diesem Bereich. Jede Variante zeigt dieselben Inhalte, damit kein Beispieltext eine Seite bevorzugt."
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
              {decision.experiment === undefined ? null : (
                <a
                  href={`#${decision.experiment}`}
                  className="self-start text-sm text-primary-text underline-offset-4 hover:underline"
                >
                  Zu den Varianten
                </a>
              )}
            </li>
          ))}
        </ul>
        <p className="max-w-measure text-sm text-muted-foreground">
          Quelle der Liste: <DsSource path="docs/design-system-inventory.md" />, Abschnitt 5. Archiv
          oder Papierkorb ist seit dem 24.09.2026 entschieden: Papierkorb (Issue #129).
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
