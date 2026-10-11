import { type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';

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
 * - **DNS rebinding through Steel.** We resolve, approve, and then Steel
 *   resolves again. A name with a one-second TTL can answer publicly here and
 *   privately there. Closing that needs Steel to be handed an IP (it is not)
 *   or its own egress firewall, which is host configuration and issue #26
 *   records it as such. A request this process makes itself has no such gap:
 *   `publicOnlyLookup` judges the addresses at the moment the socket is
 *   opened, so the address checked is the address dialled (issue #178).
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

/** The IPv4 address in two IPv6 groups, as dotted text. */
function ipv4FromGroups(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/**
 * Rewrites a dotted IPv4 tail (`::ffff:127.0.0.1`) as the two hex groups it
 * stands for, so every spelling of an address reaches the same group test.
 * The URL parser already writes `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`,
 * which is why judging the dotted text alone let the hex spelling through.
 */
function withoutDottedTail(address: string): string {
  const match = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (match === null) return address;
  const value = ipv4ToNumber(match[2] ?? '');
  if (value === null) return address;
  return `${match[1] ?? ''}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
}

/**
 * The IPv4 address inside an IPv6 one, if it carries one a socket would dial.
 *
 * An IPv4 address wearing an IPv6 hat is judged as the IPv4 address: mapped
 * (`::ffff:a.b.c.d`), compatible (`::a.b.c.d`, which also covers `::` and
 * `::1`), the SIIT form (`::ffff:0:a.b.c.d`) and 6to4 (`2002:aabb:ccdd::`,
 * which a relay dials). `node:dns` hands the mapped form back on a dual-stack
 * host, and judging the hat instead of the address is how loopback gets
 * through.
 */
function embeddedIpv4(groups: readonly number[]): string | null {
  const [first = 0, second = 0, third = 0, , fifth = 0, sixth = 0, seventh = 0, eighth = 0] =
    groups;
  if (first === 0x2002) return ipv4FromGroups(second, third);
  if (!groups.slice(0, 4).every((group) => group === 0)) return null;
  const mappedOrCompatible = fifth === 0 && (sixth === 0 || sixth === 0xffff);
  const siit = fifth === 0xffff && sixth === 0;
  return mappedOrCompatible || siit ? ipv4FromGroups(seventh, eighth) : null;
}

/**
 * IPv6 prefixes that are not globally routable, as `[value, mask]` over the
 * first two groups, so each line can be checked against RFC 6890.
 */
const BLOCKED_IPV6: readonly (readonly [number, number, number, number])[] = [
  [0xfc00, 0xfe00, 0, 0], // fc00::/7 unique local
  [0xfe80, 0xffc0, 0, 0], // fe80::/10 link-local
  [0xfec0, 0xffc0, 0, 0], // fec0::/10 site-local, deprecated but routable inside
  [0xff00, 0xff00, 0, 0], // ff00::/8 multicast
  // 64:ff9b::/96 and 64:ff9b:1::/48 are NAT64: a public-looking IPv6 address
  // whose last 32 bits are an IPv4 address the gateway will dial, loopback
  // included.
  [0x0064, 0xffff, 0xff9b, 0xffff],
  [0x0100, 0xffff, 0x0000, 0xffff], // 100::/64 discard (and the rest of 100::/32)
  [0x2001, 0xffff, 0x0000, 0xfe00], // 2001::/23 protocol assignments, Teredo included
  [0x2001, 0xffff, 0x0db8, 0xffff], // documentation
];

function isPublicIpv6(address: string): boolean {
  const groups = ipv6Groups(withoutDottedTail(address));
  if (groups === null) return false;

  const ipv4 = embeddedIpv4(groups);
  if (ipv4 !== null) return isPublicIpv4(ipv4);

  const [first = 0, second = 0] = groups;
  return !BLOCKED_IPV6.some(
    ([firstValue, firstMask, secondValue, secondMask]) =>
      (first & firstMask) === firstValue && (second & secondMask) === secondValue,
  );
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

/**
 * How a name becomes addresses. The system resolver by default; a parameter so
 * a test can answer differently on the second lookup than on the first, which
 * is the whole shape of a rebinding attack and the one thing a real resolver
 * will not do on request.
 */
export type Resolver = (host: string) => Promise<readonly LookupAddress[]>;

const systemResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true });

/** What `publicOnlyLookup` hands the socket instead of a private address. */
export class PrivateAddressError extends Error {
  readonly code = 'EPRIVATEADDRESS';

  constructor(readonly detail: string) {
    super(`Address refused: ${detail}`);
    this.name = 'PrivateAddressError';
  }
}

/**
 * Resolves a name and returns its addresses only if *every* one is public.
 *
 * Every record, not the first one: a name with one public and one loopback
 * record is answered differently on each lookup, and the one the connection
 * gets is not necessarily the one we looked at.
 */
async function resolvePublic(
  host: string,
  resolve: Resolver,
): Promise<{ ok: true; addresses: readonly LookupAddress[] } | { ok: false; detail: string }> {
  let addresses: readonly LookupAddress[];
  try {
    addresses = await resolve(host);
  } catch {
    // A name that does not resolve out here is the common shape of an internal
    // one: `grafana`, `windmill`, `.internal`. Steel's resolver would answer it
    // from inside the Docker network, so "unknown" has to mean "no".
    return { ok: false, detail: `${host} does not resolve` };
  }
  if (addresses.length === 0) return { ok: false, detail: `${host} does not resolve` };

  const privateOne = addresses.find((entry) => !isPublicAddress(entry.address));
  if (privateOne !== undefined) {
    return { ok: false, detail: `${host} resolves to ${privateOne.address}` };
  }
  return { ok: true, addresses };
}

/**
 * A `lookup` for `net.connect` that only ever yields public addresses
 * (issue #178).
 *
 * `checkPublicAddress` alone is a check followed by a second, independent
 * resolution inside the HTTP client, and a name with a short TTL can answer
 * publicly to the first and privately to the second. Handing this to the
 * socket instead makes the judgement and the dial one step: the addresses
 * judged here are the only ones the connection is given. A literal IP never
 * reaches a lookup, which is fine, because a literal cannot change between
 * the check and the connect.
 */
export function publicOnlyLookup(resolve: Resolver = systemResolver): LookupFunction {
  return (hostname, options, callback) => {
    void resolvePublic(hostname, resolve).then((result) => {
      if (!result.ok) {
        callback(new PrivateAddressError(result.detail), '', 0);
        return;
      }
      const wanted =
        options.family === 4 || options.family === 'IPv4'
          ? 4
          : options.family === 6 || options.family === 'IPv6'
            ? 6
            : 0;
      const usable =
        wanted === 0
          ? result.addresses
          : result.addresses.filter((entry) => entry.family === wanted);
      const first = usable[0];
      if (first === undefined) {
        callback(new PrivateAddressError(`${hostname} has no IPv${wanted} address`), '', 0);
        return;
      }
      if (options.all === true) callback(null, [...usable]);
      else callback(null, first.address, first.family);
    });
  };
}

/**
 * Checks one address before it is handed to the browser.
 *
 * Returns the normalized URL rather than a boolean, so the caller fetches
 * exactly the string that was judged instead of the one the model typed --
 * `HTTP://EXAMPLE.COM./x` and `http://example.com/x` are the same request and
 * only one of them was checked.
 *
 * For a request this process makes itself this is the early, well-worded
 * refusal; the binding one is `publicOnlyLookup` on the socket.
 */
export async function checkPublicAddress(
  candidate: string,
  resolve: Resolver = systemResolver,
): Promise<AddressCheck> {
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

  // `hostname` keeps the brackets of an IPv6 literal (`[::1]`), and `isIP`
  // does not recognise them, so they come off before anything is judged.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (host.length === 0) {
    return { allowed: false, reason: 'malformed_url', detail: 'no host' };
  }

  if (isIP(host) !== 0) {
    return isPublicAddress(host)
      ? { allowed: true, url: url.toString() }
      : { allowed: false, reason: 'private_address', detail: host };
  }

  const resolved = await resolvePublic(host, resolve);
  return resolved.ok
    ? { allowed: true, url: url.toString() }
    : { allowed: false, reason: 'private_address', detail: resolved.detail };
}
