/**
 * Which job each token in `packages/ui/src/tokens.css` does, in the words the
 * styleguide shows next to it.
 *
 * Names and values are not written here: they are parsed out of the stylesheet
 * (`lib/design-tokens.ts`). What the stylesheet cannot say in a form a page can
 * show is the role, so this file carries the role and nothing else, and
 * `token-catalog.test.ts` holds it to the stylesheet in both directions: every
 * token here must exist, and every token the stylesheet declares must be placed
 * in exactly one group. A new token therefore cannot reach the product without
 * somebody deciding what it is for -- the rule in issue #128, as a test.
 *
 * The reasons behind the roles live in DESIGN.md §2 and §4; this is the short
 * form, German because a person reads it.
 */

export type TokenKind = 'colour' | 'radius' | 'shadow' | 'motion' | 'length';

export interface TokenGroup {
  id: string;
  title: string;
  kind: TokenKind;
  description: string;
  tokens: Readonly<Record<string, string>>;
}

const CONTENT_COLOURS = {
  gray: 'Grau',
  brown: 'Braun',
  orange: 'Orange',
  yellow: 'Gelb',
  green: 'Grün',
  blue: 'Blau',
  purple: 'Violett',
  pink: 'Pink',
  red: 'Rot',
} as const;

function contentTokens(prefix: string, role: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(CONTENT_COLOURS).map(([key, label]) => [`${prefix}${key}`, `${role} ${label}`]),
  );
}

export const TOKEN_GROUPS: readonly TokenGroup[] = [
  {
    id: 'oberflaechen',
    title: 'Oberflächen',
    kind: 'colour',
    description:
      'Die Rampe von unten nach oben. Die Seite ist die hellste große Fläche, die Hülle liegt darunter. Popover ist die eine gewollte Ausnahme.',
    tokens: {
      '--sunken': 'Vertiefung: Code, Messwerte, in die Seite geschnitten',
      '--surface': 'Hülle: Kopfzeile, Seitenleiste, Kontextbereich',
      '--popover': 'Schwebend: Menüs, Dialoge, Befehlspalette',
      '--background': 'Die Seite, #344955',
      '--card': 'Ein Block, von der Seite abgehoben',
      '--overlay': 'Abdunklung hinter modalen Flächen',
    },
  },
  {
    id: 'text',
    title: 'Text',
    kind: 'colour',
    description: 'Tinte auf den Oberflächen. Alles, was nicht Inhalt ist, ist gedämpft.',
    tokens: {
      '--foreground': 'Fließtext, 7,7:1 auf der Seite',
      '--muted-foreground': 'Zweitrangiger Text, Metadaten',
      '--surface-foreground': 'Text auf der Hülle',
      '--card-foreground': 'Text auf einem Block',
      '--popover-foreground': 'Text in Menüs und Dialogen',
      '--muted': 'Gedämpfte Fläche: Skelett, Leiste',
    },
  },
  {
    id: 'signal',
    title: 'Signal',
    kind: 'colour',
    description:
      'Ein Bernstein in vier Stufen: Struktur, Hover, Auswahl, Aktion. Nur die letzte ist eine Farbe, die man bemerkt.',
    tokens: {
      '--signal-line': 'Struktur: Linien, Leitpunkte, Baumführung. Nie Text',
      '--accent-solid': 'Hover',
      '--accent-strong': 'Auswahl: „du bist hier“',
      '--primary': 'Aktion, Fokus, live. Füllfarbe',
      '--primary-foreground': 'Text auf der Primärfläche',
      '--primary-text': 'Bernstein als Text und Icon',
      '--accent-foreground': 'Text auf der Hover-Fläche',
      '--ring': 'Fokusring',
    },
  },
  {
    id: 'neutral',
    title: 'Neutrale Bedienelemente',
    kind: 'colour',
    description: 'Bewusst farblos: ein zweites warmes Element würde mit dem Signal konkurrieren.',
    tokens: {
      '--secondary': 'Neutrale Fläche für Chips und zweitrangige Aktionen',
      '--secondary-foreground': 'Text darauf',
    },
  },
  {
    id: 'status',
    title: 'Status',
    kind: 'colour',
    description:
      'Ein eigenes System neben dem Signal. Nie die einzige Information: immer mit Icon oder Text.',
    tokens: {
      '--destructive': 'Unwiderruflich: Füllfarbe',
      '--destructive-foreground': 'Text auf der Destruktiv-Fläche',
      '--destructive-text': 'Fehler als Text und Icon',
      '--warning': 'Warnung, 28° vom Signal entfernt',
      '--warning-foreground': 'Text auf der Warnfläche',
      '--success': 'Erfolg',
      '--success-foreground': 'Text auf der Erfolgsfläche',
      '--info': 'Hinweis',
      '--info-foreground': 'Text auf der Hinweisfläche',
    },
  },
  {
    id: 'rahmen',
    title: 'Rahmen',
    kind: 'colour',
    description:
      'Trennen oder begrenzen: eine Linie, an der man etwas tun kann, braucht 3:1 und damit input oder border-strong.',
    tokens: {
      '--border': 'Trennung, begrenzt nie ein Bedienelement',
      '--border-strong': 'Wahrnehmbare Grenze',
      '--input': 'Rand eines Formularfelds',
    },
  },
  {
    id: 'praesenz',
    title: 'Präsenz',
    kind: 'colour',
    description:
      'Cursor und Avatare der Mitarbeitenden, über Farbton und Helligkeit gestreut. Präsenz 1 ist immer du selbst.',
    tokens: {
      '--presence-1': 'Du selbst, auf deinem Bildschirm',
      '--presence-2': 'Andere, per Hash verteilt',
      '--presence-3': 'Andere, per Hash verteilt',
      '--presence-4': 'Andere, per Hash verteilt',
      '--presence-5': 'Andere, per Hash verteilt',
      '--presence-6': 'Andere, per Hash verteilt',
      '--presence-foreground': 'Beschriftung auf allen sechs',
    },
  },
  {
    id: 'inhaltsfarben',
    title: 'Inhaltsfarben',
    kind: 'colour',
    description:
      'Farben, die Schreibende selbst wählen. Sie stehen außerhalb des Signalsystems; ein Dokument speichert nur den Namen.',
    tokens: {
      ...contentTokens('--content-', 'Textfarbe'),
      ...contentTokens('--content-bg-', 'Hintergrund'),
    },
  },
  {
    id: 'radien',
    title: 'Radien',
    kind: 'radius',
    description: 'Ein Radius sagt, wie groß das Ding ist, das ihn trägt.',
    tokens: {
      '--radius-xs': 'Tönung über Text oder Grafik',
      '--radius-sm': 'Marke kleiner als ein Bedienelement: Chip, Taste',
      '--radius': 'Bedienelement: Knopf, Feld, Auswahl (md)',
      '--radius-lg': 'Fläche: Popover, Dialog, Sheet, Karte',
    },
  },
  {
    id: 'schatten',
    title: 'Schatten',
    kind: 'shadow',
    description:
      'Die Ebene sagt die Rampe, der Schatten bestätigt sie nur. Eingefärbt mit dem Schiefer, nicht schwarz.',
    tokens: {
      '--shadow-xs': 'Ein Feld in Ruhe',
      '--shadow-sm': 'Ein abgehobener Block: Karte, PDF-Seite',
      '--shadow-md': 'Schwebend: Menü, Popover, Werkzeugleiste, Tooltip',
      '--shadow-lg': 'Modal: Dialog, Sheet',
    },
  },
  {
    id: 'bewegung',
    title: 'Bewegung',
    kind: 'motion',
    description: 'Eine Kurve, zwei Dauern. Bewegung meldet eine Zustandsänderung, sonst nichts.',
    tokens: {
      '--ease-out-quint': 'Die eine Kurve: schnell los, lang ausklingen',
      '--duration-fast': 'Standard für jeden Übergang',
      '--duration-settle': 'Ausklingen eines Signals, das gefeuert hat',
    },
  },
  {
    id: 'masse',
    title: 'Maße der Hülle',
    kind: 'length',
    description: 'Die festen Maße der Anwendungshülle.',
    tokens: {
      '--header-height': 'Höhe der Kopfzeile',
      '--sidebar-width': 'Breite der Seitenleiste',
      '--context-panel-width': 'Breite des Kontextbereichs',
    },
  },
];
