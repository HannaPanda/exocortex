'use client';

import { FilePenLineIcon, Undo2Icon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type AiRunWrittenPages } from '@exocortex/contracts';
import { Button } from '@exocortex/ui';

import { documentHref } from '@/lib/document-href';
import { requestRunHighlight } from '@/lib/run-highlight';

import { RunRevertDialog } from './run-revert-dialog';

/**
 * The line under a run's answer that says which pages it changed (issue #248).
 *
 * Each page is a link that opens it with the run's blocks marked, so "what did
 * it change" is answered on the page itself rather than in a list of ids. The
 * way back sits beside it and opens a dialog first: an undo that names what it
 * will restore and what it will leave alone, before anything happens.
 *
 * While the run is still writing there is nothing to take back yet; the line
 * names the pages as they come and offers the undo once the run has ended.
 */
export function RunChangesLine({
  writes,
  running,
  conversationId,
}: {
  writes: AiRunWrittenPages;
  running: boolean;
  conversationId: string | null;
}) {
  const t = useTranslations('ai.runChanges');
  const [dialogOpen, setDialogOpen] = React.useState(false);

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
      data-testid="ai-run-changes"
      data-run-id={writes.runId}
    >
      <FilePenLineIcon aria-hidden className="size-3.5 shrink-0" />
      <span>{t('changed', { count: writes.pages.length })}</span>
      {writes.pages.map((page) => (
        <Link
          key={page.documentId}
          href={documentHref(page.workspaceId, page.documentId, 'PAGE')}
          onClick={() => requestRunHighlight(page.documentId, writes.runId)}
          className="max-w-full truncate font-medium text-foreground underline-offset-2 hover:underline focus-visible:underline"
          title={t('showOnPage')}
          data-testid="ai-run-changes-page"
        >
          {t('pageTitle', { title: page.title ?? t('untitled') })}
        </Link>
      ))}
      {running ? null : (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          onClick={() => setDialogOpen(true)}
          data-testid="ai-run-undo"
        >
          <Undo2Icon aria-hidden />
          {t('undo')}
        </Button>
      )}
      {dialogOpen ? (
        <RunRevertDialog
          runId={writes.runId}
          conversationId={conversationId}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}
