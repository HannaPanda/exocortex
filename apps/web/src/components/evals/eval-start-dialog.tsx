'use client';

import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type AiReasoningLevel,
  EVAL_LIMITS,
  type EvalCase,
  type StartEvalRunRequestInput,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { useAiModels } from '@/lib/api/ai-queries';
import { useStartEvalRun } from '@/lib/api/eval-queries';

import { useAgentProfileWording } from '../agent-profiles/agent-profile-labels';

import { rowKey } from './eval-case-draft';

const ALL_CASES = '__cases__';

interface VariantDraft {
  rowKey: string;
  modelSlug: string | null;
  reasoningLevel: AiReasoningLevel;
  /** Comma-separated OpenRouter provider names for `only`. */
  providers: string;
  label: string;
}

function emptyVariant(): VariantDraft {
  return { rowKey: rowKey(), modelSlug: null, reasoningLevel: 'none', providers: '', label: '' };
}

/**
 * Starting an eval run (issue #146): which cases, against which variants,
 * how often. The number of attempts is shown before anything starts,
 * because every one of them is a paid run.
 */
export function EvalStartDialog({
  open,
  onOpenChange,
  workspaceId,
  cases,
  suites,
  preselected = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  cases: readonly EvalCase[];
  suites: readonly string[];
  preselected?: readonly string[];
}) {
  const t = useTranslations('evals.start');
  const router = useRouter();
  const start = useStartEvalRun(workspaceId);
  const [suite, setSuite] = React.useState<string>(ALL_CASES);
  const [caseIds, setCaseIds] = React.useState<string[]>([...preselected]);
  const [variants, setVariants] = React.useState<VariantDraft[]>(() => [emptyVariant()]);
  const [repetitions, setRepetitions] = React.useState('1');
  const [label, setLabel] = React.useState('');

  const [wasOpen, setWasOpen] = React.useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setCaseIds([...preselected]);
      setSuite(ALL_CASES);
    }
  }

  const chosenCases =
    suite === ALL_CASES ? caseIds.length : cases.filter((entry) => entry.suite === suite).length;
  const reps = Number(repetitions);
  const repsValid = Number.isInteger(reps) && reps >= 1 && reps <= EVAL_LIMITS.maxRepetitions;
  const total = chosenCases * variants.length * (repsValid ? reps : 0);
  const variantsValid = variants.every((variant) => variant.modelSlug !== null);
  const valid =
    chosenCases > 0 &&
    variantsValid &&
    repsValid &&
    total <= EVAL_LIMITS.maxAttemptsPerRun &&
    chosenCases <= EVAL_LIMITS.maxCasesPerRun;

  const submit = async (): Promise<void> => {
    const request: StartEvalRunRequestInput = {
      ...(suite === ALL_CASES ? { caseIds } : { suite }),
      variants: variants.map((variant) => {
        const only = variant.providers
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        return {
          modelSlug: variant.modelSlug!,
          reasoningLevel: variant.reasoningLevel,
          providerRouting: only.length === 0 ? null : { only },
          label: variant.label.trim() || null,
        };
      }),
      repetitions: reps,
      label: label.trim() || null,
    };
    const started = await start.mutateAsync(request);
    onOpenChange(false);
    router.push(`/arbeitsbereich/${workspaceId}/evals/${started.run.id}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-5" data-testid="eval-start-form">
            {start.error === null ? null : (
              <Alert variant="destructive">
                <AlertDescription>{start.error.message}</AlertDescription>
              </Alert>
            )}
            <CaseChoice
              cases={cases}
              suites={suites}
              suite={suite}
              caseIds={caseIds}
              onSuite={setSuite}
              onCases={setCaseIds}
            />
            <VariantList variants={variants} onChange={setVariants} />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="eval-start-repetitions">{t('repetitionsLabel')}</Label>
                <Input
                  id="eval-start-repetitions"
                  inputMode="numeric"
                  value={repetitions}
                  onChange={(event) => setRepetitions(event.target.value)}
                  aria-invalid={!repsValid}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="eval-start-label">{t('labelLabel')}</Label>
                <Input
                  id="eval-start-label"
                  value={label}
                  maxLength={120}
                  placeholder={t('labelPlaceholder')}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </div>
            </div>
          </div>
        </DialogBody>
        <DialogFooter className="items-center">
          <p
            className={
              total > EVAL_LIMITS.maxAttemptsPerRun
                ? 'mr-auto text-xs text-destructive'
                : 'mr-auto text-xs text-muted-foreground'
            }
            data-testid="eval-start-total"
          >
            {t('total', { count: total, max: EVAL_LIMITS.maxAttemptsPerRun })}
          </p>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!valid || start.isPending}
            data-testid="eval-start-submit"
          >
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CaseChoice({
  cases,
  suites,
  suite,
  caseIds,
  onSuite,
  onCases,
}: {
  cases: readonly EvalCase[];
  suites: readonly string[];
  suite: string;
  caseIds: string[];
  onSuite: (suite: string) => void;
  onCases: (caseIds: string[]) => void;
}) {
  const t = useTranslations('evals.start');
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="eval-start-suite">{t('casesLabel')}</Label>
      <Select value={suite} onValueChange={(next) => onSuite(String(next))}>
        <SelectTrigger id="eval-start-suite">
          <SelectValue>
            {() => (suite === ALL_CASES ? t('chooseCases') : t('wholeSuite', { suite }))}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_CASES}>{t('chooseCases')}</SelectItem>
          {suites.map((name) => (
            <SelectItem key={name} value={name}>
              {t('wholeSuite', { suite: name })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {suite === ALL_CASES ? (
        <div
          className="flex max-h-48 flex-col gap-1.5 overflow-y-auto"
          data-testid="eval-start-cases"
        >
          {cases.map((evalCase) => (
            <label key={evalCase.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={caseIds.includes(evalCase.id)}
                onCheckedChange={(checked) =>
                  onCases(
                    checked === true
                      ? [...caseIds, evalCase.id]
                      : caseIds.filter((id) => id !== evalCase.id),
                  )
                }
              />
              {evalCase.name}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function VariantList({
  variants,
  onChange,
}: {
  variants: VariantDraft[];
  onChange: (variants: VariantDraft[]) => void;
}) {
  const t = useTranslations('evals.start');
  const wording = useAgentProfileWording();
  const models = useAiModels();
  const usable = (models.data?.models ?? []).filter((model) => model.supportsTools);
  const update = (key: string, patch: Partial<VariantDraft>): void =>
    onChange(
      variants.map((variant) => (variant.rowKey === key ? { ...variant, ...patch } : variant)),
    );

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{t('variantsLabel')}</legend>
      <p className="text-xs text-muted-foreground">{t('variantsHint')}</p>
      {variants.map((variant) => {
        const model = usable.find((entry) => entry.slug === variant.modelSlug) ?? null;
        const prefix = `eval-variant-${variant.rowKey}`;
        return (
          <div
            key={variant.rowKey}
            className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]"
            data-testid="eval-variant-row"
          >
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${prefix}-model`} className="text-xs">
                {t('model')}
              </Label>
              <Select
                value={variant.modelSlug ?? ''}
                onValueChange={(next) =>
                  update(variant.rowKey, {
                    modelSlug: next === null ? null : String(next),
                    reasoningLevel: 'none',
                  })
                }
              >
                <SelectTrigger id={`${prefix}-model`}>
                  <SelectValue>{() => model?.displayName ?? t('modelChoose')}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {usable.map((entry) => (
                    <SelectItem key={entry.slug} value={entry.slug}>
                      {entry.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${prefix}-reasoning`} className="text-xs">
                {t('reasoning')}
              </Label>
              <Select
                value={variant.reasoningLevel}
                onValueChange={(next) =>
                  update(variant.rowKey, { reasoningLevel: next as AiReasoningLevel })
                }
              >
                <SelectTrigger id={`${prefix}-reasoning`}>
                  <SelectValue>{() => wording.reasoning(variant.reasoningLevel)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(model?.reasoningLevels ?? ['none']).map((level) => (
                    <SelectItem key={level} value={level}>
                      {wording.reasoning(level)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${prefix}-providers`} className="text-xs">
                {t('providers')}
              </Label>
              <Input
                id={`${prefix}-providers`}
                value={variant.providers}
                placeholder={t('providersPlaceholder')}
                onChange={(event) => update(variant.rowKey, { providers: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${prefix}-label`} className="text-xs">
                {t('variantLabel')}
              </Label>
              <Input
                id={`${prefix}-label`}
                value={variant.label}
                maxLength={60}
                onChange={(event) => update(variant.rowKey, { label: event.target.value })}
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="self-end"
              disabled={variants.length === 1}
              aria-label={t('removeVariant')}
              onClick={() => onChange(variants.filter((entry) => entry.rowKey !== variant.rowKey))}
            >
              <Trash2Icon className="size-4" />
            </Button>
          </div>
        );
      })}
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        disabled={variants.length >= EVAL_LIMITS.maxVariants}
        onClick={() => onChange([...variants, emptyVariant()])}
        data-testid="eval-variant-add"
      >
        <PlusIcon className="size-4" />
        {t('addVariant')}
      </Button>
    </fieldset>
  );
}
