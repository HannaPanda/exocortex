import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canEditDocument, WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  type BlockRangeEdit,
  type DocumentBlockWriteRequest,
  type DocumentGranularWriteResponse,
  type DocumentPatchRequest,
  type DocumentSectionWriteRequest,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import {
  type AppliedBlockRange,
  applyBlockRangeEditToState,
  bindPageLinkIdentities,
  BlockRangeError,
  EXOCORTEX_SCHEMA_VERSION,
  type PageEditResult,
  type PageIdentityLookup,
  parseMarkdown,
  type PatchEdit,
  type ProseMirrorDocument,
  resolvePageLinkTitles,
  resolvePatchEdits,
  resolveSectionEdit,
  serializeMarkdown,
  yjsStateToProseMirrorJson,
} from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { API_ENV, LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';

import { foreignMediaWarnings } from './document-content.service';
import { assertExpectedRevision } from './document-revision';
import { DocumentWriteCommitService } from './document-write-commit.service';
import { judgePageGrowth, oversizedPageRefusal, pageGrowthLimits } from './page-growth-policy';
import { PageLinkIdentityService } from './page-link-identity.service';

/** What `apply` needs, whichever entrance asked for it. */
interface NarrowWrite {
  documentId: string;
  userId: string;
  correlationId: string;
  source: 'api' | 'ai';
  expectedYjsUpdatedAt: string | undefined;
  /** Given the page as it stands, the edits to carry out. */
  resolve: (page: ProseMirrorDocument) => PageEditResult<PatchEdit[]>;
}

/** What a preview answers: the page before and after, and the revision it was read at. */
export interface WritePreview {
  workspaceId: string;
  revision: Date;
  before: ProseMirrorDocument;
  after: ProseMirrorDocument;
}

interface PreparedWrite {
  workspaceId: string;
  existing: { yjsState: Uint8Array; schemaVersion: number; yjsUpdatedAt: Date };
  edits: readonly PatchEdit[];
  contents: ProseMirrorDocument[];
  applied: AppliedBlockRange;
  blockIds: string[];
  warnings: string[];
  markdown: string;
}

/** A block write as the one ranged edit it is. */
function blockEdit(request: DocumentBlockWriteRequest): PatchEdit {
  const edit: BlockRangeEdit = {
    fromBlockId: request.blockId,
    toBlockId: null,
    placement:
      request.mode === 'replace' ? 'replace' : request.mode === 'append' ? 'after' : 'before',
  };
  return { edit, markdown: request.markdown, replacements: 1 };
}

/** A section write, resolved against the page by its heading. */
function sectionEdits(
  page: ProseMirrorDocument,
  request: DocumentSectionWriteRequest,
): PageEditResult<PatchEdit[]> {
  const resolved = resolveSectionEdit(page, request.heading, request.mode);
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    value: [{ edit: resolved.value, markdown: request.markdown, replacements: 1 }],
  };
}

/**
 * Writes that change part of a page and leave the rest alone (issue #111).
 *
 * `DocumentContentService` is the whole-page write: it takes the Markdown a
 * page should have and installs it. That is the right shape for "write this
 * page" and the wrong shape for "change this line", which is most of what an
 * agent does. A one-line change through it costs the whole page in tokens on
 * the way out and on the way back, and it regenerates every block identifier on
 * the page in passing, because a `replace` deletes the fragment and inserts a
 * new one.
 *
 * Here the page is read, the blocks the caller means are worked out, and only
 * those are swapped. Everything else keeps its identifier, its position and any
 * edit that landed on it while this request was in flight, which is also what
 * makes two agents on one page merge instead of overwrite.
 *
 * Three entrances, one mechanism: a block is addressed directly, a section
 * through its heading, a patch through the page's own Markdown. All three
 * become a `BlockRangeEdit` and go through `apply`.
 */
@Injectable()
export class DocumentEditService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly access: WorkspaceAccessService,
    private readonly commits: DocumentWriteCommitService,
    private readonly pageLinks: PageLinkIdentityService,
    private readonly settings: SettingsService,
  ) {}

  /** Replaces one block, or inserts beside it. */
  async writeBlock(input: {
    documentId: string;
    userId: string;
    request: DocumentBlockWriteRequest;
    correlationId: string;
    source: 'api' | 'ai';
  }): Promise<DocumentGranularWriteResponse> {
    return this.apply({
      ...input,
      expectedYjsUpdatedAt: input.request.expectedYjsUpdatedAt,
      resolve: () => ({ ok: true, value: [blockEdit(input.request)] }),
    });
  }

  /** Writes under a heading, without touching the rest of the page. */
  async writeSection(input: {
    documentId: string;
    userId: string;
    request: DocumentSectionWriteRequest;
    correlationId: string;
    source: 'api' | 'ai';
  }): Promise<DocumentGranularWriteResponse> {
    return this.apply({
      ...input,
      expectedYjsUpdatedAt: input.request.expectedYjsUpdatedAt,
      resolve: (page) => sectionEdits(page, input.request),
    });
  }

  /** Replaces a piece of text, refusing anything that is not unambiguous. */
  async patch(input: {
    documentId: string;
    userId: string;
    request: DocumentPatchRequest;
    correlationId: string;
    source: 'api' | 'ai';
  }): Promise<DocumentGranularWriteResponse> {
    return this.apply({
      ...input,
      expectedYjsUpdatedAt: input.request.expectedYjsUpdatedAt,
      resolve: (page) => resolvePatchEdits(page, input.request),
    });
  }

  /**
   * What a narrow write would make of the page, without writing it (issue
   * #141): the page before and after, and the revision it was computed on.
   * Runs exactly the resolution, parse and growth checks the write runs, so a
   * proposal that previews cleanly is refused later only because its page moved.
   */
  async preview(input: {
    documentId: string;
    userId: string;
    kind: 'block' | 'section' | 'patch';
    request: DocumentBlockWriteRequest | DocumentSectionWriteRequest | DocumentPatchRequest;
    correlationId: string;
  }): Promise<WritePreview> {
    const narrow = this.narrowWrite(input);
    const prepared = await this.prepare(narrow);
    return {
      workspaceId: prepared.workspaceId,
      revision: prepared.existing.yjsUpdatedAt,
      before: yjsStateToProseMirrorJson(prepared.existing.yjsState),
      after: prepared.applied.proseMirrorJson,
    };
  }

  /** The same three entrances, chosen by name; what a changeset stores and replays. */
  async writeByKind(input: {
    documentId: string;
    userId: string;
    kind: 'block' | 'section' | 'patch';
    request: DocumentBlockWriteRequest | DocumentSectionWriteRequest | DocumentPatchRequest;
    correlationId: string;
    source: 'api' | 'ai';
  }): Promise<DocumentGranularWriteResponse> {
    switch (input.kind) {
      case 'block':
        return this.writeBlock({ ...input, request: input.request as DocumentBlockWriteRequest });
      case 'section':
        return this.writeSection({
          ...input,
          request: input.request as DocumentSectionWriteRequest,
        });
      default:
        return this.patch({ ...input, request: input.request as DocumentPatchRequest });
    }
  }

  /** The resolver each entrance stands for, for a preview. */
  private narrowWrite(input: {
    documentId: string;
    userId: string;
    kind: 'block' | 'section' | 'patch';
    request: DocumentBlockWriteRequest | DocumentSectionWriteRequest | DocumentPatchRequest;
    correlationId: string;
  }): NarrowWrite {
    const base = {
      documentId: input.documentId,
      userId: input.userId,
      correlationId: input.correlationId,
      source: 'api' as const,
      expectedYjsUpdatedAt: input.request.expectedYjsUpdatedAt,
    };
    if (input.kind === 'block') {
      const request = input.request as DocumentBlockWriteRequest;
      return { ...base, resolve: () => ({ ok: true, value: [blockEdit(request)] }) };
    }
    if (input.kind === 'section') {
      const request = input.request as DocumentSectionWriteRequest;
      return { ...base, resolve: (page) => sectionEdits(page, request) };
    }
    const request = input.request as DocumentPatchRequest;
    return { ...base, resolve: (page) => resolvePatchEdits(page, request) };
  }

  /**
   * Everything a narrow write does before it commits: access, revision,
   * resolution, parse, the edit on the stored state, the growth refusal.
   * Shared by the write and the preview, so the two cannot disagree.
   */
  private async prepare(input: NarrowWrite): Promise<PreparedWrite> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canEditDocument(context.role, context.document));

    const existing = await this.prisma.documentContent.findUnique({
      where: { documentId: input.documentId },
      select: {
        yjsState: true,
        schemaVersion: true,
        yjsUpdatedAt: true,
        // See the same select in `DocumentContentService` (issue #120).
        document: { select: { updatedAt: true } },
      },
    });
    if (existing === null) throw AppError.notFound('Document content');

    assertExpectedRevision({
      expected: input.expectedYjsUpdatedAt,
      current: existing.yjsUpdatedAt,
      documentUpdatedAt: existing.document.updatedAt,
    });

    // References are read and written as `[[Titel]]`, so both directions go
    // through the identity index for the reason `DocumentContentService`
    // documents: a title that has changed since somebody typed it must go out
    // as it reads now, or it comes back bound to nothing (issue #14).
    const identities = await this.pageLinks.loadIndex(context.workspaceId);
    const page = resolvePageLinkTitles(yjsStateToProseMirrorJson(existing.yjsState), (documentId) =>
      identities.titleFor(documentId),
    );

    const edits = this.resolved(input.resolve, page);
    const warnings: string[] = [];
    const contents: ProseMirrorDocument[] = [];

    let state = existing.yjsState as Uint8Array;
    let applied: AppliedBlockRange | null = null;
    const blockIds: string[] = [];

    for (const step of edits) {
      const content = this.parse(step.markdown, (title) => identities.identityFor(title), input);
      warnings.push(...foreignMediaWarnings(content, this.env.APP_URL));
      try {
        applied = applyBlockRangeEditToState(state, content, step.edit);
      } catch (error) {
        throw this.refusal(error);
      }
      state = applied.yjsState;
      blockIds.push(...applied.blockIds);
      contents.push(content);
    }
    if (applied === null) throw AppError.validation('Nothing to write');

    const markdown = serializeMarkdown(applied.proseMirrorJson);
    await this.refuseUnboundedGrowth(context.workspaceId, page, markdown.length);
    return {
      workspaceId: context.workspaceId,
      existing,
      edits,
      contents,
      applied,
      blockIds,
      warnings,
      markdown,
    };
  }

  /**
   * The one write path all three take.
   *
   * `resolve` is handed the page as it is stored, because a heading or a piece
   * of text can only be looked up in content, where a block identifier needs no
   * lookup at all. Everything after that is the same: parse, bind references,
   * edit the stored state, commit.
   */
  private async apply(input: NarrowWrite): Promise<DocumentGranularWriteResponse> {
    const { workspaceId, existing, edits, contents, applied, blockIds, warnings, markdown } =
      await this.prepare(input);

    const committed = await this.commits.commit({
      documentId: input.documentId,
      workspaceId,
      userId: input.userId,
      correlationId: input.correlationId,
      source: input.source,
      previous: { yjsState: existing.yjsState, schemaVersion: existing.schemaVersion },
      applied,
      markdown,
      promotedTitle: null,
      /*
       * The open session is handed the same ranged edit, so it performs the
       * same surgery instead of being sent the whole page (ADR-016).
       *
       * Except when there were several, which only a `replaceAll` patch
       * produces: the bridge carries one edit per call, and four calls that
       * must not interleave with what somebody is typing between them is a
       * worse promise than one honest page update. So the rare case falls back
       * to the whole document, which is exactly what `exo_page_write` already
       * does today.
       */
      live:
        edits.length === 1
          ? {
              mode: 'replace',
              proseMirrorJson: contents[0] as ProseMirrorDocument,
              edit: (edits[0] as PatchEdit).edit,
            }
          : { mode: 'replace', proseMirrorJson: applied.proseMirrorJson, edit: null },
    });
    warnings.push(...committed.warnings);

    this.logger.info('Document edited in place', {
      documentId: input.documentId,
      edits: edits.length,
      blockIds: blockIds.length,
      correlationId: input.correlationId,
    });

    return {
      documentId: input.documentId,
      snapshotId: committed.snapshotId,
      yjsUpdatedAt: committed.yjsUpdatedAt,
      schemaVersion: EXOCORTEX_SCHEMA_VERSION,
      byteSize: applied.yjsState.byteLength,
      appliedToLiveSession: committed.appliedToLiveSession,
      warnings,
      blockIds,
      replacements: edits.reduce((total, step) => total + step.replacements, 0),
    };
  }

  /**
   * Refuses a narrow write that would push an oversized page further (#118).
   *
   * The whole-page write is where the growth policy is written down, and this
   * is the door beside it: a page the policy refuses one more append to could
   * otherwise be appended to with `exo_page_section_write` and a placement of
   * `after`, and a limit one call enforces while its neighbour does not is a
   * limit nobody has.
   *
   * Only the refusal, never the warning at `large`. These three calls *are* the
   * way out the refusal offers -- change a section instead of adding to the
   * end -- and a sentence about the page's size on every targeted edit would
   * make the way out feel like the thing being discouraged.
   *
   * The page before this write is only serialized when the result is already
   * over the limit, which is a few pages on this deployment and none of the
   * ones these calls are usually aimed at.
   */
  private async refuseUnboundedGrowth(
    workspaceId: string,
    before: ProseMirrorDocument,
    after: number,
  ): Promise<void> {
    const limits = pageGrowthLimits(await this.settings.getForWorkspace(workspaceId));
    if (after <= limits.oversizedChars) return;

    const current = serializeMarkdown(before).length;
    const growth = judgePageGrowth({ before: current, after, limits });
    if (!growth.grew) return;

    throw new AppError(
      'document_page_oversized',
      oversizedPageRefusal(before, { current, after, limit: limits.oversizedChars }),
    );
  }

  /** Runs a resolver and turns its refusal into the API's vocabulary. */
  private resolved(
    resolve: NarrowWrite['resolve'],
    page: ProseMirrorDocument,
  ): readonly PatchEdit[] {
    const result = resolve(page);
    if (result.ok) return result.value;

    const details = { count: result.count, blockIds: result.blockIds };
    switch (result.reason) {
      case 'heading_not_found':
        throw new AppError(
          'document_heading_not_found',
          'No heading on this page carries that text',
          details,
        );
      case 'heading_not_unique':
        throw new AppError(
          'document_heading_not_unique',
          'That heading occurs more than once; address one of these blocks instead',
          details,
        );
      case 'patch_not_found':
        throw new AppError('document_patch_not_found', 'That text is not on this page', details);
      case 'patch_not_unique':
        throw new AppError(
          'document_patch_not_unique',
          'That text occurs more than once; nothing was written',
          details,
        );
      case 'section_end_unaddressable':
        throw new AppError(
          'document_block_range_invalid',
          'The last block of this section carries no identifier, so the end of the section ' +
            'cannot be addressed. Open the page once in the editor, which gives every block one',
          details,
        );
      default:
        throw new AppError(
          'document_block_range_invalid',
          "This page's Markdown could not be mapped back onto its blocks; address a block directly",
          details,
        );
    }
  }

  /** Parses one piece of incoming Markdown, with references bound to pages. */
  private parse(
    markdown: string,
    lookup: PageIdentityLookup,
    input: { documentId: string; correlationId: string },
  ): ProseMirrorDocument {
    try {
      return bindPageLinkIdentities(parseMarkdown(markdown).document, lookup);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn('Narrow write rejected: markdown could not be parsed', {
        documentId: input.documentId,
        correlationId: input.correlationId,
        reason,
      });
      // The reason travels back for the reason issue #82 records: without it a
      // rejection can only be narrowed down by sending smaller and smaller
      // writes until it stops happening.
      throw AppError.validation('The Markdown could not be parsed', { reason });
    }
  }

  /** A `BlockRangeError` in the API's vocabulary; anything else stays what it is. */
  private refusal(error: unknown): unknown {
    if (error instanceof BlockRangeError) {
      return error.reason === 'block_not_found'
        ? new AppError('document_block_not_found', error.message, { blockId: error.blockId })
        : new AppError('document_block_range_invalid', error.message, { blockId: error.blockId });
    }
    // The schema refused the result, which for a ranged edit means the content
    // is not allowed where it was placed: a heading inside a list item, say.
    return error instanceof Error ? AppError.validation(error.message) : error;
  }
}
