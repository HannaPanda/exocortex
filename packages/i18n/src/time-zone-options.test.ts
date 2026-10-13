import { describe, expect, it } from 'vitest';

import {
  canonicalTimeZone,
  findTimeZoneOption,
  matchesTimeZoneQuery,
  supportedTimeZones,
  timeZoneOption,
  timeZoneOptions,
} from './time-zone-options.js';

const SUMMER = new Date('2026-07-01T12:00:00Z');
const WINTER = new Date('2026-01-15T12:00:00Z');

function option(id: string, at = SUMMER, locale = 'de') {
  const built = timeZoneOption(id, locale, at);
  if (built === null) throw new Error(`no option for ${id}`);
  return built;
}

describe('supportedTimeZones', () => {
  it('lists the runtime zones and always UTC', () => {
    const zones = supportedTimeZones();
    expect(zones).toContain('Europe/Berlin');
    expect(zones).toContain('UTC');
    expect(new Set(zones).size).toBe(zones.length);
  });
});

describe('timeZoneOption', () => {
  it('splits the id into a readable place and area', () => {
    expect(option('America/Argentina/Buenos_Aires')).toMatchObject({
      place: 'Buenos Aires',
      area: 'America/Argentina',
    });
    expect(option('UTC')).toMatchObject({ place: 'UTC', area: '' });
  });

  it('shows the offset of the instant, so daylight saving time moves it', () => {
    expect(option('Europe/Berlin', SUMMER).offset).toBe('GMT+2');
    expect(option('Europe/Berlin', WINTER).offset).toBe('GMT+1');
  });

  it('names the zone in the reader language', () => {
    expect(option('Europe/Berlin', SUMMER, 'de').name).toBe('Mitteleuropäische Zeit');
    expect(option('Europe/Berlin', SUMMER, 'en').name).toBe('Central European Time');
  });

  it('refuses what is no zone', () => {
    expect(timeZoneOption('Mars/Olympus', 'de', SUMMER)).toBeNull();
    expect(timeZoneOption('', 'de', SUMMER)).toBeNull();
  });
});

describe('timeZoneOptions', () => {
  it('adds a stored spelling the runtime does not list and drops unknown ids', () => {
    const ids = timeZoneOptions(['Europe/Berlin'], 'de', SUMMER, [
      'Europe/Kyiv',
      'Nowhere/Here',
    ]).map((entry) => entry.id);
    expect(ids).toEqual(['Europe/Berlin', 'Europe/Kyiv']);
  });
});

describe('findTimeZoneOption', () => {
  const options = timeZoneOptions(['Asia/Calcutta', 'Europe/Kiev', 'UTC'], 'de', SUMMER);

  it('prefers the exact spelling', () => {
    expect(findTimeZoneOption(options, 'UTC')?.id).toBe('UTC');
  });

  it('finds an alias by the zone it resolves to', () => {
    expect(canonicalTimeZone('Asia/Kolkata')).toBe(canonicalTimeZone('Asia/Calcutta'));
    expect(findTimeZoneOption(options, 'Asia/Kolkata')?.id).toBe('Asia/Calcutta');
    expect(findTimeZoneOption(options, 'Europe/Kyiv')?.id).toBe('Europe/Kiev');
    expect(findTimeZoneOption(options, 'Etc/UTC')?.id).toBe('UTC');
  });

  it('finds nothing for an unknown id', () => {
    expect(findTimeZoneOption(options, 'Mars/Olympus')).toBeUndefined();
  });
});

describe('matchesTimeZoneQuery', () => {
  const berlin = option('Europe/Berlin');

  it('matches place, path, name and offset', () => {
    expect(matchesTimeZoneQuery(berlin, 'berlin')).toBe(true);
    expect(matchesTimeZoneQuery(berlin, 'Europe/Ber')).toBe(true);
    expect(matchesTimeZoneQuery(berlin, 'mitteleuropaische')).toBe(true);
    expect(matchesTimeZoneQuery(berlin, 'gmt+2')).toBe(true);
    expect(matchesTimeZoneQuery(berlin, '')).toBe(true);
  });

  it('needs every word', () => {
    expect(matchesTimeZoneQuery(berlin, 'europe berlin')).toBe(true);
    expect(matchesTimeZoneQuery(berlin, 'europe paris')).toBe(false);
  });

  it('reads an underscore as a space', () => {
    expect(matchesTimeZoneQuery(option('America/New_York'), 'new york')).toBe(true);
  });
});
