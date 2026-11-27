'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { cn, ErrorState, LoadingState } from '@exocortex/ui';

import { DatabaseShell } from '@/components/database/database-shell';
import { RowPeekProvider } from '@/components/database/row-peek';
import { RowPeekPanel } from '@/components/database/row-peek-panel';
import { PagePropertiesDialog } from '@/components/document/page-properties-dialog';
import { usePageBodyCommands } from '@/components/palette/page-commands';
import { useAskPalette } from '@/components/palette/palette-requests';
import { PageRenderDialog } from '@/components/render/page-render-dialog';
import { useCreateDocument, useDocument, useUpdateDocument } from '@/lib/api/document-queries';
import { useExportMarkdown } from '@/lib/api/markdown-queries';
import { useSessionQuery } from '@/lib/api/session-queries';
import { documentHref } from '@/lib/document-href';

import { replacesPageOnError } from './document-load-failure';
import { useDocumentSession } from './document-session';
import { DocumentTopBar } from './document-top-bar';
import { MarkdownImportDialog } from './markdown-import-dialog';
import { PageCoverBand, PageHead, PageSurface } from './page-surface';

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
  if (document.isError && replacesPageOnError(document.error, document.data !== undefined)) {
    return (
      <ErrorState
        title={t('unavailableTitle')}
        description={t('unavailableDescription')}
        onRetry={() => void document.refetch()}
      />
    );
  }

  // A failed refetch keeps the page it already has (see above), so the data is
  // read rather than assumed; without any there is nothing to show yet.
  const detail = document.data;
  if (detail === undefined) return <LoadingState label={t('loading')} />;
  const user = session.data?.user;
  const archived = detail.archivedAt !== null;
  const readOnly = archived || detail.access === 'read';

  return (
    <RowPeekProvider workspaceId={workspaceId} documentId={documentId}>
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

        {/* The page area, and over its right-hand part the side panel a row
            of a database opens in (issue #239). */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {detail.type === 'COLLECTION' ? (
            <div className="exocortex-page-scroll group/page flex min-h-0 flex-1 flex-col overflow-y-auto">
              <PageCoverBand workspaceId={workspaceId} detail={detail} readOnly={readOnly} />
              <div
                className={cn(
                  'exocortex-page flex min-h-0 flex-1 flex-col',
                  detail.coverAttachmentId === null ? 'pt-8' : 'pt-5',
                )}
                data-layout={detail.layout}
              >
                <PageHead workspaceId={workspaceId} detail={detail} readOnly={readOnly} />
                <DatabaseShell
                  workspaceId={workspaceId}
                  documentId={documentId}
                  readOnly={readOnly}
                  onActiveViewResolved={publishActiveDatabaseView}
                />
              </div>
            </div>
          ) : (
            <PageSurface
              workspaceId={workspaceId}
              detail={detail}
              readOnly={readOnly}
              user={user}
            />
          )}
          <RowPeekPanel />
        </div>

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
    </RowPeekProvider>
  );
}
