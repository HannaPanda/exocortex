'use client';

import { Maximize2Icon, PanelRightCloseIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { Button, EmptyState, ErrorState, LoadingState } from '@exocortex/ui';

import { useLatest } from '@/components/palette/contributions';
import { replacesPageOnError } from '@/components/shell/document-load-failure';
import { DocumentSessionProvider } from '@/components/shell/document-session';
import { PageSurface } from '@/components/shell/page-surface';
import { SaveIndicator } from '@/components/shell/save-indicator';
import { useDocument } from '@/lib/api/document-queries';
import { useSessionQuery } from '@/lib/api/session-queries';
import { useDocumentHrefs } from '@/lib/document-href-context';

import { ROW_PEEK_ATTRIBUTE, type RowPeek, useRowPeek } from './row-peek';

/**
 * The side panel a row of a database opens in (issue #239).
 *
 * It lies over the right-hand part of the page area, beside the table rather
 * than instead of it, and leaves the context panel and the AI chat where they
 * are: those still speak about the page the address names. The table under it
 * is not re-rendered, so its filters, sort, selection and scroll position are
 * what they were. Where the page area is narrower than the panel wants to be,
 * on a phone, the panel takes all of it.
 *
 * The content is the row's real page (`PageSurface`): title, its properties,
 * the collaborative editor. It reports into a document session of its own, so
 * the header's presence, save and connection state keep describing the page
 * underneath, and the panel shows its own save state.
 */
export function RowPeekPanel() {
  const peek = useRowPeek();
  if (peek === null || peek.peekId === null) return null;
  return (
    <DocumentSessionProvider>
      <PeekFrame peek={peek} rowId={peek.peekId} />
    </DocumentSessionProvider>
  );
}

function PeekFrame({ peek, rowId }: { peek: RowPeek; rowId: string }) {
  const t = useTranslations('database.peek');
  const panel = React.useRef<HTMLElement>(null);
  const hrefs = useDocumentHrefs();
  const href = hrefs.href(peek.workspaceId, rowId, 'PAGE');
  const selectTitle = peek.selectTitleFor === rowId;

  // The focus moves into the panel with every row it shows, so the keyboard
  // and a screen reader are where the reader is looking. A new row's title
  // takes it instead, once the row has loaded (see `RowPeekContent`).
  // Read through a ref: only a new row moves the focus, never the moment the
  // title request is let go of.
  const titleTakesFocus = useLatest(selectTitle);
  React.useEffect(() => {
    if (titleTakesFocus.current) return;
    panel.current?.focus({ preventScroll: true });
  }, [rowId, titleTakesFocus]);

  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label={t('label')}
      data-testid="row-peek"
      {...{ [ROW_PEEK_ATTRIBUTE]: rowId }}
      className="absolute inset-y-0 right-0 z-40 flex w-[clamp(26rem,48%,44rem)] max-w-full flex-col border-l border-border-strong bg-background shadow-lg outline-none"
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('close')}
          title={t('closeHint')}
          data-testid="row-peek-close"
          onClick={peek.close}
        >
          <PanelRightCloseIcon />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-testid="row-peek-open-page"
          render={<Link href={href} />}
        >
          <Maximize2Icon aria-hidden /> {t('openAsPage')}
        </Button>
        <span className="flex-1" />
        <SaveIndicator />
      </div>
      <RowPeekContent key={rowId} peek={peek} rowId={rowId} href={href} />
    </aside>
  );
}

function RowPeekContent({ peek, rowId, href }: { peek: RowPeek; rowId: string; href: string }) {
  const t = useTranslations('database.peek');
  const tView = useTranslations('document.view');
  const session = useSessionQuery();
  const document = useDocument(rowId);
  const detail = document.data;
  const selectTitle = peek.selectTitleFor === rowId && detail !== undefined;
  const { titleSelected } = peek;

  // The title effect runs first (children before parents), so by now the
  // field has the focus and the request can be let go of: a later remount of
  // the field after a rename must not select it again.
  React.useEffect(() => {
    if (selectTitle) titleSelected();
  }, [selectTitle, titleSelected]);

  if (document.isError && replacesPageOnError(document.error, detail !== undefined)) {
    return (
      <ErrorState
        title={t('unavailableTitle')}
        description={t('unavailableDescription')}
        onRetry={() => void document.refetch()}
      />
    );
  }
  if (detail === undefined || session.isPending) return <LoadingState label={t('loading')} />;

  if (detail.type !== 'PAGE') {
    return (
      <EmptyState title={t('notAPageTitle')} description={t('notAPageDescription')}>
        <Button variant="outline" size="sm" className="mt-2" render={<Link href={href} />}>
          {t('openAsPage')}
        </Button>
      </EmptyState>
    );
  }

  const archived = detail.archivedAt !== null;
  return (
    <>
      {archived ? (
        <p className="border-b border-warning/40 bg-warning/10 px-4 py-1.5 text-xs text-warning">
          {tView('archivedBanner')}
        </p>
      ) : null}
      <PageSurface
        workspaceId={peek.workspaceId}
        detail={detail}
        readOnly={archived || detail.access === 'read'}
        user={session.data?.user}
        titleAnswersPalette={false}
        selectTitle={selectTitle}
      />
    </>
  );
}
