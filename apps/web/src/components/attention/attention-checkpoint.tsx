'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { type AttentionItem } from '@exocortex/contracts';

import { documentHref } from '@/lib/document-href';

/**
 * What a human checkpoint hands a person beyond its question (issue #140).
 *
 * Read in the order somebody decides in: whether the work waits on this at
 * all, what exactly a yes approves and which pages it is bound to, and then,
 * folded away because it is background rather than the question, the context
 * and where the agent left the work. A page that moved since the question is
 * said plainly, because answering now approves nothing.
 */
export function AttentionCheckpoint({ item }: { item: AttentionItem }) {
  const t = useTranslations('attention.item');
  const open = item.status === 'open';
  const anyChanged = item.subject?.some((page) => page.changed) ?? false;

  return (
    <div className="mt-2 flex flex-col gap-2 text-sm">
      {open && !item.blocking && !item.system && item.workItem !== null ? (
        <p className="text-muted-foreground">{t('nonBlocking')}</p>
      ) : null}

      {item.action === null ? null : (
        <div className="max-w-measure border-l-2 border-border pl-3">
          <p className="text-xs font-medium text-muted-foreground">{t('actionLabel')}</p>
          <p className="whitespace-pre-wrap">{item.action}</p>
        </div>
      )}

      {item.changeset === null ? null : (
        <div className="flex flex-col gap-1" data-testid="attention-changeset">
          <p className="text-xs font-medium text-muted-foreground">{t('changesetLabel')}</p>
          <Link
            href={`/arbeitsbereich/${item.workspaceId}/vorschlaege/${item.changeset.id}`}
            className="w-fit font-medium hover:underline"
          >
            {item.changeset.title}
          </Link>
          <p className="text-muted-foreground">
            {t('changesetCounts', {
              pending: item.changeset.pending,
              total: item.changeset.total,
            })}
          </p>
          {item.changeset.intact ? null : (
            <p className="text-destructive-text">{t('changesetAltered')}</p>
          )}
          {open && item.changeset.pending > 0 ? (
            <p className="max-w-measure text-muted-foreground">{t('changesetHint')}</p>
          ) : null}
        </div>
      )}

      {item.subject === null ? null : (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">{t('subjectLabel')}</p>
          <ul className="flex flex-col gap-0.5" data-testid="attention-subject">
            {item.subject.map((page) => (
              <li key={page.documentId} className="flex flex-wrap items-baseline gap-2">
                {page.title === null ? (
                  <span className="text-muted-foreground">{t('subjectUnavailable')}</span>
                ) : (
                  <Link
                    href={documentHref(item.workspaceId, page.documentId, 'PAGE')}
                    className="hover:underline"
                  >
                    {page.title}
                  </Link>
                )}
                {page.changed ? (
                  <span className="text-xs font-medium text-destructive-text">
                    {t('subjectChanged')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {open && anyChanged ? (
            <p role="status" className="max-w-measure text-destructive-text">
              {t('subjectChangedHint')}
            </p>
          ) : null}
        </div>
      )}

      {item.context === null ? null : <Folded label={t('contextLabel')} text={item.context} />}
      {item.workState === null ? null : (
        <Folded label={t('workStateLabel')} text={item.workState} />
      )}
    </div>
  );
}

function Folded({ label, text }: { label: string; text: string }) {
  return (
    <details className="max-w-measure">
      <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        {label}
      </summary>
      <p className="mt-1 whitespace-pre-wrap">{text}</p>
    </details>
  );
}
