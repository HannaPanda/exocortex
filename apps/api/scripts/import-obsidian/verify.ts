// ---------------------------------------------------------------------------
// Verification (pass 6) — also runnable standalone with --verify-only
// ---------------------------------------------------------------------------

interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * Recomputes wikilink resolution statistics from the vault text alone (no
 * database access), using the same title/basename index and rewrite logic a
 * real import applies. Used by verification so the expectation is accurate
 * whether it runs right after an import or standalone via `--verify-only`.
 */
function computeExpectedWikilinkStats(notes: readonly VaultNote[]): {
  totalFound: number;
  resolved: number;
  unresolved: number;
} {
  const titleOf = buildTitleIndex(notes);
  const { byBasename } = buildBasenameIndex(notes);

  let totalFound = 0;
  let resolved = 0;
  let unresolved = 0;
  for (const note of notes) {
    const { body } = parseFrontmatter(note.raw);
    const rewritten = rewriteWikilinks(body, byBasename, titleOf);
    totalFound += rewritten.totalFound;
    resolved += rewritten.resolved;
    unresolved += rewritten.unresolvedTargets.length;
  }
  return { totalFound, resolved, unresolved };
}

function pickWord(plainText: string): string | null {
  const words = plainText
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{Letter}\p{Number}]/gu, ''))
    .filter((word) => word.length >= 5);
  return words[0] ?? null;
}

export async function runVerification(
  prisma: PrismaClient,
  vaultRoot: string,
  workspaceId: string,
  expectedFailed: number,
): Promise<{ checks: VerificationCheck[]; allPassed: boolean }> {
  const checks: VerificationCheck[] = [];
  const { notes: allNotes } = await scanVault(vaultRoot);
  const titleOf = buildTitleIndex(allNotes);

  // Every scanned note gets a page, even one whose content failed to convert
  // (phase A creates the page before phase B attempts the content, and phase
  // B falls back to an empty placeholder rather than leaving no content row
  // at all) — so the expected count is the full scan, not `scanned - failed`.
  // `expectedFailed` only affects the detail text below.
  const expectedNoteCount = allNotes.length;
  // Folder count is derived the same way import does it.
  const expectedFolderCount = collectFolderPaths(allNotes).length;

  // 1. Note page count. Folder pages carry the '📁' icon marker and notes
  // always have a null icon, so counting pages with a null icon is exact.
  // (Deliberately `icon: null`, not `icon: { not: '📁' }`: Prisma compiles
  // `not` on a nullable column to plain SQL `<>`, which — per three-valued
  // NULL logic — excludes every row where icon is actually null, i.e. every
  // note. Confirmed against the live database before relying on it.)
  const actualNoteCount = await prisma.document.count({
    where: { workspaceId, type: 'PAGE', icon: null },
  });
  checks.push({
    name: 'Note page count',
    passed: actualNoteCount === expectedNoteCount,
    detail: `expected ${expectedNoteCount} (${expectedFailed} of them content-failed placeholders), found ${actualNoteCount}`,
  });

  // 2. Folder page count.
  const folderPagesActual = await prisma.document.count({
    where: { workspaceId, type: 'PAGE', icon: '\u{1F4C1}' },
  });
  checks.push({
    name: 'Folder page count',
    passed: folderPagesActual === expectedFolderCount,
    detail: `expected ${expectedFolderCount} folder pages (icon marker), found ${folderPagesActual}`,
  });

  // 3. Every page has non-empty content. LEFT JOIN deliberately: a page with
  // no `document_content` row at all (which an INNER JOIN would silently
  // miss) is exactly as broken as one with a zero-length yjsState.
  const emptyContentCount = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*)::bigint AS count
    FROM "document" d
    LEFT JOIN "document_content" c ON c."documentId" = d.id
    WHERE d."workspaceId" = ${workspaceId} AND (c."documentId" IS NULL OR length(c."yjsState") = 0)
  `;
  const emptyCount = Number(emptyContentCount[0]?.count ?? 0);
  checks.push({
    name: 'Every page has non-empty Yjs content',
    passed: emptyCount === 0,
    detail: `${emptyCount} document(s) with an empty yjsState`,
  });

  // 4. Spot check 5 deterministic notes.
  const spotIndexes = [0, 151, 303, 455, allNotes.length - 1].filter(
    (index, position, all) =>
      index >= 0 && index < allNotes.length && all.indexOf(index) === position,
  );
  for (const index of spotIndexes) {
    const note = allNotes[index] as VaultNote;
    const title = titleOf.get(note.relativePath) as string;
    // `icon: null` (never a folder marker) disambiguates the note page from a
    // same-named folder page: a note that shares its folder's name — e.g.
    // "Watchlist/Watchlist.md" inside the "Watchlist" folder, both titled
    // "Watchlist" — would otherwise let an unordered `findFirst` return the
    // folder page instead of the note.
    const document = await prisma.document.findFirst({
      where: { workspaceId, title, type: 'PAGE', icon: null },
      select: { id: true },
    });
    if (document === null) {
      checks.push({
        name: `Spot check #${index + 1} (${note.relativePath})`,
        passed: false,
        detail: `no document titled "${title}" found`,
      });
      continue;
    }
    const content = await prisma.documentContent.findUnique({
      where: { documentId: document.id },
      select: { yjsState: true, plainText: true },
    });
    const markdown =
      content !== undefined && content !== null ? yjsStateToMarkdown(content.yjsState) : '';
    const firstLine = markdown.split('\n').find((line) => line.trim().length > 0) ?? '';
    const { body } = parseFrontmatter(note.raw);
    // A literal substring match against the raw Markdown body is too fragile:
    // the stored `plainText` is derived from ProseMirror JSON and never
    // contains Markdown syntax (`#`, `**`, `` ` ``, ...), so a sample that
    // happens to include any of it would never match even though the content
    // fully survived. Distinctive-word overlap is robust to that and still
    // verifies real content, not just structure.
    // Extract runs of letters/digits directly (rather than splitting on
    // whitespace and stripping punctuation per token): a hyphenated compound
    // like "KI-Dystopie" must become the two words "KI" and "Dystopie", not
    // the merged, hyphen-free "KIDystopie" — the latter never occurs
    // verbatim in `plainText`, which keeps the original hyphen.
    const distinctiveWords = (
      body.replace(/^#{1,6}\s+.*$/m, '').match(/[\p{Letter}\p{Number}]{6,}/gu) ?? []
    ).slice(0, 10);
    const plainNormalized = (content?.plainText ?? '').toLowerCase();
    const foundWords = distinctiveWords.filter((word) =>
      plainNormalized.includes(word.toLowerCase()),
    );
    const survived =
      distinctiveWords.length === 0 ||
      foundWords.length >= Math.ceil(distinctiveWords.length * 0.6);
    console.log(`Spot check "${title}": ${firstLine}`);
    checks.push({
      name: `Spot check #${index + 1} (${note.relativePath})`,
      passed: survived,
      detail: `title "${title}" round-tripped, ${foundWords.length}/${distinctiveWords.length} distinctive body words found in plainText`,
    });
  }

  // 5. wiki: link mark count vs. resolved. `expectedResolved` is recomputed
  // from a fresh, write-free vault scan (same title/basename index a real
  // import would build), so this check is accurate whether it runs right
  // after an import or standalone via --verify-only.
  const expectedResolved = computeExpectedWikilinkStats(allNotes).resolved;
  // Postgres's ::text cast of a `json` column preserves the exact bytes
  // Prisma's driver sent, which includes a space after every colon
  // (`"href": "wiki:..."`), not the compact form a hand-written pattern would
  // guess — confirmed against the live data before relying on it. A literal
  // (non-regex) needle is used deliberately: a `\s*` pattern here silently
  // returned 0 through Prisma's `$queryRaw` even though the identical SQL
  // returns the correct count via `psql` — some layer between Prisma's query
  // engine and Postgres mangles the backslash. Not worth chasing further
  // since the data has exactly one space, consistently, by construction.
  const wikiLinkOccurrences = await prisma.$queryRaw<Array<{ total: bigint | null }>>`
    SELECT SUM(regexp_count(c."proseMirrorJson"::text, '"href": "wiki:'))::bigint AS total
    FROM "document_content" c
    JOIN "document" d ON d.id = c."documentId"
    WHERE d."workspaceId" = ${workspaceId}
  `;
  const actualWikiLinks = Number(wikiLinkOccurrences[0]?.total ?? 0);
  const tolerance = Math.max(1, Math.ceil(expectedResolved * 0.02));
  checks.push({
    name: 'wiki: link mark count within 2% of resolved',
    passed: Math.abs(actualWikiLinks - expectedResolved) <= tolerance,
    detail: `expected ~${expectedResolved} (±${tolerance}) wiki: hrefs, found ${actualWikiLinks}`,
  });

  // 6. No document has an empty title.
  const emptyTitleCount = await prisma.document.count({ where: { workspaceId, title: '' } });
  checks.push({
    name: 'No empty titles',
    passed: emptyTitleCount === 0,
    detail: `${emptyTitleCount} document(s) with an empty title`,
  });

  // 7. Full-text search.
  if (allNotes.length > 0) {
    const firstNote = allNotes[0] as VaultNote;
    const word = pickWord(firstNote.raw);
    if (word !== null) {
      const adapter = new PostgresSearchAdapter(prisma);
      const results = await adapter.search({
        workspaceId,
        query: word,
        limit: 5,
        includeArchived: false,
      });
      checks.push({
        name: `Full-text search ("${word}")`,
        passed: results.length > 0,
        detail:
          results.length > 0
            ? `${results.length} hit(s)`
            : 'no hits — if this runs immediately after import, the worker may not have drained the queue yet; re-run --verify-only',
      });
    }
  }

  return { checks, allPassed: checks.every((check) => check.passed) };
}

export function printVerification(result: {
  checks: VerificationCheck[];
  allPassed: boolean;
}): void {
  console.log('');
  console.log('Verification:');
  for (const check of result.checks) {
    console.log(`  [${check.passed ? 'PASS' : 'FAIL'}] ${check.name} — ${check.detail}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
