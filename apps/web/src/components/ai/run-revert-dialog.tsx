'use client';

import { Undo2Icon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type AiRunChangedBlock,
  type AiRunChangedPage,
  type AiRunRevertResponse,
} from '@exocortex/contracts';
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  LoadingState,
} from '@exocortex/ui';

import { useBlockTypeLabel } from '@/components/shell/diff-blocks';
import { useAiRunChanges, useRevertAiRun } from '@/lib/api/run-changes-queries';
import { documentHref } from '@/lib/document-href';
import { requestRunHighlight } from '@/lib/run-highlight';

/** One change: the blocks that go back together, in page order (issue #248). */
function groupsOf(page: AiRunChangedPage): AiRunChangedBlock[][] {
  const groups = new Map<number, AiRunChangedBlock[]>();
  for (const block of page.blocks) {
    groups.set(block.group, [...(groups.get(block.group) ?? []), block]);
  }
  return [...groups.values()];
}

const STATE_BADGE: Record<AiRunChangedBlock['state'], 'default' | 'outline' | 'muted'> = {
  revertible: 'default',
  changed_since: 'outline',
  reverted: 'muted',
};

function ChangeRow({ blocks }: { blocks: AiRunChangedBlock[] }) {
  const t = useTranslations('ai.runChanges');
  const blockTypeLabel = useBlockTypeLabel();
  const state = blocks[0]?.state ?? 'changed_since';
  return (
    <li
      className="flex flex-col gap-1 rounded-md border border-border px-3 py-2"
      data-testid="ai-run-change"
      data-state={state}
    >
      <Badge variant={STATE_BADGE[state]} className="w-fit">
        {t(`states.${state}`)}
      </Badge>
      {blocks.map((block) => (
        <p key={block.blockId} className="text-sm break-words">
          <span className="text-muted-foreground">
            {t(`kinds.${block.change}`, {
              type: block.nodeType === null ? t('block') : blockTypeLabel(block.nodeType),
            })}
          </span>{' '}
          {block.excerpt === null ? null : (
            <span className={block.change === 'removed' ? 'line-through' : undefined}>
              {t('excerpt', { text: block.excerpt })}
            </span>
          )}
        </p>
      ))}
    </li>
  );
}

function PageSection({
  page,
  runId,
  onNavigate,
}: {
  page: AiRunChangedPage;
  runId: string;
  onNavigate: () => void;
}) {
  const t = useTranslations('ai.runChanges');
  const title = t('pageTitle', { title: page.title ?? t('untitled') });
  return (
    <section className="flex flex-col gap-2" data-testid="ai-run-changes-dialog-page">
      <h3 className="text-sm font-medium">
        {page.workspaceId === null ? (
          title
        ) : (
          <Link
            href={documentHref(page.workspaceId, page.documentId, 'PAGE')}
            className="underline-offset-2 hover:underline"
            onClick={() => {
              requestRunHighlight(page.documentId, runId);
              onNavigate();
            }}
          >
            {title}
          </Link>
        )}
      </h3>
      {page.skipped !== null ? (
        <p className="text-xs text-muted-foreground">{t(`skipped.${page.skipped}`)}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {groupsOf(page).map((blocks) => (
            <ChangeRow key={blocks[0]?.blockId ?? 'empty'} blocks={blocks} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Taking one AI run back, after saying what that means (issue #248).
 *
 * The reading comes first and is the whole point: every change the run made,
 * whether it still stands as the run left it, and which ones somebody has
 * changed since and will therefore be left alone. Only then the button, which
 * restores exactly the first kind. The answer replaces the reading, so what
 * the dialog shows afterwards is the page as it now is.
 */
export function RunRevertDialog({
  runId,
  conversationId,
  onClose,
}: {
  runId: string;
  conversationId: string | null;
  onClose: () => void;
}) {
  const t = useTranslations('ai.runChanges');
  const changes = useAiRunChanges(runId);
  const revert = useRevertAiRun(conversationId);
  const [result, setResult] = React.useState<AiRunRevertResponse | null>(null);

  const reading = changes.data;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-2xl" data-testid="ai-run-revert-dialog">
        <DialogHeader>
          <DialogTitle>{t('dialogTitle')}</DialogTitle>
          <DialogDescription>{t('dialogDescription')}</DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {changes.isPending ? (
            <LoadingState variant="skeleton" rows={3} label={t('reading')} />
          ) : changes.isError ? (
            <ErrorState
              title={t('failedTitle')}
              description={t('failedDescription')}
              onRetry={() => void changes.refetch()}
            />
          ) : changes.data.pages.length === 0 ? (
            <EmptyState title={t('nothingTitle')} description={t('nothingDescription')} />
          ) : (
            <>
              <p className="text-sm text-muted-foreground" data-testid="ai-run-changes-summary">
                {t('summary', {
                  revertible: changes.data.revertible,
                  changedSince: changes.data.changedSince,
                })}
              </p>
              {changes.data.pages.map((page) => (
                <PageSection key={page.documentId} page={page} runId={runId} onNavigate={onClose} />
              ))}
            </>
          )}
        </DialogBody>

        {result === null ? null : (
          <p role="status" className="text-sm" data-testid="ai-run-revert-result">
            {t('done', { pages: result.restored.length })}{' '}
            {result.after.changedSince > 0
              ? t('doneKept', { count: result.after.changedSince })
              : null}
          </p>
        )}
        {revert.isError ? (
          <p role="alert" className="text-sm text-destructive-text">
            {revert.error instanceof Error ? revert.error.message : t('revertFailed')}
          </p>
        ) : null}
        {reading !== undefined && !reading.canRevert && reading.pages.length > 0 ? (
          <p className="text-xs text-muted-foreground">{t('notYours')}</p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
          {reading === undefined || !reading.canRevert || reading.revertible === 0 ? null : (
            <Button
              variant="destructive"
              disabled={revert.isPending}
              data-testid="ai-run-revert-confirm"
              onClick={() =>
                revert.mutate(runId, {
                  onSuccess: (response) => setResult(response),
                })
              }
            >
              <Undo2Icon aria-hidden />
              {revert.isPending ? t('reverting') : t('revert', { count: reading.revertible })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
