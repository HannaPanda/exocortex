/**
 * The variants `/design-system/rahmen/<probe>` can show (issue #126), with the
 * name each carries on the styleguide. Kept apart from the components because
 * the route is a server component and needs the list at build time, and a
 * value exported from a client module is only a reference there.
 */
export const DENSE_PROBE_TITLES = {
  'p12-tabelle-a': 'Tabelle A: seitwärts scrollen',
  'p12-tabelle-b': 'Tabelle B: Liste',
  'p12-tabelle-c': 'Tabelle C: angeheftete Spalten',
  'p12-einstellungen-a': 'Einstellungen A: wie heute',
  'p12-einstellungen-b': 'Einstellungen B: für schmal gesetzt',
} as const;

export type DenseProbe = keyof typeof DENSE_PROBE_TITLES;

export function isDenseProbe(value: string): value is DenseProbe {
  return Object.hasOwn(DENSE_PROBE_TITLES, value);
}
