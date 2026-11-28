'use client';

import { ArrowLeftIcon, HistoryIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type PageHistoryGroup, type PageHistoryVersion } from '@exocortex/contracts';
import {
  Button,
  cn,
  EmptyState,
  ErrorState,
  LoadingState,
  Toggle,
  ToggleGroup,
} from '@exocortex/ui';

import { ReadOnlyDocument } from '@/components/editor/read-only-document';
import {
  type usePageHistory,
  useSnapshotContent,
  useSnapshotDiff,
} from '@/lib/api/snapshot-queries';
import { useFormatter } from '@/lib/formatter';

import { groupTitle, PageHistoryList } from './page-history-list';
import { DiffBody } from './snapshot-diff-dialog';

/**
 * The two halves of the page history dialog (issue #235): the list of
 * versions, and the chosen version as a preview or as its changes. Split from
 * the dialog, which keeps the state and the restore.
 */

export type HistoryView = 'preview' | 'changes';

export interface SelectedVersion {
  group: PageHistoryGroup;
  version: PageHistoryVersion;
}

/** The selected version, with the group it belongs to. */
export function findVersion(
  groups: readonly PageHistoryGroup[],
  id: string | null,
): SelectedVersion | null {
  if (id === null) return null;
  for (const group of groups) {
    const version = group.versions.find((candidate) => candidate.id === id);
    if (version !== undefined) return { group, version };
  }
  return null;
}

function Preview({ documentId, snapshotId }: { documentId: string; snapshotId: string }) {
  const t = useTranslations('document.pageHistory');
  const tDiff = useTranslations('document.snapshotDiff.notices');
  const format = useFormatter();
  const content = useSnapshotContent(documentId, snapshotId);
  if (content.isPending)
    return <LoadingState variant="skeleton" rows={6} label={t('previewLoading')} />;
  if (content.isError) {
    return (
      <ErrorState
        title={t('unavailable')}
        description={t('previewError')}
        onRetry={() => void content.refetch()}
      />
    );
  }
  const { proseMirrorJson, notices, chars } = content.data;
  return (
    <div className="flex flex-col gap-2" data-testid="page-history-preview">
      {notices.map((notice) =>
        notice.code === 'older_schema' ? (
          <p key={notice.code} className="text-xs text-warning">
            {tDiff('olderSchema', {
              time: format.dateTime(new Date(notice.stateCreatedAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
            })}
          </p>
        ) : null,
      )}
      {chars === 0 || proseMirrorJson === null ? (
        <p className="text-sm text-muted-foreground">{t('previewEmpty')}</p>
      ) : (
        // `inert`: a stored version is a picture of the page, and a link or a
        // checkbox in it that looked live would be a promise it cannot keep.
        <div inert>
          <ReadOnlyDocument content={proseMirrorJson} />
        </div>
      )}
    </div>
  );
}

function Changes({
  documentId,
  snapshotId,
  readOnly,
  onPickBlocks,
}: {
  documentId: string;
  snapshotId: string;
  readOnly: boolean;
  onPickBlocks: () => void;
}) {
  const t = useTranslations('document.pageHistory');
  const diff = useSnapshotDiff(documentId, snapshotId, 'current');
  return (
    <div className="flex flex-col gap-2" data-testid="page-history-changes">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('changesLead')}</p>
        {readOnly ? null : (
          <Button variant="outline" size="sm" onClick={onPickBlocks}>
            {t('pickBlocks')}
          </Button>
        )}
      </div>
      <DiffBody
        diff={diff}
        selected={new Set()}
        readOnly
        onToggle={() => undefined}
        onRetry={() => void diff.refetch()}
      />
    </div>
  );
}

export function HistoryListPane({
  history,
  groups,
  selectedId,
  onSelect,
  hidden,
}: {
  history: ReturnType<typeof usePageHistory>;
  groups: readonly PageHistoryGroup[];
  selectedId: string | null;
  onSelect: (snapshotId: string) => void;
  hidden: boolean;
}) {
  const t = useTranslations('document.pageHistory');
  let body: React.ReactNode;
  if (history.isPending) {
    body = <LoadingState variant="skeleton" rows={6} label={t('loading')} />;
  } else if (history.isError) {
    body = (
      <ErrorState
        title={t('unavailable')}
        description={t('loadError')}
        onRetry={() => void history.refetch()}
      />
    );
  } else if (groups.length === 0) {
    body = (
      <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} icon={HistoryIcon} />
    );
  } else {
    body = (
      <PageHistoryList
        groups={groups}
        currentUpdatedAt={history.data.pages[0]?.currentUpdatedAt ?? new Date().toISOString()}
        selectedId={selectedId}
        onSelect={onSelect}
        footer={
          history.hasNextPage ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              {t('loadMore')}
            </Button>
          ) : null
        }
      />
    );
  }
  return (
    <div
      className={cn(
        'min-h-0 overflow-y-auto overscroll-contain border-border px-3 py-4 md:w-80 md:shrink-0 md:border-l',
        hidden && 'hidden',
      )}
    >
      {body}
    </div>
  );
}

function VersionHeading({
  selected,
  onBack,
}: {
  selected: SelectedVersion;
  onBack: (() => void) | null;
}) {
  const t = useTranslations('document.pageHistory');
  const format = useFormatter();
  const representsWrite =
    selected.group.kind === 'write' && selected.version.id === selected.group.representativeId;
  return (
    <>
      {onBack === null ? null : (
        <Button variant="ghost" size="icon-sm" aria-label={t('back')} onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
      )}
      <div className="min-w-0 flex-1">
        <h3 id="page-history-version-title" className="truncate text-sm font-medium">
          {groupTitle(selected.group, t)}
        </h3>
        <p className="exocortex-numeric text-xs text-muted-foreground">
          {format.dateTime(new Date(selected.version.createdAt), {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
          {representsWrite ? ` · ${t('representsWrite')}` : ''}
        </p>
      </div>
    </>
  );
}

export function HistoryVersionPane({
  documentId,
  selected,
  waiting,
  view,
  onView,
  readOnly,
  onBack,
  onPickBlocks,
  hidden,
}: {
  documentId: string;
  selected: SelectedVersion | null;
  /** The list is still loading, so "choose one" would be premature. */
  waiting: boolean;
  view: HistoryView;
  onView: (view: HistoryView) => void;
  readOnly: boolean;
  /** Back to the list on a phone; `null` where both stand side by side. */
  onBack: (() => void) | null;
  onPickBlocks: () => void;
  hidden: boolean;
}) {
  const t = useTranslations('document.pageHistory');
  return (
    <section
      aria-labelledby="page-history-version-title"
      className={cn('flex min-h-0 min-w-0 flex-1 flex-col', hidden && 'hidden')}
    >
      {selected === null ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          {waiting ? null : t('noSelection')}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
            <VersionHeading selected={selected} onBack={onBack} />
            <ToggleGroup
              aria-label={t('viewLabel')}
              value={[view]}
              onValueChange={(next: string[]) => {
                const chosen = next[0];
                if (chosen === 'preview' || chosen === 'changes') onView(chosen);
              }}
            >
              <Toggle
                value="preview"
                variant="outline"
                size="sm"
                data-testid="page-history-view-preview"
              >
                {t('preview')}
              </Toggle>
              <Toggle
                value="changes"
                variant="outline"
                size="sm"
                data-testid="page-history-view-changes"
              >
                {t('changes')}
              </Toggle>
            </ToggleGroup>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-4">
            {view === 'preview' ? (
              <Preview documentId={documentId} snapshotId={selected.version.id} />
            ) : (
              <Changes
                documentId={documentId}
                snapshotId={selected.version.id}
                readOnly={readOnly}
                onPickBlocks={onPickBlocks}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}
