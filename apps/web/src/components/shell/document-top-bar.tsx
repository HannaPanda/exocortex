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
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DocumentDetail } from '@exocortex/contracts';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@exocortex/ui';

import { usePageMenuCommands } from '@/components/palette/page-commands';
import { useArchiveDocument, useRestoreDocument } from '@/lib/api/document-queries';
import { useInbox } from '@/lib/api/inbox-queries';
import { useDocumentShares } from '@/lib/api/share-queries';
import { useWorkspaces } from '@/lib/api/workspace-queries';

import { PageBreadcrumb } from './page-breadcrumb';
import { SaveIndicator } from './save-indicator';
import { ShareDialog } from './share-dialog';
import { SuggestParentDialog } from './suggest-parent-dialog';
import { TemplateSettingsDialog } from './template-settings-dialog';

const AI_RULE_BADGE_KEY = {
  always: 'aiRuleAlways',
  on_demand: 'aiRuleOnDemand',
} as const satisfies Record<'always' | 'on_demand', string>;

/** Breadcrumb, rule badge and the page's own actions. */
export function DocumentTopBar({
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
  const t = useTranslations('shell.documentTopBar');
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

  const archive = (): void => {
    void archiveDocument
      .mutateAsync(documentId)
      .then(() => router.push(`/arbeitsbereich/${workspaceId}`));
  };

  // The same menu, reachable by name from Strg + K (issue #148).
  usePageMenuCommands(detail, archived, {
    openTemplate: () => setTemplateSettings(true),
    openShare: () => setSharing(true),
    file: () => setFiling(true),
    archive,
    restore: () => void restoreDocument.mutateAsync(documentId),
  });

  return (
    <div className="flex items-center gap-2 border-b border-border px-6 py-2">
      <PageBreadcrumb workspaceId={workspaceId} workspaceName={workspaceName} detail={detail} />

      {detail.aiRuleMode !== 'off' ? (
        <Badge variant="muted" data-testid="ai-rule-badge">
          {t(AI_RULE_BADGE_KEY[detail.aiRuleMode])}
        </Badge>
      ) : null}

      {isShared ? (
        <Badge variant="outline" data-testid="share-badge">
          <Share2Icon className="size-3" /> {t('shared')}
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
            <FolderTreeIcon /> {t('file')}
          </Button>
        ) : null}

        {archived ? (
          <Button
            variant="outline"
            size="sm"
            data-testid="restore-document"
            onClick={() => void restoreDocument.mutateAsync(documentId)}
          >
            <RotateCcwIcon /> {t('restore')}
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
          onArchive={archive}
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
  const t = useTranslations('shell.documentTopBar');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('actions')}
            data-testid="document-actions"
          >
            <MoreHorizontalIcon />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem data-testid="open-page-properties" onClick={onOpenProperties}>
          <SlidersHorizontalIcon /> {t('properties')}
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="open-template-settings" onClick={onOpenTemplateSettings}>
          <LayoutTemplateIcon /> {t('template')}
        </DropdownMenuItem>
        {canShare ? (
          <DropdownMenuItem data-testid="open-share" onClick={onOpenShare}>
            <Share2Icon /> {t('share')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="export-markdown" onClick={onExport}>
          <DownloadIcon /> {t('exportMarkdown')}
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="open-render" onClick={onOpenRender}>
          <FileTextIcon /> {t('render')}
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="open-import" onClick={onOpenImport}>
          <UploadIcon /> {t('importMarkdown')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={archived}
          data-testid="archive-document"
          onClick={onArchive}
        >
          <TrashIcon /> {t('archive')}
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
