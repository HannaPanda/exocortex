import { XMLParser } from 'fast-xml-parser';

/**
 * WebDAV XML, reduced to the two things every caller here needs: namespace
 * prefixes gone, and single elements indistinguishable from lists.
 *
 * `removeNSPrefix` is what makes this tractable at all. The same document uses
 * `D:href`, `href` and `DAV:href` depending on the server and even on the
 * element, so matching on prefixed names means matching every spelling. mailbox
 * .org alone returns `<D:href>` inside a `<calendar-home-set>` that carries its
 * own default namespace.
 *
 * `isArray` is not configurable per path here on purpose: `asArray` at the call
 * site is clearer than a growing list of XPath-ish strings, and a `<response>`
 * that appears once must behave like a `<response>` that appears twice.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  // Text-only elements become their string; `<sync-token>abc</sync-token>` is
  // then simply a string, while `<resourcetype><calendar/></resourcetype>`
  // stays an object whose keys are the child names.
  parseTagValue: false,
  trimValues: true,
});

/** A parsed XML node: a string, a record of children, or a list of either. */
export type XmlNode = string | number | boolean | null | XmlNode[] | { [key: string]: XmlNode };

export function parseXml(text: string): Record<string, XmlNode> {
  return parser.parse(text) as Record<string, XmlNode>;
}

/** Treats a missing value as empty and a single value as a one-element list. */
export function asArray(value: XmlNode | undefined): XmlNode[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function isRecord(value: XmlNode | undefined): value is Record<string, XmlNode> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads `path` as a string, or null if any step is missing or not text. */
export function textAt(node: XmlNode | undefined, ...path: string[]): string | null {
  let current: XmlNode | undefined = node;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
    // A repeated element yields a list; the first entry is the one meant.
    if (Array.isArray(current)) current = current[0];
  }
  if (typeof current === 'string') return current;
  if (typeof current === 'number' || typeof current === 'boolean') return String(current);
  return null;
}

/** Reads `path` as a node, or undefined if any step is missing. */
export function nodeAt(node: XmlNode | undefined, ...path: string[]): XmlNode | undefined {
  let current: XmlNode | undefined = node;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * The child element names of a node, which is how `resourcetype` is read:
 * `<resourcetype><collection/><calendar/></resourcetype>` has no text, only the
 * presence of children, so the names *are* the value.
 */
export function childNames(node: XmlNode | undefined): string[] {
  if (!isRecord(node)) return [];
  return Object.keys(node).filter((key) => !key.startsWith('@') && key !== '#text');
}

/**
 * Whether a WebDAV status line means success.
 *
 * Inside a `multistatus` every property and every resource carries its own
 * status, and a `sync-collection` response marks a deleted resource with `404`
 * in exactly this field. Reading only the HTTP status would treat a deletion as
 * a change.
 */
export function isSuccessStatus(status: string | null): boolean {
  if (status === null) return true;
  const match = /\s(\d{3})\s/.exec(` ${status} `);
  if (match === null) return true;
  const code = Number(match[1]);
  return code >= 200 && code < 300;
}

/** Extracts the numeric code from a WebDAV status line, e.g. `HTTP/1.1 404 …`. */
export function statusCode(status: string | null): number | null {
  if (status === null) return null;
  const match = /\s(\d{3})\s/.exec(` ${status} `);
  return match === null ? null : Number(match[1]);
}
