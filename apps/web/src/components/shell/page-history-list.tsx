'use client';

import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  HistoryIcon,
  PencilIcon,
  RotateCcwIcon,
  SaveIcon,
  SparklesIcon,
  UploadIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type PageHistoryAuthor, type PageHistoryGroup } from '@exocortex/contracts';
import { Button, cn, sectionLabelClassName, TruncatedText } from '@exocortex/ui';

import { useFormatter } from '@/lib/formatter';

type Translate = ReturnType<typeof useTranslations<'document.pageHistory'>>;
type Formatter = ReturnType<typeof useFormatter>;

function nameOf(author: PageHistoryAuthor, t: Translate): string {
  return author.kind === 'unknown' ? t('unknownName') : (author.name ?? t('unknownName'));
}

/**
 * What an entry says happened, in one line.
 *
 * The direction differs by kind and is the thing most easily read backwards:
 * a typing session is the page *as somebody left it*, a write series the page
 * *before* somebody wrote. The sentence says which, so nobody has to know what
 * a snapshot reason is.
 */
export function groupTitle(group: PageHistoryGroup, t: Translate): string {
  const name = nameOf(group.author, t);
  switch (group.kind) {
    case 'edit':
      return t('groups.edit', { name });
    case 'write':
      if (group.author.kind === 'aiRun') return t('groups.writeAiRun');
      if (group.author.kind === 'agent') {
        return t('groups.writeAgent', { agent: group.author.clientLabel ?? t('unknownAgent') });
      }
      return t('groups.writePerson', { name });
    case 'restore':
      return t('groups.restore', { name });
    case 'manual':
      return t('groups.manual', { name });
    case 'import':
      return t('groups.import', { name });
  }
}

function GroupIcon({ group }: { group: PageHistoryGroup }) {
  const className = 'mt-0.5 size-4 shrink-0 text-muted-foreground';
  if (group.kind === 'write' && group.author.kind === 'aiRun') {
    return <SparklesIcon className={className} aria-hidden />;
  }
  if (group.kind === 'write' && group.author.kind === 'agent') {
    return <BotIcon className={className} aria-hidden />;
  }
  switch (group.kind) {
    case 'edit':
      return <PencilIcon className={className} aria-hidden />;
    case 'restore':
      return <RotateCcwIcon className={className} aria-hidden />;
    case 'manual':
      return <SaveIcon className={className} aria-hidden />;
    case 'import':
      return <UploadIcon className={className} aria-hidden />;
    case 'write':
      return <HistoryIcon className={className} aria-hidden />;
  }
}

function time(format: Formatter, iso: string): string {
  return format.dateTime(new Date(iso), { timeStyle: 'short' });
}

/** The second line: when, how many, and on whose behalf an agent wrote. */
function groupMeta(group: PageHistoryGroup, t: Translate, format: Formatter): string {
  const when =
    time(format, group.startedAt) === time(format, group.endedAt)
      ? time(format, group.endedAt)
      : t('span', { from: time(format, group.startedAt), to: time(format, group.endedAt) });
  const parts = [when];
  const count = group.versions.length;
  if (count > 1) {
    parts.push(
      group.kind === 'edit'
        ? t('editCount', { count })
        : group.kind === 'write'
          ? t('writeCount', { count })
          : t('otherCount', { count }),
    );
  }
  if (group.kind === 'write' && group.author.kind !== 'person' && group.author.kind !== 'unknown') {
    parts.push(t('onBehalfOf', { name: nameOf(group.author, t) }));
  }
  return parts.join(' · ');
}

/** Local calendar day, which is what a reader means by "the same day". */
function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function dayHeading(iso: string, format: Formatter): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return format.dateTime(
    date,
    sameYear ? { weekday: 'long', day: 'numeric', month: 'long' } : { dateStyle: 'long' },
  );
}

const rowClassName = cn(
  'flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
  'hover:bg-accent hover:text-foreground',
  'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
  'aria-[current=true]:bg-accent aria-[current=true]:text-foreground',
);

function GroupRow({
  group,
  selectedId,
  onSelect,
}: {
  group: PageHistoryGroup;
  selectedId: string | null;
  onSelect: (snapshotId: string) => void;
}) {
  const t = useTranslations('document.pageHistory');
  const format = useFormatter();
  const members = group.versions.length;
  const memberSelected =
    selectedId !== group.representativeId &&
    group.versions.some((version) => version.id === selectedId);
  const [open, setOpen] = React.useState(memberSelected);

  return (
    <li className="flex flex-col">
      <div className="flex items-start gap-0.5">
        <button
          type="button"
          className={rowClassName}
          aria-current={selectedId === group.representativeId}
          data-testid="page-history-entry"
          onClick={() => onSelect(group.representativeId)}
        >
          <GroupIcon group={group} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <TruncatedText text={groupTitle(group, t)} className="font-medium" />
            <span className="exocortex-numeric truncate text-xs text-muted-foreground">
              {groupMeta(group, t, format)}
            </span>
          </span>
        </button>
        {members > 1 ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="mt-1 shrink-0"
            aria-expanded={open}
            aria-label={open ? t('hideMembers') : t('showMembers', { count: members })}
            data-testid="page-history-expand"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </Button>
        ) : null}
      </div>
      {open ? (
        <ul className="ml-6 flex flex-col">
          {group.versions.map((version) => (
            <li key={version.id}>
              <button
                type="button"
                className={cn(rowClassName, 'py-1 text-xs')}
                aria-current={selectedId === version.id}
                aria-label={t('memberLabel', { time: time(format, version.createdAt) })}
                data-testid="page-history-member"
                onClick={() => onSelect(version.id)}
              >
                <span className="exocortex-numeric">{time(format, version.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The versions, by day, newest first. Each entry is a group of versions in
 * short succession (issue #235); its members open beside it, and every one of
 * them can be chosen on its own, so the folding loses nothing.
 */
export function PageHistoryList({
  groups,
  currentUpdatedAt,
  selectedId,
  onSelect,
  footer,
}: {
  groups: readonly PageHistoryGroup[];
  currentUpdatedAt: string;
  selectedId: string | null;
  onSelect: (snapshotId: string) => void;
  footer?: React.ReactNode;
}) {
  const t = useTranslations('document.pageHistory');
  const format = useFormatter();
  const days: { key: string; heading: string; groups: PageHistoryGroup[] }[] = [];
  for (const group of groups) {
    const key = dayKey(group.endedAt);
    const last = days[days.length - 1];
    if (last?.key === key) last.groups.push(group);
    else days.push({ key, heading: dayHeading(group.endedAt, format), groups: [group] });
  }

  return (
    <nav aria-label={t('listLabel')} className="flex flex-col gap-4">
      <div className="px-2 text-sm">
        <p className="font-medium">{t('current')}</p>
        <p className="exocortex-numeric text-xs text-muted-foreground">
          {t('currentMeta', {
            time: format.dateTime(new Date(currentUpdatedAt), {
              dateStyle: 'medium',
              timeStyle: 'short',
            }),
          })}
        </p>
      </div>
      {days.map((day) => (
        <section key={day.key} className="flex flex-col gap-0.5">
          <h3 className={cn('exocortex-numeric px-2 pb-1', sectionLabelClassName)}>
            {day.heading}
          </h3>
          <ul className="flex flex-col gap-0.5">
            {day.groups.map((group) => (
              <GroupRow key={group.id} group={group} selectedId={selectedId} onSelect={onSelect} />
            ))}
          </ul>
        </section>
      ))}
      {footer}
    </nav>
  );
}
