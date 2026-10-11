import { describe, expect, it } from 'vitest';

import { checkPublicAddress, isPublicAddress } from './public-address';

/**
 * The SSRF fence in front of the browser (issue #26).
 *
 * Worth testing as a table because it is the one piece of this feature whose
 * failure is not visible: a research tool that fetches Grafana's login page
 * returns a perfectly ordinary-looking result. Every case below is an address
 * the Steel container can actually reach from inside this host's Docker
 * network, which is why they are the cases and not a generic IP-parsing suite.
 *
 * The `checkPublicAddress` half resolves names for real, deliberately: the
 * whole claim is about what DNS answers, and a stubbed resolver would only
 * prove that the stub was written to agree with the code. The cost is that
 * these few cases need working DNS, which both this host and the CI have.
 */

describe('which literal addresses count as public', () => {
  it.each([
    '1.1.1.1',
    '93.184.216.34',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80f::200e',
    '::ffff:5db8:d822',
    '2002:5db8:d822::1',
  ])('allows %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'the rest of the loopback /8'],
    ['0.0.0.0', 'this network'],
    ['10.1.2.3', 'private'],
    ['172.18.0.1', 'the Docker bridge this deployment actually uses'],
    ['172.31.255.255', 'the top of the 172.16/12 block'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'the cloud metadata address'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['255.255.255.255', 'broadcast'],
    ['::1', 'IPv6 loopback'],
    ['::', 'the unspecified address'],
    ['fc00::1', 'unique local'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'loopback wearing an IPv6 hat'],
    ['64:ff9b::7f00:1', 'NAT64 pointing at loopback'],
    ['::ffff:7f00:1', 'mapped loopback in the hex spelling the URL parser writes'],
    ['::7f00:1', 'IPv4-compatible loopback'],
    ['::ffff:0:a9fe:a9fe', 'the metadata address in the SIIT form'],
    ['::ffff:a9fe:a9fe', 'the metadata address, mapped'],
    ['2002:7f00:1::', '6to4 wrapped around loopback'],
    ['2002:ac12:1::1', '6to4 wrapped around the Docker bridge'],
    ['fec0::1', 'site-local'],
    ['2001::1', 'Teredo'],
  ])('refuses %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it('refuses anything that is not an address at all', () => {
    expect(isPublicAddress('localhost')).toBe(false);
    expect(isPublicAddress('')).toBe(false);
  });
});

describe('checking an address before it reaches the browser', () => {
  it('refuses a scheme other than http and https', async () => {
    const result = await checkPublicAddress('file:///etc/passwd');
    expect(result).toMatchObject({ allowed: false, reason: 'unsupported_scheme' });
  });

  it('refuses something that is not a URL', async () => {
    const result = await checkPublicAddress('not a url');
    expect(result).toMatchObject({ allowed: false, reason: 'malformed_url' });
  });

  it('judges an IPv6 literal without its brackets', async () => {
    await expect(checkPublicAddress('http://[::ffff:127.0.0.1]/')).resolves.toMatchObject({
      allowed: false,
      reason: 'private_address',
      detail: '::ffff:7f00:1',
    });
    await expect(checkPublicAddress('http://[2606:4700:4700::1111]/')).resolves.toMatchObject({
      allowed: true,
    });
  });

  it('refuses a literal private address', async () => {
    const result = await checkPublicAddress('http://169.254.169.254/latest/meta-data/');
    expect(result).toMatchObject({ allowed: false, reason: 'private_address' });
  });

  it('refuses a name that only resolves inside the container network', async () => {
    // `grafana` answers for the Steel container and for nothing out here. A
    // check that only looked at the text would wave it through.
    const result = await checkPublicAddress('http://grafana:3000/login');
    expect(result).toMatchObject({ allowed: false, reason: 'private_address' });
  });

  it('refuses a public name that resolves to loopback', async () => {
    // localtest.me is a real, public DNS name whose A record is 127.0.0.1.
    // It is the exact shape the resolved check exists for.
    const result = await checkPublicAddress('http://localtest.me/');
    expect(result).toMatchObject({ allowed: false, reason: 'private_address' });
  });

  it('allows an ordinary public address and hands back the normalized URL', async () => {
    const result = await checkPublicAddress('HTTPS://Example.COM/a?b=1');
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.url).toBe('https://example.com/a?b=1');
  });

  it('strips credentials rather than passing them on', async () => {
    const result = await checkPublicAddress('https://user:secret@example.com/');
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.url).toBe('https://example.com/');
  });
});
