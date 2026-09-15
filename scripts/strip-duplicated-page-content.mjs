/**
 * Removes the second copy from a page that carries its content twice.
 *
 * Until 2026-09-15 a write that did not come from the editor stored freshly
 * built Yjs state instead of editing the stored state (see
 * `applyProseMirrorDocumentToState`). The page read back correctly; the damage
 * appeared later, when a copy of the document that predated the write showed up
 * -- a tab still holding it, its `y-indexeddb` store, a session that had loaded
 * earlier. Sharing no history with the stored state, that copy merged as an
 * unrelated document and Yjs kept both halves, so the page came back with its
 * content duplicated. The write path no longer does this; this script is for
 * the pages it already damaged.
 *
 *   node scripts/strip-duplicated-page-content.mjs --workspace <id>            # dry run
 *   node scripts/strip-duplicated-page-content.mjs --workspace <id> --apply
 *   node scripts/strip-duplicated-page-content.mjs --all-workspaces --apply
 *
 * What counts as duplicated is deliberately narrow: a tail of at least a third
 * of the page must repeat *exactly* somewhere earlier in it. The page is then
 * cut back to the end of that first copy, which also drops whatever sat between
 * the two -- the difference between the version the write left and the one the
 * stale copy brought back, so exactly what the write had decided against. The
 * dry run prints that text; read it before running with `--apply`. A page whose
 * halves have drifted apart is reported and left alone: picking a winner there
 * is a judgement call, not a sweep.
 *
 * Like its two siblings, this reads from the database to decide what is worth
 * opening and writes only through the REST API, so each page takes the ordinary
 * path: a snapshot first (its id is printed), the open session is told
 * (ADR-016), and the indexes are rebuilt afterwards. Every write is read back
 * and compared; a mismatch stops the run.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createPrismaClient } from '../packages/database/dist/index.js';
import { stripRedundantTitleHeading } from '../packages/editor/dist/index.js';

const API = process.env.EXOCORTEX_API_URL ?? 'http://127.0.0.1:3211';

/** The frontmatter block the export prepends, which is metadata, not content. */
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** A copy shorter than this share of the page is not what this script is for. */
const MIN_COPY_SHARE = 1 / 3;

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

/** The token the MCP server uses, read from where it already lives. */
function readToken() {
  if (process.env.EXOCORTEX_API_TOKEN) return process.env.EXOCORTEX_API_TOKEN;
  const config = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
  const token = config?.mcpServers?.exocortex?.env?.EXOCORTEX_API_TOKEN;
  if (!token) throw new Error('No EXOCORTEX_API_TOKEN in the environment or ~/.claude.json');
  return token;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Paced to stay under the API's own rate limit (300 requests a minute). */
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
 * Writing Markdown back escapes characters that were literal before, which
 * changes the text without changing the page.
 */
function normalizeEscapes(markdown) {
  return markdown.replace(/\\([-!"#$%&'()*+,./:;<=>?@[\]^_`{|}~])/g, '$1').trim();
}

const bodyOf = (markdown) => markdown.replace(FRONTMATTER, '');

/** Trailing spaces and blank-line runs differ between the two copies. */
const normalize = (text) =>
  text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Where the page starts repeating itself, or `null` when it does not.
 *
 * The shape left behind by the merge is `A + between + A`: one of the two
 * copies is what the write meant to leave, the other is what the stale copy
 * brought back, and `between` is the difference between them -- the title
 * heading the write endpoint strips, or a generated section a sweep had just
 * removed. Which of the two came out on top is decided by Yjs from the client
 * ids and is not stable, so it cannot be used to tell them apart.
 *
 * Found by binary search over the length of the repeated tail: if a suffix of
 * length `d` occurs earlier in the page, so does every shorter one, which is
 * what makes the search sound.
 */
function findDuplicate(body) {
  const text = normalize(body);
  const n = text.length;
  let low = 1;
  let high = Math.floor(n / 2);
  let copy = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (text.lastIndexOf(text.slice(n - middle), n - middle - 1) >= 0) {
      copy = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (copy === 0 || copy < n * MIN_COPY_SHARE) return null;
  const start = text.lastIndexOf(text.slice(n - copy), n - copy - 1);
  return { copy, start, between: text.slice(start + copy, n - copy) };
}

/**
 * What the page should say instead: up to the end of the first copy.
 *
 * Everything after it goes, `between` included: that text is the part of the
 * older version the write had already decided against, carried back in by the
 * copy that resurrected it.
 */
function withoutDuplicate(body, duplicate) {
  const text = normalize(body);
  return `${text.slice(0, duplicate.start + duplicate.copy).trimEnd()}\n`;
}

/** Depth-first search for an embedded database in the stored projection. */
function hasDatabaseEmbed(node) {
  if (node === null || typeof node !== 'object') return false;
  if (node.type === 'databaseEmbed') return true;
  return (node.content ?? []).some((child) => hasDatabaseEmbed(child));
}

/**
 * The pages worth opening: ordinary, live pages long enough to hold two copies
 * of anything. The stored text can lag behind the Yjs state, so it decides what
 * to look at and never what to write.
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
      content: { select: { plainText: true, proseMirrorJson: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const candidates = [];
  const embeds = [];
  for (const row of rows) {
    const text = row.content?.plainText ?? '';
    if (text.length < 200) continue;
    if (hasDatabaseEmbed(row.content?.proseMirrorJson)) {
      if (findDuplicate(text) !== null) embeds.push(row);
      continue;
    }
    if (findDuplicate(text) === null) continue;
    candidates.push(row);
  }
  return { candidates, embeds };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }
  if (!args.all && args.workspaces.length === 0) {
    throw new Error('Pass --workspace <id> or --all-workspaces');
  }

  const token = readToken();
  const prisma = createPrismaClient();
  try {
    const reachable = (await api(token, 'GET', '/api/workspaces')).workspaces.map(
      (workspace) => workspace.id,
    );
    const workspaceIds = args.all
      ? reachable
      : args.workspaces.filter((id) => reachable.includes(id));
    if (workspaceIds.length === 0) throw new Error('None of those workspaces are readable');

    const { candidates, embeds } = await collectCandidates(prisma, {
      workspaceIds,
      only: args.only,
    });
    console.log(
      `${candidates.length} Seite(n) tragen ihren Inhalt doppelt${
        args.apply ? '' : ' (Probelauf, es wird nichts geschrieben)'
      }.`,
    );

    const changed = [];
    const drifted = [];
    for (const document of candidates) {
      if (changed.length >= args.limit) break;

      const exported = await api(token, 'GET', `/api/documents/${document.id}/export/markdown`);
      const body = bodyOf(exported.markdown);
      const duplicate = findDuplicate(body);
      /*
       * The stored text said the page is duplicated and the exported Markdown
       * does not. That is a page whose halves have drifted apart, and deciding
       * which half to keep is not this script's call.
       */
      if (duplicate === null) {
        drifted.push(`${document.title} (${document.id})`);
        continue;
      }

      const next = withoutDuplicate(body, duplicate);
      changed.push(document.title);
      console.log(
        `${args.apply ? '✓' : '·'} ${document.title}  (${document.id})  ` +
          `${body.length} → ${next.length} Zeichen`,
      );
      if (duplicate.between.trim().length > 0) {
        const preview = duplicate.between.trim().replace(/\s+/g, ' ');
        console.log(
          `    Zwischen den Kopien stand (fällt ebenfalls weg): ` +
            `${preview.slice(0, 160)}${preview.length > 160 ? ' …' : ''}`,
        );
      }
      if (!args.apply) continue;

      const written = await api(token, 'POST', `/api/documents/${document.id}/content`, {
        markdown: next,
        mode: 'replace',
      });
      console.log(`    Snapshot davor: ${written.snapshotId}`);

      /*
       * The endpoint drops a first-level heading that only repeats the page
       * title, so the page is compared against what it was asked to store
       * rather than against what was sent.
       */
      const expected = stripRedundantTitleHeading(next, document.title).markdown;
      const after = await api(token, 'GET', `/api/documents/${document.id}/export/markdown`);
      if (normalizeEscapes(bodyOf(after.markdown)) !== normalizeEscapes(expected)) {
        throw new Error(
          `Die Seite ${document.id} sieht nach dem Schreiben anders aus als beabsichtigt. ` +
            `Zurückrollen mit Snapshot ${written.snapshotId}. Lauf gestoppt.`,
        );
      }
    }

    if (drifted.length > 0) {
      console.log(
        `\n${drifted.length} Seite(n) sind doppelt, aber die Hälften weichen voneinander ab. ` +
          'Die bleiben unberührt und wollen von Hand angesehen werden:',
      );
      for (const entry of drifted) console.log(`  · ${entry}`);
    }
    if (embeds.length > 0) {
      console.log(
        `\n${embeds.length} Seite(n) mit eingebetteter Datenbank übersprungen: ` +
          'die Blöcke überleben den Markdown-Umweg nicht.',
      );
      for (const entry of embeds) console.log(`  · ${entry.title} (${entry.id})`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

await main();
