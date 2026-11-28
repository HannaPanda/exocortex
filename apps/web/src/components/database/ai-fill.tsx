'use client';

import {
  AlertCircleIcon,
  CircleDashedIcon,
  Loader2Icon,
  RotateCwIcon,
  SparklesIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  AI_AUTO_FILL,
  AI_FILL_CELL_ERROR_CODES,
  AI_FILL_MODES,
  type AiAutoFill,
  type AiFillCellErrorCode,
  aiFillConfigProblems,
  type AiFillMode,
  type AiFillPreset,
  type AiFillStartResponse,
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseRowAiCell,
  isAiFillableType,
  presetsForType,
  type SetDatabasePropertyAiRequest,
} from '@exocortex/contracts';
import {
  Button,
  cn,
  Dialog,
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
  Switch,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exocortex/ui';

import {
  useRemovePropertyAi,
  useSetPropertyAi,
  useStartAiFill,
} from '@/lib/api/database-ai-fill-queries';
import { useFormatter } from '@/lib/formatter';

import { CELL_MARK_ATTRIBUTE } from './column-fit';

/**
 * The AI fill of database columns in the browser (issue #237, ADR-099): the
 * dialog that gives a column its instruction, the dialog that fills a column
 * or a selection, the mark a cell carries, and the strip that shows a batch
 * working. `useAiFillControls` holds the two dialogs, so the column header,
 * a cell, the selection bar and the palette all open the same ones.
 */

export interface AiFillControls {
  /** Opens the instruction dialog for a column. */
  configure: (property: DatabaseProperty) => void;
  /** Opens the confirmation for filling a column, or the named rows of it. */
  fill: (property: DatabaseProperty, rowIds?: readonly string[]) => void;
  /** Fills these cells straight away, keeping every value a person wrote. */
  fillCells: (property: DatabaseProperty, rowIds: readonly string[]) => void;
  /** Whether this column may be given an instruction at all. */
  canConfigure: (property: DatabaseProperty) => boolean;
  dialogs: React.ReactNode;
}

export function useAiFillControls(documentId: string): AiFillControls {
  const [configuring, setConfiguring] = React.useState<DatabaseProperty | null>(null);
  const [filling, setFilling] = React.useState<{
    property: DatabaseProperty;
    rowIds?: readonly string[];
  } | null>(null);
  const start = useStartAiFill(documentId);

  return {
    configure: setConfiguring,
    fill: (property, rowIds) => setFilling({ property, rowIds }),
    fillCells: (property, rowIds) =>
      start.mutate({ propertyId: property.id, rowIds: [...rowIds], mode: 'replace_ai' }),
    canConfigure: (property) => isAiFillableType(property.type),
    dialogs: (
      <>
        {configuring === null ? null : (
          <AiConfigDialog
            documentId={documentId}
            property={configuring}
            onClose={() => setConfiguring(null)}
          />
        )}
        {filling === null ? null : (
          <AiFillDialog
            documentId={documentId}
            property={filling.property}
            rowIds={filling.rowIds}
            onClose={() => setFilling(null)}
          />
        )}
      </>
    ),
  };
}

// ---------------------------------------------------------------------------
// The instruction
// ---------------------------------------------------------------------------

interface AiConfigDraft {
  preset: AiFillPreset;
  instruction: string;
  targetLanguage: string;
  allowNewOptions: boolean;
  useContent: boolean;
  useProperties: boolean;
  useAttachments: boolean;
  autoFill: AiAutoFill;
}

function draftOf(property: DatabaseProperty): AiConfigDraft {
  const current = property.ai ?? null;
  if (current === null) {
    return {
      preset: presetsForType(property.type)[0] ?? 'custom',
      instruction: '',
      targetLanguage: '',
      allowNewOptions: false,
      useContent: true,
      useProperties: true,
      useAttachments: true,
      autoFill: 'off',
    };
  }
  return {
    preset: current.preset,
    instruction: current.instruction ?? '',
    targetLanguage: current.targetLanguage ?? '',
    allowNewOptions: current.allowNewOptions,
    useContent: current.useContent,
    useProperties: current.useProperties,
    useAttachments: current.useAttachments,
    autoFill: current.autoFill,
  };
}

/** The request a draft stands for: fields that do not apply to the column are cleared. */
function requestOf(draft: AiConfigDraft, isSelect: boolean): SetDatabasePropertyAiRequest {
  return {
    ...draft,
    instruction: draft.instruction.trim().length === 0 ? null : draft.instruction,
    targetLanguage: draft.preset === 'translate' ? draft.targetLanguage : null,
    allowNewOptions: isSelect && draft.allowNewOptions,
  };
}

function AiConfigDialog({
  documentId,
  property,
  onClose,
}: {
  documentId: string;
  property: DatabaseProperty;
  onClose: () => void;
}) {
  const t = useTranslations('database.aiFill');
  const [draft, setDraft] = React.useState(() => draftOf(property));
  const change = (patch: Partial<AiConfigDraft>) => setDraft((prev) => ({ ...prev, ...patch }));
  const save = useSetPropertyAi(documentId);
  const remove = useRemovePropertyAi(documentId);

  const isSelect = property.type === 'SELECT' || property.type === 'MULTI_SELECT';
  const request = requestOf(draft, isSelect);
  const problems = aiFillConfigProblems(property.type, {
    ...draft,
    instruction: request.instruction,
    targetLanguage: request.targetLanguage,
    allowNewOptions: request.allowNewOptions,
  });
  const error = save.error ?? remove.error;
  const hasInstruction = property.ai !== null && property.ai !== undefined;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent data-testid="ai-config-dialog">
        <DialogHeader>
          <DialogTitle>{t('configTitle', { name: property.name })}</DialogTitle>
          <DialogDescription>{t('configDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <AiInstructionFields property={property} draft={draft} change={change} />
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">{t('sources')}</legend>
            <SwitchRow
              label={t('useContent')}
              checked={draft.useContent}
              onChange={(useContent) => change({ useContent })}
            />
            <SwitchRow
              label={t('useProperties')}
              checked={draft.useProperties}
              onChange={(useProperties) => change({ useProperties })}
            />
            <SwitchRow
              label={t('useAttachments')}
              checked={draft.useAttachments}
              onChange={(useAttachments) => change({ useAttachments })}
            />
          </fieldset>
          {isSelect ? (
            <SwitchRow
              label={t('allowNewOptions')}
              hint={t('allowNewOptionsHint')}
              checked={draft.allowNewOptions}
              onChange={(allowNewOptions) => change({ allowNewOptions })}
            />
          ) : null}
          <AiAutoFillField value={draft.autoFill} onChange={(autoFill) => change({ autoFill })} />
          {problems[0] === undefined ? null : (
            <p className="text-sm text-muted-foreground" data-testid="ai-config-problem">
              {t(`problems.${problems[0]}`)}
            </p>
          )}
          {error === null ? null : (
            <p className="text-sm text-destructive-text" role="alert">
              {error.message}
            </p>
          )}
        </div>
        <DialogFooter>
          {hasInstruction ? (
            <Button
              variant="ghost"
              className="mr-auto text-destructive-text hover:text-destructive-text"
              disabled={remove.isPending}
              data-testid="ai-config-remove"
              onClick={() => remove.mutate(property.id, { onSuccess: onClose })}
            >
              {t('remove')}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            data-testid="ai-config-save"
            disabled={problems.length > 0 || save.isPending}
            onClick={() =>
              save.mutate({ propertyId: property.id, request }, { onSuccess: onClose })
            }
          >
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The preset, the target language a translation needs, and the person's own words. */
function AiInstructionFields({
  property,
  draft,
  change,
}: {
  property: DatabaseProperty;
  draft: AiConfigDraft;
  change: (patch: Partial<AiConfigDraft>) => void;
}) {
  const t = useTranslations('database.aiFill');
  const presets = presetsForType(property.type);
  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor="ai-preset">{t('preset')}</Label>
        <Select
          value={draft.preset}
          onValueChange={(value) => change({ preset: value as AiFillPreset })}
        >
          <SelectTrigger id="ai-preset" data-testid="ai-config-preset">
            <SelectValue>{() => t(`presets.${draft.preset}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {presets.map((entry) => (
              <SelectItem key={entry} value={entry} data-testid={`ai-config-preset-${entry}`}>
                {t(`presets.${entry}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {draft.preset === 'translate' ? (
        <div className="grid gap-1.5">
          <Label htmlFor="ai-language">{t('targetLanguage')}</Label>
          <Input
            id="ai-language"
            data-testid="ai-config-language"
            value={draft.targetLanguage}
            placeholder={t('targetLanguagePlaceholder')}
            onChange={(event) => change({ targetLanguage: event.target.value })}
          />
        </div>
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor="ai-instruction">
          {draft.preset === 'custom' ? t('instruction') : t('instructionExtra')}
        </Label>
        <Textarea
          id="ai-instruction"
          data-testid="ai-config-instruction"
          value={draft.instruction}
          rows={3}
          placeholder={t('instructionPlaceholder')}
          onChange={(event) => change({ instruction: event.target.value })}
        />
      </div>
    </>
  );
}

/** When the column fills itself; off unless somebody decides otherwise. */
function AiAutoFillField({
  value,
  onChange,
}: {
  value: AiAutoFill;
  onChange: (value: AiAutoFill) => void;
}) {
  const t = useTranslations('database.aiFill');
  return (
    <div className="grid gap-1.5">
      <Label htmlFor="ai-auto">{t('autoFill')}</Label>
      <Select value={value} onValueChange={(next) => onChange(next as AiAutoFill)}>
        <SelectTrigger id="ai-auto" data-testid="ai-config-auto">
          <SelectValue>{() => t(`auto.${value}`)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {AI_AUTO_FILL.map((entry) => (
            <SelectItem key={entry} value={entry} data-testid={`ai-config-auto-${entry}`}>
              {t(`auto.${entry}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{t('autoFillHint')}</p>
    </div>
  );
}

function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = React.useId();
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="grid gap-0.5">
        <Label htmlFor={id} className="font-normal">
          {label}
        </Label>
        {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filling a column or a selection
// ---------------------------------------------------------------------------

/**
 * Asks before a batch starts: how many cells it would fill, what it leaves
 * out, and whether values that are already there may be replaced. The count
 * is a dry run of the same request, so what the dialog says is what the
 * batch will do.
 */
function AiFillDialog({
  documentId,
  property,
  rowIds,
  onClose,
}: {
  documentId: string;
  property: DatabaseProperty;
  rowIds?: readonly string[];
  onClose: () => void;
}) {
  const t = useTranslations('database.aiFill');
  const [mode, setMode] = React.useState<AiFillMode>('empty_only');
  const [preview, setPreview] = React.useState<AiFillStartResponse | null>(null);
  const dry = useStartAiFill(documentId);
  const start = useStartAiFill(documentId);
  const ids = React.useMemo(() => (rowIds === undefined ? undefined : [...rowIds]), [rowIds]);
  const { mutate: count } = dry;

  React.useEffect(() => {
    count({ propertyId: property.id, rowIds: ids, mode, dryRun: true }, { onSuccess: setPreview });
  }, [count, ids, mode, property.id]);

  const error = start.error ?? dry.error;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent data-testid="ai-fill-dialog">
        <DialogHeader>
          <DialogTitle>{t('fillTitle', { name: property.name })}</DialogTitle>
          <DialogDescription>
            {ids === undefined
              ? t('fillDescriptionColumn')
              : t('fillDescriptionRows', { count: ids.length })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="ai-fill-mode">{t('mode')}</Label>
          <Select value={mode} onValueChange={(value) => setMode(value as AiFillMode)}>
            <SelectTrigger id="ai-fill-mode" data-testid="ai-fill-mode">
              <SelectValue>{() => t(`modes.${mode}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {AI_FILL_MODES.map((entry) => (
                <SelectItem key={entry} value={entry} data-testid={`ai-fill-mode-${entry}`}>
                  {t(`modes.${entry}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t(`modeHints.${mode}`)}</p>
        </div>
        <p className="text-sm" aria-live="polite" data-testid="ai-fill-preview">
          {preview === null ? t('counting') : t('preview', { count: preview.queued })}
          {preview !== null && preview.remaining > 0
            ? ` ${t('previewRemaining', { count: preview.remaining, limit: preview.limit })}`
            : null}
          {preview !== null && preview.skippedNotEmpty > 0
            ? ` ${t('previewKept', { count: preview.skippedNotEmpty })}`
            : null}
          {preview !== null && preview.skippedForbidden > 0
            ? ` ${t('previewForbidden', { count: preview.skippedForbidden })}`
            : null}
        </p>
        <p className="text-xs text-muted-foreground">{t('costHint')}</p>
        {error === null ? null : (
          <p className="text-sm text-destructive-text" role="alert">
            {error.message}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            data-testid="ai-fill-start"
            variant={mode === 'replace_all' ? 'destructive' : 'default'}
            disabled={preview === null || preview.queued === 0 || start.isPending}
            onClick={() =>
              start.mutate({ propertyId: property.id, rowIds: ids, mode }, { onSuccess: onClose })
            }
          >
            <SparklesIcon /> {t('start', { count: preview?.queued ?? 0 })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// A cell's mark
// ---------------------------------------------------------------------------

/**
 * What a cell says about the AI (issue #237): its value is the AI's (with the
 * time), a batch is filling it, or the last attempt failed or found nothing,
 * with a way to try again. A column with an instruction offers to fill an
 * empty cell on hover. Drawn in the corner, over the cell's own editor.
 */
export function AiCellMark({
  row,
  property,
  empty,
  readOnly,
  onFill,
}: {
  row: DatabaseRow;
  property: DatabaseProperty;
  empty: boolean;
  readOnly: boolean;
  onFill: () => void;
}) {
  const t = useTranslations('database.aiFill');
  const format = useFormatter();
  const mark = row.aiCells?.find((entry) => entry.propertyId === property.id);
  const configured = property.ai !== null && property.ai !== undefined;
  if (mark === undefined && (!configured || readOnly || !empty)) return null;

  const when =
    typeof mark?.at === 'string'
      ? format.dateTime(new Date(mark.at), { dateStyle: 'short', timeStyle: 'short' })
      : '';
  const { icon, label, retry } = markLook(t, mark, when, readOnly);
  const again = retry && mark !== undefined;

  const hoverOnly = mark === undefined;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={again ? `${label} ${t('fillAgain')}` : label}
            data-testid={`ai-cell-${row.document.id}-${property.id}`}
            data-state={mark?.state ?? 'offer'}
            {...{ [CELL_MARK_ATTRIBUTE]: '' }}
            disabled={!retry}
            onClick={(event) => {
              event.stopPropagation();
              if (retry) onFill();
            }}
            className={cn(
              'absolute right-0.5 top-0.5 z-10 inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground',
              'bg-background/80 hover:bg-accent hover:text-foreground disabled:cursor-default [&_svg]:size-3.5',
              hoverOnly
                ? 'opacity-0 focus-visible:opacity-100 group-hover/cell:opacity-100 pointer-coarse:opacity-100'
                : null,
            )}
          >
            {again && mark.state !== 'filled' ? <RotateCwIcon /> : icon}
          </button>
        }
      />
      <TooltipContent>
        {label}
        {again ? ` ${t('fillAgain')}` : null}
      </TooltipContent>
    </Tooltip>
  );
}

type AiFillT = ReturnType<typeof useTranslations<'database.aiFill'>>;

/** How a cell's mark looks and whether pressing it fills the cell again. */
function markLook(
  t: AiFillT,
  mark: DatabaseRowAiCell | undefined,
  when: string,
  readOnly: boolean,
): { icon: React.ReactNode; label: string; retry: boolean } {
  switch (mark?.state) {
    case 'pending':
      return {
        icon: <Loader2Icon className="animate-spin" />,
        label: t('markPending'),
        retry: false,
      };
    case 'filled':
      return { icon: <SparklesIcon />, label: t('markFilled', { when }), retry: !readOnly };
    case 'failed':
      return {
        icon: <AlertCircleIcon className="text-destructive-text" />,
        label: t('markFailed', { when, reason: t(`errors.${cellErrorCode(mark.errorCode)}`) }),
        retry: !readOnly,
      };
    case 'empty':
      return { icon: <CircleDashedIcon />, label: t('markEmpty', { when }), retry: !readOnly };
    default:
      return { icon: <SparklesIcon />, label: t('fillCell'), retry: true };
  }
}

/** A row's error code as one the catalogue words; anything unknown reads as a failed call. */
function cellErrorCode(code: string | null): AiFillCellErrorCode {
  return (AI_FILL_CELL_ERROR_CODES as readonly string[]).includes(code ?? '')
    ? (code as AiFillCellErrorCode)
    : 'model_failed';
}

/** The columns of a table that carry an instruction, for the selection bar and the palette. */
export function aiColumns(properties: readonly DatabaseProperty[]): DatabaseProperty[] {
  return properties.filter((property) => property.ai !== null && property.ai !== undefined);
}
