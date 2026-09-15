/**
 * Removes the first-level heading that only repeats the page title.
 *
 * A page's title is metadata and is rendered above the page; the Markdown
 * serializer writes it into the frontmatter and never into the body. Agents
 * write it into the body anyway, because that is what a Markdown file looks
 * like everywhere else, and the page then shows the same line twice. Since the
 * write endpoint strips that heading on its way in, this script is only about
 * the pages written before it did.
 *
 *   node scripts/strip-duplicate-title-headings.mjs --workspace <id>            # dry run
 *   node scripts/strip-duplicate-title-headings.mjs --workspace <id> --apply
 *   node scripts/strip-duplicate-title-headings.mjs --all-workspaces --apply
 *
 * The decision is made by the same function the API uses
 * (`stripRedundantTitleHeading`), imported from the built editor package, so a
 * page this script would change is exactly a page the endpoint would have
 * changed. Nothing is matched by hand here.
 *
 * Reading happens twice, on purpose. The database says cheaply which pages are
 * worth looking at and which ones must be left alone; the export endpoint then
 * provides the text that is actually edited, because the canonical state is the
 * Yjs update and Markdown is derived from it (ADR-007). Every write goes
 * through the REST API, so each page takes the ordinary path: a snapshot
 * before the change (its id is printed, restore it to undo a single page), the
 * open editing session is told (ADR-016), and the indexes are rebuilt after.
 *
 * What it refuses to touch:
 *
 *  * a page carrying an embedded database. Those blocks do not survive a
 *    Markdown round trip, and a repeated heading is not worth losing one
 *  * anything but an ordinary page: a database and a project keep their own
 *    shape in the Yjs state
 *  * archived pages, which nobody is reading
 *
 * Every write is verified by reading the page back; a single mismatch stops the
 * run.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createPrismaClient } from '../packages/database/dist/index.js';
import { stripRedundantTitleHeading } from '../packages/editor/dist/index.js';

const API = process.env.EXOCORTEX_API_URL ?? 'http://127.0.0.1:3211';

/** The frontmatter block the export prepends, which is metadata, not content. */
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

function parseArgs(argv) {
  const args = { workspaces: [], all: false, only: null, limit: Infinity, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--workspace') args.workspaces.push(argv[++i]);
    else if (flag === '--all-workspaces') args.all = true;
    else if (flag === '--only') args.only = argv[++i] ?? null;
    else if (flag === '--limit') args.limit = Number(argv[++i] ?? '0');
    else if (flag === '--apply') args.apply = true;
    else if (flag === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

/**
 * The token the MCP server uses. Read from the same place rather than asked
 * for, so running this needs no secret on a command line.
 */
function readToken() {
  if (process.env.EXOCORTEX_API_TOKEN) return process.env.EXOCORTEX_API_TOKEN;
  const config = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
  const token = config?.mcpServers?.exocortex?.env?.EXOCORTEX_API_TOKEN;
  if (!token) throw new Error('No EXOCORTEX_API_TOKEN in the environment or ~/.claude.json');
  return token;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Paced to stay under the API's own rate limit (300 requests a minute), because
 * a sweep over a workspace is exactly the traffic that limit is there to stop.
 */
const MIN_REQUEST_INTERVAL_MS = 250;
let nextRequestAt = 0;

async function api(token, method, path, body, attempt = 0) {
  const wait = nextRequestAt - Date.now();
  if (wait > 0) await sleep(wait);
  nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;

  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();

  if (response.status === 429 && attempt < 5) {
    const retryAfter = Number(response.headers.get('retry-after'));
    const pause = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 15_000;
    console.log(`  … Ratenlimit erreicht, warte ${Math.round(pause / 1000)} s`);
    await sleep(pause);
    return api(token, method, path, body, attempt + 1);
  }
  if (!response.ok)
    throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  return text.length === 0 ? null : JSON.parse(text);
}

/**
 * What the read-back comparison is allowed to ignore: writing Markdown back
 * escapes characters that were literal before (`*` inside a word), which
 * changes the text without changing the page.
 */
function normalizeEscapes(markdown) {
  return markdown.replace(/\\([-!"#$%&'()*+,./:;<=>?@[\]^_`{|}~])/g, '$1').trim();
}

const bodyOf = (markdown) => markdown.replace(FRONTMATTER, '');

/** Depth-first search for an embedded database in the stored projection. */
function hasDatabaseEmbed(node) {
  if (node === null || typeof node !== 'object') return false;
  if (node.type === 'databaseEmbed') return true;
  return (node.content ?? []).some((child) => hasDatabaseEmbed(child));
}

/**
 * The pages worth opening: ordinary, live pages whose stored projection starts
 * with a first-level heading. The projection can lag behind the Yjs state, so
 * this decides what to look at and never what to write.
 */
async function collectCandidates(prisma, { workspaceIds, only }) {
  const rows = await prisma.document.findMany({
    where: {
      type: 'PAGE',
      archivedAt: null,
      ...(only === null ? {} : { id: only }),
      ...(workspaceIds === null ? {} : { workspaceId: { in: workspaceIds } }),
    },
    select: {
      id: true,
      title: true,
      workspaceId: true,
      content: { select: { proseMirrorJson: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const candidates = [];
  const embeds = [];
  for (const row of rows) {
    const json = row.content?.proseMirrorJson;
    if (json === null || json === undefined) continue;
    if (hasDatabaseEmbed(json)) {
      embeds.push(row);
      continue;
    }
    const first = (json.content ?? [])[0];
    if (first?.type !== 'heading' || first?.attrs?.level !== 1) continue;
    candidates.push(row);
  }
  return { candidates, embeds, total: rows.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (args.workspaces.length === 0 && !args.all && args.only === null)) {
    console.log(
      'Usage: (--workspace <id> … | --all-workspaces | --only <documentId>) [--limit n] [--apply]',
    );
    process.exit(args.help ? 0 : 1);
  }

  const token = readToken();
  const prisma = createPrismaClient();

  try {
    /*
     * Even `--all-workspaces` means "all of them this token can open". The
     * database knows about workspaces the token's user is not a member of, and
     * a sweep that walks into one only finds out when the API refuses it.
     */
    const reachable = (await api(token, 'GET', '/api/workspaces')).workspaces.map(
      (workspace) => workspace.id,
    );
    const requested = args.all ? reachable : args.workspaces;
    const unreachable = requested.filter((id) => !reachable.includes(id));
    if (unreachable.length > 0) {
      throw new Error(`Kein Zugriff auf ${unreachable.join(', ')}.`);
    }

    const { candidates, embeds, total } = await collectCandidates(prisma, {
      workspaceIds: args.only === null ? requested : null,
      only: args.only,
    });
    console.log(
      `${total} Seiten geprüft, ${candidates.length} beginnen mit einer Überschrift, ` +
        `${embeds.length} mit eingebetteter Datenbank übersprungen.`,
    );

    const changed = [];
    const unparsable = [];
    for (const document of candidates) {
      if (changed.length >= args.limit) break;

      const exported = await api(token, 'GET', `/api/documents/${document.id}/export/markdown`);
      const body = bodyOf(exported.markdown);
      const { markdown: next, removed } = stripRedundantTitleHeading(body, document.title);
      if (removed === null) continue;

      changed.push(document.title);
      console.log(`${args.apply ? '✓' : '·'} ${document.title}  (${document.id})`);
      if (!args.apply) continue;

      /*
       * A page whose own content does not survive the Markdown round trip is
       * left alone rather than allowed to stop the sweep. That is a defect in
       * the serializer, not in this page's heading, and the run is more useful
       * finishing and naming those pages than dying on the first one.
       */
      let written;
      try {
        written = await api(token, 'POST', `/api/documents/${document.id}/content`, {
          markdown: next,
          mode: 'replace',
        });
      } catch (error) {
        if (!String(error.message).includes('-> 400')) throw error;
        changed.pop();
        unparsable.push(`${document.title} (${document.id})`);
        console.log('    … nicht schreibbar, Markdown lässt sich nicht zurücklesen. Übersprungen.');
        continue;
      }
      console.log(`    Snapshot davor: ${written.snapshotId}`);

      const after = await api(token, 'GET', `/api/documents/${document.id}/export/markdown`);
      if (normalizeEscapes(bodyOf(after.markdown)) !== normalizeEscapes(next)) {
        throw new Error(
          `Die Seite ${document.id} sieht nach dem Schreiben anders aus als beabsichtigt. ` +
            `Zurückrollen mit Snapshot ${written.snapshotId}. Lauf gestoppt.`,
        );
      }
    }

    console.log(
      args.apply
        ? `\n${changed.length} Seiten bereinigt.`
        : `\n${changed.length} Seiten würden bereinigt. Mit --apply ausführen.`,
    );
    if (unparsable.length > 0) {
      console.log(`\n${unparsable.length} Seiten übersprungen, Markdown nicht zurücklesbar:`);
      for (const entry of unparsable) console.log(`  · ${entry}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

await main();
