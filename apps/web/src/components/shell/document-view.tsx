'use client';

import {
  DownloadIcon,
  FileTextIcon,
  FolderTreeIcon,
  LayoutTemplateIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  Share2Icon,
  SlidersHorizontalIcon,
  TrashIcon,
  UploadIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { type DocumentDetail } from '@exocortex/contracts';
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ErrorState,
  LoadingState,
  Textarea,
  TruncatedText,
} from '@exocortex/ui';

import { DatabaseShell } from '@/components/database/database-shell';
import { DocumentIcon } from '@/components/document/document-icon';
import { PageCover, PageCoverAddButton } from '@/components/document/page-cover';
import { PageIconAddButton, PageIconButton } from '@/components/document/page-icon-picker';
import { PageOverview } from '@/components/document/page-overview';
import { PagePropertiesDialog } from '@/components/document/page-properties-dialog';
import { CollaborativeEditor } from '@/components/editor/collaborative-editor';
import { PageRenderDialog } from '@/components/render/page-render-dialog';
import {
  useArchiveDocument,
  useDocument,
  useRestoreDocument,
  useUpdateDocument,
} from '@/lib/api/document-queries';
import { useInbox } from '@/lib/api/inbox-queries';
import { useExportMarkdown, useImportMarkdown } from '@/lib/api/markdown-queries';
import { useSessionQuery } from '@/lib/api/session-queries';
import { useDocumentShares } from '@/lib/api/share-queries';
import { useWorkspaces } from '@/lib/api/workspace-queries';

import { useDocumentSession } from './document-session';
import { SaveIndicator } from './save-indicator';
import { ShareDialog } from './share-dialog';
import { SuggestParentDialog } from './suggest-parent-dialog';
import { TemplateSettingsDialog } from './template-settings-dialog';

const AI_RULE_BADGE_LABEL: Record<'always' | 'on_demand', string> = {
  always: 'KI-Regel',
  on_demand: 'KI-Regel (auf Anfrage)',
};

interface DocumentViewProps {
  workspaceId: string;
  documentId: string;
}

/**
 * Document surface: breadcrumb, editable title, actions and the collaborative
 * editor. No business logic lives here — every action calls an API endpoint.
 */
export function DocumentView({ workspaceId, documentId }: DocumentViewProps) {
  const router = useRouter();
  const session = useSessionQuery();
  const document = useDocument(documentId);
  const updateDocument = useUpdateDocument(workspaceId);
  const exportMarkdown = useExportMarkdown();
  const importMarkdown = useImportMarkdown(workspaceId);

  const [importOpen, setImportOpen] = React.useState(false);
  const [importText, setImportText] = React.useState('');
  const [propertiesOpen, setPropertiesOpen] = React.useState(false);
  const [renderOpen, setRenderOpen] = React.useState(false);

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
    return <LoadingState label="Seite wird geladen …" />;
  }
  if (document.isError) {
    return (
      <ErrorState
        title="Seite nicht verfügbar"
        description="Die Seite existiert nicht oder du hast keinen Zugriff darauf."
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
  const decorations = (
    <PageDecorations
      workspaceId={workspaceId}
      documentId={documentId}
      detail={detail}
      readOnly={readOnly}
    />
  );

  const pageIcon =
    detail.icon === null ? null : (
      <PageIconButton workspaceId={workspaceId} document={detail} readOnly={readOnly} />
    );

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

  const importAsNewPage = async (): Promise<void> => {
    const markdown = importText.trim();
    if (markdown.length === 0) return;
    const result = await importMarkdown.mutateAsync({ markdown, parentId: null });
    setImportOpen(false);
    setImportText('');
    router.push(`/arbeitsbereich/${workspaceId}/seite/${result.document.id}`);
  };

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
          Diese Seite liegt im Papierkorb und ist deshalb nur lesbar.
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
            {decorations}
            {pageIcon}
            <DocumentTitleInput
              key={`${detail.id}:${detail.title}`}
              initialTitle={detail.title}
              readOnly={readOnly}
              onCommit={(nextTitle) => {
                void updateDocument.mutateAsync({ documentId, request: { title: nextTitle } });
              }}
            />
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
            {decorations}
            {pageIcon}
            <DocumentTitleInput
              // Remounting on document change resets the field without an effect.
              key={`${detail.id}:${detail.title}`}
              initialTitle={detail.title}
              readOnly={readOnly}
              onCommit={(nextTitle) => {
                void updateDocument.mutateAsync({ documentId, request: { title: nextTitle } });
              }}
            />

            {/* Between the title and the body: the overview is about the page's
                sub-pages, and a reader looking for one of them should not have
                to scroll past a body that may be empty (ADR-028). Renders
                nothing unless the page is marked as an overview. */}
            <PageOverview workspaceId={workspaceId} documentId={documentId} readOnly={readOnly} />

            {user === undefined || user === null ? (
              <LoadingState label="Sitzung wird geprüft …" />
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

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Markdown importieren</DialogTitle>
            <DialogDescription>
              Der Inhalt wird als neue Seite angelegt. Frontmatter, Aufgabenlisten, Tabellen,
              Wiki-Links und Callouts werden übernommen.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={12}
            value={importText}
            data-testid="import-textarea"
            onChange={(event) => setImportText(event.target.value)}
            // No `# Meine Seite` here: the title belongs in the frontmatter, and
            // an example that shows it twice is an example of the duplicate
            // heading this import strips out again.
            placeholder={'---\ntitle: Meine Seite\n---\n\nErster Absatz.\n'}
            className="font-mono text-xs"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>
              Abbrechen
            </Button>
            <Button
              data-testid="import-submit"
              disabled={importMarkdown.isPending || importText.trim().length === 0}
              onClick={() => void importAsNewPage()}
            >
              Importieren
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface DocumentTitleInputProps {
  initialTitle: string;
  readOnly: boolean;
  onCommit: (title: string) => void;
}

/**
 * The title field owns its draft value. It is remounted through its `key` when the
 * document changes, so no effect has to copy server state into local state.
 */
function DocumentTitleInput({ initialTitle, readOnly, onCommit }: DocumentTitleInputProps) {
  const [value, setValue] = React.useState(initialTitle);

  const commit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === initialTitle) {
      setValue(initialTitle);
      return;
    }
    onCommit(trimmed);
  };

  return (
    /*
     * A textarea rather than an input, because an input cannot wrap: a long
     * title scrolled sideways inside its own box and had to be read with
     * shift-scroll. The field still behaves like a single-line one -- Enter
     * commits and a pasted line break becomes a space -- it just occupies as
     * many lines as it needs.
     *
     * The height comes from the mirror below it, not from JavaScript: both sit
     * in the same grid cell, the mirror carries the same text and the same
     * wrapping, and the grid row grows to the taller of the two. That keeps the
     * field correct on the very first paint and through every reflow, without a
     * resize effect that would run one frame late.
     */
    <div className="exocortex-page-title mb-5 grid w-full">
      <textarea
        value={value}
        rows={1}
        aria-label="Seitentitel"
        data-testid="document-title"
        readOnly={readOnly}
        onChange={(event) => setValue(event.target.value.replace(/[\r\n]+/g, ' '))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        className={cn(
          'col-start-1 row-start-1 m-0 resize-none overflow-hidden p-0',
          'bg-transparent outline-none placeholder:text-muted-foreground',
          // The caret alone is too faint a focus mark on a heading this size.
          'rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring/50',
        )}
        placeholder="Unbenannte Seite"
      />
      <span aria-hidden className="col-start-1 row-start-1 invisible whitespace-pre-wrap">
        {/* The trailing space reserves room for the caret behind the last
            character, and keeps a title ending in a newline from collapsing. */}
        {`${value} `}
      </span>
    </div>
  );
}

/** Breadcrumb, rule badge and the page's own actions. */
function DocumentTopBar({
  workspaceId,
  documentId,
  detail,
  archived,
  onOpenProperties,
  onOpenImport,
  onExport,
  onOpenRender,
}: {
  workspaceId: string;
  documentId: string;
  detail: DocumentDetail;
  archived: boolean;
  onOpenProperties: () => void;
  onOpenImport: () => void;
  onExport: () => void;
  onOpenRender: () => void;
}) {
  const router = useRouter();
  const archiveDocument = useArchiveDocument(workspaceId);
  const restoreDocument = useRestoreDocument(workspaceId);
  const workspaces = useWorkspaces();
  const workspaceName = workspaces.data?.find((workspace) => workspace.id === workspaceId)?.name;
  // Not for a page reached through a share: the reader is not a member of this
  // workspace, so asking about its inbox is a refused request on every load.
  const inbox = useInbox(detail.viaShare ? undefined : workspaceId);
  const [filing, setFiling] = React.useState(false);
  const [templateSettings, setTemplateSettings] = React.useState(false);
  const [sharing, setSharing] = React.useState(false);
  /*
   * Asked on every page view, not only when the dialog opens (issue #83): the
   * badge below is the only thing that tells somebody a page is readable from
   * outside, and the case that matters most is the one they would never open a
   * dialog to check -- a page that is shared because a section above it is.
   */
  const isShared = useIsShared(documentId, detail.viaShare);

  /*
   * Filing is offered where the captured page is read, not only in the tree's
   * context menu (issue #71). Somebody emptying the inbox opens an entry,
   * decides what it is, and that is the moment the question "where does this
   * belong" can be answered -- a menu two levels deep in the navigation is not
   * where that decision gets made.
   */
  const inInbox =
    detail.parentId !== null && detail.parentId === (inbox.data?.inbox?.id ?? null) && !archived;

  return (
    <div className="flex items-center gap-2 border-b border-border px-6 py-2">
      <PageBreadcrumb workspaceId={workspaceId} workspaceName={workspaceName} detail={detail} />

      {detail.aiRuleMode !== 'off' ? (
        <Badge variant="muted" data-testid="ai-rule-badge">
          {AI_RULE_BADGE_LABEL[detail.aiRuleMode]}
        </Badge>
      ) : null}

      {isShared ? (
        <Badge variant="outline" data-testid="share-badge">
          <Share2Icon className="size-3" /> Geteilt
        </Badge>
      ) : null}

      <div className="ml-auto flex items-center gap-3">
        {!archived && detail.access === 'write' ? <SaveIndicator /> : null}

        {inInbox && detail.access === 'write' ? (
          <Button
            variant="outline"
            size="sm"
            data-testid="file-from-inbox"
            onClick={() => setFiling(true)}
          >
            <FolderTreeIcon /> Einsortieren …
          </Button>
        ) : null}

        {archived ? (
          <Button
            variant="outline"
            size="sm"
            data-testid="restore-document"
            onClick={() => void restoreDocument.mutateAsync(documentId)}
          >
            <RotateCcwIcon /> Wiederherstellen
          </Button>
        ) : null}

        <PageActionsMenu
          canShare={detail.canShare}
          archived={archived}
          onOpenProperties={onOpenProperties}
          onOpenTemplateSettings={() => setTemplateSettings(true)}
          onOpenShare={() => setSharing(true)}
          onExport={onExport}
          onOpenRender={onOpenRender}
          onOpenImport={onOpenImport}
          onArchive={() => {
            void archiveDocument
              .mutateAsync(documentId)
              .then(() => router.push(`/arbeitsbereich/${workspaceId}`));
          }}
        />
      </div>

      <SuggestParentDialog
        workspaceId={workspaceId}
        node={filing ? { id: documentId, title: detail.title, parentId: detail.parentId } : null}
        onClose={() => setFiling(false)}
      />

      <TemplateSettingsDialog
        workspaceId={workspaceId}
        documentId={documentId}
        documentTitle={detail.title}
        open={templateSettings}
        onOpenChange={setTemplateSettings}
      />

      <ShareDialog
        documentId={documentId}
        documentTitle={detail.title}
        open={sharing}
        onOpenChange={setSharing}
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

/**
 * The page's own actions, in one menu.
 *
 * Extracted from `DocumentTopBar` rather than inlined: the bar had grown past
 * what the complexity rule allows, and a menu of eight entries is a thing in
 * its own right. It takes callbacks and nothing else, so it holds no state and
 * knows nothing about workspaces.
 */
function PageActionsMenu({
  canShare,
  archived,
  onOpenProperties,
  onOpenTemplateSettings,
  onOpenShare,
  onExport,
  onOpenRender,
  onOpenImport,
  onArchive,
}: {
  canShare: boolean;
  archived: boolean;
  onOpenProperties: () => void;
  onOpenTemplateSettings: () => void;
  onOpenShare: () => void;
  onExport: () => void;
  onOpenRender: () => void;
  onOpenImport: () => void;
  onArchive: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Seitenaktionen"
            data-testid="document-actions"
          >
            <MoreHorizontalIcon />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem data-testid="open-page-properties" onClick={onOpenProperties}>
          <SlidersHorizontalIcon /> Seiteneigenschaften …
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="open-template-settings" onClick={onOpenTemplateSettings}>
          <LayoutTemplateIcon /> Vorlage …
        </DropdownMenuItem>
        {canShare ? (
          <DropdownMenuItem data-testid="open-share" onClick={onOpenShare}>
            <Share2Icon /> Teilen …
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="export-markdown" onClick={onExport}>
          <DownloadIcon /> Als Markdown exportieren
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="open-render" onClick={onOpenRender}>
          <FileTextIcon /> Als PDF veröffentlichen …
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="open-import" onClick={onOpenImport}>
          <UploadIcon /> Markdown importieren
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={archived}
          data-testid="archive-document"
          onClick={onArchive}
        >
          <TrashIcon /> In den Papierkorb
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Whether anybody outside this workspace can reach the page (issue #83).
 *
 * Asked on every page view rather than only when the share dialog opens,
 * because the badge it feeds is the only thing that tells somebody a page is
 * readable from outside -- and the case that matters most is the one nobody
 * would open a dialog to check: a page that is shared because a section above
 * it is. A reader who is here through a share is not asked at all; they are
 * told nothing about the other grants on the page.
 */
function useIsShared(documentId: string, viaShare: boolean): boolean {
  const shares = useDocumentShares(documentId, { enabled: !viaShare });
  const live = (shares.data?.shares ?? []).filter((share) => share.revokedAt === null);
  return live.length + (shares.data?.inherited ?? []).length > 0;
}

/**
 * Where the page sits, as a line of links.
 *
 * Its own component because the bar it came out of had grown past what the
 * complexity rule allows, and because a breadcrumb is the one part of the bar
 * that is pure rendering: it holds no state and calls nothing.
 *
 * `breadcrumb` is already cut for a reader who is here through a share (issue
 * #83, ADR-044) -- the API stops it at the shared page -- so nothing here has
 * to know that shares exist.
 */
function PageBreadcrumb({
  workspaceId,
  workspaceName,
  detail,
}: {
  workspaceId: string;
  workspaceName: string | undefined;
  detail: DocumentDetail;
}) {
  return (
    <nav
      aria-label="Pfad"
      className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
    >
      {/* The workspace starts the path, so its overview is one click away
          instead of two through the switcher. It is skipped while the list
          is still loading rather than shown under a placeholder name. */}
      {workspaceName === undefined ? null : (
        <>
          <Link
            href={`/arbeitsbereich/${workspaceId}`}
            className="flex max-w-32 items-center gap-1 truncate hover:text-foreground"
            data-testid="breadcrumb-workspace"
          >
            <TruncatedText text={workspaceName} side="bottom" />
          </Link>
          <span aria-hidden>/</span>
        </>
      )}
      {detail.breadcrumb.map((entry) => (
        <React.Fragment key={entry.id}>
          <Link
            href={`/arbeitsbereich/${workspaceId}/seite/${entry.id}`}
            className="flex max-w-32 items-center gap-1 truncate hover:text-foreground"
          >
            {/* Only a chosen symbol, never the default one: a path is a line
                  of text, and a file icon in front of every step would say
                  nothing the path does not already say. */}
            {entry.icon === null ? null : (
              <DocumentIcon
                icon={entry.icon}
                iconColor={entry.iconColor}
                type="PAGE"
                className="size-3.5 text-xs"
              />
            )}
            <TruncatedText text={entry.title} side="bottom" />
          </Link>
          <span aria-hidden>/</span>
        </React.Fragment>
      ))}
      <TruncatedText text={detail.title} side="bottom" className="max-w-40 text-foreground" />
    </nav>
  );
}
