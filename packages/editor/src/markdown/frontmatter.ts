import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/**
 * YAML frontmatter handling for Markdown import and export.
 *
 * Exocortex owns a small set of keys; every other key found on import is
 * preserved verbatim and written back on export so external tooling (Obsidian,
 * static site generators, CLI agents) does not lose metadata.
 */
export const EXOCORTEX_FRONTMATTER_KEYS = [
  'title',
  'icon',
  'iconColor',
  'cover',
  'coverPosition',
  'exocortexId',
  'exocortexSchemaVersion',
  'type',
  'createdAt',
  'updatedAt',
] as const;

export interface Frontmatter {
  title?: string;
  icon?: string | null;
  /** Colour of a drawn `lucide:` icon. Meaningless next to an emoji. */
  iconColor?: string | null;
  /**
   * Attachment id of the page's cover image. A cover is page metadata, not a
   * block, so it belongs here and not in the body (ADR-007).
   */
  cover?: string | null;
  /** Vertical crop of the cover, in percent of its height. */
  coverPosition?: number;
  exocortexId?: string;
  exocortexSchemaVersion?: number;
  type?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Any property Exocortex does not own, preserved as-is. */
  unknown: Record<string, unknown>;
}

export interface ParsedMarkdown {
  frontmatter: Frontmatter;
  body: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads one known key out of the parsed YAML onto the frontmatter.
 *
 * A reader that does not recognise the value simply leaves the field unset:
 * frontmatter comes from files other tools wrote, so a wrong type is an everyday
 * occurrence and never a reason to reject the document.
 */
type FrontmatterReader = (frontmatter: Frontmatter, value: unknown) => void;

/** A timestamp key, which YAML may already have turned into a `Date`. */
function readTimestamp(key: 'createdAt' | 'updatedAt'): FrontmatterReader {
  return (frontmatter, value) => {
    const asString = value instanceof Date ? value.toISOString() : value;
    if (typeof asString === 'string') frontmatter[key] = asString;
  };
}

const FRONTMATTER_READERS: Readonly<Record<string, FrontmatterReader>> = {
  title: (frontmatter, value) => {
    if (typeof value === 'string') frontmatter.title = value;
  },
  icon: (frontmatter, value) => {
    if (typeof value === 'string' || value === null) frontmatter.icon = value;
  },
  iconColor: (frontmatter, value) => {
    if (typeof value === 'string' || value === null) frontmatter.iconColor = value;
  },
  cover: (frontmatter, value) => {
    if (typeof value === 'string' || value === null) frontmatter.cover = value;
  },
  coverPosition: (frontmatter, value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      frontmatter.coverPosition = Math.min(100, Math.max(0, value));
    }
  },
  exocortexId: (frontmatter, value) => {
    if (typeof value === 'string') frontmatter.exocortexId = value;
  },
  exocortexSchemaVersion: (frontmatter, value) => {
    if (typeof value === 'number') frontmatter.exocortexSchemaVersion = value;
  },
  type: (frontmatter, value) => {
    if (typeof value === 'string') frontmatter.type = value;
  },
  createdAt: readTimestamp('createdAt'),
  updatedAt: readTimestamp('updatedAt'),
};

export function parseFrontmatter(markdown: string): ParsedMarkdown {
  const normalized = markdown.replace(/^\uFEFF/, '');
  const match = FRONTMATTER_PATTERN.exec(normalized);
  if (match === null) {
    return { frontmatter: { unknown: {} }, body: normalized };
  }


  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] as string);
  } catch (error) {
    // Malformed frontmatter must not lose the document: keep it as body text.
    throw new FrontmatterParseError(
      `Failed to parse YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const data = isPlainObject(parsed) ? parsed : {};
  const frontmatter: Frontmatter = { unknown: {} };

  for (const [key, value] of Object.entries(data)) {
    const read = FRONTMATTER_READERS[key];
    // Every key Exocortex does not own is preserved verbatim, so exporting the
    // document again hands the other tool back exactly what it wrote.
    if (read === undefined) {
      frontmatter.unknown[key] = value;
      continue;
    }
    read(frontmatter, value);
  }

  // Leading blank lines after the closing fence are not content.
  return { frontmatter, body: normalized.slice(match[0].length).replace(/^\s*\n/, '') };
}

export class FrontmatterParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontmatterParseError';
  }
}

/**
 * Serializes frontmatter deterministically: Exocortex keys first in a fixed
 * order, then preserved unknown keys sorted alphabetically.
 */
export function serializeFrontmatter(frontmatter: Frontmatter): string {
  const record: Record<string, unknown> = {};
  for (const key of EXOCORTEX_FRONTMATTER_KEYS) {
    const value = frontmatter[key];
    // `undefined` and `null` are both "not set"; writing `icon: null` would only
    // add noise to exported files.
    if (value === undefined || value === null) continue;
    record[key] = value;
  }
  for (const key of Object.keys(frontmatter.unknown).sort()) {
    record[key] = frontmatter.unknown[key];
  }
  if (Object.keys(record).length === 0) return '';
  const yaml = stringifyYaml(record, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n`;
}
