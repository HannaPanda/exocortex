'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { type DocumentTreeNode } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import { useMoveDocument } from '@/lib/api/document-queries';
import { messageForCode } from '@/lib/api/error-messages';
import { useWorkspaces } from '@/lib/api/workspace-queries';

/**
 * Moving a page into another workspace, with the one thing that is not obvious
 * spelled out: everything under it comes along, and its members can see it.
 */
export function MoveWorkspaceDialog({
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
  const t = useTranslations('dialogs.moveWorkspace');
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
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description', { title: node?.title ?? '' })}</DialogDescription>
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
                t('targetPlaceholder')
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
            {t('cancel')}
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
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
