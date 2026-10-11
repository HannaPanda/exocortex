'use client';

import { CheckIcon, CircleHelpIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type EvalAssertionResult, type EvalAttempt, type EvalVerdict } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Readout,
  SectionRule,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@exocortex/ui';

import { useReviewEvalAttempt } from '@/lib/api/eval-queries';

import { type EvalWording, outcomeVariant, useEvalWording } from './eval-labels';

const NONE = '__none__';
const SCORES = ['1', '2', '3', '4', '5'] as const;

interface ReviewDraft {
  verdict: EvalVerdict | null;
  score: string | null;
  note: string;
  manual: Record<string, boolean | null>;
}

function reviewDraftOf(attempt: EvalAttempt | null): ReviewDraft {
  const manual: Record<string, boolean | null> = {};
  for (const result of attempt?.assertions ?? []) {
    if (result.kind === 'manual') manual[result.id] = result.passed;
  }
  return {
    verdict: attempt?.review?.verdict ?? null,
    score: attempt?.review?.score == null ? null : String(attempt.review.score),
    note: attempt?.review?.note ?? '',
    manual,
  };
}

/**
 * One eval attempt (issue #146): what the run answered, how each check
 * came out, what the fixture pages read afterwards, and the review a
 * person adds. The review stands beside the automatic outcome; only the
 * answers to manual checks change it, because those are checks too.
 */
export function EvalAttemptDialog({
  attempt,
  canReview,
  onOpenChange,
}: {
  attempt: EvalAttempt | null;
  canReview: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('evals.attempt');
  const wording = useEvalWording();
  const review = useReviewEvalAttempt();
  const [draft, setDraft] = React.useState<ReviewDraft>(() => reviewDraftOf(attempt));
  const [openedFor, setOpenedFor] = React.useState<string | null>(null);
  const key = attempt?.id ?? null;
  if (key !== openedFor) {
    setOpenedFor(key);
    setDraft(reviewDraftOf(attempt));
  }
  if (attempt === null) return null;
  const finished = attempt.status === 'finished';

  const save = async (): Promise<void> => {
    await review.mutateAsync({
      attemptId: attempt.id,
      request: {
        verdict: draft.verdict,
        score: draft.score === null ? null : Number(draft.score),
        note: draft.note.trim() || null,
        manual: draft.manual,
      },
    });
    onOpenChange(false);
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="eval-attempt">
        <DialogHeader>
          <DialogTitle>
            {t('title', {
              case: attempt.caseName,
              variant: attempt.variantLabel,
              repetition: attempt.repetition,
            })}
          </DialogTitle>
          <DialogDescription>
            {attempt.outcome === null ? (
              wording.status(attempt.status)
            ) : (
              <Badge variant={outcomeVariant(attempt.outcome)}>
                {wording.outcome(attempt.outcome)}
              </Badge>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-5">
            <Checks results={attempt.assertions} wording={wording} />
            <Metrics attempt={attempt} wording={wording} />
            <section className="flex flex-col gap-2">
              <SectionRule>{t('answer')}</SectionRule>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">
                {attempt.answer ?? t('noAnswer')}
              </pre>
            </section>
            <Artifacts attempt={attempt} />
            {canReview && finished ? (
              <ReviewFields
                attempt={attempt}
                draft={draft}
                onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
              />
            ) : null}
            {review.error === null ? null : (
              <Alert variant="destructive">
                <AlertDescription>{review.error.message}</AlertDescription>
              </Alert>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('close')}
          </Button>
          {canReview && finished ? (
            <Button
              onClick={() => void save()}
              disabled={review.isPending}
              data-testid="eval-review-save"
            >
              {t('saveReview')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResultMark({ passed }: { passed: boolean | null }) {
  const t = useTranslations('evals.attempt');
  if (passed === null) {
    return (
      <CircleHelpIcon
        className="size-4 shrink-0 text-muted-foreground"
        aria-label={t('undecided')}
      />
    );
  }
  return passed ? (
    <CheckIcon className="size-4 shrink-0 text-primary" aria-label={t('passed')} />
  ) : (
    <XIcon className="size-4 shrink-0 text-destructive" aria-label={t('failed')} />
  );
}

function Checks({
  results,
  wording,
}: {
  results: readonly EvalAssertionResult[];
  wording: EvalWording;
}) {
  const t = useTranslations('evals.attempt');
  if (results.length === 0) return <p className="text-sm text-muted-foreground">{t('noChecks')}</p>;
  return (
    <section className="flex flex-col gap-2">
      <SectionRule>{t('checks')}</SectionRule>
      <ul className="flex flex-col gap-1.5" data-testid="eval-attempt-checks">
        {results.map((result) => {
          const actual = wording.actual(result);
          return (
            <li key={`${result.role}-${result.id}`} className="flex items-start gap-2 text-sm">
              <ResultMark passed={result.passed} />
              <span>
                <span className="font-medium">
                  {result.role === 'invariant' ? t('invariant') : t('criterion')} {result.id}
                </span>
                <span className="text-muted-foreground">
                  {' · '}
                  {result.kind === 'manual' && result.text !== null
                    ? result.text
                    : wording.kind(result.kind as Parameters<EvalWording['kind']>[0])}
                  {actual === null ? '' : ` · ${t('found', { actual })}`}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Metrics({ attempt, wording }: { attempt: EvalAttempt; wording: EvalWording }) {
  const t = useTranslations('evals.attempt');
  const metrics = attempt.metrics;
  if (metrics === null) return null;
  const { format } = wording;
  return (
    <section className="flex flex-col gap-2">
      <SectionRule>{t('metrics')}</SectionRule>
      <div className="flex flex-col gap-1.5">
        <Readout
          label={t('duration')}
          value={metrics.durationMs === null ? '–' : format.duration(metrics.durationMs)}
        />
        <Readout
          label={t('cost')}
          value={metrics.costMicroUsd === null ? '–' : format.money(metrics.costMicroUsd)}
          note={
            metrics.costEstimated
              ? t('costEstimated')
              : metrics.usedOwnKey
                ? t('ownKey')
                : undefined
          }
        />
        <Readout
          label={t('tokens')}
          value={t('tokensValue', {
            input: metrics.inputTokens === null ? '–' : format.count(metrics.inputTokens),
            output: metrics.outputTokens === null ? '–' : format.count(metrics.outputTokens),
          })}
        />
        <Readout
          label={t('toolCalls')}
          value={t('toolCallsValue', { count: metrics.toolCalls, failed: metrics.failedToolCalls })}
          note={Object.entries(metrics.tools)
            .map(([tool, calls]) => `${tool} ×${calls}`)
            .join(', ')}
        />
        <Readout
          label={t('providers')}
          value={metrics.providers.length === 0 ? '–' : metrics.providers.join(', ')}
          note={
            metrics.providerSwitches > 0
              ? t('switches', { count: metrics.providerSwitches })
              : undefined
          }
        />
        <Readout
          label={t('context')}
          value={
            metrics.contextTokens === null
              ? '–'
              : t('contextValue', { tokens: format.count(metrics.contextTokens) })
          }
        />
        <Readout label={t('humanCheckpoints')} value={format.count(metrics.humanCheckpoints)} />
        {metrics.errorCode === null ? null : (
          <Readout
            label={t('error')}
            value={<code className="font-mono text-meta">{metrics.errorCode}</code>}
          />
        )}
      </div>
    </section>
  );
}

function Artifacts({ attempt }: { attempt: EvalAttempt }) {
  const t = useTranslations('evals.attempt');
  const artifacts = attempt.artifacts;
  if (artifacts === null) return null;
  const pages = Object.entries(artifacts.pages);
  if (
    pages.length === 0 &&
    artifacts.createdPages.length === 0 &&
    artifacts.changesets.length === 0
  ) {
    return null;
  }
  return (
    <section className="flex flex-col gap-2">
      <SectionRule>{t('artifacts')}</SectionRule>
      {artifacts.truncated ? (
        <p className="text-xs text-muted-foreground">{t('truncated')}</p>
      ) : null}
      {pages.map(([key, markdown]) => (
        <details key={key} className="rounded-md border border-border p-2 text-sm">
          <summary className="cursor-pointer font-medium">{t('finalPage', { key })}</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">
            {markdown ?? t('pageDeleted')}
          </pre>
        </details>
      ))}
      {artifacts.createdPages.map((page, index) => (
        <details
          key={`${page.title}-${index}`}
          className="rounded-md border border-border p-2 text-sm"
        >
          <summary className="cursor-pointer font-medium">
            {t('createdPage', { title: page.title })}
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">
            {page.markdown}
          </pre>
        </details>
      ))}
      {artifacts.changesets.length === 0 ? null : (
        <ul className="flex flex-col gap-1 text-sm">
          {artifacts.changesets.map((changeset) => (
            <li key={changeset.id}>
              {t('proposal', { title: changeset.title, changes: changeset.changes })}
              <span className="text-muted-foreground">
                {' '}
                · {t(`closedAs.${changeset.closedAs}`)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReviewFields({
  attempt,
  draft,
  onChange,
}: {
  attempt: EvalAttempt;
  draft: ReviewDraft;
  onChange: (patch: Partial<ReviewDraft>) => void;
}) {
  const t = useTranslations('evals.attempt');
  const wording = useEvalWording();
  const manual = attempt.assertions.filter((result) => result.kind === 'manual');
  return (
    <section className="flex flex-col gap-3" data-testid="eval-review">
      <SectionRule>{t('review')}</SectionRule>
      {manual.map((result) => (
        <div key={result.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>{result.text ?? result.id}</span>
          <Select
            value={
              draft.manual[result.id] === undefined || draft.manual[result.id] === null
                ? NONE
                : String(draft.manual[result.id])
            }
            onValueChange={(next) =>
              onChange({
                manual: {
                  ...draft.manual,
                  [result.id]: next === 'true' ? true : next === 'false' ? false : null,
                },
              })
            }
          >
            <SelectTrigger className="h-8 w-40" aria-label={result.text ?? result.id}>
              <SelectValue>
                {() =>
                  draft.manual[result.id] === true
                    ? t('manualYes')
                    : draft.manual[result.id] === false
                      ? t('manualNo')
                      : t('manualOpen')
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('manualOpen')}</SelectItem>
              <SelectItem value="true">{t('manualYes')}</SelectItem>
              <SelectItem value="false">{t('manualNo')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ))}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="eval-review-verdict">{t('verdict')}</Label>
          <Select
            value={draft.verdict ?? NONE}
            onValueChange={(next) =>
              onChange({ verdict: next === NONE || next === null ? null : (next as EvalVerdict) })
            }
          >
            <SelectTrigger id="eval-review-verdict" data-testid="eval-review-verdict">
              <SelectValue>
                {() => (draft.verdict === null ? t('verdictNone') : wording.outcome(draft.verdict))}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('verdictNone')}</SelectItem>
              <SelectItem value="passed">{wording.outcome('passed')}</SelectItem>
              <SelectItem value="failed">{wording.outcome('failed')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="eval-review-score">{t('score')}</Label>
          <Select
            value={draft.score ?? NONE}
            onValueChange={(next) =>
              onChange({ score: next === NONE || next === null ? null : String(next) })
            }
          >
            <SelectTrigger id="eval-review-score">
              <SelectValue>
                {() =>
                  draft.score === null ? t('scoreNone') : t('scoreValue', { score: draft.score })
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('scoreNone')}</SelectItem>
              {SCORES.map((score) => (
                <SelectItem key={score} value={score}>
                  {t('scoreValue', { score })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="eval-review-note">{t('note')}</Label>
        <Textarea
          id="eval-review-note"
          value={draft.note}
          rows={3}
          maxLength={4_000}
          onChange={(event) => onChange({ note: event.target.value })}
        />
      </div>
    </section>
  );
}
