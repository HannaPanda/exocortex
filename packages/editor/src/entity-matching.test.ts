import { describe, expect, it } from 'vitest';

import {
  entityAliasKey,
  findEntityPhrases,
  formatEntityAliases,
  matchEntityAliases,
  parseEntityAliases,
  sentenceAround,
} from './entity-matching';

describe('entityAliasKey', () => {
  it('folds case and inner whitespace', () => {
    expect(entityAliasKey('  Second   Brain ')).toBe('second brain');
  });

  it('keeps punctuation, because f.p.b.2 is not obviously fpb2', () => {
    expect(entityAliasKey('f.p.b.2')).toBe('f.p.b.2');
    expect(entityAliasKey('fpb2')).toBe('fpb2');
  });
});

describe('parseEntityAliases', () => {
  it('splits on commas, semicolons and newlines and drops empties', () => {
    expect(parseEntityAliases('fpb2, der Hetzner-Server;\n\nfpb2.example.net,')).toEqual([
      'fpb2',
      'der Hetzner-Server',
      'fpb2.example.net',
    ]);
  });

  it('keeps one spelling per key', () => {
    expect(parseEntityAliases('Orielle, orielle, ORIELLE')).toEqual(['Orielle']);
  });

  it('round-trips through the column', () => {
    const aliases = ['fpb2', 'der Hetzner-Server'];
    expect(parseEntityAliases(formatEntityAliases(aliases))).toEqual(aliases);
  });

  it('answers empty for a column nobody filled in', () => {
    expect(parseEntityAliases(null)).toEqual([]);
    expect(parseEntityAliases('   ')).toEqual([]);
  });
});

describe('matchEntityAliases', () => {
  const candidates = [
    { entityId: 'host', alias: 'fpb2' },
    { entityId: 'host', alias: 'der Hetzner-Server' },
    { entityId: 'service', alias: 'Orielle' },
  ];

  it('counts every alias of one entity into one match', () => {
    const text = 'Orielle läuft auf fpb2. Der Brevo-Key liegt auf fpb2, dem Hetzner-Server.';
    const matches = matchEntityAliases(text, candidates);
    expect(matches).toHaveLength(2);
    const host = matches.find((match) => match.entityId === 'host');
    expect(host?.occurrences).toBe(2);
    expect(host?.alias).toBe('fpb2');
  });

  it('does not match inside a longer name', () => {
    // The systemd unit is not the host, and `\b` would have said it was.
    const matches = matchEntityAliases('exocortex-api startet neu, fpb2-alt bleibt aus.', [
      { entityId: 'api', alias: 'exocortex' },
      { entityId: 'host', alias: 'fpb2' },
    ]);
    expect(matches).toEqual([]);
  });

  it('matches across case', () => {
    const matches = matchEntityAliases('FPB2 rebootet.', candidates);
    expect(matches[0]?.entityId).toBe('host');
  });

  it('skips aliases below the minimum length', () => {
    const matches = matchEntityAliases('Der Server hat 16 GB.', [{ entityId: 'x', alias: 'GB' }], {
      minAliasLength: 3,
    });
    expect(matches).toEqual([]);
  });

  it('carries the sentence around the first occurrence', () => {
    const matches = matchEntityAliases('Erster Satz ohne Namen. Orielle läuft dort.', candidates);
    expect(matches[0]?.context).toBe('Orielle läuft dort.');
  });

  it('reports the most-used alias as the name this page uses', () => {
    const text = 'Der Hetzner-Server ist voll. Der Hetzner-Server braucht Platz. fpb2 auch.';
    const matches = matchEntityAliases(text, candidates);
    expect(matches[0]?.alias).toBe('der Hetzner-Server');
    expect(matches[0]?.occurrences).toBe(3);
  });
});

describe('sentenceAround', () => {
  it('cuts at sentence boundaries, not mid-clause', () => {
    const text = 'Satz eins. Hier steht fpb2 drin. Satz drei.';
    expect(sentenceAround(text, text.indexOf('fpb2'))).toBe('Hier steht fpb2 drin.');
  });

  it('falls back to a window when nothing ends a sentence', () => {
    const text = `${'a'.repeat(400)}fpb2${'b'.repeat(400)}`;
    expect(sentenceAround(text, 400).length).toBeLessThanOrEqual(240);
  });
});

describe('findEntityPhrases', () => {
  const known = new Set<string>();

  it('proposes a repeated proper name', () => {
    const text = 'Windmill hängt an der Datenbank. Windmill braucht den internen Port.';
    const phrases = findEntityPhrases(text, { known });
    expect(phrases.map((phrase) => phrase.phrase)).toContain('Windmill');
  });

  it('ignores a name seen only once on the page', () => {
    const phrases = findEntityPhrases('Mailpit läuft mit.', { known });
    expect(phrases).toEqual([]);
  });

  it('ignores names an entity already answers to', () => {
    const text = 'Windmill hängt dran. Windmill nervt.';
    expect(findEntityPhrases(text, { known: new Set(['windmill']) })).toEqual([]);
  });

  it('ignores the words every German page starts a sentence with', () => {
    const text = 'Der Dienst läuft. Der Dienst fällt aus. Die Sache ist die. Die Sache klemmt.';
    const proposed = findEntityPhrases(text, { known }).map((phrase) => phrase.phraseKey);
    expect(proposed).not.toContain('der');
    expect(proposed).not.toContain('die');
  });

  it('finds bare identifiers as well as capitalized names', () => {
    const text = 'Läuft auf fpb2 und noch mal fpb2, dazu exocortex-api und exocortex-api.';
    const proposed = findEntityPhrases(text, { known }).map((phrase) => phrase.phrase);
    expect(proposed).toContain('fpb2');
    expect(proposed).toContain('exocortex-api');
  });
});
