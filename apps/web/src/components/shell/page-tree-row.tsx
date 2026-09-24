import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  FolderCodeIcon,
  FolderInputIcon,
  FolderTreeIcon,
  IndentDecreaseIcon,
  IndentIncreaseIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SmilePlusIcon,
  TableIcon,
  TrashIcon,
} from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { type DocumentTreeNode } from '@exocortex/contracts';
import {
  cn,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  TruncatedText,
} from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { PageIconPicker, type PageIconSelection } from '@/components/document/page-icon-picker';
import { documentHref } from '@/lib/document-href';

import { type DropZone, type ExpandedState } from './page-tree-state';

/** Everything a row needs that is not the page it renders. */
export interface PageTreeRowContext {
  workspaceId: string;
  activeDocumentId: string | undefined;
  /** The one row that carries the tree's tab stop (`useTreeKeyboard`). */
  tabStopId: string | null;
  onRowKeyDown: (event: React.KeyboardEvent<HTMLElement>, documentId: string) => void;
  onRowFocus: (documentId: string) => void;
  expanded: ExpandedState;
  draggedId: string | null;
  dropTarget: { id: string; zone: DropZone } | null;
  iconPickerFor: string | null;
  setIconPickerFor: (documentId: string | null) => void;
  setDraggedId: (documentId: string | null) => void;
  setDropTarget: (target: { id: string; zone: DropZone } | null) => void;
  cancelSpringOpen: () => void;
  onRowDragOver: (event: React.DragEvent<HTMLDivElement>, node: DocumentTreeNode) => void;
  onRowDrop: (event: React.DragEvent<HTMLDivElement>, node: DocumentTreeNode) => void;
  toggle: (documentId: string) => void;
  nudge: (documentId: string, direction: 'up' | 'down' | 'in' | 'out') => void;
  canNudge: (documentId: string, direction: 'up' | 'down' | 'in' | 'out') => boolean;
  createChild: (parentId: string, type?: 'PAGE' | 'COLLECTION') => void;
  createProject: (parentId: string) => void;
  setIcon: (documentId: string, selection: PageIconSelection) => void;
  archive: (documentId: string) => void;
  startWorkspaceMove: (node: DocumentTreeNode) => void;
  suggestParent: (node: DocumentTreeNode) => void;
}

/**
 * One page in the tree, and its subtree below it.
 *
 * Recursive rather than a flattened list: the indentation, the unfold state and
 * the drop zones all describe a shape, and flattening it would mean carrying
 * that shape in every row instead.
 *
 * The `<li>` is the `treeitem`, not the row inside it, because a treeitem owns
 * the group of its children and here that group is the nested `<ul>`. It is
 * also what holds focus, so everything inside it -- the chevron, the symbol,
 * the link, "create a child page" -- carries `tabIndex={-1}`: a composite
 * widget hands out one tab stop and answers the arrow keys itself
 * (`useTreeKeyboard`). The name is stated rather than composed, or a screen
 * reader would read all four labels where the page's title belongs.
 */
export function PageTreeRow({
  node,
  depth,
  context,
}: {
  node: DocumentTreeNode;
  depth: number;
  context: PageTreeRowContext;
}) {
  const {
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
    createChild,
    setIcon,
    tabStopId,
    onRowKeyDown,
    onRowFocus,
  } = context;
  const isOpen = expanded[node.id] === true;
  const hasChildren = node.children.length > 0;
  const isActive = node.id === activeDocumentId;
  const zone = dropTarget?.id === node.id ? dropTarget.zone : null;
  const isDropInside = zone === 'inside';
  const dropLine = zone === 'inside' ? null : zone;

  return (
    <li
      role="treeitem"
      aria-label={node.title}
      aria-selected={isActive}
      aria-expanded={hasChildren ? isOpen : undefined}
      data-tree-item={node.id}
      tabIndex={tabStopId === node.id ? 0 : -1}
      onKeyDown={(event) => onRowKeyDown(event, node.id)}
      onFocus={() => onRowFocus(node.id)}
      // The ring belongs on the row, not on the item: an unfolded item is as
      // tall as its whole branch, and a ring around that says nothing about
      // where focus is. Inset, because the tree sits in a scroll container
      // with one unit of padding and an outset ring would be clipped on both
      // edges.
      className="group/item outline-none"
    >
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              draggable
              data-tree-row=""
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
              className={cn(
                'group relative flex items-center gap-1 rounded-md pr-1 text-sm transition-colors',
                'group-focus-visible/item:ring-[3px] group-focus-visible/item:ring-ring/50 group-focus-visible/item:ring-inset',
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
                tabIndex={-1}
                aria-label={isOpen ? 'Unterseiten einklappen' : 'Unterseiten ausklappen'}
                aria-expanded={isOpen}
                onClick={() => toggle(node.id)}
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-transform hover:text-foreground',
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
                onSelect={(selection) => setIcon(node.id, selection)}
                trigger={
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`Symbol von „${node.title}“ ändern`}
                    data-testid={`tree-icon-${node.id}`}
                    className="grid size-5 shrink-0 place-items-center rounded-sm hover:bg-accent-strong"
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
                href={documentHref(workspaceId, node.id, node.type)}
                // A link drags itself by default, which would start a drag of
                // its URL instead of the row the pointer is actually on.
                draggable={false}
                // Clickable, not tabbable: the tree item above it is the tab
                // stop, and Enter on that item opens this same page.
                tabIndex={-1}
                className="flex min-w-0 flex-1 items-center py-1"
                data-testid={`tree-link-${node.id}`}
              >
                <TruncatedText text={node.title} side="right" />
              </Link>

              <button
                type="button"
                tabIndex={-1}
                aria-label={`Unterseite in „${node.title}“ anlegen`}
                onClick={() => createChild(node.id)}
                // Revealed by the pointer, and by a coarse pointer
                // permanently, because there is no hover to reveal it with.
                // It is a pointer shortcut rather than the only way in: the
                // keyboard reaches the same command in the row's own menu,
                // which is what the tree pattern trades the tab stop for.
                className="size-5 shrink-0 rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground pointer-coarse:opacity-100"
              >
                <PlusIcon className="size-3.5" />
              </button>

              {/* The same menu as the right click, for a hand that has none: a
                  phone, a pen, a trackpad set to one button. Revealed like the
                  plus beside it. */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={`Aktionen für „${node.title}“`}
                      data-testid={`tree-actions-${node.id}`}
                      className="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground data-popup-open:opacity-100 pointer-coarse:opacity-100"
                    >
                      <MoreHorizontalIcon className="size-3.5" />
                    </button>
                  }
                />
                <PageTreeRowMenu node={node} context={context} parts={DROPDOWN_PARTS} />
              </DropdownMenu>
            </div>
          }
        />
        <PageTreeRowMenu node={node} context={context} parts={CONTEXT_PARTS} />
      </ContextMenu>

      {isOpen && hasChildren ? (
        // The guide runs down the parent's own chevron column, so an unfolded
        // branch reads as a branch rather than as rows that happen to start
        // further right. It matters most exactly where the tree is hardest:
        // several levels deep, where indentation alone stops being countable.
        // `--signal-line`, because it describes the shape of the screen and is
        // not something you can act on.
        <ul role="group" className="relative">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-signal-line"
            style={{ left: `${depth * 0.75 + 0.875}rem` }}
          />
          {node.children.map((child) => (
            <PageTreeRow key={child.id} node={child} depth={depth + 1} context={context} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The row's menu is rendered twice, as a context menu and behind the ⋯ button. */
interface MenuParts {
  Content: React.ComponentType<{ children: React.ReactNode; align?: 'start' | 'end' }>;
  Item: React.ComponentType<{
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: 'default' | 'destructive';
    'data-testid'?: string;
  }>;
  Separator: React.ComponentType;
}

const CONTEXT_PARTS: MenuParts = {
  Content: ContextMenuContent,
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
};

const DROPDOWN_PARTS: MenuParts = {
  Content: DropdownMenuContent,
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
};

/**
 * The keyboard half of dragging, plus everything else a row can be told to do.
 *
 * The four move commands are named with their shortcuts, because a command
 * nobody can find is a command that does not exist.
 */
function PageTreeRowMenu({
  node,
  context,
  parts,
}: {
  node: DocumentTreeNode;
  context: PageTreeRowContext;
  parts: MenuParts;
}) {
  const { Content, Item, Separator } = parts;
  const {
    canNudge,
    nudge,
    createChild,
    createProject,
    archive,
    setIconPickerFor,
    startWorkspaceMove,
    suggestParent,
  } = context;
  return (
    <Content>
      <Item data-testid={`tree-change-icon-${node.id}`} onClick={() => setIconPickerFor(node.id)}>
        <SmilePlusIcon /> Symbol ändern …
      </Item>
      <Separator />
      {/* The keyboard half of dragging. Named with their shortcuts, because
            a command nobody can find is a command that does not exist. */}
      <Item
        disabled={!canNudge(node.id, 'up')}
        data-testid={`tree-move-up-${node.id}`}
        onClick={() => nudge(node.id, 'up')}
      >
        <ArrowUpIcon /> Nach oben
        <span className="exocortex-numeric ml-auto pl-4 text-xs text-muted-foreground">Alt ↑</span>
      </Item>
      <Item
        disabled={!canNudge(node.id, 'down')}
        data-testid={`tree-move-down-${node.id}`}
        onClick={() => nudge(node.id, 'down')}
      >
        <ArrowDownIcon /> Nach unten
        <span className="exocortex-numeric ml-auto pl-4 text-xs text-muted-foreground">Alt ↓</span>
      </Item>
      <Item
        disabled={!canNudge(node.id, 'in')}
        data-testid={`tree-indent-${node.id}`}
        onClick={() => nudge(node.id, 'in')}
      >
        <IndentIncreaseIcon /> Unter die Seite darüber
        <span className="exocortex-numeric ml-auto pl-4 text-xs text-muted-foreground">Alt →</span>
      </Item>
      <Item
        disabled={!canNudge(node.id, 'out')}
        data-testid={`tree-outdent-${node.id}`}
        onClick={() => nudge(node.id, 'out')}
      >
        <IndentDecreaseIcon /> Eine Ebene höher
        <span className="exocortex-numeric ml-auto pl-4 text-xs text-muted-foreground">Alt ←</span>
      </Item>
      <Separator />
      <Item onClick={() => createChild(node.id)}>
        <PlusIcon /> Unterseite anlegen
      </Item>
      <Item onClick={() => createChild(node.id, 'COLLECTION')}>
        <TableIcon /> Datenbank anlegen
      </Item>
      <Item onClick={() => createProject(node.id)}>
        <FolderCodeIcon /> LaTeX-Projekt anlegen
      </Item>
      <Separator />
      {/* Filing help rather than a move: the answer is a list of candidates
          with the pages that already live under them, and agreeing with one
          is a second click. */}
      <Item data-testid={`tree-suggest-parent-${node.id}`} onClick={() => suggestParent(node)}>
        <FolderTreeIcon /> Passenden Ort vorschlagen …
      </Item>
      <Item data-testid={`tree-move-workspace-${node.id}`} onClick={() => startWorkspaceMove(node)}>
        <FolderInputIcon /> In anderen Arbeitsbereich verschieben …
      </Item>
      <Separator />
      <Item variant="destructive" onClick={() => archive(node.id)}>
        <TrashIcon /> In den Papierkorb
      </Item>
    </Content>
  );
}
