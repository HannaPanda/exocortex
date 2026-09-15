import { type PrismaClient } from '@exocortex/database';

/**
 * The page a refresh is about, read once (issue #53, ADR-028).
 *
 * One query for everything the processor needs to decide what to do: what the
 * page is, what its parent is, what it already has, and how much of its own
 * text may reach a prompt. Split out of the processor so the decision logic
 * there reads as decisions rather than as a select.
 */

export interface OverviewPage {
  id: string;
  workspaceId: string;
  title: string;
  parentId: string | null;
  parentTitle: string | null;
  isOverview: boolean;
  parentIsOverview: boolean;
  /** The page's own body, already capped at `overview.maxPageChars`. */
  ownText: string;
  hasCover: boolean;
  /** Who last touched the page; the cover job acts as that person. */
  updatedById: string;
  summary: string | null;
  summaryInputHash: string | null;
  intro: string | null;
  introInputHash: string | null;
  /** True once a cover has been offered for this page, successful or not. */
  coverAsked: boolean;
}

export async function readOverviewPage(
  prisma: PrismaClient,
  documentId: string,
  maxPageChars: number,
): Promise<OverviewPage | null> {
  const row = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      parentId: true,
      overviewMode: true,
      coverAttachmentId: true,
      updatedById: true,
      archivedAt: true,
      parent: { select: { title: true, overviewMode: true } },
      content: { select: { markdown: true } },
      digest: {
        select: {
          summary: true,
          summaryInputHash: true,
          intro: true,
          introInputHash: true,
          coverAskedAt: true,
        },
      },
    },
  });
  // An archived page is read-only everywhere else, and an overview of pages
  // nobody can reach is not worth a model call.
  if (row === null || row.archivedAt !== null) return null;

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    parentId: row.parentId,
    parentTitle: row.parent?.title ?? null,
    isOverview: row.overviewMode === 'AUTO',
    parentIsOverview: row.parent?.overviewMode === 'AUTO',
    ownText: (row.content?.markdown ?? '').slice(0, maxPageChars),
    hasCover: row.coverAttachmentId !== null,
    updatedById: row.updatedById,
    summary: row.digest?.summary ?? null,
    summaryInputHash: row.digest?.summaryInputHash ?? null,
    intro: row.digest?.intro ?? null,
    introInputHash: row.digest?.introInputHash ?? null,
    coverAsked: row.digest?.coverAskedAt != null,
  };
}

/** How much of the composition describes the picture. A prompt, not an essay. */
const MAX_COVER_THEME_CHARS = 300;

/**
 * The prompt an overview page's cover is drawn from.
 *
 * Built from the composition rather than from the title alone, because "Technik"
 * is not a picture and "Server, Netzwerk und die Geräte im Haus" is. Returns
 * `null` while there is no composition yet: a cover drawn from a title with no
 * context is a stock photo, and the page is better off waiting one refresh.
 *
 * No text in the image, on purpose. Every image model spells badly, and a cover
 * with a misspelt page title on it is worse than one with no words at all.
 */
export function coverPromptFor(page: OverviewPage): string | null {
  const theme = page.intro?.trim();
  if (theme === undefined || theme.length === 0) return null;

  return [
    `Ruhiges, abstraktes Titelbild für die Übersichtsseite „${page.title}" eines persönlichen Wissensspeichers.`,
    `Thema der Seite: ${theme.slice(0, MAX_COVER_THEME_CHARS)}`,
    'Breites Banner, gedeckte Farben, viel Ruhe, keine Menschen, keine Marken.',
    'Enthalte keinerlei Schrift, Buchstaben, Zahlen oder Logos im Bild.',
  ].join(' ');
}
