/**
 * Removes the "Verwandte Notizen" block that the Obsidian export appended to
 * every imported page.
 *
 * That block is not a curated list. It is the page's folder rendered as prose:
 * a heading, the category in italics, and then the page's siblings in that
 * folder. It repeats what the page tree already shows, it has to be maintained
 * by hand to stay true, and since issue #33 the panel computes a better answer
 * from the page's own text. So it goes.
 *
 *   node scripts/strip-generated-related-sections.mjs --workspace <id>           # dry run
 *   node scripts/strip-generated-related-sections.mjs --workspace <id> --apply
 *
 * Everything goes through the REST API rather than the database, so each page
 * takes the ordinary write path: a snapshot before the change (its id is
 * printed, restore it to undo a single page), the open editing session is told
 * (ADR-016), and the search and reference indexes are rebuilt afterwards. The
 * canonical Yjs state stays canonical; Markdown is only the interchange format
 * the write endpoint already speaks (ADR-007).
 *
 * What it refuses to touch:
 *
 *  * a section without the italic category line. Those are hand-written, they
 *    carry notes like "(Hermes Agent als Health-Tracker)", and they are the
 *    whole reason this matches on shape rather than on the heading alone
 *  * a section with anything but wiki links under it
 *  * a section that is not the last thing on the page
 *
 * Every write is verified by reading the page back and comparing it to what was
 * intended; a single mismatch stops the run.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const API = process.env.EXOCORTEX_API_URL ?? 'http://127.0.0.1:3211';

/**
 * The generated block, anchored to the end of the page.
 *
 * The italic category line is what identifies it. A hand-written list never has
 * one: it starts with the entries. Everything under it has to be a bullet
 * carrying a wiki link, and the block has to be the last thing on the page --
 * two conditions that keep this from eating a section somebody wrote by hand
 * under the same heading.
 *
 * The bullet is matched loosely on purpose. Titles contain brackets
 * (`[[Hatsune Miku - "Dreamscape" [VOCALOID2]]]`), and a stricter pattern
 * silently skipped exactly those pages while looking like it had checked them.
 */
const GENERATED_SECTION =
  /\n*## Verwandte Notizen\n+\*[^*\n]+\*\n+(?:[ \t]*[-*] [^\n]*\[\[[^\n]*\n?)+$/;

function parseArgs(argv) {
  const args = { workspace: null, apply: false, limit: Infinity, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--workspace') args.workspace = argv[++i] ?? null;
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
 * A 429 is still handled rather than assumed away: the limit is a runtime
 * setting, and a person using the application at the same time spends from the
 * same budget.
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
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  return text.length === 0 ? null : JSON.parse(text);
}

/**
 * The page's body as the write endpoint wants it back.
 *
 * The export adds two things the content itself does not carry: a frontmatter
 * block, and the title as an H1. Writing either of them back would turn
 * metadata into content, so both come off, and the H1 only when it really is
 * the title.
 */
function bodyOf(markdown, title) {
  let body = markdown;
  const frontmatter = /^---\n[\s\S]*?\n---\n/;
  body = body.replace(frontmatter, '');
  const heading = `# ${title}`;
  const trimmed = body.trimStart();
  if (trimmed.startsWith(`${heading}\n`) || trimmed === heading) {
    body = trimmed.slice(heading.length);
  }
  return body.trim();
}

/**
 * Every page of the workspace, root first.
 *
 * Asked for without `depth`, which the endpoint reads as "all of them", and
 * then flattened here. Archived pages are deliberately not included: the block
 * on a page in the trash bothers nobody, and rewriting a page somebody threw
 * away would drag it back through indexing for nothing.
 */
async function collectDocumentIds(token, workspaceId) {
  const result = await api(token, 'GET', `/api/workspaces/${workspaceId}/documents/tree`);
  const ids = [];
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      ids.push({ id: node.id, title: node.title });
      walk(node.children);
    }
  };
  walk(result.nodes);
  return ids;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (args.workspace === null && args.only === null)) {
    console.log('Usage: --workspace <id> [--only <documentId>] [--limit n] [--apply]');
    process.exit(args.help ? 0 : 1);
  }
  const token = readToken();

  const documents =
    args.only !== null
      ? [{ id: args.only, title: null }]
      : await collectDocumentIds(token, args.workspace);
  console.log(`${documents.length} Seiten im Arbeitsbereich.`);

  const stripped = [];
  const kept = [];
  let touched = 0;

  for (const document of documents) {
    if (touched >= args.limit) break;

    const exported = await api(token, 'GET', `/api/documents/${document.id}/export/markdown`);
    const title =
      document.title ?? (await api(token, 'GET', `/api/documents/${document.id}`)).title;
    const body = bodyOf(exported.markdown, title);
    if (!body.includes('## Verwandte Notizen')) continue;

    const next = body.replace(GENERATED_SECTION, '').trim();
    if (next === body) {
      // The heading is there but the shape is not: a hand-written list, or one
      // with something after it. Left exactly as it is.
      kept.push(title);
      continue;
    }

    stripped.push(title);
    touched += 1;
    if (!args.apply) continue;

    const written = await api(token, 'POST', `/api/documents/${document.id}/content`, {
      markdown: next,
      mode: 'replace',
    });

    // Read back and compare. A silent difference between what was sent and what
    // the page now holds is the one failure mode worth stopping the run for.
    const after = await api(token, 'GET', `/api/documents/${document.id}/export/markdown`);
    const actual = bodyOf(after.markdown, title);
    if (actual !== next) {
      console.error(`\nAbbruch: ${title} (${document.id}) sieht nach dem Schreiben anders aus.`);
      console.error(`Snapshot zum Zurückrollen: ${written.snapshotId}`);
      console.error(`--- erwartet ---\n${next.slice(-400)}`);
      console.error(`--- tatsächlich ---\n${actual.slice(-400)}`);
      process.exit(1);
    }
    console.log(`  ok  ${title}  (Snapshot ${written.snapshotId})`);
  }

  console.log(`\n${args.apply ? 'Entfernt' : 'Würde entfernen'}: ${stripped.length}`);
  console.log(`Unangetastet (handgeschrieben): ${kept.length}`);
  for (const title of kept) console.log(`  - ${title}`);
  if (!args.apply) console.log('\nTrockenlauf. Mit --apply wird geschrieben.');
}

await main();
