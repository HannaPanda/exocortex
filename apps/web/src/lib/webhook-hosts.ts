import {
  isWebhookHostAllowed,
  parseAllowedWebhookHosts,
  type SettingKey,
} from '@exocortex/contracts';

/**
 * The webhook allowlist as a list of hosts (issue #173).
 *
 * The setting stays one comma-separated string, because that is what the API
 * stores and what the worker reads; this file is the adapter between that
 * string and a field with one host per entry. It never decides what matches:
 * every judgement below is asked of `parseAllowedWebhookHosts` and
 * `isWebhookHostAllowed`, the two functions the API and the worker use, so the
 * field can only describe the security rule, never loosen or tighten it.
 */

/** The settings edited as a host list. */
export function isHostListSettingKey(key: SettingKey): boolean {
  return key === 'automations.webhookAllowedHosts';
}

/**
 * The entries of a stored value, as written.
 *
 * Split by commas only, exactly as the server splits, so an entry the server
 * reads as one host (`a b`, which never matches) shows up as one entry with a
 * complaint rather than as two that look fine.
 */
export function entriesOfStoredHosts(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The entries of pasted text. A host never contains whitespace, so a list
 * copied out of a mail or a spreadsheet splits at lines, spaces, commas and
 * semicolons alike.
 */
export function entriesOfPastedHosts(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The stored value of a list of entries. Empty entries are dropped. */
export function serializeHosts(entries: readonly string[]): string {
  return entries
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .join(', ');
}

/** The host the server reads out of one entry, or `null` when it reads none. */
export function normalizedHost(entry: string): string | null {
  const [host] = parseAllowedWebhookHosts(entry);
  return host ?? null;
}

/**
 * What is wrong with one entry, in two strengths.
 *
 * The first four mean the entry can never match a webhook URL, so it allows
 * nothing at all: the server drops it (`unusable`), it is a pattern the server
 * deliberately does not read as one (`wildcard`), it is no host a URL can
 * name (`invalid`), or it is written in Unicode while a URL's host arrives in
 * its ASCII form (`idn`, with the form that would match). The last three are
 * harmless but worth knowing: the server reads it as a different spelling
 * (`rewritten`), it is already in the list (`duplicate`), or a broader entry
 * already allows it (`covered`).
 */
export type HostProblem =
  | { kind: 'unusable' }
  | { kind: 'wildcard' }
  | { kind: 'invalid' }
  | { kind: 'idn'; ascii: string }
  | { kind: 'rewritten'; host: string }
  | { kind: 'duplicate' }
  | { kind: 'covered'; by: string };

/** Whether a problem means the entry allows nothing. */
export function hostNeverMatches(problem: HostProblem | null): boolean {
  return (
    problem !== null &&
    (problem.kind === 'unusable' ||
      problem.kind === 'wildcard' ||
      problem.kind === 'invalid' ||
      problem.kind === 'idn')
  );
}

/** The hostname a URL with this host would carry, or `null` if it is no host. */
function urlHostname(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

/**
 * The problem of each entry of a list, in order.
 *
 * A duplicate is the later of two equal entries, so the first stays clean and
 * removing the marked one changes nothing. A covered entry is one another
 * entry already allows, checked with the server's own matching.
 */
export function hostProblems(entries: readonly string[]): (HostProblem | null)[] {
  const hosts = entries.map(normalizedHost);
  return entries.map((entry, index) => {
    const host = hosts[index] ?? null;
    if (host === null) return { kind: 'unusable' };
    if (host.includes('*')) return { kind: 'wildcard' };
    const hostname = urlHostname(host);
    if (hostname === null) return { kind: 'invalid' };
    if (hostname !== host) {
      // Unicode the parser turned into Punycode. A tab inside an entry is
      // outside printable ASCII too, but the parser drops it rather than
      // encoding it, so it is no IDN and stays invalid.
      const idn = /[^ -~]/.test(host) && hostname.includes('xn--');
      return idn ? { kind: 'idn', ascii: hostname } : { kind: 'invalid' };
    }
    if (hosts.slice(0, index).includes(host)) return { kind: 'duplicate' };
    const coveringIndex = hosts.findIndex(
      (other, otherIndex) =>
        otherIndex !== index &&
        other !== null &&
        other !== host &&
        urlHostname(other) === other &&
        isWebhookHostAllowed(`http://${host}/`, [other]),
    );
    const covering = coveringIndex === -1 ? null : (hosts[coveringIndex] ?? null);
    if (covering !== null) return { kind: 'covered', by: covering };
    if (host !== entry.trim()) return { kind: 'rewritten', host };
    return null;
  });
}

/**
 * The hosts of the stored value the edited list no longer allows.
 *
 * Asked of the server's matching, so a host that is still allowed through a
 * broader entry is not named: removing `hooks.example.org` while
 * `example.org` stays stops nothing.
 */
export function hostsNoLongerAllowed(stored: string, edited: string): string[] {
  const now = parseAllowedWebhookHosts(edited);
  const before = parseAllowedWebhookHosts(stored).filter(
    (host) => !host.includes('*') && urlHostname(host) === host,
  );
  return [...new Set(before)].filter((host) => !isWebhookHostAllowed(`http://${host}/`, now));
}
