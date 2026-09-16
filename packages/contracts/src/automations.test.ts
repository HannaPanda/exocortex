import { describe, expect, it } from 'vitest';

import {
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
