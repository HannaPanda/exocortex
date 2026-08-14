'use client';

import {
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  FolderInputIcon,
  IndentDecreaseIcon,
  IndentIncreaseIcon,
  PlusIcon,
  SmilePlusIcon,
  TableIcon,
  Trash2Icon,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import * as React from 'react';

import {
  type DocumentTreeNode,
  type DocumentType,
  type MoveDocumentRequest,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
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

import { DocumentIcon } from '@/components/document/document-icon';
import { PageIconPicker } from '@/components/document/page-icon-picker';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import {
  useArchiveDocument,
  useCreateDocument,
  useDocumentTree,
  useMoveDocument,
  useUpdateDocument,
  useWorkspaces,
} from '@/lib/api/queries';
import { usePersistentState } from '@/lib/use-persistent-state';

import {
  ancestorsOf,
  type DropZone,
  EMPTY_EXPANDED,
  type ExpandedState,
  indexTree,
  isSelfOrDescendant,
  parseExpanded,
} from './page-tree-state';
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
  const archiveDocument = useArchiveDocument(workspaceId);
  const updateDocument = useUpdateDocument(workspaceId);
  const moveDocument = useMoveDocument(workspaceId);
  const workspaces = useWorkspaces();
  // Per workspace, and persisted: which rows are unfolded is orientation, and
  // orientation that a reload throws away is orientation nobody relies on.
  const [expanded, setExpanded] = usePersistentState<ExpandedState>(
    `exocortex.tree.expanded.${workspaceId}`,
    EMPTY_EXPANDED,
    parseExpanded,
  );
  const [showTrash, setShowTrash] = React.useState(false);
  // Which row's icon picker is open. One id rather than one flag per row,
  // because two of them can never be open at the same time, and because the
  // context menu has to be able to open the picker of the row it belongs to.
  const [iconPickerFor, setIconPickerFor] = React.useState<string | null>(null);
  // The node offered for a cross-workspace move, and the workspace picked for
  // it. Kept as one pair rather than a boolean flag, because the dialog needs
  // to know which subtree it is about.
  const [moveWorkspaceNode, setMoveWorkspaceNode] = React.useState<DocumentTreeNode | null>(null);
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
  const springOpen = React.useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);

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

  const createChild = async (parentId: string | null, type: DocumentType = 'PAGE'): Promise<void> => {
    const document = await createDocument.mutateAsync({
      title: type === 'COLLECTION' ? 'Unbenannte Datenbank' : 'Unbenannte Seite',
      type,
      parentId,
    });
    if (parentId !== null) setExpanded({ ...expanded, [parentId]: true });
    router.push(`/arbeitsbereich/${workspaceId}/seite/${document.id}`);
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
      if (previous !== undefined) submitMove(documentId, { parentId, beforeSiblingId: previous.id });
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

    const shouldSpring = zone === 'inside' && node.children.length > 0 && expanded[node.id] !== true;
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

  const nudgeKeys: Readonly<Record<string, 'up' | 'down' | 'in' | 'out'>> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowRight: 'in',
    ArrowLeft: 'out',
  };

  if (tree.isPending) return <LoadingState variant="skeleton" rows={6} label="Seiten werden geladen" />;
  if (tree.isError) {
    return <ErrorState onRetry={() => void tree.refetch()} title="Seitenbaum nicht geladen" />;
  }

  const renderNode = (node: DocumentTreeNode, depth: number): React.ReactNode => {
    const isOpen = expanded[node.id] === true;
    const hasChildren = node.children.length > 0;
    const isActive = node.id === activeDocumentId;
    const zone = dropTarget?.id === node.id ? dropTarget.zone : null;
    const isDropInside = zone === 'inside';
    const dropLine = zone === 'inside' ? null : zone;

    return (
      <li key={node.id}>
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', node.id);
                  setDraggedId(node.id);
                }}
                onDragEnd={() => {
                  setDraggedId(null);
                  setDropTarget(null);
                  cancelSpringOpen();
                }}
                onDragOver={(event) => onRowDragOver(event, node)}
                onDrop={(event) => onRowDrop(event, node)}
                onKeyDown={(event) => {
                  const direction = event.altKey ? nudgeKeys[event.key] : undefined;
                  if (direction === undefined) return;
                  event.preventDefault();
                  nudge(node.id, direction);
                }}
                className={cn(
                  'group relative flex items-center gap-1 rounded-md pr-1 text-sm transition-colors',
                  // Where you are is the most important state in the tree, so it
                  // is carried three times over: surface, weight and an amber
                  // icon. Hover stays a hint and never comes close to it.
                  isActive
                    ? 'bg-accent-strong font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  draggedId === node.id && 'opacity-40',
                  isDropInside && 'bg-accent ring-1 ring-primary ring-inset',
                )}
                style={{ paddingLeft: `${depth * 0.75 + 0.25}rem` }}
                data-testid={`tree-item-${node.id}`}
                data-drop-zone={dropTarget?.id === node.id ? dropTarget.zone : undefined}
              >
                {/* The line that says "it lands here", drawn on the edge it would
                    land on. Amber, because in this product amber means the thing
                    that is about to happen. */}
                {dropLine !== null ? (
                  <span
                    aria-hidden
                    className={cn(
                      'pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-primary',
                      dropLine === 'before' ? 'top-0' : 'bottom-0',
                    )}
                  />
                ) : null}

                <button
                  type="button"
                  aria-label={isOpen ? 'Unterseiten einklappen' : 'Unterseiten ausklappen'}
                  aria-expanded={isOpen}
                  onClick={() => toggle(node.id)}
                  className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-transform hover:text-foreground',
                    isOpen && 'rotate-90',
                    !hasChildren && 'invisible',
                  )}
                >
                  <ChevronRightIcon className="size-3.5" />
                </button>

                {/* The symbol is its own button and sits outside the link: it is
                    the shortest way to change it, and inside the link every
                    click on it would navigate instead. */}
                <PageIconPicker
                  icon={node.icon}
                  iconColor={node.iconColor}
                  type={node.type}
                  open={iconPickerFor === node.id}
                  onOpenChange={(next) => setIconPickerFor(next ? node.id : null)}
                  onSelect={(selection) => {
                    void updateDocument.mutateAsync({ documentId: node.id, request: selection });
                  }}
                  trigger={
                    <button
                      type="button"
                      aria-label={`Symbol von „${node.title}“ ändern`}
                      data-testid={`tree-icon-${node.id}`}
                      className="grid size-5 shrink-0 place-items-center rounded hover:bg-accent-strong"
                    >
                      <DocumentIcon
                        icon={node.icon}
                        iconColor={node.iconColor}
                        type={node.type}
                        className={cn(
                          'size-3.5 text-xs',
                          isActive ? 'text-primary-text' : 'text-muted-foreground',
                        )}
                      />
                    </button>
                  }
                />

                <Link
                  href={`/arbeitsbereich/${workspaceId}/seite/${node.id}`}
                  // A link drags itself by default, which would start a drag of
                  // its URL instead of the row the pointer is actually on.
                  draggable={false}
                  className="flex min-w-0 flex-1 items-center py-1"
                  data-testid={`tree-link-${node.id}`}
                >
                  <span className="truncate">{node.title}</span>
                </Link>

                <button
                  type="button"
                  aria-label={`Unterseite in „${node.title}“ anlegen`}
                  onClick={() => void createChild(node.id)}
                  className="invisible size-5 shrink-0 rounded text-muted-foreground group-hover:visible hover:text-foreground"
                >
                  <PlusIcon className="size-3.5" />
                </button>
              </div>
            }
          />
          <ContextMenuContent>
            <ContextMenuItem
              data-testid={`tree-change-icon-${node.id}`}
              onClick={() => setIconPickerFor(node.id)}
            >
              <SmilePlusIcon /> Symbol ändern …
            </ContextMenuItem>
            <ContextMenuSeparator />
            {/* The keyboard half of dragging. Named with their shortcuts, because
                a command nobody can find is a command that does not exist. */}
            <ContextMenuItem
              disabled={!canNudge(node.id, 'up')}
              data-testid={`tree-move-up-${node.id}`}
              onClick={() => nudge(node.id, 'up')}
            >
              <ArrowUpIcon /> Nach oben
              <span className="exocortex-numeric ml-auto pl-4 text-xs text-muted-foreground">
                Alt ↑
              </span>
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!canNudge(node.id, 'down')}
              data-testid={`tree-move-down-${node.id}`}
              onClick={() => nudge(node.id, 'down')}
            >
              <ArrowDownIcon /> Nach unten
              <span className="exocortex-numeric ml-auto pl-4 text-xs text-muted-foreground">
                Alt ↓
              </span>
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!canNudge(node.id, 'in')}
              data-testid={`tree-indent-${node.id}`}
              onClick={() => nudge(node.id, 'in')}
            >
              <IndentIncreaseIcon /> Unter die Seite darüber
              <span className="exocortex-numeric ml-auto pl-4 text-xs text-muted-foreground">
                Alt →
              </span>
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!canNudge(node.id, 'out')}
              data-testid={`tree-outdent-${node.id}`}
              onClick={() => nudge(node.id, 'out')}
            >
              <IndentDecreaseIcon /> Eine Ebene höher
              <span className="exocortex-numeric ml-auto pl-4 text-xs text-muted-foreground">
                Alt ←
              </span>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => void createChild(node.id)}>
              <PlusIcon /> Unterseite anlegen
            </ContextMenuItem>
            <ContextMenuItem onClick={() => void createChild(node.id, 'COLLECTION')}>
              <TableIcon /> Datenbank anlegen
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid={`tree-move-workspace-${node.id}`}
              onClick={() => {
                setMoveWorkspaceNode(node);
                setMoveTargetWorkspaceId('');
              }}
            >
              <FolderInputIcon /> In anderen Arbeitsbereich verschieben …
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              onClick={() => void archiveDocument.mutateAsync(node.id)}
            >
              <ArchiveIcon /> Archivieren
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>

        {isOpen && hasChildren ? (
          <ul>{node.children.map((child) => renderNode(child, depth + 1))}</ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-2 py-1.5">
        <p className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
          Seiten
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label="Anlegen" data-testid="create-root-page">
                <PlusIcon />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem data-testid="create-root-page-item" onClick={() => void createChild(null)}>
              <PlusIcon /> Seite anlegen
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="create-root-database" onClick={() => void createChild(null, 'COLLECTION')}>
              <TableIcon /> Datenbank anlegen
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-1 pb-2">
        {tree.data.nodes.length === 0 ? (
          <EmptyState
            title="Noch keine Seiten"
            description="Lege deine erste Seite an, um zu beginnen."
            action={{ label: 'Seite anlegen', onClick: () => void createChild(null) }}
          />
        ) : (
          <ul data-testid="page-tree">{tree.data.nodes.map((node) => renderNode(node, 0))}</ul>
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

      <Dialog
        open={moveWorkspaceNode !== null}
        onOpenChange={(open) => {
          if (!open) setMoveWorkspaceNode(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>In anderen Arbeitsbereich verschieben</DialogTitle>
            <DialogDescription>
              „{moveWorkspaceNode?.title}“ wandert mit allen Unterseiten, Anhängen und eingebetteten
              Datenbanken in den gewählten Arbeitsbereich. Inhalte, die bisher nur du gesehen hast,
              sind danach für dessen Mitglieder sichtbar wie jede andere Seite dort auch.
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
            value={moveTargetWorkspaceId.length === 0 ? null : moveTargetWorkspaceId}
            onValueChange={(next) => setMoveTargetWorkspaceId(next ?? '')}
          >
            <SelectTrigger data-testid="move-workspace-select">
              <SelectValue>
                {() =>
                  workspaces.data?.find((option) => option.id === moveTargetWorkspaceId)?.name ??
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
            <Button variant="ghost" onClick={() => setMoveWorkspaceNode(null)}>
              Abbrechen
            </Button>
            <Button
              data-testid="move-workspace-submit"
              disabled={moveTargetWorkspaceId.length === 0 || moveDocument.isPending}
              onClick={() => {
                if (moveWorkspaceNode === null) return;
                const movedId = moveWorkspaceNode.id;
                const targetId = moveTargetWorkspaceId;
                void moveDocument
                  .mutateAsync({
                    documentId: movedId,
                    request: { parentId: null, workspaceId: targetId },
                  })
                  .then(() => {
                    setMoveWorkspaceNode(null);
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
    </div>
  );
}
