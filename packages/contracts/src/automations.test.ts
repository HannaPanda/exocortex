import { describe, expect, it } from 'vitest';

import {
  automationRuleProblems,
  disallowedWebhookAddressReason,
  isIpAddressLiteral,
  isWebhookHostAllowed,
  parseAllowedWebhookHosts,
} from './automations';

describe('the webhook host allowlist', () => {
  it('matches a host and its subdomains, and nothing else', () => {
    const allowed = parseAllowedWebhookHosts('https://hooks.example.org/path, Example.NET:8443');
    expect(allowed).toEqual(['hooks.example.org', 'example.net']);
    expect(isWebhookHostAllowed('https://hooks.example.org/x', allowed)).toBe(true);
    expect(isWebhookHostAllowed('https://eu.hooks.example.org/x', allowed)).toBe(true);
    expect(isWebhookHostAllowed('https://evilexample.net/x', allowed)).toBe(false);
  });

  it('allows nothing when the list is empty', () => {
    expect(isWebhookHostAllowed('https://hooks.example.org/x', [])).toBe(false);
  });
});

describe('the webhook address policy', () => {
  it('refuses loopback, private, link-local and reserved IPv4', () => {
    for (const address of [
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(disallowedWebhookAddressReason(address), address).not.toBeNull();
    }
  });

  it('allows ordinary public IPv4, including the edges of the private ranges', () => {
    for (const address of [
      '93.184.216.34',
      '1.1.1.1',
      '172.15.255.255',
      '172.32.0.1',
      '11.0.0.1',
    ]) {
      expect(disallowedWebhookAddressReason(address), address).toBeNull();
    }
  });

  it('refuses loopback, ULA, link-local and multicast IPv6', () => {
    for (const address of [
      '::1',
      '::',
      '[::1]',
      'fe80::1',
      'fe80::1%eth0',
      'fc00::1',
      'fd12:3456:789a::1',
      'ff02::1',
    ]) {
      expect(disallowedWebhookAddressReason(address), address).not.toBeNull();
    }
  });

  it('sees through an IPv4 address written as IPv6', () => {
    expect(disallowedWebhookAddressReason('::ffff:127.0.0.1')).not.toBeNull();
    expect(disallowedWebhookAddressReason('::ffff:10.0.0.1')).not.toBeNull();
    expect(disallowedWebhookAddressReason('::ffff:93.184.216.34')).toBeNull();
  });

  it('allows ordinary public IPv6', () => {
    expect(disallowedWebhookAddressReason('2606:4700:4700::1111')).toBeNull();
    expect(disallowedWebhookAddressReason('2001:db8::1')).toBeNull();
  });

  it('knows a name from an address, so a hostname is judged where it is resolved', () => {
    expect(isIpAddressLiteral('hooks.example.org')).toBe(false);
    expect(isIpAddressLiteral('127.0.0.1')).toBe(true);
    expect(isIpAddressLiteral('[::1]')).toBe(true);
    expect(disallowedWebhookAddressReason('hooks.example.org')).toBe(
      'The webhook target is not an IP address',
    );
  });
});

describe('a scheduled rule', () => {
  const base = {
    scope: 'SUBTREE' as const,
    scopeDocumentId: 'doc1',
    action: 'AI_RUN' as const,
    webhookUrl: null,
    prompt: 'Schreib ein Wochenreview.',
    scheduleKind: 'WEEKLY' as const,
    scheduleAt: null,
    scheduleTime: '07:00',
    scheduleWeekday: 0,
    scheduleDayOfMonth: null,
    scheduleCron: null,
    scheduleTimeZone: 'Europe/Berlin',
  };

  it('is coherent when the clock is its only trigger', () => {
    expect(automationRuleProblems({ ...base, triggers: ['SCHEDULE'] })).toEqual([]);
  });

  it('may not also listen for changes', () => {
    const problems = automationRuleProblems({
      ...base,
      triggers: ['SCHEDULE', 'DOCUMENT_UPDATED'],
    });
    expect(problems).toContain(
      'A scheduled rule listens to the clock alone, not to changes as well',
    );
  });

  it('needs a page, because the clock names none', () => {
    const problems = automationRuleProblems({
      ...base,
      scope: 'WORKSPACE',
      scopeDocumentId: null,
      triggers: ['SCHEDULE'],
    });
    expect(problems).toContain('A scheduled rule needs a scope document: the clock names no page');
  });

  it('needs the fields its kind uses, and a zone', () => {
    const problems = automationRuleProblems({
      ...base,
      triggers: ['SCHEDULE'],
      scheduleWeekday: null,
      scheduleTimeZone: null,
    });
    expect(problems).toContain('A weekly schedule needs a weekday');
    expect(problems).toContain('A scheduled rule needs an explicit time zone');
  });

  it('refuses a cron expression this deployment cannot read', () => {
    const problems = automationRuleProblems({
      ...base,
      triggers: ['SCHEDULE'],
      scheduleKind: 'CRON',
      scheduleTime: null,
      scheduleWeekday: null,
      scheduleCron: '@daily',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('five numeric fields');
  });

  it('is not what an event rule may carry half of', () => {
    const problems = automationRuleProblems({
      ...base,
      triggers: ['DOCUMENT_UPDATED'],
    });
    expect(problems).toContain(
      'A rule without the SCHEDULE trigger must not carry schedule fields',
    );
  });

  it('lets a database rule be scheduled without watching rows', () => {
    expect(
      automationRuleProblems({
        ...base,
        scope: 'DATABASE',
        triggers: ['SCHEDULE'],
      }),
    ).toEqual([]);
  });
});

describe('a mail rule', () => {
  const base = {
    scope: 'SUBTREE' as const,
    scopeDocumentId: 'doc1',
    action: 'EMAIL_SELF' as const,
    webhookUrl: null,
    prompt: null,
    mailSubject: 'Dein Tag',
    triggers: ['SCHEDULE'] as const,
    scheduleKind: 'DAILY' as const,
    scheduleAt: null,
    scheduleTime: '07:00',
    scheduleWeekday: null,
    scheduleDayOfMonth: null,
    scheduleCron: null,
    scheduleTimeZone: 'Europe/Berlin',
  };

  it('is coherent with a subject and nothing else', () => {
    expect(automationRuleProblems(base)).toEqual([]);
    expect(automationRuleProblems({ ...base, mailSubject: null })).toEqual([]);
  });

  it('has no target of any kind, which is the point of the action', () => {
    const problems = automationRuleProblems({
      ...base,
      webhookUrl: 'https://hooks.example.org/x',
    });
    expect(problems).toContain('A mail rule has no target URL');
  });

  it('has no prompt', () => {
    const problems = automationRuleProblems({ ...base, prompt: 'Fasse zusammen.' });
    expect(problems).toContain('A mail rule has no prompt');
  });

  it('refuses a subject on a rule that sends no mail', () => {
    const problems = automationRuleProblems({
      ...base,
      action: 'AI_RUN',
      prompt: 'Fasse zusammen.',
    });
    expect(problems).toContain('Only a mail rule carries a subject line');
  });
});
