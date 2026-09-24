/**
 * The canonical examples `/design-system/rahmen/<probe>` shows in a window
 * 390 px wide, with the name each carries on the styleguide. Kept apart from
 * the components because the route is a server component and needs the list
 * at build time, and a value exported from a client module is only a
 * reference there.
 */
export const NARROW_PROBE_TITLES = {
  'tabelle-liste': 'Tabelle als Liste, 390 px',
  einstellungen: 'Einstellungen, 390 px',
} as const;

export type NarrowProbe = keyof typeof NARROW_PROBE_TITLES;

export function isNarrowProbe(value: string): value is NarrowProbe {
  return Object.hasOwn(NARROW_PROBE_TITLES, value);
}
