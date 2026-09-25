'use client';

import * as React from 'react';

import { type DocumentTreeNode, type MoveDocumentRequest } from '@exocortex/contracts';

import {
  dropRequest,
  type DropZone,
  dropZoneAt,
  type ExpandedState,
  isSelfOrDescendant,
  type TreePosition,
} from './page-tree-state';

/**
 * How long a folded page has to be hovered before it opens under the pointer.
 *
 * Long enough that dragging *past* a folded page does not open it, short enough
 * that dropping something three levels down does not need three separate drags.
 */
const SPRING_OPEN_MS = 700;

interface TreeDragOptions {
  positions: ReadonlyMap<string, TreePosition>;
  expanded: ExpandedState;
  setExpanded: (next: ExpandedState) => void;
  submitMove: (documentId: string, request: MoveDocumentRequest) => void;
}

/**
 * Dragging rows of the page tree: which row is dragged, which row and zone it
 * is over, the drop zone for "out to the top level", and the timer that
 * unfolds a folded page the pointer rests on.
 *
 * Split out of `page-tree.tsx` (issue #97). Native HTML5 drag and drop, see
 * the note on `PageTree` for why.
 */
export function useTreeDrag({ positions, expanded, setExpanded, submitMove }: TreeDragOptions) {
  // The row being dragged, and the row it is currently over. Two pieces of state
  // rather than one: the dragged row stays marked while the pointer travels over
  // rows that would refuse it.
  const [draggedId, setDraggedId] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<{ id: string; zone: DropZone } | null>(null);
  const [rootDropActive, setRootDropActive] = React.useState(false);

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

  const draggedNode = draggedId === null ? null : (positions.get(draggedId)?.node ?? null);

  /** Whether a row is allowed to receive the page currently being dragged. */
  const acceptsDrop = (targetId: string): boolean =>
    draggedNode !== null && !isSelfOrDescendant(draggedNode, targetId);

  /** Ends a drag, whether it landed or not. */
  const finishDrag = (): string | null => {
    const documentId = draggedId;
    setDraggedId(null);
    setDropTarget(null);
    setRootDropActive(false);
    cancelSpringOpen();
    return documentId;
  };

  const onRowDragOver = (event: React.DragEvent<HTMLDivElement>, node: DocumentTreeNode): void => {
    // No `preventDefault` means "not a drop target", which is how the browser is
    // told that a page cannot be dropped into itself.
    if (!acceptsDrop(node.id)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    const rect = event.currentTarget.getBoundingClientRect();
    const zone = dropZoneAt((event.clientY - rect.top) / rect.height);

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
    const accepted = acceptsDrop(node.id);
    const documentId = finishDrag();
    if (documentId === null || !accepted) return;
    const request = dropRequest(positions, node.id, zone);
    if (request !== null) submitMove(documentId, request);
  };

  /** The handlers of the "out to the top level" zone under the tree. */
  const rootDropHandlers = {
    onDragOver: (event: React.DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setRootDropActive(true);
    },
    onDragLeave: (): void => setRootDropActive(false),
    onDrop: (event: React.DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      const documentId = finishDrag();
      if (documentId !== null) submitMove(documentId, { parentId: null });
    },
  };

  return {
    draggedId,
    draggedNode,
    dropTarget,
    rootDropActive,
    setDraggedId,
    setDropTarget,
    cancelSpringOpen,
    onRowDragOver,
    onRowDrop,
    rootDropHandlers,
  };
}
