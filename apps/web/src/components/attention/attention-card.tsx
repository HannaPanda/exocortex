'use client';

import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type AttentionItem,
  type AttentionOption,
  SYSTEM_ATTENTION_OPTIONS,
  type WorkItemParticipant,
} from '@exocortex/contracts';
import { Badge, Button, Textarea } from '@exocortex/ui';

import { useResolveAttention } from '@/lib/api/attention-queries';

/**
 * One thing that waits on the reader (issue #139).
 *
 * The card answers three questions in reading order: what kind of thing this
 * is and what it is about (the badge and the title), why it needs you (the
 * reason), and what you can do about it right here (the options). Everything
 * about where it came from is one quiet line, because it helps somebody decide
 * without being what they decide on.
 *
 * An answer in words is either asked for, and then the field is simply there,
 * or optional, and then it hides behind "Notiz dazu": a text field under
 * every review would make a two-second decision look like a form.
 */

const SYSTEM_OPTIONS: ReadonlySet<string> = new Set(SYSTEM_ATTENTION_OPTIONS);

type OptionId = (typeof SYSTEM_ATTENTION_OPTIONS)[number];

/** The option the card leads with: the one that moves the work forward. */
const PRIMARY: ReadonlySet<string> = new Set<OptionId>(['accept', 'answer', 'unblock', 'retry']);

function kindVariant(item: AttentionItem): 'destructive' | 'outline' | 'default' {
  if (item.kind === 'run_failed' || item.kind === 'conflict') return 'destructive';
  if (item.kind === 'review') return 'default';
  return 'outline';
}

export function AttentionCard({
  item,
  showWorkspace = true,
}: {
  item: AttentionItem;
  /** Off where the card sits inside the work item it is about. */
  showWorkspace?: boolean;
}) {
  const t = useTranslations('attention');
  const format = useFormatter();
  const resolve = useResolveAttention();
  const noteRequired = item.noteMode === 'required';
  const [noteOpen, setNoteOpen] = React.useState(noteRequired);
  const [note, setNote] = React.useState('');
  const open = item.status === 'open';

  const optionLabel = (option: AttentionOption): string =>
    option.label ??
    (SYSTEM_OPTIONS.has(option.id) ? t(`option.${option.id as OptionId}`) : option.id);

  const moment = (iso: string): string =>
    format.relativeTime(new Date(iso), { now: new Date(), style: 'long' });

  const raisedBy = (participant: WorkItemParticipant): string => {
    if (participant.kind === 'assistant') return t('item.raisedByAssistant');
    if (participant.name === null) return t('item.raisedBySomebody');
    return participant.kind === 'agent'
      ? t('item.raisedByAgent', { name: item.agentLabel ?? participant.name })
      : t('item.raisedBy', { name: participant.name });
  };

  const submit = (optionId: string | undefined) => {
    const trimmed = note.trim();
    resolve.mutate({
      attentionItemId: item.id,
      request: {
        ...(optionId === undefined ? {} : { optionId }),
        ...(trimmed.length === 0 ? {} : { note: trimmed }),
      },
    });
  };
  const missingNote = noteRequired && note.trim().length === 0;
  const workItemHref =
    item.workItem === null
      ? null
      : `/arbeitsbereich/${item.workspaceId}/auftraege/${item.workItem.id}`;

  return (
    <article
      className="rounded-lg border border-border bg-card p-4"
      data-testid="attention-item"
      data-kind={item.kind}
      aria-labelledby={`attention-${item.id}-title`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={kindVariant(item)}>{t(`kind.${item.kind}`)}</Badge>
        {item.urgency === 'high' || item.urgency === 'urgent' ? (
          <span className="text-xs font-medium text-destructive-text">
            {t(`urgency.${item.urgency}`)}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {[
            raisedBy(item.raisedBy),
            showWorkspace ? t('item.workspace', { name: item.workspaceName }) : null,
            moment(item.createdAt),
          ]
            .filter((part) => part !== null)
            .join(' · ')}
        </span>
      </div>

      <h2 id={`attention-${item.id}-title`} className="mt-2 text-base font-medium text-pretty">
        {item.title}
      </h2>
      {item.reason === null ? null : (
        <p className="mt-1 max-w-measure text-sm whitespace-pre-wrap text-muted-foreground">
          {item.kind === 'run_failed' ? t('item.runError', { code: item.reason }) : item.reason}
        </p>
      )}

      {open ? (
        <>
          {noteOpen ? (
            <div className="mt-3 flex flex-col gap-1">
              <label htmlFor={`attention-${item.id}-note`} className="text-xs font-medium">
                {t('item.noteLabel')}
              </label>
              <Textarea
                id={`attention-${item.id}-note`}
                rows={noteRequired ? 3 : 2}
                value={note}
                placeholder={t(
                  noteRequired ? 'item.notePlaceholderRequired' : 'item.notePlaceholderOptional',
                )}
                onChange={(event) => setNote(event.target.value)}
                data-testid="attention-note"
              />
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {item.options.length === 0 ? (
              <Button
                size="sm"
                disabled={missingNote || resolve.isPending}
                onClick={() => submit(undefined)}
                data-testid="attention-send"
              >
                {t('item.send')}
              </Button>
            ) : (
              item.options.map((option, index) => (
                <Button
                  key={option.id}
                  size="sm"
                  variant={
                    PRIMARY.has(option.id) || (!item.system && index === 0) ? 'default' : 'outline'
                  }
                  disabled={missingNote || resolve.isPending}
                  onClick={() => submit(option.id)}
                  data-testid={`attention-option-${option.id}`}
                >
                  {optionLabel(option)}
                </Button>
              ))
            )}
            {!noteOpen && item.noteMode === 'optional' ? (
              <Button size="sm" variant="ghost" onClick={() => setNoteOpen(true)}>
                {t('item.addNote')}
              </Button>
            ) : null}
            <ContextLinks item={item} workItemHref={workItemHref} />
          </div>
          {resolve.isError ? (
            <p role="alert" className="mt-2 text-sm text-destructive-text">
              {resolve.error.message || t('item.failed')}
            </p>
          ) : null}
        </>
      ) : (
        <Settled item={item} optionLabel={optionLabel} workItemHref={workItemHref} />
      )}
    </article>
  );
}

function ContextLinks({
  item,
  workItemHref,
}: {
  item: AttentionItem;
  workItemHref: string | null;
}) {
  const t = useTranslations('attention.item');
  return (
    <span className="ml-auto flex flex-wrap gap-3 text-sm">
      {item.run?.conversationId == null ? null : (
        <Link
          href={`/chats?fortsetzen=${item.run.conversationId}`}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          {t('openConversation')}
        </Link>
      )}
      {workItemHref === null ? null : (
        <Link
          href={workItemHref}
          className="text-muted-foreground hover:text-foreground hover:underline"
          data-testid="attention-open-work-item"
        >
          {t('openWorkItem')}
        </Link>
      )}
    </span>
  );
}

function Settled({
  item,
  optionLabel,
  workItemHref,
}: {
  item: AttentionItem;
  optionLabel: (option: AttentionOption) => string;
  workItemHref: string | null;
}) {
  const t = useTranslations('attention.item');
  const format = useFormatter();
  const moment =
    item.settledAt === null
      ? ''
      : format.relativeTime(new Date(item.settledAt), { now: new Date(), style: 'long' });
  const chosen = item.options.find((option) => option.id === item.resolution?.optionId);
  const reason = item.resolution?.reason;
  const knownReason =
    reason === 'work_item_cancelled' ||
    reason === 'work_item_deleted' ||
    reason === 'withdrawn' ||
    reason === 'superseded'
      ? reason
      : null;

  return (
    <div className="mt-3 flex flex-col gap-1 text-sm text-muted-foreground">
      <p>
        {item.status === 'obsolete'
          ? t('settledObsolete', { moment })
          : t('settledResolved', { name: item.settledBy?.name ?? t('settledBySystem'), moment })}
      </p>
      {chosen === undefined ? null : <p>{t('chose', { option: optionLabel(chosen) })}</p>}
      {knownReason === null ? null : <p>{t(`obsoleteReason.${knownReason}`)}</p>}
      {item.resolution?.note === undefined ? null : (
        <p className="whitespace-pre-wrap text-foreground">
          {t('quotedNote', { note: item.resolution.note })}
        </p>
      )}
      {workItemHref === null ? null : (
        <Link href={workItemHref} className="w-fit hover:text-foreground hover:underline">
          {t('openWorkItem')}
        </Link>
      )}
    </div>
  );
}
