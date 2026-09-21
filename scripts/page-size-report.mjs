/**
 * How big the pages in this deployment actually are (issue #118).
 *
 * The issue opens with a census -- 1,478 pages, 43 over ten thousand
 * characters, one at 2.9 million -- and every decision in it rests on those
 * numbers. This is that census, so the next person does not have to write the
 * SQL again and, more to the point, can ask a month later whether the shape
 * changed.
 *
 *   node scripts/page-size-report.mjs
 *   node scripts/page-size-report.mjs --workspace <id>
 *   node scripts/page-size-report.mjs --top 20
 *
 * Archived pages are left out: what this is about is what an agent can be
 * handed, and the issue's own figure of 1,478 counted them, so the totals are
 * not directly comparable. The buckets are.
 *
 * It reads `document_content.markdown`, which is derived and may lag a save by
 * seconds (ADR-005). That is fine for a census and wrong for a decision about
 * one page: an agent write is measured against `effectiveMarkdown` instead
 * (ADR-057), never against this column.
 *
 * Read-only. It writes nothing, changes nothing and takes no `--apply`.
 */
import { createPrismaClient } from '../packages/database/dist/index.js';

/** The thresholds the issue and ADR-056/057 argue in. */
const BUCKETS = [
  { label: 'über 2.400 Zeichen (Passagen-Vektoren, ADR-034)', min: 2_400 },
  { label: 'über 10.000 Zeichen (Karte statt Text, ADR-056)', min: 10_000 },
  { label: 'über 15.000 Zeichen (Warnung beim Schreiben, ADR-057)', min: 15_000 },
  { label: 'über 50.000 Zeichen (Wachstum verweigert, ADR-057)', min: 50_000 },
  { label: 'über 500.000 Zeichen', min: 500_000 },
];

function parseArgs(argv) {
  const args = { workspaceId: null, top: 10, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--workspace') args.workspaceId = argv[++i] ?? null;
    else if (flag === '--top') args.top = Number(argv[++i] ?? '10');
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

function german(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node scripts/page-size-report.mjs [--workspace <id>] [--top <n>]');
    return;
  }

  const prisma = createPrismaClient();
  try {
    const rows = await prisma.documentContent.findMany({
      where: {
        markdown: { not: null },
        document: {
          is: {
            type: 'PAGE',
            archivedAt: null,
            ...(args.workspaceId === null ? {} : { workspaceId: args.workspaceId }),
          },
        },
      },
      select: {
        markdown: true,
        document: { select: { id: true, title: true, workspaceId: true } },
      },
    });

    const pages = rows
      .map((row) => ({
        id: row.document.id,
        title: row.document.title,
        workspaceId: row.document.workspaceId,
        chars: row.markdown?.length ?? 0,
      }))
      .filter((page) => page.chars > 0)
      .sort((left, right) => right.chars - left.chars);

    if (pages.length === 0) {
      console.log('Keine Seiten mit Inhalt gefunden.');
      return;
    }

    const total = pages.reduce((sum, page) => sum + page.chars, 0);
    const ascending = [...pages].map((page) => page.chars).reverse();

    console.log(`Seiten mit Inhalt: ${german(pages.length)}`);
    console.log(`Zeichen insgesamt: ${german(total)}`);
    console.log(`Schnitt: ${german(Math.round(total / pages.length))}`);
    console.log(`Median: ${german(percentile(ascending, 0.5))}`);
    console.log(`95. Perzentil: ${german(percentile(ascending, 0.95))}`);
    console.log(`Größte Seite: ${german(pages[0].chars)}`);
    console.log('');

    for (const bucket of BUCKETS) {
      const count = pages.filter((page) => page.chars > bucket.min).length;
      const share = ((count / pages.length) * 100).toFixed(1);
      console.log(`${bucket.label}: ${german(count)} (${share} %)`);
    }
    console.log('');

    console.log(`Die ${String(args.top)} größten:`);
    for (const page of pages.slice(0, args.top)) {
      console.log(`  ${german(page.chars).padStart(10)}  ${page.title} (${page.id})`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

await main();
