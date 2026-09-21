import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canEditDocument, WorkspaceAccessService } from '@exocortex/auth';
import {
  type BlockRangeEdit,
  type DocumentSummary,
  type ExtractSectionRequest,
  type ExtractSectionResponse,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import {
  type AppliedBlockRange,
  applyBlockRangeEditToState,
  BLOCK_ID_ATTRIBUTE,
  BlockRangeError,
  copyDocumentForNewPage,
  createBlockId,
  type ExtractableSection,
  type ProseMirrorDocument,
  proseMirrorJsonToYjsState,
  resolvePageLinkTitles,
  resolveSectionExtraction,
  serializeMarkdown,
  titleForSection,
  yjsStateToProseMirrorJson,
} from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform.module';

import { DOCUMENT_SELECT, toSummary } from './document-shape';
import { DocumentWriteCommitService } from './document-write-commit.service';
import { DocumentsService } from './documents.service';
import { PageLinkIdentityService } from './page-link-identity.service';

/** The stored content a move reads and writes back. */
interface StoredContent {
  yjsState: Uint8Array;
  schemaVersion: number;
  yjsUpdatedAt: Date;
}

/**
 * Moving a section onto its own page (issue #118).
 *
 * The other half of reading a page as a map. A map tells an agent what is on a
 * page and what each part costs; this is what it can then *do* about a part
 * that has outgrown the page it sits on. Until now that took six calls -- read
 * the page, create the child, write the content, read the page again, write it
 * back without the section, fix the link -- and carried the whole page through
 * the context twice, which makes appending the cheap move and splitting the
 * expensive one. That is the wrong way round for a system whose pages grow.
 *
 * Three deliberate decisions:
 *
 * The address is the one the map hands out, so navigating and acting speak the
 * same language and a section found in a map can be moved without a second
 * lookup.
 *
 * The heading stays behind when something stands in the section's place. It is
 * the address the caller named and the source page's outline is built from it;
 * a link or a transclusion goes underneath, so the page still reads as it did
 * and the map of it still lists the section, now as one line. Only `remove`
 * takes the heading too, because a heading over nothing is worse than no
 * heading.
 *
 * The content travels as canonical state, never as Markdown: it is copied out
 * of the page's own Yjs state with fresh block identifiers (ADR-039), so
 * callouts, columns, embedded databases and transclusions survive the move,
 * and no identifier exists twice afterwards.
 */
@Injectable()
export class DocumentSectionExtractService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly commits: DocumentWriteCommitService,
    private readonly pageLinks: PageLinkIdentityService,
    private readonly documents: DocumentsService,
  ) {}

  async extract(input: {
    documentId: string;
    userId: string;
    request: ExtractSectionRequest;
    correlationId: string;
    source: 'api' | 'ai';
  }): Promise<ExtractSectionResponse> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canEditDocument(context.role, context.document));

    const existing = await this.load(input.documentId);
    if (
      input.request.expectedYjsUpdatedAt !== undefined &&
      input.request.expectedYjsUpdatedAt !== existing.yjsUpdatedAt.toISOString()
    ) {
      throw new AppError('document_content_conflict', 'The document changed since it was read');
    }

    const identities = await this.pageLinks.loadIndex(context.workspaceId);
    const page = resolvePageLinkTitles(yjsStateToProseMirrorJson(existing.yjsState), (documentId) =>
      identities.titleFor(documentId),
    );

    const section = this.resolve(page, input.request);
    const moving = section.heading === null ? section.content : section.body;
    if (moving === null || (moving.content ?? []).length === 0) {
      throw AppError.validation(
        'This section holds nothing but its heading, so there is nothing to move',
      );
    }

    const keepsHeading = section.heading !== null && input.request.replacement !== 'remove';
    const range = keepsHeading ? section.bodyRange : section.range;
    if (range === null) {
      throw new AppError(
        'document_block_range_invalid',
        'The blocks of this section carry no identifiers, so they cannot be written over',
      );
    }
    if (input.request.replacement === 'remove' && section.wholePage) {
      throw AppError.validation(
        'This is the whole page; removing it would leave no content. ' +
          'Use link or transclusion, or move the page itself',
      );
    }

    const warnings: string[] = [];
    const copy = copyDocumentForNewPage(moving);
    if (copy.attachmentIds.length > 0) {
      warnings.push('Die Dateien des Abschnitts gehören weiterhin zur Quellseite.');
    }
    if (copy.embeddedDatabaseIds.length > 0) {
      warnings.push('Eingebettete Datenbanken zeigen weiterhin auf dieselbe Datenbank.');
    }

    const title = input.request.title ?? titleForSection(section);
    const target = await this.place({
      copy: copy.document,
      title,
      request: input.request,
      context: { workspaceId: context.workspaceId, sourceDocumentId: input.documentId },
      userId: input.userId,
      correlationId: input.correlationId,
      source: input.source,
    });

    const replacement = this.replacementFor(input.request.replacement, target.id, target.title);
    const committed = await this.write({
      documentId: input.documentId,
      workspaceId: context.workspaceId,
      userId: input.userId,
      correlationId: input.correlationId,
      source: input.source,
      existing,
      content: replacement,
      range,
      /*
       * The new page exists at this point. Saying so in the refusal is the
       * difference between a caller that can finish the move by hand and one
       * that creates a second copy trying again.
       */
      onFailure: target.id,
    });

    this.logger.info('Section moved onto its own page', {
      documentId: input.documentId,
      targetDocumentId: target.id,
      created: target.created,
      blocks: (moving.content ?? []).length,
      replacement: input.request.replacement,
      correlationId: input.correlationId,
    });

    return {
      document: target.summary,
      created: target.created,
      sourceDocumentId: input.documentId,
      heading: section.heading === null ? null : section.heading.text,
      movedBlocks: (moving.content ?? []).length,
      movedChars: serializeMarkdown(moving).length,
      replacement: input.request.replacement,
      snapshotId: committed.snapshotId,
      yjsUpdatedAt: committed.yjsUpdatedAt,
      appliedToLiveSession: committed.appliedToLiveSession,
      warnings: [...warnings, ...committed.warnings],
    };
  }

  private async load(documentId: string): Promise<StoredContent> {
    const content = await this.prisma.documentContent.findUnique({
      where: { documentId },
      select: { yjsState: true, schemaVersion: true, yjsUpdatedAt: true },
    });
    if (content === null) throw AppError.notFound('Document content');
    return {
      yjsState: content.yjsState as Uint8Array,
      schemaVersion: content.schemaVersion,
      yjsUpdatedAt: content.yjsUpdatedAt,
    };
  }

  /** The addressed blocks, or the refusal in the API's vocabulary. */
  private resolve(page: ProseMirrorDocument, request: ExtractSectionRequest): ExtractableSection {
    const resolved = resolveSectionExtraction(page, request.blockId, request.toBlockId ?? null);
    if (resolved.ok) return resolved.value;

    const details = { blockId: resolved.blockId };
    if (resolved.reason === 'block_not_found') {
      throw new AppError(
        'document_block_not_found',
        'No block on this page carries that identifier',
        details,
      );
    }
    throw new AppError(
      'document_block_range_invalid',
      resolved.reason === 'block_range_not_siblings'
        ? 'The two blocks are not beside each other, so they describe no section'
        : resolved.reason === 'block_range_inverted'
          ? 'The end of the section sits before its start'
          : 'The last block of this section has no identifier',
      details,
    );
  }

  /** Where the section lands: a new child page, or the end of an existing one. */
  private async place(input: {
    copy: ProseMirrorDocument;
    title: string;
    request: ExtractSectionRequest;
    context: { workspaceId: string; sourceDocumentId: string };
    userId: string;
    correlationId: string;
    source: 'api' | 'ai';
  }): Promise<{ id: string; title: string; created: boolean; summary: DocumentSummary }> {
    if (input.request.targetDocumentId === undefined) {
      const created = await this.documents.create({
        workspaceId: input.context.workspaceId,
        userId: input.userId,
        request: {
          type: 'PAGE',
          title: input.title,
          parentId: input.request.parentId ?? input.context.sourceDocumentId,
        },
        correlationId: input.correlationId,
        initialYjsState: proseMirrorJsonToYjsState(input.copy),
      });
      return { id: created.id, title: created.title, created: true, summary: created };
    }

    const target = await this.access.requireDocumentContext(
      input.request.targetDocumentId,
      input.userId,
    );
    assertPolicy(canEditDocument(target.role, target.document));
    if (target.workspaceId !== input.context.workspaceId) {
      throw new AppError(
        'document_cross_workspace',
        'The target page belongs to a different workspace',
      );
    }

    const existing = await this.load(input.request.targetDocumentId);
    const lastBlockId = this.lastBlockIdOf(yjsStateToProseMirrorJson(existing.yjsState));
    if (lastBlockId === null) {
      throw new AppError(
        'document_block_range_invalid',
        'The target page carries no block identifiers, so nothing can be appended to it',
      );
    }

    await this.write({
      documentId: input.request.targetDocumentId,
      workspaceId: target.workspaceId,
      userId: input.userId,
      correlationId: input.correlationId,
      source: input.source,
      existing,
      content: input.copy,
      range: { fromBlockId: lastBlockId, toBlockId: null, placement: 'after' },
      onFailure: null,
    });

    const row = await this.prisma.document.findUniqueOrThrow({
      where: { id: input.request.targetDocumentId },
      select: DOCUMENT_SELECT,
    });
    const summary = toSummary(row);
    return { id: summary.id, title: summary.title, created: false, summary };
  }

  /** The identifier of the page's last top-level block, for an append. */
  private lastBlockIdOf(document: ProseMirrorDocument): string | null {
    const blocks = document.content ?? [];
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const value: unknown = blocks[index]?.attrs?.[BLOCK_ID_ATTRIBUTE];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return null;
  }

  /** What stands where the section stood. An empty document deletes the range. */
  private replacementFor(
    replacement: ExtractSectionRequest['replacement'],
    documentId: string,
    title: string,
  ): ProseMirrorDocument {
    if (replacement === 'remove') return { type: 'doc', content: [] };
    if (replacement === 'transclusion') {
      return {
        type: 'doc',
        content: [
          {
            type: 'transclusion',
            // The whole page, because the whole section moved there: a
            // reader sees exactly what stood here before (ADR-045).
            attrs: {
              [BLOCK_ID_ATTRIBUTE]: createBlockId(),
              documentId,
              label: title,
              sourceBlockId: null,
            },
          },
        ],
      };
    }
    return {
      type: 'doc',
      content: [
        { type: 'pageLink', attrs: { [BLOCK_ID_ATTRIBUTE]: createBlockId(), documentId, title } },
      ],
    };
  }

  /** One ranged write, committed the way every other write is. */
  private async write(input: {
    documentId: string;
    workspaceId: string;
    userId: string;
    correlationId: string;
    source: 'api' | 'ai';
    existing: StoredContent;
    content: ProseMirrorDocument;
    range: BlockRangeEdit;
    onFailure: string | null;
  }): Promise<{
    snapshotId: string;
    yjsUpdatedAt: string;
    appliedToLiveSession: boolean;
    warnings: string[];
  }> {
    let applied: AppliedBlockRange;
    try {
      applied = applyBlockRangeEditToState(input.existing.yjsState, input.content, input.range);
    } catch (error) {
      throw this.refusal(error, input.onFailure);
    }

    return this.commits.commit({
      documentId: input.documentId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      correlationId: input.correlationId,
      source: input.source,
      previous: { yjsState: input.existing.yjsState, schemaVersion: input.existing.schemaVersion },
      applied,
      markdown: serializeMarkdown(applied.proseMirrorJson),
      promotedTitle: null,
      live: { mode: 'replace', proseMirrorJson: input.content, edit: input.range },
    });
  }

  /** A failed edit, with the page that was already created named. */
  private refusal(error: unknown, createdDocumentId: string | null): unknown {
    const details = createdDocumentId === null ? {} : { createdDocumentId };
    const suffix =
      createdDocumentId === null
        ? ''
        : '. Die neue Seite wurde bereits angelegt und enthält den Abschnitt';
    if (error instanceof BlockRangeError) {
      return new AppError('document_block_range_invalid', `${error.message}${suffix}`, {
        ...details,
        blockId: error.blockId,
      });
    }
    return error instanceof Error
      ? AppError.validation(`${error.message}${suffix}`, details)
      : error;
  }
}
