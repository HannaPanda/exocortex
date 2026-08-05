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
  'exocortexId',
  'exocortexSchemaVersion',
  'type',
  'createdAt',
  'updatedAt',
] as const;

export interface Frontmatter {
  title?: string;
  icon?: string | null;
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
    switch (key) {
      case 'title':
        if (typeof value === 'string') frontmatter.title = value;
        break;
      case 'icon':
        if (typeof value === 'string' || value === null) frontmatter.icon = value;
        break;
      case 'exocortexId':
        if (typeof value === 'string') frontmatter.exocortexId = value;
        break;
      case 'exocortexSchemaVersion':
        if (typeof value === 'number') frontmatter.exocortexSchemaVersion = value;
        break;
      case 'type':
        if (typeof value === 'string') frontmatter.type = value;
        break;
      case 'createdAt':
      case 'updatedAt': {
        const asString = value instanceof Date ? value.toISOString() : value;
        if (typeof asString === 'string') frontmatter[key] = asString;
        break;
      }
      default:
        frontmatter.unknown[key] = value;
    }
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
