'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { type ChangesetChange } from '@exocortex/contracts';
import { Badge, Checkbox } from '@exocortex/ui';

import { documentHref } from '@/lib/document-href';

import { DiffBlockView } from '../shell/diff-blocks';
import { useWorkItemWording } from '../work-items/work-item-labels';

import { changeStatusVariant } from './changeset-labels';

/**
 * One proposed change, as a reviewer reads it (issue #141).
 *
 * Top to bottom: where it lands and what kind of change it is, why, whether
 * it still fits the page, and the diff. A change that no longer fits cannot
 * be chosen, and the card says why instead of greying out silently.
 */
export function ChangesetChangeCard({
  workspaceId,
  change,
  selectable,
  selected,
  onToggle,
}: {
  workspaceId: string;
  change: ChangesetChange;
  selectable: boolean;
  selected: boolean;
  onToggle: (next: boolean) => void;
}) {
  const t = useTranslations('changesets');
  const wording = useWorkItemWording();
  const position = change.position + 1;
  const pageId = change.createdDocumentId ?? change.documentId;

  return (
    <article
      className="rounded-lg border border-border bg-card p-4"
      data-testid="changeset-change"
      data-status={change.status}
      aria-labelledby={`change-${change.id}-title`}
    >
      <div className="flex items-start gap-3">
        {selectable ? (
          <Checkbox
            className="mt-1"
            checked={selected}
            aria-label={t('change.select', { position })}
            onCheckedChange={(next) => onToggle(next === true)}
            data-testid="changeset-change-checkbox"
          />
        ) : (
          <span className="mt-1 size-4 shrink-0" aria-hidden />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={changeStatusVariant(change.status)}>
              {t(`labels.changeStatus.${change.status}`)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {t('change.position', { position })} · {t(`labels.kind.${change.kind}`)}
              {change.mode === 'replace' || change.mode === 'append' || change.mode === 'prepend'
                ? ` · ${t(`labels.mode.${change.mode}`)}`
                : ''}
            </span>
          </div>
          <h3 id={`change-${change.id}-title`} className="text-sm font-medium text-pretty">
            {change.title ?? t('change.gone')}
            {change.target === null ? null : (
              <span className="font-normal text-muted-foreground">
                {' '}
                {t('change.target', { target: change.target })}
              </span>
            )}
          </h3>
          {change.message === null ? null : (
            <p className="max-w-measure text-sm whitespace-pre-wrap text-muted-foreground">
              {change.message}
            </p>
          )}
          {change.status === 'pending' && !change.applicable ? (
            <p role="status" className="max-w-measure text-sm text-destructive-text">
              {t('change.notApplicable')}
            </p>
          ) : null}
          <Decision change={change} moment={wording.moment} participant={wording.participant} />

          <div className="flex flex-col gap-1.5">
            {change.diff.blocks.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('change.noDiff')}</p>
            ) : (
              change.diff.blocks.map((block, index) => (
                <DiffBlockView key={`${block.blockId ?? 'x'}-${index}`} block={block} />
              ))
            )}
            {change.diff.truncated ? (
              <p className="text-xs text-muted-foreground">{t('change.diffTruncated')}</p>
            ) : null}
          </div>

          {pageId === null || change.title === null ? null : (
            <Link
              href={documentHref(workspaceId, pageId, 'PAGE')}
              className="w-fit text-sm hover:underline"
            >
              {change.createdDocumentId === null ? t('change.openPage') : t('change.openCreated')}
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}

function Decision({
  change,
  moment,
  participant,
}: {
  change: ChangesetChange;
  moment: (iso: string) => string;
  participant: ReturnType<typeof useWorkItemWording>['participant'];
}) {
  const t = useTranslations('changesets');
  return (
    <>
      {change.decidedAt === null ? null : (
        <p className="text-xs text-muted-foreground">
          {t('change.decided', {
            status: t(`labels.changeStatus.${change.status}`),
            who: participant(change.decidedBy),
            when: moment(change.decidedAt),
          })}
        </p>
      )}
      {change.decisionNote === null ? null : (
        <p className="max-w-measure border-l-2 border-border pl-3 text-sm whitespace-pre-wrap">
          {change.decisionNote}
        </p>
      )}
      {change.errorCode === null ? null : (
        <p className="text-xs text-muted-foreground">
          {change.status === 'stale'
            ? t('change.staleCode', { code: change.errorCode })
            : t('change.failedCode', { code: change.errorCode })}
        </p>
      )}
    </>
  );
}
