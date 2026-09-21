import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canEditDocument, WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  type DocumentContentWriteRequest,
  type DocumentContentWriteResponse,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import {
  type AppliedDocumentState,
  applyProseMirrorDocumentToState,
  bindPageLinkIdentities,
  collectForeignMediaSources,
  EXOCORTEX_SCHEMA_VERSION,
  leadingTitleHeading,
  parseMarkdown,
  type ProseMirrorDocument,
  type ProseMirrorNode,
  resolvePageLinkTitles,
  serializeMarkdown,
  stripRedundantTitleHeading,
  yjsStateToProseMirrorJson,
} from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { API_ENV, LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform.module';

import { DocumentWriteCommitService } from './document-write-commit.service';
import { PageLinkIdentityService } from './page-link-identity.service';

/** The title `createDocumentRequestSchema` gives a page nobody has named. */
const UNTITLED_PAGE_TITLE = 'Unbenannte Seite';

/** `documentTitleSchema`'s ceiling, applied to a title taken from content. */
const DOCUMENT_TITLE_MAX_LENGTH = 300;

interface IncomingMarkdown {
  /** What is written, with a heading that only repeated the title taken out. */
  markdown: string;
  /** A title taken from that heading, when the page had none. */
  promotedTitle: string | null;
  /** What to tell the writer about either, `null` when nothing happened. */
  warning: string | null;
}

/**
 * Prepares the Markdown that arrives with a write.
 *
 * The page's title is metadata, and the Markdown serializer writes it into the
 * frontmatter rather than as a heading. A writer that opens the body with the
 * title once more -- which is what every Markdown file outside this product
 * looks like, and therefore what language models produce -- would put it on the
 * page twice, so that one heading comes off.
 *
 * On a page nobody has named yet the same heading is the best title anyone has,
 * so it is promoted instead of dropped and the page ends up carrying it exactly
 * once. The candidate is only kept when the heading was really removed;
 * otherwise the title and the heading would both be there again.
 *
 * Only content that lands at the top is examined: on `append` the first heading
 * belongs to what is already on the page, and editing that would be a change
 * nobody asked for.
 */
function prepareIncomingMarkdown(
  request: DocumentContentWriteRequest,
  currentTitle: string,
): IncomingMarkdown {
  if (request.mode === 'append') {
    return { markdown: request.markdown, promotedTitle: null, warning: null };
  }

  const candidateTitle =
    currentTitle.trim() === UNTITLED_PAGE_TITLE ? leadingTitleHeading(request.markdown) : null;
  const { markdown, removed } = stripRedundantTitleHeading(
    request.markdown,
    candidateTitle ?? currentTitle,
  );
  if (removed === null) {
    return { markdown, promotedTitle: null, warning: null };
  }

  if (candidateTitle !== null) {
    const promotedTitle = candidateTitle.slice(0, DOCUMENT_TITLE_MAX_LENGTH);
    return {
      markdown,
      promotedTitle,
      warning:
        `Die Seite hatte noch keinen Titel; die erste Überschrift „${promotedTitle}“ ist jetzt ` +
        'der Seitentitel und steht nicht mehr im Text.',
    };
  }

  return {
    markdown,
    promotedTitle: null,
    warning:
      `Die erste Überschrift „${removed}“ wiederholte den Seitentitel und wurde weggelassen; ` +
      'der Titel steht bereits über der Seite.',
  };
}

/** Depth-first search for a `databaseEmbed` node (D8, mirrors collectImageSources). */
function containsDatabaseEmbed(node: ProseMirrorNode | null | undefined): boolean {
  if (node === null || node === undefined) return false;
  if (node.type === 'databaseEmbed') return true;
  return (node.content ?? []).some((child) => containsDatabaseEmbed(child));
}

/** German names for the media types the same-origin policy restricts. */
const MEDIA_TYPE_LABELS: Readonly<Record<string, string>> = {
  image: 'Bild',
  video: 'Video',
  audio: 'Audio',
  pdf: 'PDF',
};

/**
 * The warning a write earns by pointing at a file on somebody else's host
 * (issue #117).
 *
 * The write itself stands. Refusing it would be worse than the broken image it
 * prevents: an address that cannot be loaded *here* is still an address, and
 * this is not the place to decide that nobody may write one down. But a write
 * response has a warnings channel, and a picture that will never appear with
 * nothing anywhere saying why is exactly what it is for.
 *
 * The sentence names the way out rather than only the problem, because the
 * reader is usually an agent that has no other way to learn it.
 */
export function foreignMediaWarnings(document: ProseMirrorDocument, origin: string): string[] {
  const foreign = collectForeignMediaSources(document, origin);
  if (foreign.length === 0) return [];

  const named = foreign
    .slice(0, 3)
    .map((entry) => `${MEDIA_TYPE_LABELS[entry.type] ?? entry.type}: ${entry.src}`)
    .join(', ');
  const rest = foreign.length > 3 ? ` (und ${foreign.length - 3} weitere)` : '';

  return [
    `Diese Seite verweist auf ${foreign.length === 1 ? 'eine Datei' : `${foreign.length} Dateien`} ` +
      `auf einem fremden Server: ${named}${rest}. Der Browser lädt das nicht, die Stelle bleibt ` +
      'leer. Lade die Datei stattdessen als Anhang hoch (exo_attachment_upload, oder ' +
      'exo_attachment_upload_url, wenn du nur die Adresse hast) und verweise auf ' +
      '/api/attachments/<id>/download.',
  ];
}

/**
 * Writes Markdown into an existing document's canonical Yjs state (D8).
 *
 * Used by humans through `POST /api/documents/:id/content` and by the built-in
 * AI / MCP tools (`source: 'ai'`). Every write snapshots the previous state
 * first, so it is always revertable, and refuses to lose a `databaseEmbed`
 * reference silently (R6).
 *
 * The write lands in the database, and then — because a page somebody has open
 * is served from the collaboration server's memory, not from the database — the
 * same change is handed to that server so the open session carries it too
 * (ADR-016). Without that second step the change would be invisible until a
 * reload, and the session's next autosave would write its stale copy back over
 * it.
 */
@Injectable()
export class DocumentContentService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly access: WorkspaceAccessService,
    private readonly commits: DocumentWriteCommitService,
    private readonly pageLinks: PageLinkIdentityService,
  ) {}

  async write(input: {
    documentId: string;
    userId: string;
    request: DocumentContentWriteRequest;
    correlationId: string;
    /** 'api' for humans, 'ai' for the built-in assistant / MCP. Recorded in the event. */
    source: 'api' | 'ai';
  }): Promise<DocumentContentWriteResponse> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canEditDocument(context.role, context.document));

    const existing = await this.prisma.documentContent.findUnique({
      where: { documentId: input.documentId },
      select: { yjsState: true, schemaVersion: true, yjsUpdatedAt: true, proseMirrorJson: true },
    });
    if (existing === null) throw AppError.notFound('Document content');

    if (
      input.request.expectedYjsUpdatedAt !== undefined &&
      input.request.expectedYjsUpdatedAt !== existing.yjsUpdatedAt.toISOString()
    ) {
      throw new AppError(
        'document_content_conflict',
        'The document changed since it was last read',
      );
    }

    const hasEmbed = containsDatabaseEmbed(existing.proseMirrorJson as ProseMirrorNode | null);
    const warnings: string[] = [];

    if (input.request.mode !== 'replace' && hasEmbed) {
      throw new AppError(
        'document_content_lossy',
        'Appending would drop the database embeds on this page',
      );
    }
    if (input.request.mode === 'replace' && hasEmbed) {
      warnings.push('Die Seite enthielt eingebettete Datenbanken; diese wurden ersetzt.');
    }

    /*
     * A write goes through Markdown, and Markdown carries no identities: every
     * reference on the page is written as `[[Titel]]` and read back in. Both
     * halves therefore run through the identity index (issue #14) — the
     * existing content is serialized from the titles its targets carry *now*,
     * so the titles that go out are the titles that come back and bind to the
     * same pages. Without that, appending a paragraph would silently strip the
     * identity from every reference already on the page.
     */
    const identities = await this.pageLinks.loadIndex(context.workspaceId);
    const currentMarkdown = serializeMarkdown(
      resolvePageLinkTitles(yjsStateToProseMirrorJson(existing.yjsState), (documentId) =>
        identities.titleFor(documentId),
      ),
    );
    const incoming = prepareIncomingMarkdown(input.request, context.document.title);
    if (incoming.warning !== null) warnings.push(incoming.warning);

    const effectiveMarkdown =
      input.request.mode === 'replace'
        ? incoming.markdown
        : input.request.mode === 'append'
          ? `${currentMarkdown}\n\n${incoming.markdown}`
          : `${incoming.markdown}\n\n${currentMarkdown}`;

    let applied: AppliedDocumentState;
    /**
     * What an open session has to be told. For `replace` that is the finished
     * document; for `append` and `prepend` it is only the incoming Markdown, so
     * the session inserts those nodes instead of rewriting a fragment somebody
     * may be typing in right now.
     */
    let liveUpdate: ProseMirrorDocument;
    try {
      const bind = (document: ProseMirrorDocument): ProseMirrorDocument =>
        bindPageLinkIdentities(document, (title) => identities.identityFor(title));
      liveUpdate = bind(parseMarkdown(incoming.markdown).document);
      /*
       * The stored state is *edited*, never rebuilt from the Markdown: the same
       * edit the open session is handed below is applied to the same document
       * here, so both sides stay one document with one history (ADR-004/005).
       * Storing freshly built state instead would read back correctly and still
       * lose the page later -- a copy of the previous document merges as an
       * unrelated one and Yjs keeps both halves. See
       * `applyProseMirrorDocumentToState`.
       */
      applied = applyProseMirrorDocumentToState(existing.yjsState, liveUpdate, input.request.mode);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn('Document content write rejected: markdown could not be parsed', {
        documentId: input.documentId,
        correlationId: input.correlationId,
        reason,
      });
      // The reason travels back to the caller. It names a node type and at most
      // a few characters of the content the caller just sent -- which it wrote
      // and may read -- so it discloses nothing, and without it a rejection is
      // unanswerable: the only way to narrow it down is to send smaller and
      // smaller writes until it stops happening (issue #82).
      throw AppError.validation('The Markdown document could not be parsed', { reason });
    }

    // What this write brought in, not what the page already carried: a page
    // that has had a broken image on it for a month would otherwise warn on
    // every append, and the warning would stop being read.
    warnings.push(...foreignMediaWarnings(liveUpdate, this.env.APP_URL));

    const committed = await this.commits.commit({
      documentId: input.documentId,
      workspaceId: context.workspaceId,
      userId: input.userId,
      correlationId: input.correlationId,
      source: input.source,
      previous: { yjsState: existing.yjsState, schemaVersion: existing.schemaVersion },
      applied,
      markdown: effectiveMarkdown,
      promotedTitle: incoming.promotedTitle,
      live: { mode: input.request.mode, proseMirrorJson: liveUpdate },
    });
    warnings.push(...committed.warnings);

    return {
      documentId: input.documentId,
      snapshotId: committed.snapshotId,
      yjsUpdatedAt: committed.yjsUpdatedAt,
      schemaVersion: EXOCORTEX_SCHEMA_VERSION,
      byteSize: applied.yjsState.byteLength,
      appliedToLiveSession: committed.appliedToLiveSession,
      warnings,
    };
  }
}
