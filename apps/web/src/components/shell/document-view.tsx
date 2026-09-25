'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DocumentDetail } from '@exocortex/contracts';
import { cn, ErrorState, LoadingState } from '@exocortex/ui';

import { DatabaseShell } from '@/components/database/database-shell';
import { PageCover, PageCoverAddButton } from '@/components/document/page-cover';
import { PageIconAddButton, PageIconButton } from '@/components/document/page-icon-picker';
import { PageOverview } from '@/components/document/page-overview';
import { PagePropertiesDialog } from '@/components/document/page-properties-dialog';
import { CollaborativeEditor } from '@/components/editor/collaborative-editor';
import { usePageBodyCommands } from '@/components/palette/page-commands';
import { useAskPalette } from '@/components/palette/palette-requests';
import { PageRenderDialog } from '@/components/render/page-render-dialog';
import { useCreateDocument, useDocument, useUpdateDocument } from '@/lib/api/document-queries';
import { useExportMarkdown } from '@/lib/api/markdown-queries';
import { useSessionQuery } from '@/lib/api/session-queries';
import { documentHref } from '@/lib/document-href';

import { useDocumentSession } from './document-session';
import { DocumentTitleInput } from './document-title-input';
import { DocumentTopBar } from './document-top-bar';
import { MarkdownImportDialog } from './markdown-import-dialog';

interface DocumentViewProps {
  workspaceId: string;
  documentId: string;
}

/**
 * Document surface: breadcrumb, editable title, actions and the collaborative
 * editor. No business logic lives here — every action calls an API endpoint.
 */
export function DocumentView({ workspaceId, documentId }: DocumentViewProps) {
  const t = useTranslations('document.view');
  const tTree = useTranslations('shell.pageTree');
  const router = useRouter();
  const session = useSessionQuery();
  const document = useDocument(documentId);
  const updateDocument = useUpdateDocument(workspaceId);
  const createDocument = useCreateDocument(workspaceId);
  const exportMarkdown = useExportMarkdown();
  const askPalette = useAskPalette();

  const [importOpen, setImportOpen] = React.useState(false);
  const [propertiesOpen, setPropertiesOpen] = React.useState(false);
  const [renderOpen, setRenderOpen] = React.useState(false);

  const downloadMarkdown = async (): Promise<void> => {
    const result = await exportMarkdown.mutateAsync(documentId);
    const blob = new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = result.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  // What the palette can do to this page (issue #148). Before the early
  // returns, because it is a hook; it offers nothing until the page is loaded.
  usePageBodyCommands(document.data, {
    ask: askPalette,
    setLayout: (layout) => void updateDocument.mutateAsync({ documentId, request: { layout } }),
    setOverview: (on) =>
      void updateDocument.mutateAsync({
        documentId,
        request: { overviewMode: on ? 'auto' : 'off' },
      }),
    openProperties: () => setPropertiesOpen(true),
    createChild: (type) => {
      void createDocument
        .mutateAsync({
          title: type === 'COLLECTION' ? tTree('untitledDatabase') : tTree('untitledPage'),
          type,
          parentId: documentId,
        })
        .then((child) => router.push(documentHref(workspaceId, child.id, type)));
    },
    copyLink: () => {
      const type = document.data?.type ?? 'PAGE';
      void window.navigator.clipboard.writeText(
        `${window.location.origin}${documentHref(workspaceId, documentId, type)}`,
      );
    },
    exportMarkdown: () => void downloadMarkdown(),
    openRender: () => setRenderOpen(true),
    openImport: () => setImportOpen(true),
  });

  // Published for the AI panel: a database page means nothing without the view
  // its rows are being read through. Only the full-page database does this; an
  // embedded one is a block, not the page.
  const { update: updateSession } = useDocumentSession();
  const publishActiveDatabaseView = React.useCallback(
    (viewId: string) => updateSession({ activeDatabaseView: { documentId, viewId } }),
    [documentId, updateSession],
  );
  React.useEffect(
    () => () => updateSession({ activeDatabaseView: null }),
    [documentId, updateSession],
  );

  if (document.isPending || session.isPending) {
    return <LoadingState label={t('loading')} />;
  }
  if (document.isError) {
    return (
      <ErrorState
        title={t('unavailableTitle')}
        description={t('unavailableDescription')}
        onRetry={() => void document.refetch()}
      />
    );
  }

  const detail = document.data;
  const user = session.data?.user;
  const archived = detail.archivedAt !== null;
  const readOnly = archived || detail.access === 'read';

  // Above the measure, so the image spans the whole surface no matter how
  // narrow the page body is; the add button sits inside it, where the title is.
  const cover =
    detail.coverAttachmentId === null ? null : (
      <PageCover
        workspaceId={workspaceId}
        documentId={documentId}
        attachmentId={detail.coverAttachmentId}
        position={detail.coverPosition}
        readOnly={readOnly}
      />
    );
  // Decorations, symbol and title: the same on a database and on a page.
  const pageHead = (
    <>
      <PageDecorations
        workspaceId={workspaceId}
        documentId={documentId}
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
        onCommit={(nextTitle) => {
          void updateDocument.mutateAsync({ documentId, request: { title: nextTitle } });
        }}
      />
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DocumentTopBar
        workspaceId={workspaceId}
        documentId={documentId}
        detail={detail}
        archived={archived}
        onOpenProperties={() => setPropertiesOpen(true)}
        onOpenImport={() => setImportOpen(true)}
        onExport={() => void downloadMarkdown()}
        onOpenRender={() => setRenderOpen(true)}
      />

      {archived ? (
        <p
          className="border-b border-warning/40 bg-warning/10 px-6 py-1.5 text-xs text-warning"
          data-testid="archived-banner"
        >
          {t('archivedBanner')}
        </p>
      ) : null}

      {detail.type === 'COLLECTION' ? (
        <div className="exocortex-page-scroll group/page flex min-h-0 flex-1 flex-col overflow-y-auto">
          {cover}
          <div
            className={cn(
              'exocortex-page flex min-h-0 flex-1 flex-col',
              cover === null ? 'pt-8' : 'pt-5',
            )}
            data-layout={detail.layout}
          >
            {pageHead}
            <DatabaseShell
              workspaceId={workspaceId}
              documentId={documentId}
              readOnly={readOnly}
              onActiveViewResolved={publishActiveDatabaseView}
            />
          </div>
        </div>
      ) : (
        <div className="exocortex-page-scroll group/page min-h-0 flex-1 overflow-y-auto">
          {cover}
          {/* Width comes from `Document.layout`; the padding comes from the
              `.exocortex-page` rule in globals.css, because on a page with an
              editor it also has to hold the interaction gutter the block handle
              and the heading toggles sit in (issue #88). */}
          <div
            className={cn('exocortex-page pb-8', cover === null ? 'pt-8' : 'pt-5')}
            data-layout={detail.layout}
            data-gutter="editor"
          >
            {pageHead}

            {/* Between the title and the body: the overview is about the page's
                sub-pages, and a reader looking for one of them should not have
                to scroll past a body that may be empty (ADR-028). Renders
                nothing unless the page is marked as an overview. */}
            <PageOverview workspaceId={workspaceId} documentId={documentId} readOnly={readOnly} />

            {user === undefined || user === null ? (
              <LoadingState label={t('checkingSession')} />
            ) : (
              <CollaborativeEditor
                workspaceId={workspaceId}
                documentId={documentId}
                documentTitle={detail.title}
                currentUser={{ id: user.id, name: user.name }}
                access={archived ? 'read' : detail.access}
                /* The breadcrumb block renders the ancestor path. The editor package
                   has no access to the page hierarchy, so the path it already
                   loaded is handed over as data. */
                breadcrumb={detail.breadcrumb.map((entry) => ({
                  id: entry.id,
                  title: entry.title,
                  href: `/arbeitsbereich/${workspaceId}/seite/${entry.id}`,
                }))}
              />
            )}
          </div>
        </div>
      )}

      <PagePropertiesDialog
        workspaceId={workspaceId}
        detail={detail}
        open={propertiesOpen}
        onOpenChange={setPropertiesOpen}
      />

      <PageRenderDialog
        workspaceId={workspaceId}
        documentId={documentId}
        open={renderOpen}
        onOpenChange={setRenderOpen}
      />

      <MarkdownImportDialog
        workspaceId={workspaceId}
        open={importOpen}
        onOpenChange={setImportOpen}
      />
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
