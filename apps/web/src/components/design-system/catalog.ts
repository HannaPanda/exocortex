/**
 * The styleguide's table of contents, in reading order.
 *
 * One list serves the navigation and the page, so a section cannot be linked
 * without existing or exist without being linked. The grouping follows the
 * taxonomy in `docs/design-system-inventory.md` §1 and its proposed navigation
 * in §6.
 */

export interface CatalogEntry {
  id: string;
  title: string;
}

export interface CatalogGroup {
  title: string;
  entries: readonly CatalogEntry[];
}

export const DESIGN_SYSTEM_CATALOG: readonly CatalogGroup[] = [
  {
    title: 'Einstieg',
    entries: [{ id: 'grundsaetze', title: 'Grundsätze' }],
  },
  {
    title: 'Grundlagen',
    entries: [
      { id: 'farben', title: 'Farben' },
      { id: 'typografie', title: 'Typografie' },
      { id: 'radien-und-ebenen', title: 'Radien und Ebenen' },
      { id: 'bewegung', title: 'Bewegung' },
      { id: 'fokus', title: 'Fokus' },
      { id: 'masse', title: 'Maße und Breiten' },
    ],
  },
  {
    title: 'Komponenten',
    entries: [
      { id: 'knoepfe', title: 'Knöpfe' },
      { id: 'formulare', title: 'Formularfelder' },
      { id: 'umschalter', title: 'Umschalter und Tabs' },
      { id: 'menues', title: 'Menüs und Popover' },
      { id: 'dialoge', title: 'Dialoge und Sheets' },
      { id: 'tabellen', title: 'Tabellen' },
      { id: 'rueckmeldung', title: 'Rückmeldung' },
      { id: 'instrument', title: 'Instrumentmarken' },
      { id: 'weitere', title: 'Weitere Bausteine' },
    ],
  },
  {
    title: 'Muster',
    entries: [
      { id: 'zustaende', title: 'Laden, leer, Fehler' },
      { id: 'bestaetigung', title: 'Bestätigung' },
      { id: 'markierte-bloecke', title: 'Markierte Blöcke' },
      { id: 'einstellungszeile', title: 'Einstellungszeile' },
      { id: 'seitenbaum', title: 'Seitenbaum' },
      { id: 'suchtreffer', title: 'Suchtreffer' },
      { id: 'praesenz', title: 'Präsenz' },
      { id: 'ki-fortschritt', title: 'KI-Lauf in Arbeit' },
    ],
  },
  {
    title: 'Layouts',
    entries: [
      { id: 'huelle', title: 'Hülle' },
      { id: 'inhaltsseite', title: 'Inhaltsseite' },
      { id: 'einstellungen-layout', title: 'Einstellungen' },
      { id: 'verwaltung', title: 'Verwaltung' },
      { id: 'suche-layout', title: 'Suche' },
      { id: 'tabellenansicht', title: 'Tabellenansicht' },
    ],
  },
  {
    title: 'Querschnitt',
    entries: [
      { id: 'barrierefreiheit', title: 'Barrierefreiheit' },
      { id: 'sprache', title: 'Sprache' },
    ],
  },
  {
    title: 'Nicht entschieden',
    entries: [{ id: 'experimente', title: 'Experimente' }],
  },
];

export const DESIGN_SYSTEM_ENTRIES: readonly CatalogEntry[] = DESIGN_SYSTEM_CATALOG.flatMap(
  (group) => group.entries,
);
