import { Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canCreateDocument,
  canEditDocument,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  type ChangesetDiff,
  type DocumentBlockWriteRequest,
  type DocumentPatchRequest,
  type DocumentSectionWriteRequest,
  type ProposeChange,
} from '@exocortex/contracts';
import {
  describeBlockType,
  diffDocuments,
  parseMarkdown,
  type ProseMirrorDocument,
} from '@exocortex/editor';

import { AppError } from '../common/app-error';
import { DocumentContentService } from '../documents/document-content.service';
import { DocumentEditService } from '../documents/document-edit.service';

/** The most diff blocks a change keeps; a longer diff says it was cut. */
const MAX_DIFF_BLOCKS = 200;

const EMPTY_DOCUMENT: ProseMirrorDocument = { type: 'doc', content: [] };

/** What a proposed change becomes on its row. */
export interface PreparedChange {
  kind: ProposeChange['kind'];
  documentId: string | null;
  parentId: string | null;
  title: string | null;
  message: string | null;
  /** The write as it will be replayed, without revision and without message. */
  request: Record<string, unknown>;
  /** The page's revision the preview was computed on; null for a new page. */
  revision: Date | null;
  diff: ChangesetDiff;
}

/** Only what differs, cut to a size a reader and a row can carry. */
export function changesetDiff(
  before: ProseMirrorDocument,
  after: ProseMirrorDocument,
): ChangesetDiff {
  const diff = diffDocuments(before, after);
  const differing = diff.blocks.filter((block) => block.kind !== 'unchanged' || block.moved);
  return {
    blocks: differing.slice(0, MAX_DIFF_BLOCKS).map((block) => ({
      ...block,
      nodeLabel: describeBlockType(block.nodeType),
    })),
    summary: diff.summary,
    truncated: diff.truncated || differing.length > MAX_DIFF_BLOCKS,
  };
}

/**
 * Turns a proposed change into what a changeset stores (issue #141, ADR-070).
 *
 * The change is resolved against the page as it stands, by the very code the
 * write itself runs (`preview` on the two write services), so a heading that
 * is not there, a text that occurs twice or a page the proposer may not edit
 * is refused when it is proposed, not days later when somebody applies it.
 * What is kept is the request to replay, the revision it was computed on and
 * the block diff a reviewer reads.
 */
@Injectable()
export class ChangesetProposalService {
  constructor(
    private readonly access: WorkspaceAccessService,
    private readonly edits: DocumentEditService,
    private readonly content: DocumentContentService,
  ) {}

  async prepare(input: {
    workspaceId: string;
    userId: string;
    change: ProposeChange;
    correlationId: string;
  }): Promise<PreparedChange> {
    const { change } = input;
    const message = change.message ?? null;

    if (change.kind === 'create')
      return this.prepareCreate(input.workspaceId, input.userId, change);

    const { kind, documentId, expectedYjsUpdatedAt, message: _message, ...rest } = change;
    const request = { ...rest } as Record<string, unknown>;
    const preview =
      kind === 'page'
        ? await this.content.preview({
            documentId,
            userId: input.userId,
            correlationId: input.correlationId,
            request: { markdown: change.markdown, mode: change.mode, expectedYjsUpdatedAt },
          })
        : await this.edits.preview({
            documentId,
            userId: input.userId,
            correlationId: input.correlationId,
            kind,
            request: { ...request, expectedYjsUpdatedAt } as
              DocumentBlockWriteRequest | DocumentSectionWriteRequest | DocumentPatchRequest,
          });
    if (preview.workspaceId !== input.workspaceId) {
      throw new AppError('changeset_target_invalid', 'The page is not in this workspace', {
        documentId,
      });
    }
    return {
      kind,
      documentId,
      parentId: null,
      title: null,
      message,
      request,
      revision: preview.revision,
      diff: changesetDiff(preview.before, preview.after),
    };
  }

  /**
   * A new page: its parent has to be one the proposer may create under, now.
   * The diff is the page's whole content against nothing.
   */
  private async prepareCreate(
    workspaceId: string,
    userId: string,
    change: Extract<ProposeChange, { kind: 'create' }>,
  ): Promise<PreparedChange> {
    const parentId = change.parentId ?? null;
    if (parentId === null) {
      assertPolicy(canCreateDocument(await this.access.requireRole(workspaceId, userId)));
    } else {
      const parent = await this.access.requireDocumentContext(parentId, userId);
      if (parent.workspaceId !== workspaceId) {
        throw new AppError('changeset_target_invalid', 'The parent is not in this workspace', {
          parentId,
        });
      }
      assertPolicy(canEditDocument(parent.role, parent.document));
    }
    let after: ProseMirrorDocument;
    try {
      after = parseMarkdown(change.markdown).document;
    } catch (error) {
      throw AppError.validation('The Markdown could not be parsed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      kind: 'create',
      documentId: null,
      parentId,
      title: change.title,
      message: change.message ?? null,
      request: { markdown: change.markdown },
      revision: null,
      diff: changesetDiff(EMPTY_DOCUMENT, after),
    };
  }
}
