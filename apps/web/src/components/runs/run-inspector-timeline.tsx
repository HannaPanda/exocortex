'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type AiRunInspection, type AiRunTimelineEntry } from '@exocortex/contracts';
import { cn, SectionRule } from '@exocortex/ui';

import { type RunFormat } from './run-inspector-format';

type Entry<K extends AiRunTimelineEntry['kind']> = Extract<AiRunTimelineEntry, { kind: K }>;
type Translate = ReturnType<typeof useTranslations<'runInspector.timeline'>>;

/** What one row says: its line, the facts after it, where it leads, and whether it is bad news. */
interface EntryLine {
  label: React.ReactNode;
  facts: string[];
  tone: 'default' | 'muted' | 'problem';
}

function turnLine(entry: Entry<'turn'>, t: Translate, format: RunFormat): EntryLine {
  const tokens =
    entry.inputTokens === null || entry.outputTokens === null
      ? []
      : [
          t('turnTokens', {
            input: format.count(entry.inputTokens),
            output: format.count(entry.outputTokens),
          }),
        ];
  return {
    label: t('turn', { index: entry.index, model: entry.model }),
    facts: [
      ...(entry.servedBy === null ? [] : [t('turnServedBy', { provider: entry.servedBy })]),
      ...tokens,
      ...(entry.costMicroUsd === null ? [] : [format.money(entry.costMicroUsd)]),
      ...(entry.reasoned ? [t('turnReasoned')] : []),
      ...(entry.toolCalls === 0 ? [] : [t('turnTools', { count: entry.toolCalls })]),
      ...(entry.failureCode === null ? [] : [t('turnFailed', { code: entry.failureCode })]),
    ],
    tone: entry.failureCode === null ? 'default' : 'problem',
  };
}

function toolLine(
  entry: Entry<'tool_call'>,
  t: Translate,
  format: RunFormat,
  workspaceId: string,
): EntryLine {
  const documentId = entry.target?.replace(/^(document|page):/, '') ?? null;
  const target =
    entry.targetTitle !== null && documentId !== null ? (
      <Link href={`/arbeitsbereich/${workspaceId}/seite/${documentId}`} className="hover:underline">
        {entry.targetTitle}
      </Link>
    ) : null;
  return {
    label: (
      <span className="flex flex-wrap items-baseline gap-x-1.5">
        <code className="font-mono text-meta">{t('toolCall', { tool: entry.toolName })}</code>
        {target === null ? null : <span className="text-muted-foreground">→ {target}</span>}
      </span>
    ),
    facts: [
      t(`toolStatus.${entry.status}`),
      ...(entry.status === 'undelivered' || entry.status === 'skipped'
        ? []
        : [t('toolResult', { chars: format.count(entry.resultChars) })]),
      ...(entry.resultTruncated ? [t('toolTruncated')] : []),
      ...(entry.untrustedOrigin === null ? [] : [t('toolUntrusted')]),
      ...(entry.repeated ? [t('toolRepeated')] : []),
      ...(entry.pausedRun ? [t('toolPaused')] : []),
    ],
    tone: entry.status === 'succeeded' ? 'default' : 'problem',
  };
}

function runLink(runId: string, label: string): React.ReactNode {
  return (
    <Link href={`/laeufe/${runId}`} className="hover:underline">
      {label}
    </Link>
  );
}

function entryLine(
  entry: AiRunTimelineEntry,
  t: Translate,
  format: RunFormat,
  workspaceId: string,
): EntryLine {
  const plain = (label: React.ReactNode, facts: string[] = []): EntryLine => ({
    label,
    facts,
    tone: 'muted',
  });
  switch (entry.kind) {
    case 'created':
      return plain(t('created'));
    case 'started':
      return plain(t('started'));
    case 'context':
      return plain(
        t('context', {
          chars: format.count(entry.chars),
          tokens: format.count(entry.estimatedTokens),
        }),
      );
    case 'compaction':
      return plain(t('compaction', { count: entry.summarizedMessages }));
    case 'turn':
      return turnLine(entry, t, format);
    case 'tool_call':
      return toolLine(entry, t, format, workspaceId);
    case 'truncation_retry':
      return { ...plain(t('truncationRetry', { attempt: entry.attempt })), tone: 'problem' };
    case 'attention_raised':
      return {
        label: (
          <Link href="/wartet" className="hover:underline">
            {t('attentionRaised', { title: entry.title })}
          </Link>
        ),
        facts: entry.blocking ? [t('attentionBlocking')] : [],
        tone: 'default',
      };
    case 'attention_settled':
      return plain(t('attentionSettled'));
    case 'changeset':
      return {
        label: (
          <Link
            href={`/arbeitsbereich/${workspaceId}/vorschlaege/${entry.changesetId}`}
            className="hover:underline"
          >
            {t('changeset', { title: entry.title })}
          </Link>
        ),
        facts: [],
        tone: 'default',
      };
    case 'work_checkpoint':
      return plain(t('workCheckpoint'));
    case 'resumed_from':
      return plain(runLink(entry.runId, t('resumedFrom')));
    case 'resumed_as':
      return plain(runLink(entry.runId, t('resumedAs')));
    case 'finished':
      return {
        label: t('finished'),
        facts: entry.errorCode === null ? [] : [t('finishedError', { code: entry.errorCode })],
        tone: entry.errorCode === null ? 'default' : 'problem',
      };
  }
}

/** Every step of the run in order, with its offset from the start and how long it took. */
export function RunTimeline({
  inspection,
  format,
}: {
  inspection: AiRunInspection;
  format: RunFormat;
}) {
  const t = useTranslations('runInspector.timeline');
  const origin = inspection.run.createdAt;
  return (
    <section className="flex flex-col gap-3">
      <SectionRule trailing={format.count(inspection.timeline.length)}>{t('heading')}</SectionRule>
      <ol className="flex flex-col" data-testid="run-timeline">
        {inspection.timeline.map((entry, index) => {
          const line = entryLine(entry, t, format, inspection.run.workspaceId);
          return (
            <li
              key={`${entry.kind}-${String(index)}`}
              className="grid grid-cols-[4.5rem_1fr_auto] items-baseline gap-x-3 border-b border-border/60 py-1.5 text-sm last:border-b-0"
              data-kind={entry.kind}
            >
              <span className="exocortex-numeric text-meta text-muted-foreground">
                {format.offset(entry.at, origin)}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span
                  className={cn(
                    'min-w-0 break-words',
                    line.tone === 'muted' && 'text-muted-foreground',
                    line.tone === 'problem' && 'text-destructive-text',
                  )}
                >
                  {line.label}
                </span>
                {line.facts.length === 0 ? null : (
                  <span className="text-meta text-muted-foreground">{line.facts.join(' · ')}</span>
                )}
              </span>
              <span className="exocortex-numeric text-meta text-muted-foreground">
                {entry.durationMs === null ? null : format.duration(entry.durationMs)}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
