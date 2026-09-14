/**
 * Where the three clients of the domain meet the REST API.
 *
 * `apps/api` owns every capability eXocortex has, and the browser, the
 * built-in AI and external MCP clients are three equal callers of it
 * (ADR-025). Two gates ask questions about that arrangement -- whether the
 * catalogue kept up with the API, and whether all three ways can reach the
 * same capabilities -- and both need the same lists. They live here so the two
 * gates cannot quietly disagree about what a route is.
 *
 * Everything is read from source rather than by loading the code. A gate has
 * to stay runnable with plain `node`, before `pnpm install` and without a
 * build step, and a scan that stops matching is caught by
 * `scripts/gates.test.ts`, which writes a violation into the tree and insists
 * the gate goes red.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

const API_SRC = join(repoRoot, 'apps/api/src');
const WEB_SRC = join(repoRoot, 'apps/web/src');
const CATALOGUE_SRC = join(repoRoot, 'packages/mcp-tools/src');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.turbo', 'coverage', '.next']);

export function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, acc);
    else if (/\.tsx?$/.test(entry)) acc.push(abs);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Reading a path out of the source
// ---------------------------------------------------------------------------

/**
 * Reads one string literal starting at `open` and returns its path shape.
 *
 * Written as a small scanner rather than a regular expression because both
 * things a regular expression gets wrong here happen in this repository:
 *
 *   `/api/workspaces/${workspaceId ?? ''}/settings`
 *   `/api/workspaces/${id}/automations/runs${rule === undefined ? '' : `?r=${rule}`}`
 *
 * The first ends at the wrong quote for any character class shared across the
 * three quote styles; the second nests a template literal inside its own
 * interpolation, so counting to the next backtick lands in the middle. Both
 * came out as plausible-looking wrong routes, which is the failure that matters:
 * a mangled route matches nothing and the gate reports a gap that is not there.
 *
 * Interpolations become `:x`, since a parameter's name is the caller's business
 * and only its position has to agree with the route.
 *
 * Returns `null` when `open` is not a string literal.
 */
export function readStringLiteral(source, open) {
  const quote = source[open];
  if (quote !== '`' && quote !== "'" && quote !== '"') return null;
  let out = '';
  let cursor = open + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '\\') {
      out += source.slice(cursor, cursor + 2);
      cursor += 2;
      continue;
    }
    if (char === quote) return { text: out, end: cursor + 1 };
    if (quote === '`' && char === '$' && source[cursor + 1] === '{') {
      let depth = 1;
      cursor += 2;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === '{') depth += 1;
        else if (source[cursor] === '}') depth -= 1;
        cursor += 1;
      }
      out += ':x';
      continue;
    }
    if (quote !== '`' && char === '\n') return null;
    out += char;
    cursor += 1;
  }
  return null;
}

/**
 * `/api/documents/:documentId/x` becomes `/api/documents/:x/x`, and so does the
 * interpolated form once `readStringLiteral` has turned its `${…}` into `:x`.
 * A query string is dropped: the browser builds one into the path, the
 * catalogue passes it as a separate `query` object, and the route is the same.
 */
export function normalizePath(path) {
  const segments = path
    .split('?')[0]
    .split('/')
    .filter((segment) => segment.length > 0)
    // A segment is either a fixed name or a whole parameter. A fixed name with
    // something appended -- `runs:x`, from a ternary that adds `?ruleId=…` or
    // adds nothing -- is a query string, so the name alone is the segment.
    .map((segment) => (segment.startsWith(':') ? ':x' : segment.split(':')[0]))
    .filter((segment) => segment.length > 0);
  return `/${segments.join('/')}`;
}

/** Every `/api/…` or `/health/…` literal in a piece of source, path shapes only. */
function pathLiterals(source) {
  const found = [];
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char !== '`' && char !== "'" && char !== '"') continue;
    const literal = readStringLiteral(source, cursor);
    if (literal === null) continue;
    cursor = literal.end - 1;
    if (/^\/(api|health)\//.test(literal.text)) found.push(literal.text);
  }
  return found;
}

/** The `{ … }` literal that starts at `open`, without its braces. */
function readBlock(source, open) {
  let depth = 1;
  let cursor = open + 1;
  while (cursor < source.length && depth > 0) {
    if (source[cursor] === '{') depth += 1;
    else if (source[cursor] === '}') depth -= 1;
    cursor += 1;
  }
  return { text: source.slice(open + 1, cursor - 1), end: cursor };
}

/**
 * Matches a `METHOD /path` route against a pattern.
 *
 * `*` as the method matches any; a `*` at the end of the path matches the rest
 * of it. Everything else is exact, with parameters written as `:x`.
 */
export function matchesRoutePattern(route, pattern) {
  const [patternMethod, patternPath] = pattern.split(' ');
  const [routeMethod, routePath] = route.split(' ');
  if (patternMethod !== '*' && patternMethod !== routeMethod) return false;
  if (patternPath.endsWith('*')) return routePath.startsWith(patternPath.slice(0, -1));
  return patternPath === routePath;
}

// ---------------------------------------------------------------------------
// The three sides
// ---------------------------------------------------------------------------

/** Every route a NestJS controller declares, as `METHOD /path` -> `file:line`. */
export function collectApiRoutes() {
  const routes = new Map();
  for (const file of walk(API_SRC).filter((file) => file.endsWith('.controller.ts'))) {
    const rel = relative(repoRoot, file);
    let prefix = null;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      const controller = line.match(/^@Controller\(\s*(?:'([^']*)')?\s*\)/);
      if (controller !== null) prefix = controller[1] ?? '';
      const handler = line.match(/^\s*@(Get|Post|Patch|Put|Delete|All)\(\s*(?:'([^']*)')?\s*\)/);
      if (handler === null || prefix === null) continue;
      const method = handler[1] === 'All' ? '*' : handler[1].toUpperCase();
      const suffix = (handler[2] ?? '').replace(/\*$/, '');
      const key = `${method} ${normalizePath(`${prefix}/${suffix}`)}`;
      if (!routes.has(key)) routes.set(key, `${rel}:${index + 1}`);
    }
  }
  return routes;
}

/** Where the query hooks live. A call here only counts once a screen reaches it. */
const WEB_CLIENT_DIR = join(WEB_SRC, 'lib/api');

/**
 * Every route the browser calls, as `METHOD /path` -> the file that calls it.
 *
 * Two shapes are read: `apiRequest('/api/…', { method: 'POST' })`, which is how
 * the whole app talks to the API, and the two bare `fetch('/api/…')` calls that
 * upload multipart bodies the JSON wrapper cannot carry. A call without a
 * `method` is a GET, which is the wrapper's own default.
 *
 * A call inside `lib/api` only counts when a screen actually reaches the hook
 * that makes it -- see `reachableClientNames`. The whole point of the UI column
 * is what a person can do, and a hook nobody renders is a capability nobody
 * has: `useProjectBuilds` sat in the client for a day reporting a build history
 * the project view never showed, and the matrix called that browser coverage.
 */
export function collectWebCalls() {
  const calls = new Map();
  const reachable = reachableClientNames();
  for (const file of walk(WEB_SRC).filter((file) => !file.includes('.test.'))) {
    const rel = relative(repoRoot, file);
    const source = readFileSync(file, 'utf8');
    const declarations = file.startsWith(WEB_CLIENT_DIR) ? topLevelDeclarations(source) : null;
    const opener = /\b(apiRequest|fetch)\s*(?:<[^>]*>)?\s*\(\s*/g;
    while (opener.exec(source) !== null) {
      const literal = readStringLiteral(source, opener.lastIndex);
      if (literal === null || !literal.text.startsWith('/api/')) continue;
      if (declarations !== null) {
        const owner = declarationAt(declarations, opener.lastIndex);
        if (owner !== null && !reachable.has(owner)) continue;
      }
      const rest = source.slice(literal.end).match(/^\s*,\s*\{/);
      const options = rest === null ? '' : readBlock(source, literal.end + rest[0].length - 1).text;
      const method = options.match(/(?:^|[\s,{])method:\s*'(\w+)'/)?.[1] ?? 'GET';
      const key = `${method.toUpperCase()} ${normalizePath(literal.text)}`;
      if (!calls.has(key)) calls.set(key, rel);
    }
  }
  return calls;
}

/**
 * Every export of `lib/api` that no screen imports, as name -> the file.
 *
 * The dead half of the same question `collectWebCalls` asks, kept here so the
 * two answers come from one scan: a hook in this list is a capability the
 * browser was given and never offered to anybody.
 */
export function deadClientExports() {
  const reachable = reachableClientNames();
  const dead = new Map();
  for (const file of walk(WEB_CLIENT_DIR).filter((file) => !file.includes('.test.'))) {
    const source = readFileSync(file, 'utf8');
    for (const declaration of topLevelDeclarations(source)) {
      if (!declaration.exported || reachable.has(declaration.name)) continue;
      // Only the ones that talk to the API: a type, a query-key map or a label
      // table is scaffolding, and an unused one is a lint concern rather than a
      // missing screen.
      if (!/\b(apiRequest|fetch)\s*(?:<[^>]*>)?\s*\(\s*['"`]\/api\//.test(declaration.body)) {
        continue;
      }
      dead.set(declaration.name, relative(repoRoot, file));
    }
  }
  return dead;
}

/**
 * The names in `lib/api` a screen can reach, directly or through each other.
 *
 * A screen is any file outside `lib/api`: a route, a component, a hook of its
 * own. What it imports from the client is the entry point, and from there the
 * set grows through the client's own calls -- `useProjectFileMutation` is one
 * hook wrapping five mutations, and reachability has to survive that.
 *
 * Import names rather than every identifier in the file, because an identifier
 * scan makes everything reachable: `useProjectBuilds` appears in a comment in
 * the very component that fails to call it.
 */
function reachableClientNames() {
  const declarations = new Map();
  for (const file of walk(WEB_CLIENT_DIR).filter((file) => !file.includes('.test.'))) {
    for (const declaration of topLevelDeclarations(readFileSync(file, 'utf8'))) {
      declarations.set(declaration.name, declaration.body);
    }
  }

  const reachable = new Set();
  const queue = [];
  for (const file of walk(WEB_SRC).filter((file) => !file.startsWith(WEB_CLIENT_DIR))) {
    for (const name of importedFromClient(readFileSync(file, 'utf8'))) {
      if (declarations.has(name) && !reachable.has(name)) {
        reachable.add(name);
        queue.push(name);
      }
    }
  }

  while (queue.length > 0) {
    const body = declarations.get(queue.pop()) ?? '';
    for (const match of body.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
      const name = match[0];
      if (declarations.has(name) && !reachable.has(name)) {
        reachable.add(name);
        queue.push(name);
      }
    }
  }
  return reachable;
}

/** The names a file imports out of `lib/api`, by any spelling of the path. */
function importedFromClient(source) {
  const names = [];
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    if (!/(^|\/)lib\/api\//.test(match[2]) && !/^\.\.?\/api\//.test(match[2])) continue;
    for (const part of match[1].split(',')) {
      const name = part
        .replace(/^\s*type\s+/, '')
        .split(/\s+as\s+/)[0]
        .trim();
      if (name.length > 0) names.push(name);
    }
  }
  return names;
}

/**
 * The top-level declarations of one file, each with the source that follows it.
 *
 * A declaration runs to the start of the next one, which is what "the body" has
 * to mean here: the point is which call belongs to which export, and a brace
 * counter that has to survive JSX, template literals and type parameters would
 * be a parser. The last declaration runs to the end of the file.
 */
function topLevelDeclarations(source) {
  const found = [];
  for (const match of source.matchAll(
    /^(export\s+)?(?:async\s+)?(?:function|const|class)\s+(\w+)/gm,
  )) {
    found.push({ name: match[2], exported: match[1] !== undefined, start: match.index, body: '' });
  }
  for (const [index, declaration] of found.entries()) {
    const end = index + 1 < found.length ? found[index + 1].start : source.length;
    declaration.body = source.slice(declaration.start, end);
  }
  return found;
}

/** Which declaration an offset falls in, or `null` above the first one. */
function declarationAt(declarations, offset) {
  let owner = null;
  for (const declaration of declarations) {
    if (declaration.start > offset) break;
    owner = declaration.name;
  }
  return owner;
}

/**
 * Every route the catalogue calls, as `METHOD /path` -> the tool file.
 *
 * Reads the object literal handed to `client.request` / `client.upload` and
 * takes every `/api/…` literal in it, rather than only the one on the line
 * after `method:`. Several tools choose their path with a ternary (the
 * invitation tools switch between the workspace route and the admin one), and
 * both branches are calls that really happen.
 */
export function collectCatalogueCalls() {
  const calls = new Map();
  for (const file of walk(CATALOGUE_SRC).filter((file) => !file.includes('.test.'))) {
    const rel = relative(repoRoot, file);
    for (const call of requestCalls(readFileSync(file, 'utf8'))) {
      if (!calls.has(call)) calls.set(call, rel);
    }
  }
  return calls;
}

/** The `METHOD /path` of every `client.request` / `client.upload` in a source. */
function requestCalls(source) {
  const found = [];
  const opener = /\bclient\.(request|upload)\s*(?:<[^>]*>)?\s*\(\s*\{/g;
  let match;
  while ((match = opener.exec(source)) !== null) {
    const block = readBlock(source, opener.lastIndex - 1).text;
    const method =
      match[1] === 'upload' ? 'POST' : (block.match(/method:\s*'(\w+)'/)?.[1] ?? 'UNKNOWN');
    for (const path of pathLiterals(block)) {
      const key = `${method} ${normalizePath(path)}`;
      if (!found.includes(key)) found.push(key);
    }
  }
  return found;
}

/**
 * Every tool in the catalogue: its name, the surfaces it is offered on, the
 * routes it calls, whether it writes, and where it is declared.
 */
export function collectTools() {
  const tools = [];
  for (const file of walk(CATALOGUE_SRC).filter((file) => !file.includes('.test.'))) {
    const rel = relative(repoRoot, file);
    const source = readFileSync(file, 'utf8');
    const opener = /\bdefineTool\s*(?:<[^>]*>)?\s*\(\s*\{/g;
    let match;
    while ((match = opener.exec(source)) !== null) {
      const block = readBlock(source, opener.lastIndex - 1).text;
      const name = block.match(/\bname:\s*'([^']+)'/)?.[1];
      if (name === undefined) continue;
      const surfaceList = block.match(/\bsurfaces:\s*\[([^\]]*)\]/)?.[1] ?? '';
      tools.push({
        name,
        surfaces: [...surfaceList.matchAll(/'(\w+)'/g)].map((entry) => entry[1]),
        mutating: /\bmutating:\s*true/.test(block),
        routes: requestCalls(block),
        where: `${rel}:${source.slice(0, match.index).split('\n').length}`,
      });
    }
  }
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}
