'use client';

import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { EVAL_ASSERTION_MODES, type EvalReplayMode } from '@exocortex/contracts';
import {
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import {
  assertionOf,
  CHECK_KINDS,
  type CheckDraft,
  type CheckRole,
  emptyCheck,
} from './eval-case-draft';
import { useEvalWording } from './eval-labels';

/**
 * The checks of an eval case (issue #146): invariants first, because a
 * broken one fails the attempt whatever else went well, then the criteria.
 * Each row shows only the fields its kind reads; a kind the case's mode
 * cannot decide is not offered.
 */
export function EvalCaseChecks({
  checks,
  replayMode,
  pageKeys,
  onChange,
}: {
  checks: CheckDraft[];
  replayMode: EvalReplayMode;
  pageKeys: string[];
  onChange: (checks: CheckDraft[]) => void;
}) {
  const t = useTranslations('evals.dialog');
  const update = (rowKey: string, patch: Partial<CheckDraft>): void =>
    onChange(checks.map((check) => (check.rowKey === rowKey ? { ...check, ...patch } : check)));
  const add = (role: CheckRole): void =>
    onChange([...checks, emptyCheck(role, checks.filter((check) => check.role === role).length)]);
  const remove = (rowKey: string): void =>
    onChange(checks.filter((check) => check.rowKey !== rowKey));

  return (
    <div className="flex flex-col gap-4" data-testid="eval-case-checks">
      {(['invariant', 'criterion'] as const).map((role) => {
        const rows = checks.filter((check) => check.role === role);
        return (
          <fieldset key={role} className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">
              {role === 'invariant' ? t('invariantsLabel') : t('criteriaLabel')}
            </legend>
            <p className="text-xs text-muted-foreground">
              {role === 'invariant' ? t('invariantsHint') : t('criteriaHint')}
            </p>
            {rows.map((check) => (
              <CheckRow
                key={check.rowKey}
                check={check}
                replayMode={replayMode}
                pageKeys={pageKeys}
                onChange={(patch) => update(check.rowKey, patch)}
                onRemove={() => remove(check.rowKey)}
              />
            ))}
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => add(role)}
              data-testid={`eval-check-add-${role}`}
            >
              <PlusIcon className="size-4" />
              {role === 'invariant' ? t('addInvariant') : t('addCriterion')}
            </Button>
          </fieldset>
        );
      })}
    </div>
  );
}

function CheckRow({
  check,
  replayMode,
  pageKeys,
  onChange,
  onRemove,
}: {
  check: CheckDraft;
  replayMode: EvalReplayMode;
  pageKeys: string[];
  onChange: (patch: Partial<CheckDraft>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('evals.dialog');
  const wording = useEvalWording();
  const kinds = CHECK_KINDS.filter((kind) => {
    const only = EVAL_ASSERTION_MODES[kind];
    return only === undefined || only === replayMode;
  });
  const complete = assertionOf(check) !== null;
  const prefix = `eval-check-${check.rowKey}`;

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border p-3"
      aria-invalid={!complete}
      data-testid="eval-check-row"
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex w-24 flex-col gap-1">
          <Label htmlFor={`${prefix}-id`} className="text-xs">
            {t('checkId')}
          </Label>
          <Input
            id={`${prefix}-id`}
            value={check.id}
            maxLength={40}
            onChange={(event) => onChange({ id: event.target.value })}
          />
        </div>
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <Label htmlFor={`${prefix}-kind`} className="text-xs">
            {t('checkKind')}
          </Label>
          <Select
            value={check.kind}
            onValueChange={(next) => onChange({ kind: next as CheckDraft['kind'] })}
          >
            <SelectTrigger id={`${prefix}-kind`}>
              <SelectValue>{() => wording.kind(check.kind)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {kinds.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {wording.kind(kind)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('removeCheck', { id: check.id })}
          onClick={onRemove}
        >
          <Trash2Icon className="size-4" />
        </Button>
      </div>
      <CheckFields check={check} pageKeys={pageKeys} prefix={prefix} onChange={onChange} />
      {complete ? null : <p className="text-xs text-destructive">{t('checkIncomplete')}</p>}
    </div>
  );
}

/** The fields one kind reads, and no others. */
function CheckFields({
  check,
  pageKeys,
  prefix,
  onChange,
}: {
  check: CheckDraft;
  pageKeys: string[];
  prefix: string;
  onChange: (patch: Partial<CheckDraft>) => void;
}) {
  const t = useTranslations('evals.dialog');
  const field = (name: keyof CheckDraft, label: string, props: { numeric?: boolean } = {}) => (
    <div className="flex min-w-24 flex-1 flex-col gap-1">
      <Label htmlFor={`${prefix}-${name}`} className="text-xs">
        {label}
      </Label>
      <Input
        id={`${prefix}-${name}`}
        value={String(check[name])}
        inputMode={props.numeric === true ? 'numeric' : undefined}
        onChange={(event) => onChange({ [name]: event.target.value })}
      />
    </div>
  );
  const caseSensitive = (
    <label className="flex items-center gap-2 text-xs">
      <Checkbox
        checked={check.caseSensitive}
        onCheckedChange={(checked) => onChange({ caseSensitive: checked === true })}
      />
      {t('caseSensitive')}
    </label>
  );
  const bounds = (
    <>
      {field('min', t('min'), { numeric: true })}
      {field('max', t('max'), { numeric: true })}
    </>
  );

  switch (check.kind) {
    case 'answer_contains':
    case 'answer_excludes':
      return (
        <div className="flex flex-col gap-2">
          {field('text', t('text'))}
          {caseSensitive}
        </div>
      );
    case 'answer_matches':
      return (
        <div className="flex flex-wrap gap-2">
          {field('pattern', t('pattern'))}
          {field('flags', t('flags'))}
          {bounds}
        </div>
      );
    case 'tool_called':
      return (
        <div className="flex flex-wrap gap-2">
          {field('tool', t('tool'))}
          {bounds}
        </div>
      );
    case 'tool_not_called':
      return field('tool', t('tool'));
    case 'max_tool_calls':
    case 'max_failed_tool_calls':
      return field('max', t('max'), { numeric: true });
    case 'max_cost':
      return field('maxUsd', t('maxUsd'));
    case 'max_duration':
      return field('maxSeconds', t('maxSeconds'), { numeric: true });
    case 'no_changes':
      return <p className="text-xs text-muted-foreground">{t('noChangesHint')}</p>;
    case 'page_contains':
    case 'page_excludes':
      return (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <div className="flex min-w-32 flex-col gap-1">
              <Label htmlFor={`${prefix}-page`} className="text-xs">
                {t('page')}
              </Label>
              <Select value={check.page} onValueChange={(next) => onChange({ page: String(next) })}>
                <SelectTrigger id={`${prefix}-page`}>
                  <SelectValue>{() => check.page || t('pageChoose')}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {pageKeys.map((key) => (
                    <SelectItem key={key} value={key}>
                      {key}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {field('text', t('text'))}
          </div>
          {caseSensitive}
        </div>
      );
    case 'pages_created':
    case 'proposed_changes':
      return <div className="flex flex-wrap gap-2">{bounds}</div>;
    case 'manual':
      return field('text', t('manualText'));
  }
}
