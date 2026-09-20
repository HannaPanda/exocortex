'use client';

import { FolderCodeIcon, LayoutTemplateIcon, PlusIcon, TableIcon, Trash2Icon } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import * as React from 'react';

import {
  type CreatableDocumentType,
  type DocumentTreeNode,
  type MoveDocumentRequest,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
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
  DropdownMenuTrigger,
  EmptyState,
  ErrorState,
  LoadingState,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import {
  useArchiveDocument,
  useCreateDocument,
  useDocumentTree,
  useMoveDocument,
  useUpdateDocument,
} from '@/lib/api/document-queries';
import { messageForCode } from '@/lib/api/error-messages';
import { useCreateProject } from '@/lib/api/project-queries';
import { useWorkspaces } from '@/lib/api/workspace-queries';
import { documentHref } from '@/lib/document-href';
import { usePersistentState } from '@/lib/use-persistent-state';

import { PageTreeRow, type PageTreeRowContext } from './page-tree-row';
import {
  ancestorsOf,
  type DropZone,
  EMPTY_EXPANDED,
  type ExpandedState,
  indexTree,
  isSelfOrDescendant,
  parseExpanded,
} from './page-tree-state';
import { SmartViews } from './smart-views';
import { SuggestParentDialog } from './suggest-parent-dialog';
import { TemplatePickerDialog } from './template-picker-dialog';
import { TrashSheet } from './trash-sheet';

interface PageTreeProps {
  workspaceId: string;
}

/**
 * How long a folded page has to be hovered before it opens under the pointer.
 *
 * Long enough that dragging *past* a folded page does not open it, short enough
 * that dropping something three levels down does not need three separate drags.
 */

const SPRING_OPEN_MS = 700;

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
export function PageTree({ workspaceId }: PageTreeProps) {
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
  const [showTrash, setShowTrash] = React.useState(false);
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
  // The row being dragged, and the row it is currently over. Two pieces of state
  // rather than one: the dragged row stays marked while the pointer travels over
  // rows that would refuse it.
  const [draggedId, setDraggedId] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<{ id: string; zone: DropZone } | null>(null);
  const [rootDropActive, setRootDropActive] = React.useState(false);

  const activeDocumentId = params.documentId;
  const nodes = tree.data?.nodes;
  const positions = React.useMemo(() => indexTree(nodes ?? []), [nodes]);

  /**
   * The folded row the pointer is currently resting on, and the timer that will
   * open it. A ref because it changes on every `dragover` — dozens per second —
   * and none of those changes belong on screen.
   */
  const springOpen = React.useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(
    null,
  );

  const cancelSpringOpen = React.useCallback((): void => {
    if (springOpen.current === null) return;
    clearTimeout(springOpen.current.timer);
    springOpen.current = null;
  }, []);

  React.useEffect(() => cancelSpringOpen, [cancelSpringOpen]);

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
      title: type === 'COLLECTION' ? 'Unbenannte Datenbank' : 'Unbenannte Seite',
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
      title: 'Unbenanntes Projekt',
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

  /** Turns "over that row, in its upper third" into a move the server accepts. */
  const dropOn = (documentId: string, targetId: string, zone: DropZone): void => {
    const target = positions.get(targetId);
    if (target === undefined) return;

    if (zone === 'inside') {
      submitMove(documentId, { parentId: targetId });
      return;
    }
    submitMove(documentId, {
      parentId: target.parentId,
      ...(zone === 'before' ? { beforeSiblingId: targetId } : { afterSiblingId: targetId }),
    });
  };

  /**
   * The keyboard half of dragging.
   *
   * Up and down swap a page with the neighbour it already has; in and out change
   * which page it belongs to. Four commands cover every move a drag can make
   * except moving across a long distance, and that is what the drag is for.
   */
  const nudge = (documentId: string, direction: 'up' | 'down' | 'in' | 'out'): void => {
    const position = positions.get(documentId);
    if (position === undefined) return;
    const { parentId, siblings, index } = position;

    if (direction === 'up') {
      const previous = siblings[index - 1];
      if (previous !== undefined)
        submitMove(documentId, { parentId, beforeSiblingId: previous.id });
      return;
    }
    if (direction === 'down') {
      const next = siblings[index + 1];
      if (next !== undefined) submitMove(documentId, { parentId, afterSiblingId: next.id });
      return;
    }
    if (direction === 'in') {
      // Into the page above it, which is where an outline puts it.
      const previous = siblings[index - 1];
      if (previous !== undefined) submitMove(documentId, { parentId: previous.id });
      return;
    }
    if (parentId === null) return;
    const parent = positions.get(parentId);
    if (parent === undefined) return;
    submitMove(documentId, { parentId: parent.parentId, afterSiblingId: parentId });
  };

  const canNudge = (documentId: string, direction: 'up' | 'down' | 'in' | 'out'): boolean => {
    const position = positions.get(documentId);
    if (position === undefined) return false;
    if (direction === 'up' || direction === 'in') return position.index > 0;
    if (direction === 'down') return position.index < position.siblings.length - 1;
    return position.parentId !== null;
  };

  const draggedNode = draggedId === null ? null : (positions.get(draggedId)?.node ?? null);

  /** Whether a row is allowed to receive the page currently being dragged. */
  const acceptsDrop = (targetId: string): boolean =>
    draggedNode !== null && !isSelfOrDescendant(draggedNode, targetId);

  const onRowDragOver = (event: React.DragEvent<HTMLDivElement>, node: DocumentTreeNode): void => {
    // No `preventDefault` means "not a drop target", which is how the browser is
    // told that a page cannot be dropped into itself.
    if (!acceptsDrop(node.id)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    const rect = event.currentTarget.getBoundingClientRect();
    const offset = (event.clientY - rect.top) / rect.height;
    // The middle half of the row means "into", the edges mean "between". A row
    // is 28 pixels tall, so the edges are seven each: enough to hit on purpose,
    // small enough that the common drop is the one in the middle.
    const zone: DropZone = offset < 0.25 ? 'before' : offset > 0.75 ? 'after' : 'inside';

    if (dropTarget?.id !== node.id || dropTarget.zone !== zone) {
      setDropTarget({ id: node.id, zone });
    }

    const shouldSpring =
      zone === 'inside' && node.children.length > 0 && expanded[node.id] !== true;
    if (!shouldSpring) {
      if (springOpen.current?.id === node.id) cancelSpringOpen();
      return;
    }
    if (springOpen.current?.id === node.id) return;
    cancelSpringOpen();
    springOpen.current = {
      id: node.id,
      timer: setTimeout(() => {
        springOpen.current = null;
        setExpanded({ ...expanded, [node.id]: true });
      }, SPRING_OPEN_MS),
    };
  };

  const onRowDrop = (event: React.DragEvent<HTMLDivElement>, node: DocumentTreeNode): void => {
    event.preventDefault();
    const zone = dropTarget?.id === node.id ? dropTarget.zone : 'inside';
    const documentId = draggedId;
    setDraggedId(null);
    setDropTarget(null);
    cancelSpringOpen();
    if (documentId === null || !acceptsDrop(node.id)) return;
    dropOn(documentId, node.id, zone);
  };

  if (tree.isPending)
    return <LoadingState variant="skeleton" rows={6} label="Seiten werden geladen" />;
  if (tree.isError) {
    return <ErrorState onRetry={() => void tree.refetch()} title="Seitenbaum nicht geladen" />;
  }

  const rowContext: PageTreeRowContext = {
    workspaceId,
    activeDocumentId,
    expanded,
    draggedId,
    dropTarget,
    iconPickerFor,
    setIconPickerFor,
    setDraggedId,
    setDropTarget,
    cancelSpringOpen,
    onRowDragOver,
    onRowDrop,
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
      <TreeHeader
        onCreatePage={() => void createChild(null)}
        onCreateFromTemplate={() => setTemplatePicker(true)}
        onCreateDatabase={() => void createChild(null, 'COLLECTION')}
        onCreateProject={() => void createProject(null)}
      />

      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-1 pb-2" clampContentWidth>
        {tree.data.nodes.length === 0 ? (
          <EmptyState
            title="Noch keine Seiten"
            description="Lege deine erste Seite an, um zu beginnen."
            action={{ label: 'Seite anlegen', onClick: () => void createChild(null) }}
          />
        ) : (
          <ul data-testid="page-tree">
            {tree.data.nodes.map((node) => (
              <PageTreeRow key={node.id} node={node} depth={0} context={rowContext} />
            ))}
          </ul>
        )}

        {/* Only while something is being dragged, and only for a page that is not
            already at the top level. Without it, a page three levels down can be
            dragged onto any row but never simply out. */}
        {draggedNode !== null && draggedNode.parentId !== null ? (
          <div
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setRootDropActive(true);
            }}
            onDragLeave={() => setRootDropActive(false)}
            onDrop={(event) => {
              event.preventDefault();
              const documentId = draggedId;
              setRootDropActive(false);
              setDraggedId(null);
              setDropTarget(null);
              cancelSpringOpen();
              if (documentId !== null) submitMove(documentId, { parentId: null });
            }}
            data-testid="tree-root-drop"
            className={cn(
              'mt-1 rounded-md border border-dashed px-2 py-1.5 text-xs transition-colors',
              rootDropActive
                ? 'border-primary bg-accent text-foreground'
                : 'border-border text-muted-foreground',
            )}
          >
            Hierher: oberste Ebene
          </div>
        ) : null}

        <SmartViews workspaceId={workspaceId} />

        {/* The trash opens as its own sheet rather than unfolding here: what it
            has to show (structure, dates, what came along, a selection) does not
            fit a navigation column, and half of it is unreadable when it does. */}
        <div className="mt-2 border-t border-border pt-2">
          <button
            type="button"
            onClick={() => setShowTrash(true)}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            data-testid="toggle-trash"
          >
            <Trash2Icon className="size-3.5" />
            Papierkorb
            <span className="exocortex-numeric ml-auto">{tree.data.archived.length}</span>
          </button>
        </div>
      </ScrollArea>

      <TrashSheet workspaceId={workspaceId} open={showTrash} onOpenChange={setShowTrash} />

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

/**
 * Moving a page into another workspace, with the one thing that is not obvious
 * spelled out: everything under it comes along, and its members can see it.
 */
function MoveWorkspaceDialog({
  workspaceId,
  node,
  onClose,
  targetWorkspaceId,
  onTargetChange,
  activeDocumentId,
}: {
  workspaceId: string;
  node: DocumentTreeNode | null;
  onClose: () => void;
  targetWorkspaceId: string;
  onTargetChange: (workspaceId: string) => void;
  activeDocumentId: string | undefined;
}) {
  const router = useRouter();
  const workspaces = useWorkspaces();
  const moveDocument = useMoveDocument(workspaceId);

  return (
    <Dialog
      open={node !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>In anderen Arbeitsbereich verschieben</DialogTitle>
          <DialogDescription>
            „{node?.title}“ wandert mit allen Unterseiten, Anhängen und eingebetteten Datenbanken in
            den gewählten Arbeitsbereich. Inhalte, die bisher nur du gesehen hast, sind danach für
            dessen Mitglieder sichtbar wie jede andere Seite dort auch.
          </DialogDescription>
        </DialogHeader>

        {moveDocument.isError ? (
          <Alert variant="destructive" data-testid="move-workspace-error">
            <AlertDescription>
              {messageForCode(
                moveDocument.error instanceof ApiError ? moveDocument.error.code : undefined,
              )}
            </AlertDescription>
          </Alert>
        ) : null}

        <Select
          value={targetWorkspaceId.length === 0 ? null : targetWorkspaceId}
          onValueChange={(next) => onTargetChange(next ?? '')}
        >
          <SelectTrigger data-testid="move-workspace-select">
            <SelectValue>
              {() =>
                workspaces.data?.find((option) => option.id === targetWorkspaceId)?.name ??
                'Zielarbeitsbereich wählen'
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(workspaces.data ?? [])
              .filter((option) => option.id !== workspaceId)
              .map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            data-testid="move-workspace-submit"
            disabled={targetWorkspaceId.length === 0 || moveDocument.isPending}
            onClick={() => {
              if (node === null) return;
              const movedId = node.id;
              const targetId = targetWorkspaceId;
              void moveDocument
                .mutateAsync({
                  documentId: movedId,
                  request: { parentId: null, workspaceId: targetId },
                })
                .then(() => {
                  onClose();
                  // The page that just left this workspace can no longer be
                  // shown under its old workspaceId route.
                  if (activeDocumentId === movedId) {
                    router.push(`/arbeitsbereich/${targetId}/seite/${movedId}`);
                  }
                });
            }}
          >
            Verschieben
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The "Seiten" label and the menu that creates things under it.
 *
 * Its own component because the three entries each carry a test id, an icon and
 * a label, and forty lines of that in the middle of the tree makes the tree
 * harder to read than the menu is worth.
 */
function TreeHeader({
  onCreatePage,
  onCreateFromTemplate,
  onCreateDatabase,
  onCreateProject,
}: {
  onCreatePage: () => void;
  onCreateFromTemplate: () => void;
  onCreateDatabase: () => void;
  onCreateProject: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5 px-2 py-1.5">
      {/* The same mark the overview and the context panel use, so "this is a
          section" looks identical wherever the reader meets it. */}
      <span className="size-1 shrink-0 bg-signal-line" aria-hidden />
      <p className="text-[0.6875rem] font-medium tracking-[0.14em] text-muted-foreground uppercase">
        Seiten
      </p>
      <span className="h-px w-6 shrink-0 bg-signal-line" aria-hidden />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Anlegen"
              data-testid="create-root-page"
            >
              <PlusIcon />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem data-testid="create-root-page-item" onClick={onCreatePage}>
            <PlusIcon /> Seite anlegen
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="create-root-from-template" onClick={onCreateFromTemplate}>
            <LayoutTemplateIcon /> Seite aus Vorlage
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="create-root-database" onClick={onCreateDatabase}>
            <TableIcon /> Datenbank anlegen
          </DropdownMenuItem>
          <DropdownMenuItem data-testid="create-root-project" onClick={onCreateProject}>
            <FolderCodeIcon /> LaTeX-Projekt anlegen
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
