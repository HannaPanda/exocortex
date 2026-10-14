'use client';

import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { type WorkItemChildResult, type WorkItemDetail } from '@exocortex/contracts';
import { Badge, Button, cn } from '@exocortex/ui';

import { useWorkItemChildResults } from '@/lib/api/work-item-queries';

import { statusVariant, useWorkItemWording } from './work-item-labels';
import { pageLinkClassName, Section } from './work-item-sections';

/**
 * The parts a piece of work was split into (issue #144, ADR-072).
 *
 * Each child is a work item of its own; what the parent shows is how far
 * they are and what each one brought back, in words, the way the parent's
 * run reads it. The full result and how the child got there are one click
 * away on the child itself.
 */
export function ChildrenSection({
  item,
  onAddChild,
}: {
  item: WorkItemDetail;
  onAddChild: (() => void) | null;
}) {
  const t = useTranslations('workItems.children');
  const wording = useWorkItemWording();
  const results = useWorkItemChildResults(item.id, item.children.length > 0);
  if (item.children.length === 0 && onAddChild === null) return null;

  const byId = new Map<string, WorkItemChildResult>(
    (results.data?.children ?? []).map((child) => [child.id, child]),
  );
  const progress = item.childProgress;
  const pending = new Set(item.awaiting?.pendingChildIds ?? []);

  return (
    <Section
      title={t('heading')}
      trailing={item.children.length === 0 ? undefined : item.children.length}
      action={
        onAddChild === null ? null : (
          <Button
            size="sm"
            variant="outline"
            onClick={onAddChild}
            data-testid="work-item-add-child"
          >
            <PlusIcon />
            {t('add')}
          </Button>
        )
      }
    >
      {item.children.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('none')}</p>
      ) : (
        <>
          <p className="text-meta text-muted-foreground" data-testid="work-item-child-progress">
            {t('progress', {
              total: progress.total,
              open: progress.open + progress.waiting,
              review: progress.review,
              closed: progress.done + progress.failed + progress.cancelled,
            })}
          </p>
          {item.awaiting === null ? null : (
            <p className="text-sm" data-testid="work-item-awaiting">
              {t('awaiting', {
                pending: item.awaiting.pendingChildIds.length,
                total: item.awaiting.childIds.length,
              })}
            </p>
          )}
          <ul className="flex flex-col text-sm" data-testid="work-item-children">
            {item.children.map((child) => {
              const result = byId.get(child.id);
              return (
                <li
                  key={child.id}
                  className="flex flex-col gap-1 border-b border-border py-2 last:border-b-0"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={statusVariant(child.status)}>
                      {wording.status(child.status)}
                    </Badge>
                    <Link
                      href={`/arbeitsbereich/${item.workspaceId}/auftraege/${child.id}`}
                      className={cn('min-w-0 break-words', pageLinkClassName)}
                    >
                      {child.title}
                    </Link>
                    <span className="text-meta text-muted-foreground">
                      {wording.participant(child.assignee)}
                    </span>
                    {pending.has(child.id) ? <Badge variant="outline">{t('awaited')}</Badge> : null}
                    {result === undefined || result.spentMicroUsd === 0 ? null : (
                      <span className="exocortex-numeric text-meta text-muted-foreground">
                        {wording.money(result.spentMicroUsd)}
                      </span>
                    )}
                  </div>
                  {child.statusReason === null ? null : (
                    <p className="text-meta text-muted-foreground">{child.statusReason}</p>
                  )}
                  {result?.result == null ? null : (
                    <p className="line-clamp-3 whitespace-pre-wrap text-muted-foreground">
                      {result.result}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Section>
  );
}
