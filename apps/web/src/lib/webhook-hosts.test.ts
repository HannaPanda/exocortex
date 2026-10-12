import { describe, expect, it } from 'vitest';

import { parseAllowedWebhookHosts } from '@exocortex/contracts';

import {
  entriesOfPastedHosts,
  entriesOfStoredHosts,
  hostNeverMatches,
  hostProblems,
  hostsNoLongerAllowed,
  isHostListSettingKey,
  normalizedHost,
  serializeHosts,
} from './webhook-hosts';

describe('isHostListSettingKey', () => {
  it('names the webhook allowlist and nothing else', () => {
    expect(isHostListSettingKey('automations.webhookAllowedHosts')).toBe(true);
    expect(isHostListSettingKey('automations.enabled')).toBe(false);
  });
});

describe('entriesOfStoredHosts', () => {
  it('splits at commas and trims, as the server does', () => {
    expect(entriesOfStoredHosts(' hooks.example.org ,127.0.0.1,, ')).toEqual([
      'hooks.example.org',
      '127.0.0.1',
    ]);
  });

  it('keeps an entry with a space as one entry', () => {
    expect(entriesOfStoredHosts('a b, c')).toEqual(['a b', 'c']);
  });

  it('reads an empty value as an empty list', () => {
    expect(entriesOfStoredHosts('')).toEqual([]);
    expect(entriesOfStoredHosts('  ,  ')).toEqual([]);
  });
});

describe('entriesOfPastedHosts', () => {
  it('splits at lines, spaces, commas and semicolons', () => {
    expect(entriesOfPastedHosts('a.org\nb.org, c.org;d.org\te.org  \r\n')).toEqual([
      'a.org',
      'b.org',
      'c.org',
      'd.org',
      'e.org',
    ]);
  });
});

describe('serializeHosts', () => {
  it('joins with a comma and drops empty entries', () => {
    expect(serializeHosts(['a.org', ' ', ' b.org '])).toBe('a.org, b.org');
    expect(serializeHosts([])).toBe('');
  });

  it('round-trips through the server parser unchanged', () => {
    const stored = 'Hooks.Example.org, https://n8n.example.net:5678/x, [::1], 10.0.0.1';
    const entries = entriesOfStoredHosts(stored);
    expect(parseAllowedWebhookHosts(serializeHosts(entries))).toEqual(
      parseAllowedWebhookHosts(stored),
    );
  });
});

describe('normalizedHost', () => {
  it('reads an entry the way the server does', () => {
    expect(normalizedHost('HTTPS://Hooks.Example.org:8443/path')).toBe('hooks.example.org');
    expect(normalizedHost('::1')).toBeNull();
  });

  it('keeps the port of a bracketed IPv6 literal, as the server does', () => {
    expect(normalizedHost('[::1]:8080')).toBe('[::1]:8080');
  });
});

describe('hostProblems', () => {
  it('passes plain hosts, IPv4 and bracketed IPv6', () => {
    expect(hostProblems(['hooks.example.org', '192.0.2.10', '[2001:db8::1]'])).toEqual([
      null,
      null,
      null,
    ]);
  });

  it.each([
    ['::1', 'unusable'],
    ['https://', 'unusable'],
    ['*.example.org', 'wildcard'],
    ['*', 'wildcard'],
    ['a b', 'invalid'],
    ['[::1]:8080', 'invalid'],
    ['a\tb.org', 'invalid'],
    ['127.1', 'invalid'],
  ] as const)('marks %s as %s and never matching', (entry, kind) => {
    const [problem] = hostProblems([entry]);
    expect(problem?.kind).toBe(kind);
    expect(hostNeverMatches(problem ?? null)).toBe(true);
  });

  it('names the ASCII form of an internationalised host', () => {
    expect(hostProblems(['bücher.de'])).toEqual([{ kind: 'idn', ascii: 'xn--bcher-kva.de' }]);
    expect(hostProblems(['xn--bcher-kva.de'])).toEqual([null]);
  });

  it('says how the server reads a rewritten entry', () => {
    expect(hostProblems(['https://Hooks.Example.org:443/'])).toEqual([
      { kind: 'rewritten', host: 'hooks.example.org' },
    ]);
  });

  it('marks the later of two equal entries, compared as the server reads them', () => {
    const problems = hostProblems(['a.org', 'b.org', 'A.org']);
    expect(problems[0]).toBeNull();
    expect(problems[2]).toEqual({ kind: 'duplicate' });
    expect(hostNeverMatches(problems[2] ?? null)).toBe(false);
  });

  it('marks a subdomain a broader entry already allows, wherever it stands', () => {
    expect(hostProblems(['hooks.example.org', 'example.org'])).toEqual([
      { kind: 'covered', by: 'example.org' },
      null,
    ]);
  });

  it('does not treat a lookalike suffix or a broken IP as covering', () => {
    expect(hostProblems(['badexample.org', 'example.org'])).toEqual([null, null]);
    expect(hostProblems(['1.2.3.4', '2.3.4'])[0]).toBeNull();
  });
});

describe('hostsNoLongerAllowed', () => {
  it('names a removed host', () => {
    expect(hostsNoLongerAllowed('a.org, b.org', 'a.org')).toEqual(['b.org']);
  });

  it('names nothing when a broader entry still allows the host', () => {
    expect(hostsNoLongerAllowed('hooks.example.org, example.org', 'example.org')).toEqual([]);
  });

  it('names every host when the list is emptied', () => {
    expect(hostsNoLongerAllowed('a.org, [::1]', '')).toEqual(['a.org', '[::1]']);
  });

  it('ignores entries that never matched anything', () => {
    expect(hostsNoLongerAllowed('*, a b, a.org', 'a.org')).toEqual([]);
  });

  it('names nothing for a reordered or respelled list', () => {
    expect(hostsNoLongerAllowed('a.org,b.org', 'https://B.org/, a.org')).toEqual([]);
  });
});
