import { DsSection } from '../showcase';

import { DsExperimentBrief, DsNarrowFrame, DsVariant, DsVariants } from './frame';
import { DENSE_PROBE_TITLES, type DenseProbe } from './probes';

/**
 * P12: dense surfaces in a window 390 px wide. Every variant is an iframe onto
 * `/design-system/rahmen/<probe>`, so the breakpoints inside it answer to 390
 * px however wide the styleguide's own window is.
 */

const TABLE_VARIANTS: readonly { probe: DenseProbe; tradeoffs: readonly string[] }[] = [
  {
    probe: 'p12-tabelle-a',
    tradeoffs: [
      'Die Tabelle bleibt eine Tabelle; Screenreader lesen Spalten und Köpfe wie auf dem Desktop.',
      'Auf 390 px ist nur der Name zu sehen, die Aktion liegt rechts außerhalb und muss erst gesucht werden.',
      'Nichts verrät, dass seitwärts mehr kommt, außer dem abgeschnittenen Rand.',
    ],
  },
  {
    probe: 'p12-tabelle-b',
    tradeoffs: [
      'Alles ohne Scrollen sichtbar, die Aktion steht neben dem Namen.',
      'Etwa dreimal so hoch pro Eintrag; lange Listen werden entsprechend länger.',
      'Spalten lassen sich nicht mehr nebeneinander vergleichen, und eine Sortierung nach Spalte hat keinen Kopf mehr.',
      'Eine zweite Darstellung pro Tabelle, die gepflegt werden will.',
    ],
  },
  {
    probe: 'p12-tabelle-c',
    tradeoffs: [
      'Name und Aktion bleiben stehen, dazwischen scrollt der Rest; so macht es die Datenbank-Tabelle heute mit der Namensspalte.',
      'Auf 390 px bleiben für die scrollende Mitte etwa 120 px, also eine Spalte auf einmal.',
      'Lange Namen brechen um und machen die Zeile höher.',
    ],
  },
];

const SETTINGS_VARIANTS: readonly { probe: DenseProbe; tradeoffs: readonly string[] }[] = [
  {
    probe: 'p12-einstellungen-a',
    tradeoffs: [
      'Unter 640 px stapelt die Zeile schon heute: Label, Feld, Hilfe, Fehler.',
      'Der Schalter steht allein unter seinem Label, mit viel Leerraum rechts.',
      'Der Stand „Eigener Wert“ steht erst unter dem Hilfetext, weit weg vom Label.',
      'Speichern steht am Ende der Liste und ist bei vielen Zeilen außer Sicht.',
    ],
  },
  {
    probe: 'p12-einstellungen-b',
    tradeoffs: [
      'Schalter auf der Zeile ihres Labels, wie auf dem Telefon üblich; spart eine Zeile pro Schalter.',
      'Trennlinien zwischen den Zeilen; auf dem Desktop gibt es sie nicht, also zwei Formen.',
      'Speichern klebt unten in voller Breite und bedeckt dabei etwa 60 px Inhalt.',
      'Braucht eine eigene Zeilenform für Schalter, die SettingRow heute nicht hat.',
    ],
  },
];

export function DenseSurfacesExperiment() {
  return (
    <DsSection id="experiment-p12" title="P12 Dichte Flächen auf schmalen Bildschirmen">
      <DsExperimentBrief
        problem="Tabellen scrollen auf dem Telefon seitwärts, und die Zeilenaktionen liegen rechts außerhalb. Seitwärts scrollen, eine Liste, oder angeheftete Spalten? Und braucht das Einstellungsformular eine eigene schmale Form?"
        width="390 CSS px, in einem eigenen Fenster, damit die Umbrüche der Komponenten greifen"
        keyboard="Tab führt durch das Fenster wie durch eine Seite; seitwärts scrollt eine fokussierte Tabelle mit den Pfeiltasten."
        sources={[
          'apps/web/src/components/settings/api-token-panel.tsx',
          'apps/web/src/components/settings/setting-row.tsx',
          'apps/web/src/components/settings/workspace-settings-form.tsx',
          'apps/web/src/components/database/table-view.tsx',
        ]}
      />
      <p className="max-w-measure text-sm text-muted-foreground">
        Alle Varianten zeigen dieselben drei Tokens mit denselben Aktionen und dieselben vier
        Einstellungen: ein Schalter mit eigenem Wert, eine Auswahl mit langen Einträgen, eine Zahl
        mit abgelehntem Wert und ein langer Text.
      </p>
      <div className="grid gap-8 md:grid-cols-2 2xl:grid-cols-3">
        {TABLE_VARIANTS.map((variant) => (
          <DsVariant
            key={variant.probe}
            name={DENSE_PROBE_TITLES[variant.probe]}
            tradeoffs={variant.tradeoffs}
            stageClassName="flex justify-center p-2 sm:p-3"
          >
            <DsNarrowFrame
              probe={variant.probe}
              title={DENSE_PROBE_TITLES[variant.probe]}
              height={440}
            />
          </DsVariant>
        ))}
      </div>
      <DsVariants>
        {SETTINGS_VARIANTS.map((variant) => (
          <DsVariant
            key={variant.probe}
            name={DENSE_PROBE_TITLES[variant.probe]}
            tradeoffs={variant.tradeoffs}
            stageClassName="flex justify-center p-2 sm:p-3"
          >
            <DsNarrowFrame probe={variant.probe} title={DENSE_PROBE_TITLES[variant.probe]} />
          </DsVariant>
        ))}
      </DsVariants>
    </DsSection>
  );
}
