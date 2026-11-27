import { describe, expect, it } from 'vitest';

import {
  formatTimeOfDay,
  hourCycleOf,
  parseTimeOfDay,
  stepTimeOfDay,
  withHourCycle,
} from '@exocortex/ui';

/**
 * The reader's clock (issue #255): how a time of day is written for a
 * language and a preference, and how what somebody types is read back.
 * `Intl` writes some of these with a narrow no-break space before "PM", so
 * every comparison normalises the spaces first.
 */
const spaced = (text: string) => text.replace(/[  ]/g, ' ');

describe('hourCycleOf', () => {
  it('maps the account preference onto the cycle Intl takes', () => {
    expect(hourCycleOf('24h')).toBe('h23');
    expect(hourCycleOf('12h')).toBe('h12');
    expect(hourCycleOf('auto')).toBeUndefined();
    expect(hourCycleOf(undefined)).toBeUndefined();
  });
});

describe('formatTimeOfDay', () => {
  it('writes the clock of the language when the account did not choose', () => {
    expect(formatTimeOfDay('14:30', 'de', undefined)).toBe('14:30');
    expect(spaced(formatTimeOfDay('14:30', 'en', undefined))).toBe('2:30 PM');
  });

  it('holds a chosen clock against the language', () => {
    expect(formatTimeOfDay('14:30', 'en', 'h23')).toBe('14:30');
    // German pads the hour on either clock: 02:30 PM, as Intl writes it.
    expect(spaced(formatTimeOfDay('14:30', 'de', 'h12'))).toBe('02:30 PM');
    expect(formatTimeOfDay('00:05', 'en', 'h23')).toBe('00:05');
    expect(spaced(formatTimeOfDay('00:05', 'en', 'h12'))).toBe('12:05 AM');
  });

  it('writes nothing for no time or a value that is not one', () => {
    expect(formatTimeOfDay(null, 'de', undefined)).toBe('');
    expect(formatTimeOfDay('25:00', 'de', undefined)).toBe('');
  });
});

describe('withHourCycle', () => {
  it('adds the clock to options that show a time, and only to those', () => {
    expect(withHourCycle({ timeStyle: 'short' }, 'h23')).toEqual({
      timeStyle: 'short',
      hourCycle: 'h23',
    });
    expect(withHourCycle({ hour: '2-digit', minute: '2-digit' }, 'h12')).toEqual({
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h12',
    });
    expect(withHourCycle({ dateStyle: 'medium' }, 'h23')).toEqual({ dateStyle: 'medium' });
    expect(withHourCycle({ timeStyle: 'short' }, undefined)).toEqual({ timeStyle: 'short' });
  });

  it('leaves a caller that named a clock alone', () => {
    expect(withHourCycle({ timeStyle: 'short', hour12: true }, 'h23')).toEqual({
      timeStyle: 'short',
      hour12: true,
    });
  });

  it('changes what Intl writes for both a German and an English reader', () => {
    const at = Date.UTC(2026, 10, 26, 13, 5);
    const write = (locale: string, cycle: 'h23' | 'h12' | undefined) =>
      spaced(
        new Intl.DateTimeFormat(
          locale,
          withHourCycle({ timeStyle: 'short', timeZone: 'UTC' }, cycle),
        ).format(at),
      );
    expect(write('en', 'h23')).toBe('13:05');
    expect(write('de', 'h12')).toBe('01:05 PM');
    expect(write('de', undefined)).toBe('13:05');
  });
});

describe('parseTimeOfDay', () => {
  it('reads a 24-hour time in every common spelling', () => {
    for (const text of ['14:30', '14.30', '14h30', '1430', ' 14:30 ']) {
      expect(parseTimeOfDay(text, 'de')).toBe('14:30');
    }
    expect(parseTimeOfDay('930', 'de')).toBe('09:30');
    expect(parseTimeOfDay('9', 'de')).toBe('09:00');
    expect(parseTimeOfDay('0:05', 'de')).toBe('00:05');
    expect(parseTimeOfDay('23:59', 'de')).toBe('23:59');
  });

  it('reads a day period, in English and in what the language writes', () => {
    expect(parseTimeOfDay('2:30 pm', 'de')).toBe('14:30');
    expect(parseTimeOfDay('2:30PM', 'en')).toBe('14:30');
    expect(parseTimeOfDay('2 p.m.', 'en')).toBe('14:00');
    expect(parseTimeOfDay('12:15 AM', 'en')).toBe('00:15');
    expect(parseTimeOfDay('12 pm', 'en')).toBe('12:00');
    expect(parseTimeOfDay('11:45 am', 'en')).toBe('11:45');
    expect(parseTimeOfDay(formatTimeOfDay('19:10', 'en', 'h12'), 'en')).toBe('19:10');
    expect(parseTimeOfDay(formatTimeOfDay('19:10', 'pt-BR', 'h12'), 'pt-BR')).toBe('19:10');
  });

  it('guesses nothing', () => {
    for (const text of [
      '',
      '25:00',
      '24:00',
      '9:7',
      '13 pm',
      '0 am',
      '12:60',
      'mittags',
      '1:2:3',
    ]) {
      expect(parseTimeOfDay(text, 'de')).toBeNull();
    }
  });

  it('reads back everything it writes, on both clocks and in every language', () => {
    for (const locale of ['de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt-BR']) {
      for (const cycle of ['h23', 'h12', undefined] as const) {
        for (const value of ['00:00', '00:30', '09:05', '12:00', '12:45', '13:00', '23:59']) {
          expect(parseTimeOfDay(formatTimeOfDay(value, locale, cycle), locale)).toBe(value);
        }
      }
    }
  });
});

describe('stepTimeOfDay', () => {
  it('moves a quarter of an hour and lands on it', () => {
    expect(stepTimeOfDay('09:07', 15)).toBe('09:15');
    expect(stepTimeOfDay('09:07', -15)).toBe('09:00');
    expect(stepTimeOfDay('09:15', 15)).toBe('09:30');
    expect(stepTimeOfDay('09:15', -15)).toBe('09:00');
  });

  it('goes round the clock instead of off it', () => {
    expect(stepTimeOfDay('23:50', 15)).toBe('00:00');
    expect(stepTimeOfDay('00:00', -15)).toBe('23:45');
    expect(stepTimeOfDay('23:30', 60)).toBe('00:00');
  });

  it('starts at nine when there is no time yet', () => {
    expect(stepTimeOfDay(null, 15)).toBe('09:15');
  });
});
