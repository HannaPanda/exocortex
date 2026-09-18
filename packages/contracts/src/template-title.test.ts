import { describe, expect, it } from 'vitest';

import { renderTitlePattern, titleForCopy } from './template-title';

const BERLIN = 'Europe/Berlin';

describe('renderTitlePattern', () => {
  it('falls back to the template title when there is no pattern', () => {
    const title = renderTitlePattern({
      pattern: null,
      fallbackTitle: 'Meeting-Notiz',
      now: new Date('2026-09-18T12:00:00Z'),
      timeZone: BERLIN,
    });
    expect(title).toBe('Meeting-Notiz');
  });

  it('fills the date placeholders in the configured zone', () => {
    const title = renderTitlePattern({
      pattern: 'Notiz {{datum}} {{zeit}} KW{{kw}} {{wochentag}}',
      fallbackTitle: 'Notiz',
      now: new Date('2026-09-18T12:34:00Z'),
      timeZone: BERLIN,
    });
    expect(title).toBe('Notiz 2026-09-18 14:34 KW38 Freitag');
  });

  it('reads the date in the given zone, not in UTC', () => {
    // 00:30 in Berlin is still the previous day in UTC.
    const title = renderTitlePattern({
      pattern: '{{datum}}',
      fallbackTitle: 'x',
      now: new Date('2026-09-17T22:30:00Z'),
      timeZone: BERLIN,
    });
    expect(title).toBe('2026-09-18');
  });

  it('substitutes the caller title for {{titel}}', () => {
    const title = renderTitlePattern({
      pattern: 'Recherche: {{titel}}',
      fallbackTitle: 'Bahnstrecken',
      now: new Date('2026-09-18T12:00:00Z'),
      timeZone: BERLIN,
    });
    expect(title).toBe('Recherche: Bahnstrecken');
  });

  it('leaves an unknown placeholder standing so the typo is visible', () => {
    const title = renderTitlePattern({
      pattern: 'Notiz {{datm}}',
      fallbackTitle: 'Notiz',
      now: new Date('2026-09-18T12:00:00Z'),
      timeZone: BERLIN,
    });
    expect(title).toBe('Notiz {{datm}}');
  });

  it('uses the server zone when the configured one does not exist', () => {
    const title = renderTitlePattern({
      pattern: '{{jahr}}',
      fallbackTitle: 'x',
      now: new Date('2026-09-18T12:00:00Z'),
      timeZone: 'Mars/Olympus_Mons',
    });
    expect(title).toBe('2026');
  });

  it('falls back rather than producing an empty title', () => {
    const title = renderTitlePattern({
      pattern: '   ',
      fallbackTitle: 'Wochenreview',
      now: new Date('2026-09-18T12:00:00Z'),
      timeZone: BERLIN,
    });
    expect(title).toBe('Wochenreview');
  });

  it('cuts a pattern that would produce a title longer than the column allows', () => {
    const title = renderTitlePattern({
      pattern: 'x'.repeat(400),
      fallbackTitle: 'x',
      now: new Date('2026-09-18T12:00:00Z'),
      timeZone: BERLIN,
    });
    expect(title).toHaveLength(300);
  });
});

describe('titleForCopy', () => {
  const now = new Date('2026-09-18T12:00:00Z');

  it('uses the pattern when nothing was typed', () => {
    expect(
      titleForCopy({
        pattern: 'Wochenreview KW{{kw}}',
        templateTitle: 'Wochenreview',
        requestedTitle: null,
        now,
        timeZone: BERLIN,
      }),
    ).toBe('Wochenreview KW38');
  });

  it('lets a typed title win over a pattern that has no place for it', () => {
    expect(
      titleForCopy({
        pattern: 'Wochenreview KW{{kw}}',
        templateTitle: 'Wochenreview',
        requestedTitle: 'Bahnstrecken',
        now,
        timeZone: BERLIN,
      }),
    ).toBe('Bahnstrecken');
  });

  it('puts a typed title into the pattern that asks for it', () => {
    expect(
      titleForCopy({
        pattern: 'Recherche: {{titel}} ({{datum}})',
        templateTitle: 'Recherche',
        requestedTitle: 'Bahnstrecken',
        now,
        timeZone: BERLIN,
      }),
    ).toBe('Recherche: Bahnstrecken (2026-09-18)');
  });

  it('falls back to the template title without a pattern', () => {
    expect(
      titleForCopy({
        pattern: null,
        templateTitle: 'Incident',
        requestedTitle: null,
        now,
        timeZone: BERLIN,
      }),
    ).toBe('Incident');
  });
});
