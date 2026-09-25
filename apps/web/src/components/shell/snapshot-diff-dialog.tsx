'use client';

import { ArrowRightLeftIcon, GitCompareIcon, MinusIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import { type DocumentDiffBlock } from '@exocortex/contracts';
import {
  Button,
  Checkbox,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { useRestoreSnapshotBlocks, useSnapshotDiff } from '@/lib/api/snapshot-queries';

/** A snapshot's moment, in the reader's language and time zone. */
function useFormatDateTime(): (iso: string) => string {
  const format = useFormatter();
  return (iso) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
}

function KindIcon({ block }: { block: DocumentDiffBlock }) {
  const className = 'size-4 shrink-0';
  if (block.kind === 'added')
    return <PlusIcon className={`${className} text-success`} aria-hidden />;
  if (block.kind === 'removed') {
    return <MinusIcon className={`${className} text-destructive-text`} aria-hidden />;
  }
  if (block.kind === 'changed') {
    return <PencilIcon className={`${className} text-muted-foreground`} aria-hidden />;
  }
  return <ArrowRightLeftIcon className={`${className} text-muted-foreground`} aria-hidden />;
}

/**
 * The word diff of one changed block.
 *
 * Deletions keep their strike-through *and* their colour: colour alone is not a
 * difference everybody can see, and this is the one place in the dialog where
 * the two directions have to be told apart at a glance.
 */
function Segments({ block }: { block: DocumentDiffBlock }) {
  if (block.segments.length === 0) {
    return <p className="text-sm whitespace-pre-wrap">{block.afterText ?? block.beforeText}</p>;
  }
  return (
    <p className="text-sm leading-relaxed whitespace-pre-wrap">
      {block.segments.map((segment, index) => {
        if (segment.kind === 'equal') return <span key={index}>{segment.text}</span>;
        if (segment.kind === 'inserted') {
          return (
            <span key={index} data-segment="inserted" className="rounded-xs bg-success/25 px-0.5">
              {segment.text}
            </span>
          );
        }
        return (
          <span
            key={index}
            data-segment="removed"
            className="rounded-xs bg-destructive/25 px-0.5 line-through"
          >
            {segment.text}
          </span>
        );
      })}
    </p>
  );
}

function BlockRow({
  block,
  selected,
  readOnly,
  onToggle,
}: {
  block: DocumentDiffBlock;
  selected: boolean;
  readOnly: boolean;
  onToggle: (blockId: string, next: boolean) => void;
}) {
  const t = useTranslations('document.snapshotDiff');
  const kind = t(`kinds.${block.kind}`);
  const selectable = !readOnly && block.blockId !== null;
  const text = block.kind === 'removed' ? block.beforeText : block.afterText;

  return (
    <div
      className="flex items-start gap-2 rounded-md border border-border px-3 py-2"
      data-testid="diff-block"
      data-block-kind={block.kind}
      data-block-id={block.blockId ?? undefined}
    >
      {selectable ? (
        <Checkbox
          className="mt-1"
          checked={selected}
          data-testid="diff-block-checkbox"
          aria-label={t('selectBlock', { kind, label: block.nodeLabel })}
          onCheckedChange={(next) => onToggle(block.blockId ?? '', next === true)}
        />
      ) : (
        <span className="mt-1 size-4 shrink-0" aria-hidden />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <KindIcon block={block} />
          <span>{kind}</span>
          <span>· {block.nodeLabel}</span>
          {block.moved ? <span>· {t('moved')}</span> : null}
          {block.blockId === null ? <span>· {t('noBlockId')}</span> : null}
        </span>
        {block.kind === 'changed' ? (
          <Segments block={block} />
        ) : (
          <p className="text-sm whitespace-pre-wrap">{text}</p>
        )}
      </div>
    </div>
  );
}

/** What the dialog needs of a snapshot: the two things it shows and sends. */
export interface DiffableSnapshot {
  id: string;
  createdAt: string;
}

export interface SnapshotDiffDialogProps {
  documentId: string;
  /** The snapshot the comparison starts from; `null` closes the dialog. */
  snapshot: DiffableSnapshot | null;
  /** Every snapshot of this page, so a second one can be picked to compare with. */
  snapshots: DiffableSnapshot[];
  readOnly: boolean;
  onClose: () => void;
}

/**
 * Comparing two states of a page, and taking single blocks back (issue #77).
 *
 * Unchanged blocks are folded into one line per run rather than listed: on a
 * long page they are the overwhelming majority, and a diff whose changes have
 * to be hunted for is a diff nobody reads. Everything that changed is expanded,
 * including a block that only moved.
 *
 * Selecting blocks restores them from the *older* of the two states into the
 * page's current content, which is why the button says what it does rather
 * than "wiederherstellen": the rest of the page, including everything written
 * after that snapshot, stays untouched.
 */
export function SnapshotDiffDialog({
  documentId,
  snapshot,
  snapshots,
  readOnly,
  onClose,
}: SnapshotDiffDialogProps) {
  const t = useTranslations('document.snapshotDiff');
  const formatDateTime = useFormatDateTime();
  const [against, setAgainst] = React.useState('current');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [confirming, setConfirming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const diff = useSnapshotDiff(documentId, snapshot?.id, against);
  const restoreBlocks = useRestoreSnapshotBlocks(documentId);

  /*
   * A different snapshot, or a different comparison, is a different selection.
   * Adjusted while rendering rather than in an effect: the blocks on screen and
   * the ticks beside them have to belong to the same comparison, and an effect
   * would paint one frame where they do not.
   */
  const comparison = `${snapshot?.id ?? ''}:${against}`;
  const [renderedComparison, setRenderedComparison] = React.useState(comparison);
  if (comparison !== renderedComparison) {
    setRenderedComparison(comparison);
    setSelected(new Set());
    setConfirming(false);
    setError(null);
  }

  const toggle = (blockId: string, next: boolean): void => {
    setSelected((previous) => {
      const updated = new Set(previous);
      if (next) updated.add(blockId);
      else updated.delete(blockId);
      return updated;
    });
    setConfirming(false);
  };

  const others = snapshots.filter((entry) => entry.id !== snapshot?.id);

  return (
    <Dialog
      open={snapshot !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-3xl" data-testid="snapshot-diff-dialog">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {snapshot === null
              ? null
              : t('description', { time: formatDateTime(snapshot.createdAt) })}
          </DialogDescription>
        </DialogHeader>

        <Select value={against} onValueChange={(value) => setAgainst(value ?? 'current')}>
          <SelectTrigger data-testid="diff-against">
            <SelectValue>
              {() =>
                against === 'current'
                  ? t('againstCurrent')
                  : t('againstSnapshot', {
                      time: formatDateTime(
                        others.find((entry) => entry.id === against)?.createdAt ??
                          new Date().toISOString(),
                      ),
                    })
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="current">{t('againstCurrent')}</SelectItem>
            {others.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {t('snapshotOption', { time: formatDateTime(entry.createdAt) })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <DialogBody className="flex flex-col gap-2">
          <DiffBody
            diff={diff}
            selected={selected}
            readOnly={readOnly}
            onToggle={toggle}
            onRetry={() => void diff.refetch()}
          />
        </DialogBody>

        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive-text">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
          {readOnly || selected.size === 0 ? null : (
            <Button
              variant={confirming ? 'destructive' : 'default'}
              disabled={restoreBlocks.isPending}
              data-testid="diff-restore-blocks"
              onClick={() => {
                if (!confirming) {
                  setConfirming(true);
                  return;
                }
                const sourceId = diff.data?.fromSnapshotId;
                if (sourceId === undefined) return;
                restoreBlocks.mutate(
                  { snapshotId: sourceId, blockIds: [...selected] },
                  {
                    onSuccess: () => {
                      setSelected(new Set());
                      setConfirming(false);
                      setError(null);
                    },
                    onError: (cause) => {
                      setConfirming(false);
                      setError(cause instanceof Error ? cause.message : t('unknownError'));
                    },
                  },
                );
              }}
            >
              {confirming ? t('confirmRestore') : t('restoreBlocks', { count: selected.size })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The list itself, split out so the dialog above stays readable. */
function DiffBody({
  diff,
  selected,
  readOnly,
  onToggle,
  onRetry,
}: {
  diff: ReturnType<typeof useSnapshotDiff>;
  selected: Set<string>;
  readOnly: boolean;
  onToggle: (blockId: string, next: boolean) => void;
  onRetry: () => void;
}) {
  const t = useTranslations('document.snapshotDiff');
  if (diff.isPending) return <LoadingState variant="skeleton" rows={4} label={t('comparing')} />;
  if (diff.isError) {
    return (
      <ErrorState title={t('failedTitle')} description={t('failedDescription')} onRetry={onRetry} />
    );
  }

  const { blocks, summary, warnings } = diff.data;
  const interesting = blocks.filter((block) => block.kind !== 'unchanged' || block.moved);

  if (interesting.length === 0) {
    return (
      <EmptyState
        title={t('noDifferenceTitle')}
        description={t('noDifferenceDescription')}
        icon={GitCompareIcon}
      />
    );
  }

  // Runs of unchanged blocks collapse to one line, so what changed is what the
  // list is made of.
  const rows: React.ReactNode[] = [];
  let skipped = 0;
  const flush = (key: string): void => {
    if (skipped === 0) return;
    rows.push(
      <p key={key} className="px-3 py-1 text-xs text-muted-foreground">
        {t('unchangedRun', { count: skipped })}
      </p>,
    );
    skipped = 0;
  };
  blocks.forEach((block, index) => {
    if (block.kind === 'unchanged' && !block.moved) {
      skipped += 1;
      return;
    }
    flush(`skip-${index}`);
    rows.push(
      <BlockRow
        key={`${block.blockId ?? 'anon'}-${index}`}
        block={block}
        selected={block.blockId !== null && selected.has(block.blockId)}
        readOnly={readOnly}
        onToggle={onToggle}
      />,
    );
  });
  flush('skip-end');

  return (
    <>
      <p className="text-sm text-muted-foreground" data-testid="diff-summary">
        {t('summary', {
          added: summary.added,
          removed: summary.removed,
          changed: summary.changed,
          moved: summary.moved,
        })}
      </p>
      {warnings.map((warning) => (
        <p key={warning} className="text-xs text-warning">
          {warning}
        </p>
      ))}
      {rows}
    </>
  );
}
