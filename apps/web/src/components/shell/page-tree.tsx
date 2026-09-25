'use client';

import { Trash2Icon } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type CreatableDocumentType,
  type DocumentTreeNode,
  type MoveDocumentRequest,
} from '@exocortex/contracts';
import { cn, EmptyState, ErrorState, LoadingState, ScrollArea } from '@exocortex/ui';

import {
  useArchiveDocument,
  useCreateDocument,
  useDocumentTree,
  useMoveDocument,
  useUpdateDocument,
} from '@/lib/api/document-queries';
import { useCreateProject } from '@/lib/api/project-queries';
import { documentHref } from '@/lib/document-href';
import { usePersistentState } from '@/lib/use-persistent-state';

import { MoveWorkspaceDialog } from './move-workspace-dialog';
import { PageTreeHeader } from './page-tree-header';
import { PageTreeRow, type PageTreeRowContext } from './page-tree-row';
import {
  ancestorsOf,
  canCollapseAll,
  collapseAll,
  EMPTY_EXPANDED,
  type ExpandedState,
  expandSiblings,
  indexTree,
  type NudgeDirection,
  nudgeRequest,
  parseExpanded,
  setSubtree,
} from './page-tree-state';
import { SmartViews } from './smart-views';
import { SuggestParentDialog } from './suggest-parent-dialog';
import { TemplatePickerDialog } from './template-picker-dialog';
import { useTreeDrag } from './use-tree-drag';
import { useTreeKeyboard } from './use-tree-keyboard';

interface PageTreeProps {
  workspaceId: string;
  /**
   * Opens the trash, which the shell owns.
   *
   * It used to live here, which meant it existed only while the navigation was
   * open -- so the command palette could not reach it, and neither could a
   * narrow window. The button below is still the way most people get there.
   */
  onOpenTrash: () => void;
}

/**
 * Hierarchical page tree.
 *
 * Ordering comes from the server's fractional `orderKey`; the client never
 * computes order — it names the sibling to land before or after and lets the
 * server work out the key. Tree updates arrive through `document.*` realtime
 * events, which the shell turns into query invalidations.
 *
 * Rows can be dragged, and every drag has a keyboard equivalent in the context
 * menu (`Alt` plus an arrow key). Native HTML5 drag and drop rather than a
 * library: the tree is one list of rows with three drop zones each, which the
 * platform already does, and a drag-and-drop library is a second interaction
 * framework to keep in step with the design system. Native drag has no keyboard
 * story at all, which is why the four commands are not a nicety here but the
 * other half of the feature.
 */
export function PageTree({ workspaceId, onOpenTrash }: PageTreeProps) {
  const t = useTranslations('shell.pageTree');
  const params = useParams<{ documentId?: string }>();
  const router = useRouter();
  const tree = useDocumentTree(workspaceId);
  const createDocument = useCreateDocument(workspaceId);
  const createProjectMutation = useCreateProject(workspaceId);
  const archiveDocument = useArchiveDocument(workspaceId);
  const updateDocument = useUpdateDocument(workspaceId);
  const moveDocument = useMoveDocument(workspaceId);
  // Per workspace, and persisted: which rows are unfolded is orientation, and
  // orientation that a reload throws away is orientation nobody relies on.
  const [expanded, setExpanded] = usePersistentState<ExpandedState>(
    `exocortex.tree.expanded.${workspaceId}`,
    EMPTY_EXPANDED,
    parseExpanded,
  );
  const [templatePicker, setTemplatePicker] = React.useState(false);
  // Which row's icon picker is open. One id rather than one flag per row,
  // because two of them can never be open at the same time, and because the
  // context menu has to be able to open the picker of the row it belongs to.
  const [iconPickerFor, setIconPickerFor] = React.useState<string | null>(null);
  // The node offered for a cross-workspace move, and the workspace picked for
  // it. Kept as one pair rather than a boolean flag, because the dialog needs
  // to know which subtree it is about.
  const [moveWorkspaceNode, setMoveWorkspaceNode] = React.useState<DocumentTreeNode | null>(null);
  const [suggestParentNode, setSuggestParentNode] = React.useState<DocumentTreeNode | null>(null);
  const [moveTargetWorkspaceId, setMoveTargetWorkspaceId] = React.useState('');

  const treeRef = React.useRef<HTMLUListElement | null>(null);

  const activeDocumentId = params.documentId;
  const nodes = tree.data?.nodes;
  const positions = React.useMemo(() => indexTree(nodes ?? []), [nodes]);

  /**
   * Which document the unfolding below has already been done for.
   *
   * The whole point of the ref: unfolding happens **once per arrival**, not for
   * as long as a page is the active one. Re-running it whenever `expanded`
   * changes would undo the very next click on the chevron of an ancestor —
   * folding away the subtree you are standing in would snap straight back open.
   */
  const unfoldedFor = React.useRef<string | null>(null);

  /**
   * Unfolds the path down to the open document.
   *
   * Without this the active row is marked but not rendered: the marking sits on
   * a node inside a folded parent, so opening a subpage through the search, a
   * reference in the text or a direct link left the tree showing nothing at all
   * (issue #29). Navigation *opens* the path and then leaves it to the reader.
   */
  React.useEffect(() => {
    if (activeDocumentId === undefined) {
      // Back on the overview. Arriving at the same page again should unfold
      // again, so this is a fresh arrival rather than the one already handled.
      unfoldedFor.current = null;
      return;
    }
    if (nodes === undefined || unfoldedFor.current === activeDocumentId) return;

    const path = ancestorsOf(nodes, activeDocumentId);
    // Not in the tree yet — a page just created, or a tree still catching up.
    // Leave the ref alone so the next version of the tree tries again.
    if (path === null) return;

    unfoldedFor.current = activeDocumentId;
    if (path.every((id) => expanded[id] === true)) return;
    setExpanded({ ...expanded, ...Object.fromEntries(path.map((id) => [id, true])) });
  }, [activeDocumentId, expanded, nodes, setExpanded]);

  const toggle = (documentId: string): void => {
    setExpanded({ ...expanded, [documentId]: expanded[documentId] !== true });
  };

  const createChild = async (
    parentId: string | null,
    type: CreatableDocumentType = 'PAGE',
  ): Promise<void> => {
    const document = await createDocument.mutateAsync({
      title: type === 'COLLECTION' ? t('untitledDatabase') : t('untitledPage'),
      type,
      parentId,
    });
    if (parentId !== null) setExpanded({ ...expanded, [parentId]: true });
    router.push(documentHref(workspaceId, document.id, type));
  };

  /**
   * A project is created through its own route, not the generic one: it needs a
   * sidecar row and a compilable first file, and a `PROJECT` that arrived
   * through `POST /api/documents` would have neither (issue #43, ADR-027).
   */
  const createProject = async (parentId: string | null): Promise<void> => {
    const { project } = await createProjectMutation.mutateAsync({
      title: t('untitledProject'),
      parentId,
    });
    if (parentId !== null) setExpanded({ ...expanded, [parentId]: true });
    router.push(documentHref(workspaceId, project.id, 'PROJECT'));
  };

  const submitMove = (documentId: string, request: MoveDocumentRequest): void => {
    // A page dropped into another one is only useful once you can see it there.
    if (request.parentId !== null) setExpanded({ ...expanded, [request.parentId]: true });
    void moveDocument.mutateAsync({ documentId, request });
  };

  const drag = useTreeDrag({ positions, expanded, setExpanded, submitMove });

  const nudge = (documentId: string, direction: NudgeDirection): void => {
    const request = nudgeRequest(positions, documentId, direction);
    if (request !== null) submitMove(documentId, request);
  };

  const canNudge = (documentId: string, direction: NudgeDirection): boolean =>
    nudgeRequest(positions, documentId, direction) !== null;

  // One tab stop, then arrow keys. Declared after `toggle` and `nudge` because
  // it drives both of them, and before the render because the tab stop is a
  // property of every row.
  const { tabStopId, onRowKeyDown, onRowFocus } = useTreeKeyboard({
    containerRef: treeRef,
    nodes: nodes ?? [],
    expanded,
    activeDocumentId,
    toggle,
    setSubtreeOpen: (documentId, open) => {
      const target = positions.get(documentId)?.node;
      if (target !== undefined) setExpanded(setSubtree(expanded, target, open));
    },
    expandSiblingsOf: (documentId) => {
      const siblings = positions.get(documentId)?.siblings;
      if (siblings !== undefined) setExpanded(expandSiblings(expanded, siblings));
    },
    nudge,
    openDocument: (documentId) => {
      const target = positions.get(documentId)?.node;
      if (target === undefined) return;
      router.push(documentHref(workspaceId, target.id, target.type));
    },
  });

  if (tree.isPending) return <LoadingState variant="skeleton" rows={6} label={t('loading')} />;
  if (tree.isError) {
    return <ErrorState onRetry={() => void tree.refetch()} title={t('loadError')} />;
  }

  const rowContext: PageTreeRowContext = {
    workspaceId,
    activeDocumentId,
    tabStopId,
    onRowKeyDown,
    onRowFocus,
    expanded,
    draggedId: drag.draggedId,
    dropTarget: drag.dropTarget,
    iconPickerFor,
    setIconPickerFor,
    setDraggedId: drag.setDraggedId,
    setDropTarget: drag.setDropTarget,
    cancelSpringOpen: drag.cancelSpringOpen,
    onRowDragOver: drag.onRowDragOver,
    onRowDrop: drag.onRowDrop,
    toggle,
    nudge,
    canNudge,
    createChild: (parentId, type) => void createChild(parentId, type),
    createProject: (parentId) => void createProject(parentId),
    setIcon: (documentId, selection) => {
      void updateDocument.mutateAsync({ documentId, request: selection });
    },
    archive: (documentId) => void archiveDocument.mutateAsync(documentId),
    startWorkspaceMove: (node) => {
      setMoveWorkspaceNode(node);
      setMoveTargetWorkspaceId('');
    },
    suggestParent: (node) => setSuggestParentNode(node),
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageTreeHeader
        onCreatePage={() => void createChild(null)}
        onCreateFromTemplate={() => setTemplatePicker(true)}
        onCreateDatabase={() => void createChild(null, 'COLLECTION')}
        onCreateProject={() => void createProject(null)}
        canCollapseAll={canCollapseAll(tree.data.nodes, expanded, activeDocumentId)}
        onCollapseAll={() => setExpanded(collapseAll(tree.data.nodes, activeDocumentId))}
      />

      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-1 pb-2" clampContentWidth>
        {tree.data.nodes.length === 0 ? (
          <EmptyState
            title={t('emptyTitle')}
            description={t('emptyDescription')}
            action={{ label: t('emptyAction'), onClick: () => void createChild(null) }}
          />
        ) : (
          <ul ref={treeRef} role="tree" aria-label={t('treeLabel')} data-testid="page-tree">
            {tree.data.nodes.map((node) => (
              <PageTreeRow key={node.id} node={node} depth={0} context={rowContext} />
            ))}
          </ul>
        )}

        {/* Only while something is being dragged, and only for a page that is not
            already at the top level. Without it, a page three levels down can be
            dragged onto any row but never simply out. */}
        {drag.draggedNode !== null && drag.draggedNode.parentId !== null ? (
          <div
            {...drag.rootDropHandlers}
            data-testid="tree-root-drop"
            className={cn(
              'mt-1 rounded-md border border-dashed px-2 py-1.5 text-xs transition-colors',
              drag.rootDropActive
                ? 'border-primary bg-accent text-foreground'
                : 'border-border text-muted-foreground',
            )}
          >
            {t('rootDrop')}
          </div>
        ) : null}

        <SmartViews workspaceId={workspaceId} />

        {/* The trash opens as its own sheet rather than unfolding here: what it
            has to show (structure, dates, what came along, a selection) does not
            fit a navigation column, and half of it is unreadable when it does. */}
        <div className="mt-2 border-t border-border pt-2">
          <button
            type="button"
            onClick={onOpenTrash}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            data-testid="toggle-trash"
          >
            <Trash2Icon className="size-3.5" />
            {t('trash')}
            <span className="exocortex-numeric ml-auto">{tree.data.archived.length}</span>
          </button>
        </div>
      </ScrollArea>

      <SuggestParentDialog
        workspaceId={workspaceId}
        node={suggestParentNode}
        onClose={() => setSuggestParentNode(null)}
      />

      <TemplatePickerDialog
        workspaceId={workspaceId}
        open={templatePicker}
        onOpenChange={setTemplatePicker}
      />

      <MoveWorkspaceDialog
        workspaceId={workspaceId}
        node={moveWorkspaceNode}
        onClose={() => setMoveWorkspaceNode(null)}
        targetWorkspaceId={moveTargetWorkspaceId}
        onTargetChange={setMoveTargetWorkspaceId}
        activeDocumentId={activeDocumentId}
      />
    </div>
  );
}
