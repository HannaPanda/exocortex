'use client';

import {
  ArchiveIcon,
  ChevronRightIcon,
  FolderInputIcon,
  PlusIcon,
  RotateCcwIcon,
  SmilePlusIcon,
  TableIcon,
  Trash2Icon,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import * as React from 'react';

import { type DocumentTreeNode, type DocumentType } from '@exocortex/contracts';
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
  useRestoreDocument,
  useUpdateDocument,
  useWorkspaces,
} from '@/lib/api/queries';

interface PageTreeProps {
  workspaceId: string;
}

/**
 * Hierarchical page tree.
 *
 * Ordering comes from the server's fractional `orderKey`; the client never
 * computes order. Tree updates arrive through `document.*` realtime events, which
 * the shell turns into query invalidations.
 */
export function PageTree({ workspaceId }: PageTreeProps) {
  const params = useParams<{ documentId?: string }>();
  const router = useRouter();
  const tree = useDocumentTree(workspaceId);
  const createDocument = useCreateDocument(workspaceId);
  const archiveDocument = useArchiveDocument(workspaceId);
  const restoreDocument = useRestoreDocument(workspaceId);
  const updateDocument = useUpdateDocument(workspaceId);
  const moveDocument = useMoveDocument(workspaceId);
  const workspaces = useWorkspaces();
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
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

  const activeDocumentId = params.documentId;

  const toggle = (documentId: string): void => {
    setExpanded((current) => ({ ...current, [documentId]: current[documentId] !== true }));
  };

  const createChild = async (parentId: string | null, type: DocumentType = 'PAGE'): Promise<void> => {
    const document = await createDocument.mutateAsync({
      title: type === 'COLLECTION' ? 'Unbenannte Datenbank' : 'Unbenannte Seite',
      type,
      parentId,
    });
    if (parentId !== null) setExpanded((current) => ({ ...current, [parentId]: true }));
    router.push(`/arbeitsbereich/${workspaceId}/seite/${document.id}`);
  };

  if (tree.isPending) return <LoadingState variant="skeleton" rows={6} label="Seiten werden geladen" />;
  if (tree.isError) {
    return <ErrorState onRetry={() => void tree.refetch()} title="Seitenbaum nicht geladen" />;
  }

  const renderNode = (node: DocumentTreeNode, depth: number): React.ReactNode => {
    const isOpen = expanded[node.id] === true;
    const hasChildren = node.children.length > 0;
    const isActive = node.id === activeDocumentId;

    return (
      <li key={node.id}>
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div
                className={cn(
                  'group flex items-center gap-1 rounded-md pr-1 text-sm transition-colors',
                  // Where you are is the most important state in the tree, so it
                  // is carried three times over: surface, weight and an amber
                  // icon. Hover stays a hint and never comes close to it.
                  isActive
                    ? 'bg-accent-strong font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
                style={{ paddingLeft: `${depth * 0.75 + 0.25}rem` }}
                data-testid={`tree-item-${node.id}`}
              >
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

        <div className="mt-2 border-t border-border pt-2">
          <button
            type="button"
            onClick={() => setShowTrash((value) => !value)}
            aria-expanded={showTrash}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            data-testid="toggle-trash"
          >
            <Trash2Icon className="size-3.5" />
            Papierkorb
            <span className="exocortex-numeric ml-auto">{tree.data.archived.length}</span>
          </button>

          {showTrash ? (
            tree.data.archived.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">Der Papierkorb ist leer.</p>
            ) : (
              <ul className="mt-1" data-testid="trash-list">
                {tree.data.archived.map((document) => (
                  <li
                    key={document.id}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-sm hover:bg-accent/60"
                  >
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {document.title}
                    </span>
                    <button
                      type="button"
                      aria-label={`„${document.title}“ wiederherstellen`}
                      onClick={() => void restoreDocument.mutateAsync(document.id)}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      <RotateCcwIcon className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
      </ScrollArea>

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
