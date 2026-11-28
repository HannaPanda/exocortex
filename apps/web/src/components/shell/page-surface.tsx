'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DocumentDetail } from '@exocortex/contracts';
import { cn, LoadingState } from '@exocortex/ui';

import { rowCollectionIdOf } from '@/components/database/row-header-layout';
import { RowPropertiesHeader } from '@/components/database/row-properties-header';
import { PageCover, PageCoverAddButton } from '@/components/document/page-cover';
import { PageIconAddButton, PageIconButton } from '@/components/document/page-icon-picker';
import { PageOverview } from '@/components/document/page-overview';
import { CollaborativeEditor } from '@/components/editor/collaborative-editor';
import { useUpdateDocument } from '@/lib/api/document-queries';
import { useDocumentHrefs } from '@/lib/document-href-context';

import { DocumentTitleInput } from './document-title-input';

interface PageHeadProps {
  workspaceId: string;
  detail: DocumentDetail;
  readOnly: boolean;
  /**
   * Whether the title answers "Seite umbenennen" from the palette. Only the
   * page the address names does; a row open beside it would be a second field
   * answering the same request (issue #239).
   */
  titleAnswersPalette?: boolean;
  /** Focuses the title and selects it once, for a row that was just made. */
  selectTitle?: boolean;
}

/**
 * Decorations, symbol and title: the same on a database, on a page and on a
 * row open in the side panel.
 */
export function PageHead({
  workspaceId,
  detail,
  readOnly,
  titleAnswersPalette = true,
  selectTitle = false,
}: PageHeadProps) {
  const updateDocument = useUpdateDocument(workspaceId);
  const queryClient = useQueryClient();
  // A row's name is also a cell of the table beside it (issue #239).
  const collectionId = rowCollectionIdOf(detail);
  return (
    <>
      <PageDecorations
        workspaceId={workspaceId}
        documentId={detail.id}
        detail={detail}
        readOnly={readOnly}
      />
      {detail.icon === null ? null : (
        <PageIconButton workspaceId={workspaceId} document={detail} readOnly={readOnly} />
      )}
      <DocumentTitleInput
        // Remounting on document change resets the field without an effect.
        key={`${detail.id}:${detail.title}`}
        initialTitle={detail.title}
        readOnly={readOnly}
        answersPalette={titleAnswersPalette}
        selectOnMount={selectTitle}
        onCommit={(nextTitle) => {
          void updateDocument
            .mutateAsync({ documentId: detail.id, request: { title: nextTitle } })
            .then(() => {
              if (collectionId === null) return;
              void queryClient.invalidateQueries({
                queryKey: ['database', collectionId, 'rows'],
              });
            });
        }}
      />
    </>
  );
}

/**
 * The cover of a page, or nothing. Above the measure, so the image spans the
 * whole surface no matter how narrow the page body is.
 */
export function PageCoverBand({
  workspaceId,
  detail,
  readOnly,
}: {
  workspaceId: string;
  detail: DocumentDetail;
  readOnly: boolean;
}) {
  if (detail.coverAttachmentId === null) return null;
  return (
    <PageCover
      workspaceId={workspaceId}
      documentId={detail.id}
      attachmentId={detail.coverAttachmentId}
      position={detail.coverPosition}
      readOnly={readOnly}
    />
  );
}

interface PageSurfaceProps {
  workspaceId: string;
  detail: DocumentDetail;
  readOnly: boolean;
  user: { id: string; name: string } | null | undefined;
  titleAnswersPalette?: boolean;
  selectTitle?: boolean;
  className?: string;
}

/**
 * A page as it is read and written: cover, title, a row's properties, the
 * overview and the collaborative editor, inside its own scroll container with
 * the room its outline floats in.
 *
 * One component for the page the address names and for a row opened beside a
 * database (issue #239), so the side panel is the real page and never a
 * second editor that could drift from the first.
 */
export function PageSurface({
  workspaceId,
  detail,
  readOnly,
  user,
  titleAnswersPalette = true,
  selectTitle = false,
  className,
}: PageSurfaceProps) {
  const t = useTranslations('document.view');
  const rowCollectionId = rowCollectionIdOf(detail);
  const hasCover = detail.coverAttachmentId !== null;
  const hrefs = useDocumentHrefs();

  return (
    // The document area: the scroll container, and beside it the room the
    // page outline floats in (`data-outline-host`, issue #194). Beside and
    // not inside, so the outline stays where it is while the page scrolls.
    <div className={cn('relative flex min-h-0 flex-1 flex-col', className)} data-outline-host="">
      <div className="exocortex-page-scroll group/page min-h-0 flex-1 overflow-y-auto">
        <PageCoverBand workspaceId={workspaceId} detail={detail} readOnly={readOnly} />
        {/* Width comes from `Document.layout`; the padding comes from the
          `.exocortex-page` rule in globals.css, because on a page with an
          editor it also has to hold the interaction gutter the block handle
          and the heading toggles sit in (issue #88). */}
        <div
          className={cn('exocortex-page pb-8', hasCover ? 'pt-5' : 'pt-8')}
          data-layout={detail.layout}
          data-gutter="editor"
        >
          <PageHead
            workspaceId={workspaceId}
            detail={detail}
            readOnly={readOnly}
            titleAnswersPalette={titleAnswersPalette}
            selectTitle={selectTitle}
          />

          {/* A row of a database carries its values under its title, read
            and written as the table's own cells (issue #254). */}
          {rowCollectionId === null ? null : (
            <RowPropertiesHeader
              collectionDocumentId={rowCollectionId}
              rowId={detail.id}
              readOnly={readOnly}
            />
          )}

          {/* Between the title and the body: the overview is about the page's
            sub-pages, and a reader looking for one of them should not have
            to scroll past a body that may be empty (ADR-028). Renders
            nothing unless the page is marked as an overview. */}
          <PageOverview workspaceId={workspaceId} documentId={detail.id} readOnly={readOnly} />

          {user === undefined || user === null ? (
            <LoadingState label={t('checkingSession')} />
          ) : (
            <CollaborativeEditor
              workspaceId={workspaceId}
              documentId={detail.id}
              documentTitle={detail.title}
              currentUser={{ id: user.id, name: user.name }}
              access={readOnly ? 'read' : detail.access}
              /* The breadcrumb block renders the ancestor path. The editor package
               has no access to the page hierarchy, so the path it already
               loaded is handed over as data. */
              breadcrumb={detail.breadcrumb.map((entry) => ({
                id: entry.id,
                title: entry.title,
                href: hrefs.href(workspaceId, entry.id),
              }))}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One row for everything a bare page can still be given, so an empty page
 * carries a single line of controls instead of one line per decoration.
 */
function PageDecorations({
  workspaceId,
  documentId,
  detail,
  readOnly,
}: {
  workspaceId: string;
  documentId: string;
  detail: DocumentDetail;
  readOnly: boolean;
}) {
  if (readOnly) return null;
  if (detail.icon !== null && detail.coverAttachmentId !== null) return null;
  return (
    <div className="-ml-3 mb-1 flex flex-wrap items-center">
      {detail.icon === null ? (
        <PageIconAddButton workspaceId={workspaceId} document={detail} />
      ) : null}
      {detail.coverAttachmentId === null ? (
        <PageCoverAddButton workspaceId={workspaceId} documentId={documentId} />
      ) : null}
    </div>
  );
}
