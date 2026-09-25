'use client';

import { type NodeViewProps } from '@tiptap/core';
import { NodeViewWrapper } from '@tiptap/react';
import { ExternalLinkIcon, RefreshCwIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type SavedQueryResultsResponse } from '@exocortex/contracts';
import { Button, EmptyState, ErrorState, LoadingState } from '@exocortex/ui';

import { SavedQueryEmbedPromptContext } from '@/components/editor/saved-query-embed-context';
import { useSavedQuery, useSavedQueryResults } from '@/lib/api/saved-query-queries';

import { SavedQueryResults } from './saved-query-results';

/**
 * React node view for the `savedQueryEmbed` node
 * (`packages/editor/src/saved-query-embed.ts`), issue #74.
 *
 * The block holds an id and shows an answer. Nothing about the answer is part
 * of the document: the page's Yjs state says "the question with this id, five
 * rows", and what those five rows are is decided when somebody looks. That is
 * what a query block is for, and it is why a reader without access to the
 * pages a query finds sees a shorter list here rather than a leak.
 */
interface SavedQueryNodeViewProps extends NodeViewProps {
  workspaceId: string;
}

export function SavedQueryNodeView({
  node,
  updateAttributes,
  editor,
  workspaceId,
}: SavedQueryNodeViewProps) {
  const t = useTranslations('search.nodeView');
  const savedQueryId = typeof node.attrs.savedQueryId === 'string' ? node.attrs.savedQueryId : '';
  const frozenName = typeof node.attrs.name === 'string' ? node.attrs.name : '';
  const limit = typeof node.attrs.limit === 'number' ? node.attrs.limit : 5;

  const stored = useSavedQuery(savedQueryId.length > 0 ? savedQueryId : undefined);
  const results = useSavedQueryResults(savedQueryId.length > 0 ? savedQueryId : undefined, limit);
  const askSavedQuery = React.useContext(SavedQueryEmbedPromptContext);
  const editable = editor.isEditable;

  const pick = async (): Promise<void> => {
    const picked = await askSavedQuery?.current?.();
    if (picked === null || picked === undefined) return;
    updateAttributes({
      savedQueryId: picked.savedQueryId,
      name: picked.name,
      limit: picked.limit,
    });
  };

  const name =
    stored.data?.savedQuery.name ?? (frozenName.length > 0 ? frozenName : t('fallbackName'));
  const missing = savedQueryId.length === 0 || stored.isError;

  return (
    <NodeViewWrapper className="exocortex-database-embed" contentEditable={false}>
      <div className="embed-header">
        <span className="embed-title">{name}</span>
        <div className="embed-actions">
          {missing ? null : (
            <Link
              href={`/arbeitsbereich/${workspaceId}/suche/${savedQueryId}`}
              className="embed-action"
            >
              <ExternalLinkIcon aria-hidden />
              {t('open')}
            </Link>
          )}
          {editable ? (
            <Button variant="ghost" size="sm" className="embed-action" onClick={() => void pick()}>
              <RefreshCwIcon aria-hidden />
              {t('change')}
            </Button>
          ) : null}
        </div>
      </div>

      {missing ? (
        <EmptyState
          title={t('noneTitle')}
          description={savedQueryId.length === 0 ? t('noneDescription') : t('missingDescription')}
          action={editable ? { label: t('pick'), onClick: () => void pick() } : undefined}
        />
      ) : results.isPending ? (
        <LoadingState variant="skeleton" rows={3} label={t('resultsLoading')} />
      ) : results.isError ? (
        <ErrorState title={t('queryFailed')} onRetry={() => void results.refetch()} />
      ) : (
        <BlockResults
          savedQueryId={savedQueryId}
          workspaceId={workspaceId}
          results={results.data}
        />
      )}
    </NodeViewWrapper>
  );
}

/**
 * The list itself, plus the one line a block needs that a full page does not:
 * a way to the whole answer when the block only shows the first few.
 */
function BlockResults({
  savedQueryId,
  workspaceId,
  results,
}: {
  savedQueryId: string;
  workspaceId: string;
  results: SavedQueryResultsResponse;
}) {
  const t = useTranslations('search.nodeView');
  return (
    <div className="p-2">
      <SavedQueryResults
        hits={results.results}
        display={{ layout: 'LIST', showPath: true, showSnippet: false, showUpdatedAt: true }}
        truncated={false}
      />
      {results.truncated ? (
        <Link
          href={`/arbeitsbereich/${workspaceId}/suche/${savedQueryId}`}
          className="mt-1 block px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          {t('allResults')}
        </Link>
      ) : null}
    </div>
  );
}
