/**
 * The styleguide's table of contents, in reading order.
 *
 * One list serves the navigation and the page, so a section cannot be linked
 * without existing or exist without being linked. The grouping follows the
 * taxonomy in `docs/design-system-inventory.md` §1 and its proposed navigation
 * in §6; a group only appears once it has something to show.
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
    ],
  },
];

export const DESIGN_SYSTEM_ENTRIES: readonly CatalogEntry[] = DESIGN_SYSTEM_CATALOG.flatMap(
  (group) => group.entries,
);
