/**
 * The IANA zones a person picks from (issue #172).
 *
 * `Intl` is the zone database, as it is everywhere else here
 * (`packages/contracts/src/zoned-time.ts`): the list comes from
 * `Intl.supportedValuesOf('timeZone')`, so it moves with the runtime instead
 * of with a copied table nobody updates. Runtimes differ in which spelling of
 * a renamed zone they list (`Europe/Kiev` or `Europe/Kyiv`, `Asia/Calcutta` or
 * `Asia/Kolkata`) and V8 leaves `UTC` out, so a stored id is matched by what
 * the runtime resolves it to, and is kept as written rather than replaced by
 * the listed spelling.
 *
 * The offset is what a clock there shows at one instant. It changes with
 * daylight saving time and is never part of an option's identity.
 */

export interface TimeZoneOption {
  /** The IANA id as listed or stored, e.g. `America/Argentina/Buenos_Aires`. */
  id: string;
  /** What the runtime resolves `id` to; differs from `id` for an alias. */
  canonical: string;
  /** The last segment, readable: `Buenos Aires`. */
  place: string;
  /** Everything before it: `America/Argentina`, empty for `UTC`. */
  area: string;
  /** The zone's generic name in the reader's language, if the runtime has one. */
  name: string;
  /** The offset at the instant the options were built, e.g. `GMT+2`. */
  offset: string;
}

/** Every zone the runtime lists, plus `UTC`; empty where the runtime lists none. */
export function supportedTimeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
  if (typeof intl.supportedValuesOf !== 'function') return [];
  const zones = intl.supportedValuesOf('timeZone');
  return zones.includes('UTC') ? zones : [...zones, 'UTC'];
}

/** What the runtime resolves `id` to, or `null` for a zone it does not know. */
export function canonicalTimeZone(id: string): string | null {
  if (id === '' || id.length > 64) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: id }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function zoneNamePart(
  locale: string,
  timeZone: string,
  style: 'longGeneric' | 'shortOffset',
  at: Date,
): string {
  try {
    return (
      new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: style })
        .formatToParts(at)
        .find((part) => part.type === 'timeZoneName')?.value ?? ''
    );
  } catch {
    return '';
  }
}

/** One option, or `null` for an id the runtime does not know. */
export function timeZoneOption(id: string, locale: string, at: Date): TimeZoneOption | null {
  const canonical = canonicalTimeZone(id);
  if (canonical === null) return null;
  const segments = id.split('/');
  const name = zoneNamePart(locale, id, 'longGeneric', at);
  const offset = zoneNamePart(locale, id, 'shortOffset', at);
  return {
    id,
    canonical,
    place: (segments.at(-1) ?? id).replaceAll('_', ' '),
    area: segments.slice(0, -1).join('/').replaceAll('_', ' '),
    // Without a generic name the runtime falls back to the offset; saying it
    // twice in one row reads like a defect.
    name: name === offset ? '' : name,
    offset,
  };
}

/**
 * The options for `ids`, sorted by id, with every id in `include` added when
 * the list does not already carry exactly that spelling. An unknown id is
 * dropped here; the caller decides how to show one that is stored.
 */
export function timeZoneOptions(
  ids: readonly string[],
  locale: string,
  at: Date,
  include: readonly string[] = [],
): TimeZoneOption[] {
  const all = new Set(ids);
  for (const id of include) if (id !== '') all.add(id);
  const options: TimeZoneOption[] = [];
  for (const id of all) {
    const option = timeZoneOption(id, locale, at);
    if (option !== null) options.push(option);
  }
  return options.sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

/** The option for a stored id: the same spelling first, then the same zone. */
export function findTimeZoneOption(
  options: readonly TimeZoneOption[],
  id: string,
): TimeZoneOption | undefined {
  const exact = options.find((option) => option.id === id);
  if (exact !== undefined) return exact;
  const canonical = canonicalTimeZone(id);
  if (canonical === null) return undefined;
  return options.find((option) => option.canonical === canonical);
}

function normalise(text: string): string {
  return text
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replaceAll(/[_/]/g, ' ');
}

/**
 * Whether every word of `query` occurs in the option: its id, place, area,
 * name, offset or the zone it is an alias of. `berlin`, `europe/ber`,
 * `mitteleuropäische` and `gmt+2` all find Berlin; accents are ignored, so
 * `sao paulo` finds `São Paulo` where a runtime names it that way.
 */
export function matchesTimeZoneQuery(option: TimeZoneOption, query: string): boolean {
  const words = normalise(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalise(
    [option.id, option.place, option.area, option.name, option.offset, option.canonical].join(' '),
  );
  return words.every((word) => haystack.includes(word));
}
