'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type ChangesetDecisionOutcome, type ChangesetDetail } from '@exocortex/contracts';
import {
  AppPage,
  Badge,
  Button,
  Checkbox,
  ErrorState,
  LoadingState,
  Textarea,
} from '@exocortex/ui';

import { useChangeset, useDecideChangeset } from '@/lib/api/changeset-queries';
import { useWorkspaceDetail } from '@/lib/api/workspace-queries';

import { useWorkItemWording } from '../work-items/work-item-labels';

import { ChangesetChangeCard } from './changeset-change';
import { changesetStatusVariant } from './changeset-labels';

/**
 * One proposal, reviewed and decided (issue #141, ADR-070).
 *
 * Every change is shown with its diff, and a reviewer chooses which to take:
 * everything pending and still fitting is selected at first, because "take
 * it all" is the common answer and the checkboxes are for the exceptions.
 * A change whose page moved cannot be chosen. The note goes with a
 * rejection back to whoever proposed it, and with an apply into the record.
 */
export function ChangesetDetailPage({
  workspaceId,
  changesetId,
}: {
  workspaceId: string;
  changesetId: string;
}) {
  const t = useTranslations('changesets.detail');
  const query = useChangeset(changesetId);

  return (
    <AppPage maxWidth="max-w-4xl">
      <Link
        href={`/arbeitsbereich/${workspaceId}/vorschlaege`}
        className="text-sm text-muted-foreground hover:underline"
      >
        {t('back')}
      </Link>
      {query.isPending ? (
        <LoadingState variant="skeleton" rows={6} label={t('loading')} />
      ) : query.isError ? (
        <ErrorState title={t('loadFailed')} onRetry={() => void query.refetch()} />
      ) : (
        <ChangesetReview workspaceId={workspaceId} changeset={query.data.changeset} />
      )}
    </AppPage>
  );
}

function ChangesetReview({
  workspaceId,
  changeset,
}: {
  workspaceId: string;
  changeset: ChangesetDetail;
}) {
  const t = useTranslations('changesets');
  const wording = useWorkItemWording();
  const detail = useWorkspaceDetail(workspaceId);
  const decide = useDecideChangeset(workspaceId, changeset.id);
  const canDecide =
    detail.data !== undefined &&
    detail.data.role !== 'GUEST' &&
    changeset.submittedAt !== null &&
    changeset.closedAt === null;

  const choosable = React.useMemo(
    () =>
      changeset.changes
        .filter((change) => change.status === 'pending' && change.applicable)
        .map((change) => change.id),
    [changeset.changes],
  );
  const [picked, setPicked] = React.useState<ReadonlySet<string>>(() => new Set(choosable));
  // A decision or a moved page shrinks what can be chosen; only that counts.
  const selected = React.useMemo(
    () => new Set([...picked].filter((id) => choosable.includes(id))),
    [picked, choosable],
  );
  const [note, setNote] = React.useState('');
  const [outcomes, setOutcomes] = React.useState<readonly ChangesetDecisionOutcome[] | null>(null);

  const run = (verb: 'apply' | 'reject', changeIds: readonly string[] | null) => {
    const trimmed = note.trim();
    decide.mutate(
      {
        verb,
        request: {
          ...(changeIds === null ? {} : { changeIds: [...changeIds] }),
          ...(trimmed.length === 0 ? {} : { note: trimmed }),
        },
      },
      {
        onSuccess: (response) => {
          setOutcomes(response.outcomes);
          setNote('');
        },
      },
    );
  };
  const pending = changeset.counts.pending;

  return (
    <div className="mt-3 flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={changesetStatusVariant(changeset.status)}>
            {t(`labels.status.${changeset.status}`)}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {t('detail.proposed', {
              who:
                changeset.proposedBy.kind === 'agent' && changeset.agentLabel !== null
                  ? changeset.agentLabel
                  : wording.participant(changeset.proposedBy),
              when: wording.moment(changeset.submittedAt ?? changeset.createdAt),
            })}
          </span>
        </div>
        <h1 className="exocortex-page-title text-pretty">{changeset.title}</h1>
        {changeset.message === null ? null : (
          <p className="max-w-measure text-sm whitespace-pre-wrap">{changeset.message}</p>
        )}
        <Relations workspaceId={workspaceId} changeset={changeset} />
      </header>

      {changeset.submittedAt === null ? (
        <p role="status" className="max-w-measure text-sm text-muted-foreground">
          {t('detail.draftNotice')}
        </p>
      ) : changeset.closedAt !== null ? (
        <p className="text-sm text-muted-foreground">{t('detail.closedNotice')}</p>
      ) : null}

      {canDecide ? (
        <section
          className="flex flex-col gap-3 rounded-lg border border-border p-4"
          aria-label={t('detail.applySelected')}
        >
          <label className="flex w-fit items-center gap-2 text-sm">
            <Checkbox
              checked={choosable.length > 0 && selected.size === choosable.length}
              onCheckedChange={(next) => setPicked(new Set(next === true ? choosable : []))}
              disabled={choosable.length === 0}
            />
            {t('detail.selectAll')}
            <span className="text-muted-foreground">
              · {t('detail.selected', { count: selected.size })}
            </span>
          </label>
          <div className="flex flex-col gap-1">
            <label htmlFor="changeset-note" className="text-xs font-medium">
              {t('detail.noteLabel')}
            </label>
            <Textarea
              id="changeset-note"
              rows={2}
              value={note}
              placeholder={t('detail.notePlaceholder')}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={selected.size === 0 || decide.isPending}
              onClick={() => run('apply', [...selected])}
              data-testid="changeset-apply-selected"
            >
              {t('detail.applySelected')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={choosable.length === 0 || decide.isPending}
              onClick={() => run('apply', null)}
            >
              {t('detail.applyAll')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={selected.size === 0 || decide.isPending}
              onClick={() => run('reject', [...selected])}
              data-testid="changeset-reject-selected"
            >
              {t('detail.rejectSelected')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending === 0 || decide.isPending}
              onClick={() => run('reject', null)}
            >
              {t('detail.rejectAll')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('detail.undoHint')}</p>
          {decide.isError ? (
            <p role="alert" className="text-sm text-destructive-text">
              {decide.error.message || t('detail.failed')}
            </p>
          ) : null}
        </section>
      ) : null}

      {outcomes === null ? null : <Outcome outcomes={outcomes} />}

      <div className="flex flex-col gap-3">
        {changeset.changes.map((change) => (
          <ChangesetChangeCard
            key={change.id}
            workspaceId={workspaceId}
            change={change}
            selectable={canDecide && choosable.includes(change.id)}
            selected={selected.has(change.id)}
            onToggle={(next) =>
              setPicked((current) => {
                const copy = new Set(current);
                if (next) copy.add(change.id);
                else copy.delete(change.id);
                return copy;
              })
            }
          />
        ))}
      </div>
    </div>
  );
}

function Relations({
  workspaceId,
  changeset,
}: {
  workspaceId: string;
  changeset: ChangesetDetail;
}) {
  const t = useTranslations('changesets.detail');
  const links: { href: string; label: string }[] = [];
  if (changeset.workItem !== null) {
    links.push({
      href: `/arbeitsbereich/${workspaceId}/auftraege/${changeset.workItem.id}`,
      label: `${t('workItem')}: ${changeset.workItem.title}`,
    });
  }
  if (changeset.revisesId !== null) {
    links.push({
      href: `/arbeitsbereich/${workspaceId}/vorschlaege/${changeset.revisesId}`,
      label: t('revises'),
    });
  }
  for (const id of changeset.revisionIds) {
    links.push({ href: `/arbeitsbereich/${workspaceId}/vorschlaege/${id}`, label: t('revisedBy') });
  }
  if (links.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {links.map((link) => (
        <li key={link.href}>
          <Link href={link.href} className="hover:underline">
            {link.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Outcome({ outcomes }: { outcomes: readonly ChangesetDecisionOutcome[] }) {
  const t = useTranslations('changesets.detail');
  const count = (outcome: ChangesetDecisionOutcome['outcome']) =>
    outcomes.filter((entry) => entry.outcome === outcome).length;
  return (
    <p role="status" className="text-sm" data-testid="changeset-outcome">
      {t('outcome', {
        applied: count('applied'),
        rejected: count('rejected'),
        stale: count('stale'),
        failed: count('failed'),
      })}
    </p>
  );
}
