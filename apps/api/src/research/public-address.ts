import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Whether an address a model chose may be fetched (issue #26).
 *
 * The Steel browser runs on this host, inside the same Docker network as
 * Grafana, Windmill, Infisical and Loki. A fetch it performs starts *inside*
 * the perimeter: nginx never sees it, fail2ban never sees it, and a request to
 * `http://grafana:3000/` is answered (measured 2026-09-18). So the only place
 * this can be stopped is before the address reaches Steel, which is here.
 *
 * Two rules, and the second is the one that matters:
 *
 *   1. The scheme is `http` or `https`. Everything else -- `file:`, `gopher:`,
 *      `data:` -- is a different attack surface for no benefit.
 *   2. Every address the name **resolves to** is globally routable. Checking
 *      the literal text would let `http://localtest.me/` through, because the
 *      string says nothing and the DNS answer says `127.0.0.1`.
 *
 * What this deliberately does not cover, written down rather than implied:
 *
 * - **DNS rebinding.** We resolve, approve, and then Steel resolves again. A
 *   name with a one-second TTL can answer publicly here and privately there.
 *   Closing that needs Steel to be handed an IP (it is not) or its own egress
 *   firewall, which is host configuration and issue #26 records it as such.
 * - **Our own back ends.** SearXNG and Steel sit on loopback and would fail
 *   every rule here. They never pass through it: this guards the parameter a
 *   model supplies, not the outgoing HTTP layer. Putting it there instead
 *   would have web research block itself.
 */

export type AddressRefusal = 'unsupported_scheme' | 'malformed_url' | 'private_address';

export type AddressCheck =
  | { readonly allowed: true; readonly url: string }
  | { readonly allowed: false; readonly reason: AddressRefusal; readonly detail: string };

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * IPv4 ranges that are not globally routable.
 *
 * `[firstOctet, prefixLength]` pairs would be shorter but unreadable; a CIDR
 * string and one comparison is what somebody auditing this can check against
 * RFC 6890 line by line.
 */
const BLOCKED_IPV4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, and the cloud metadata address
  ['172.16.0.0', 12], // private -- the Docker bridges live here
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255
];

function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  if (value === null) return false;
  return !BLOCKED_IPV4.some(([network, prefix]) => {
    const base = ipv4ToNumber(network);
    if (base === null) return false;
    // `>>> 0` keeps the shift unsigned; a /8 mask is 0xff000000, which is
    // negative as a signed 32-bit integer and would compare wrongly.
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) >>> 0 === (base & mask) >>> 0;
  });
}

/**
 * Expands an IPv6 address to its eight groups.
 *
 * Needed because `fc00::1` and `fc00:0:0:0:0:0:0:1` are the same address and
 * only one of them has a comparable prefix in the text.
 */
function ipv6Groups(address: string): readonly number[] | null {
  const withoutZone = address.split('%')[0] ?? address;
  const [head = '', tail = ''] = withoutZone.split('::', 2);
  const hasGap = withoutZone.includes('::');
  const parse = (part: string): number[] =>
    part.length === 0 ? [] : part.split(':').map((group) => Number.parseInt(group, 16));

  const left = parse(head);
  const right = parse(tail);
  if (!hasGap && left.length !== 8) return null;
  const groups = hasGap
    ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right]
    : left;
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0)) {
    return null;
  }
  return groups;
}

function isPublicIpv6(address: string): boolean {
  // An IPv4-mapped or IPv4-compatible address (`::ffff:127.0.0.1`) is an IPv4
  // address wearing a hat. `node:dns` hands those back on a dual-stack host,
  // and judging the hat instead of the address is how loopback gets through.
  const embedded = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (embedded !== null) return isPublicIpv4(embedded[1] ?? '');

  const groups = ipv6Groups(address);
  if (groups === null) return false;
  const [first = 0, second = 0] = groups;

  if (groups.every((group) => group === 0)) return false; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return false; // ::1
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  // 64:ff9b::/96 is NAT64: a public-looking IPv6 address whose last 32 bits are
  // an IPv4 address the gateway will dial, loopback included.
  if (first === 0x0064 && second === 0xff9b) return false;
  if (first === 0x2001 && (second & 0xff00) === 0x0000) return false; // 2001::/23 protocol assignments
  if (first === 0x2001 && second === 0x0db8) return false; // documentation
  return true;
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

/**
 * Checks one address before it is handed to the browser.
 *
 * Returns the normalized URL rather than a boolean, so the caller fetches
 * exactly the string that was judged instead of the one the model typed --
 * `HTTP://EXAMPLE.COM./x` and `http://example.com/x` are the same request and
 * only one of them was checked.
 */
export async function checkPublicAddress(candidate: string): Promise<AddressCheck> {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { allowed: false, reason: 'malformed_url', detail: candidate.slice(0, 200) };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { allowed: false, reason: 'unsupported_scheme', detail: url.protocol };
  }

  // Credentials in the address are dropped rather than refused: they are never
  // something a model should be sending on this deployment's behalf, and a
  // refusal would only teach it to encode them differently.
  url.username = '';
  url.password = '';

  // `hostname` strips the brackets an IPv6 literal carries in a URL.
  const host = url.hostname;
  if (host.length === 0) {
    return { allowed: false, reason: 'malformed_url', detail: 'no host' };
  }

  if (isIP(host) !== 0) {
    return isPublicAddress(host)
      ? { allowed: true, url: url.toString() }
      : { allowed: false, reason: 'private_address', detail: host };
  }

  let addresses: readonly { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    // A name that does not resolve out here is the common shape of an internal
    // one: `grafana`, `windmill`, `.internal`. Steel's resolver would answer it
    // from inside the Docker network, so "unknown" has to mean "no".
    return { allowed: false, reason: 'private_address', detail: `${host} does not resolve` };
  }

  if (addresses.length === 0) {
    return { allowed: false, reason: 'private_address', detail: `${host} does not resolve` };
  }

  // *Every* record has to be public, not the first one: a name with one public
  // and one loopback record is answered differently on each lookup, and the one
  // Steel gets is not the one we checked.
  const privateOne = addresses.find((entry) => !isPublicAddress(entry.address));
  if (privateOne !== undefined) {
    return {
      allowed: false,
      reason: 'private_address',
      detail: `${host} resolves to ${privateOne.address}`,
    };
  }

  return { allowed: true, url: url.toString() };
}
