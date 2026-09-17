/**
 * The SyncTeX map, read (issue #53, ADR-027).
 *
 * `latexmk -synctex=1` writes a map beside the PDF that says which source line
 * produced which rectangle on which page, and the build stores it uncompressed
 * as an ordinary attachment. This file turns that text into the two questions
 * anybody actually asks of it: which line made this spot, and where did this
 * line end up.
 *
 * Our own parser rather than a library, for two reasons that are both about
 * what is available rather than about taste. The `synctex` program is not in
 * the TeX Live image the build runs in, so shelling out to it is not an option
 * that exists; and the JavaScript packages that read the format are either
 * unmaintained or carry a licence this repository cannot take (rule 14). The
 * format is a preamble and a dozen record types, and this is the whole of it.
 *
 * Coordinates leave here in PDF points measured from the top left of the page,
 * because that is the one system both callers already hold: pdf.js hands out a
 * viewport in exactly those units, and "what is at 100,200 on page 3" means the
 * same thing to an agent. Inside the file they are scaled points measured from
 * a point one inch above and to the left of the paper, which is TeX's origin
 * and nobody else's.
 */

/** Scaled points in one PDF point: 65536 sp/pt * 72.27 pt/in / 72 bp/in. */
const SP_PER_POINT = 65781.76;

/** Records kept from one map. Past this the answer stops being worth its memory. */
const MAX_RECORDS = 400_000;

/**
 * One rectangle on one page, in PDF points from the top left.
 *
 * A record with no extent -- a glue, a kern, a math node -- still produces one,
 * with zero width and height. It cannot contain a click, but it is the thing
 * that makes a click precise: the boxes say which paragraph, and the points
 * inside them say which word.
 */
export interface SyncTexArea {
  page: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One entry of the map: a place on paper and the source line that made it. */
export interface SyncTexRecord extends SyncTexArea {
  /** The `Input:` tag. Several tags can name the same file. */
  tag: number;
  line: number;
}

export interface SyncTexMap {
  /** Raw path per tag, exactly as TeX wrote it. */
  inputs: ReadonlyMap<number, string>;
  records: readonly SyncTexRecord[];
  /** True when the file was longer than this parser is willing to hold. */
  truncated: boolean;
}

/**
 * Record types that carry `width,height,depth` after the position.
 *
 * `(` and `[` open a box and are closed by `)` and `]`; `h`, `v` and `r` are a
 * box with no content. All five describe an area.
 */
const BOX_TYPES = new Set(['(', '[', 'h', 'v', 'r']);

/**
 * Record types that are a single point on a baseline rather than an area.
 *
 * Every other line of the content is skipped, which is the right answer for all
 * of them: `)` and `]` only close what was already described, `!` is a
 * character-count anchor for readers that seek rather than scan, and `<` and
 * `>` delimit a form -- reusable content whose coordinates are relative to
 * wherever the form is later placed, not to any page.
 */
const POINT_TYPES = new Set(['g', 'k', '$', 'x']);

/**
 * `tag,line[,column]:x,y[:width,height[,depth]]`
 *
 * Written tolerantly on purpose: a kern carries a width and no height, a glue
 * carries neither, and an engine is free to add a column. Refusing a record
 * whose tail is shaped differently would drop exactly the fine-grained ones.
 */
const RECORD = /^(\d+),(\d+)(?:,\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+)(?:,(-?\d+))?)?)?/;

/** The scale and origin every record is read against. */
interface SyncTexPreamble {
  unit: number;
  magnification: number;
  xOffset: number;
  yOffset: number;
}

export function parseSyncTex(text: string): SyncTexMap {
  const inputs = new Map<number, string>();
  const records: SyncTexRecord[] = [];
  const preamble: SyncTexPreamble = { unit: 1, magnification: 1, xOffset: 0, yOffset: 0 };

  let inContent = false;
  let page = 0;
  let truncated = false;

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length === 0) continue;

    // `Input:` appears in the preamble and again between sheets, because TeX
    // learns about a file the moment it opens it.
    if (line.startsWith('Input:')) {
      readInput(line, inputs);
      continue;
    }
    if (!inContent) {
      if (line === 'Content:') inContent = true;
      else readPreambleLine(line, preamble);
      continue;
    }
    if (line.startsWith('Postamble:')) break;

    const type = line[0] as string;
    if (type === '{') {
      page = readNumber(line.slice(1), 0);
      continue;
    }
    if (type === '}') {
      page = 0;
      continue;
    }
    // A sheet has to be open: records between sheets describe a form, which is
    // reusable content with no place on any page.
    if (page === 0) continue;

    const record = readRecord(line, type, page, preamble);
    if (record === null) continue;
    if (records.length >= MAX_RECORDS) {
      truncated = true;
      break;
    }
    records.push(record);
  }

  return { inputs, records, truncated };
}

function readInput(line: string, inputs: Map<number, string>): void {
  const colon = line.indexOf(':', 6);
  if (colon < 0) return;
  const tag = Number.parseInt(line.slice(6, colon), 10);
  if (Number.isFinite(tag)) inputs.set(tag, line.slice(colon + 1));
}

function readPreambleLine(line: string, preamble: SyncTexPreamble): void {
  if (line.startsWith('Unit:')) preamble.unit = readNumber(line.slice(5), 1);
  else if (line.startsWith('Magnification:'))
    preamble.magnification = readNumber(line.slice(14), 1000) / 1000;
  else if (line.startsWith('X Offset:')) preamble.xOffset = readNumber(line.slice(9), 0);
  else if (line.startsWith('Y Offset:')) preamble.yOffset = readNumber(line.slice(9), 0);
}

/**
 * One content line, or null when it carries no geometry.
 *
 * `!` is a character-count anchor for readers that seek rather than scan, and
 * `)` and `]` only close what `(` and `[` already described, so all three are
 * nothing to record.
 */
function readRecord(
  line: string,
  type: string,
  page: number,
  preamble: SyncTexPreamble,
): SyncTexRecord | null {
  const box = BOX_TYPES.has(type);
  if (!box && !POINT_TYPES.has(type)) return null;

  const match = RECORD.exec(line.slice(1));
  if (match === null) return null;

  const scale = (value: number): number =>
    (value * preamble.unit * preamble.magnification) / SP_PER_POINT;
  const x = scale(Number(match[3]) + preamble.xOffset);
  const y = scale(Number(match[4]) + preamble.yOffset);
  // A box is anchored at its baseline: the height reaches up from there, the
  // depth hangs below. A kern carries a trailing number too, but it is the
  // amount of space it inserts rather than an extent on paper, so it is
  // dropped: read as a width it would make a wide kern look near a click it
  // is nowhere close to.
  const width = box ? scale(Number(match[5] ?? 0)) : 0;
  const height = box ? scale(Number(match[6] ?? 0)) : 0;
  const depth = box ? scale(Number(match[7] ?? 0)) : 0;

  return {
    tag: Number(match[1]),
    line: Number(match[2]),
    page,
    left: x,
    top: y - height,
    width,
    height: height + depth,
  };
}

function readNumber(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Which source line produced the point `(x, y)` on `page`.
 *
 * The algorithm SyncTeX's own `edit` query uses, in two steps, because one step
 * is not enough: the smallest box containing the point says which paragraph was
 * clicked, and the nearest point record inside that box says which word. A
 * paragraph that runs over three source lines is one box carrying the first of
 * them, so stopping after step one would answer "line 41" for every click in it.
 *
 * Nothing containing the point is the ordinary case in a margin, so the
 * fallback is the nearest record on the page rather than no answer at all.
 */
export function lookupSource(
  map: SyncTexMap,
  query: { page: number; x: number; y: number },
): SyncTexRecord | null {
  const onPage = map.records.filter((record) => record.page === query.page);
  if (onPage.length === 0) return null;

  let box: SyncTexRecord | null = null;
  for (const record of onPage) {
    if (record.width <= 0 || record.height <= 0) continue;
    if (!contains(record, query.x, query.y)) continue;
    // `<=` rather than `<`: later records are deeper in the tree, and the
    // deepest of two boxes of equal size is the more specific answer.
    if (box === null || area(record) <= area(box)) box = record;
  }

  const candidates = box === null ? onPage : onPage.filter((record) => inside(box, record));
  let best: SyncTexRecord | null = box;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const record of candidates) {
    if (record === box) continue;
    const distance = distanceTo(record, query.x, query.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = record;
    }
  }
  return best;
}

/**
 * Where a source line ended up, as the areas it produced.
 *
 * A line that produced nothing at all -- a comment, a blank line, a `\usepackage`
 * -- has no answer of its own, and returning none would make forward sync fail
 * on exactly the lines somebody's cursor rests on between edits. So the search
 * falls forward to the next line that did produce something, and only then
 * back, which is what a reader means by "show me where I am".
 */
export function lookupAreas(
  map: SyncTexMap,
  query: { tag: number; line: number },
  limit: number,
): { line: number; areas: SyncTexArea[] } | null {
  const ofFile = map.records.filter((record) => record.tag === query.tag);
  if (ofFile.length === 0) return null;

  let exact = false;
  let after: number | null = null;
  let before: number | null = null;
  for (const record of ofFile) {
    if (record.line === query.line) {
      exact = true;
      break;
    }
    if (record.line > query.line) {
      if (after === null || record.line < after) after = record.line;
    } else if (before === null || record.line > before) {
      before = record.line;
    }
  }
  const line = exact ? query.line : (after ?? before);
  if (line === null) return null;

  // A point record answers with the line box around it rather than with itself.
  // Half the records of a line are glue and kerns with no extent of their own,
  // and a caller that wants to draw where the line went needs the height of the
  // line it sits on -- a marker one pixel tall is not a place on a page.
  const rects: SyncTexArea[] = [];
  for (const record of ofFile) {
    if (record.line !== line) continue;
    if (record.width > 0 && record.height > 0) {
      rects.push({
        page: record.page,
        left: record.left,
        top: record.top,
        width: record.width,
        height: record.height,
      });
      continue;
    }
    const box = smallestBoxAt(map, record);
    rects.push({
      page: record.page,
      left: record.left,
      top: box?.top ?? record.top,
      width: 0,
      height: box?.height ?? 0,
    });
  }

  return { line, areas: mergeAreas(rects).slice(0, limit) };
}

/** The tightest box on a record's page that has the record inside it. */
function smallestBoxAt(map: SyncTexMap, point: SyncTexRecord): SyncTexRecord | null {
  let best: SyncTexRecord | null = null;
  for (const record of map.records) {
    if (record.page !== point.page) continue;
    if (record.width <= 0 || record.height <= 0) continue;
    if (!contains(record, point.left, point.top)) continue;
    if (best === null || area(record) <= area(best)) best = record;
  }
  return best;
}

/**
 * One rectangle per run of a line, smallest first.
 *
 * Every glyph of a line that runs across a page produces its own record, so the
 * unmerged answer is forty marks where a reader sees one. Areas that share a
 * page and a vertical extent are the same run of text, and the span from the
 * leftmost to the rightmost of them is what somebody means by "there". Smallest
 * first because the box that was open around a line can be the whole sheet, and
 * a caller that draws only the first answer should get the line.
 */
function mergeAreas(areas: readonly SyncTexArea[]): SyncTexArea[] {
  const byRow = new Map<string, SyncTexArea>();
  for (const entry of areas) {
    const key = `${String(entry.page)}|${entry.top.toFixed(2)}|${entry.height.toFixed(2)}`;
    const merged = byRow.get(key);
    if (merged === undefined) {
      byRow.set(key, { ...entry });
      continue;
    }
    const right = Math.max(merged.left + merged.width, entry.left + entry.width);
    merged.left = Math.min(merged.left, entry.left);
    merged.width = right - merged.left;
  }
  return [...byRow.values()].sort(
    (a, b) => a.width * a.height - b.width * b.height || a.page - b.page || a.top - b.top,
  );
}

/**
 * The project-relative path a map entry names, or null when it names none.
 *
 * TeX writes absolute paths into a directory that only ever existed inside the
 * build container, and it names its own distribution the same way, so the raw
 * path is never usable as it stands. Matching by suffix against what the project
 * actually holds is what separates `chapters/intro.tex` from
 * `/opt/texlive/.../article.cls`, and it keeps this file from having to know
 * where the container put things.
 */
export function resolveInputPath(raw: string, knownPaths: Iterable<string>): string | null {
  let path = raw.trim().replaceAll('\\', '/');
  while (path.includes('/./')) path = path.replaceAll('/./', '/');
  while (path.startsWith('./')) path = path.slice(2);

  let best: string | null = null;
  for (const known of knownPaths) {
    if (path !== known && !path.endsWith(`/${known}`)) continue;
    if (best === null || known.length > best.length) best = known;
  }
  return best;
}

function area(record: SyncTexRecord): number {
  return record.width * record.height;
}

function contains(record: SyncTexRecord, x: number, y: number): boolean {
  return (
    x >= record.left &&
    x <= record.left + record.width &&
    y >= record.top &&
    y <= record.top + record.height
  );
}

/** Whether `record` lies within `box`, which is what nesting looks like on paper. */
function inside(box: SyncTexRecord, record: SyncTexRecord): boolean {
  return (
    record.left >= box.left &&
    record.left <= box.left + box.width &&
    record.top >= box.top &&
    record.top + record.height <= box.top + box.height + 1
  );
}

function distanceTo(record: SyncTexRecord, x: number, y: number): number {
  const dx = Math.max(record.left - x, 0, x - (record.left + record.width));
  const dy = Math.max(record.top - y, 0, y - (record.top + record.height));
  return Math.hypot(dx, dy);
}
