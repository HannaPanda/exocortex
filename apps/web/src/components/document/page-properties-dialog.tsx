'use client';

import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type AiRuleMode,
  type DocumentDetail,
  type DocumentIconColor,
  type DocumentLayout,
  type OverviewMode,
} from '@exocortex/contracts';
import {
  Button,
  cn,
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
  Switch,
} from '@exocortex/ui';

import { useSetAiRule } from '@/lib/api/ai-queries';
import { useUpdateDocument } from '@/lib/api/document-queries';

import { DocumentIcon } from './document-icon';
import { PageIconPicker } from './page-icon-picker';

/**
 * The rule modes in the order the select offers them; each one's name is
 * `document.aiRuleModes.<mode>`, which the context panel's properties tab
 * reads too (issue #17).
 */
export const AI_RULE_MODES: readonly AiRuleMode[] = ['off', 'always', 'on_demand'];

/**
 * The German names of the rule modes, for `ai-rules-panel.tsx` only, which
 * has not moved into the catalogues yet. Everything in this namespace reads
 * `document.aiRuleModes` instead; delete this once that panel does too.
 */
export const AI_RULE_MODE_LABELS: Record<AiRuleMode, string> = {
  off: 'Keine Regel',
  always: 'Immer anwenden',
  on_demand: 'Auf Anfrage',
};

/** Label and hint of each are `document.propertiesDialog.layouts.<value>`. */
const LAYOUTS: { value: DocumentLayout; bars: string[] }[] = [
  { value: 'narrow', bars: ['w-1/2', 'w-1/2', 'w-1/3'] },
  { value: 'wide', bars: ['w-3/4', 'w-3/4', 'w-1/2'] },
  { value: 'full', bars: ['w-full', 'w-full', 'w-2/3'] },
];

export interface PagePropertiesDialogProps {
  workspaceId: string;
  detail: DocumentDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Everything about a page that is not its content: title, icon, body width and
 * whether the page acts as an AI rule (D5), plus the metadata a user can only
 * read.
 *
 * One dialog rather than one per field: these are the page's properties, and a
 * page-properties surface that a new setting can join is the difference between
 * a fifth entry in the actions menu and a fifth row in a form.
 *
 * The AI rule and the presentation fields go to the same `PATCH`, but through
 * two mutations, because they invalidate different lists (the rule list versus
 * the page tree) and the dialog only sends what actually changed.
 */
export function PagePropertiesDialog({
  workspaceId,
  detail,
  open,
  onOpenChange,
}: PagePropertiesDialogProps) {
  const t = useTranslations('document.propertiesDialog');
  const tDocument = useTranslations('document');
  const format = useFormatter();
  const updateDocument = useUpdateDocument(workspaceId);
  const setAiRule = useSetAiRule();

  const [title, setTitle] = React.useState(detail.title);
  const [icon, setIcon] = React.useState<string | null>(detail.icon);
  const [iconColor, setIconColor] = React.useState<DocumentIconColor | null>(detail.iconColor);
  const [layout, setLayout] = React.useState<DocumentLayout>(detail.layout);
  const [overviewMode, setOverviewMode] = React.useState<OverviewMode>(detail.overviewMode);
  const [mode, setMode] = React.useState<AiRuleMode>(detail.aiRuleMode);
  const [trigger, setTrigger] = React.useState(detail.aiRuleTrigger ?? '');
  const [priority, setPriority] = React.useState(String(detail.aiRulePriority));

  // Re-sync the draft whenever the dialog opens. Adjusted during render (React's
  // documented reset-on-change pattern) instead of in an effect, so there is no
  // extra committed render showing the stale draft first.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTitle(detail.title);
      setIcon(detail.icon);
      setIconColor(detail.iconColor);
      setLayout(detail.layout);
      setOverviewMode(detail.overviewMode);
      setMode(detail.aiRuleMode);
      setTrigger(detail.aiRuleTrigger ?? '');
      setPriority(String(detail.aiRulePriority));
    }
  }

  const readOnly = detail.access === 'read';
  const triggerInvalid = mode === 'on_demand' && trigger.trim().length === 0;
  const trimmedTitle = title.trim();
  const titleInvalid = trimmedTitle.length === 0;

  const save = async (): Promise<void> => {
    if (triggerInvalid || titleInvalid) return;

    const presentation = {
      ...(trimmedTitle === detail.title ? {} : { title: trimmedTitle }),
      ...(icon === detail.icon ? {} : { icon }),
      ...(iconColor === detail.iconColor ? {} : { iconColor }),
      ...(layout === detail.layout ? {} : { layout }),
      ...(overviewMode === detail.overviewMode ? {} : { overviewMode }),
    };
    if (Object.keys(presentation).length > 0) {
      await updateDocument.mutateAsync({ documentId: detail.id, request: presentation });
    }

    const parsedPriority = Number.parseInt(priority, 10);
    const nextTrigger = mode === 'off' ? null : trigger.trim().length === 0 ? null : trigger.trim();
    const nextPriority = Number.isFinite(parsedPriority) ? parsedPriority : detail.aiRulePriority;
    if (
      mode !== detail.aiRuleMode ||
      nextTrigger !== detail.aiRuleTrigger ||
      nextPriority !== detail.aiRulePriority
    ) {
      await setAiRule.mutateAsync({
        documentId: detail.id,
        request: { aiRuleMode: mode, aiRuleTrigger: nextTrigger, aiRulePriority: nextPriority },
      });
    }

    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          <div className="flex gap-2">
            <div className="flex flex-col gap-1.5">
              <Label>{t('symbol')}</Label>
              {/* The dialog only edits the draft; nothing is written until
                  "Speichern", the same as the title next to it. */}
              <PageIconPicker
                icon={icon}
                iconColor={iconColor}
                type={detail.type}
                onSelect={(selection) => {
                  setIcon(selection.icon);
                  setIconColor(selection.iconColor);
                }}
                trigger={
                  <button
                    type="button"
                    disabled={readOnly}
                    aria-label={t('chooseSymbol')}
                    data-testid="page-properties-icon"
                    className={cn(
                      'grid size-9 place-items-center rounded-md border border-border transition-colors',
                      'hover:border-border-strong disabled:opacity-50',
                    )}
                  >
                    <DocumentIcon
                      icon={icon}
                      iconColor={iconColor}
                      type={detail.type}
                      className="size-5 text-lg text-muted-foreground"
                    />
                  </button>
                }
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Label htmlFor="page-title">{t('titleLabel')}</Label>
              <Input
                id="page-title"
                name="title"
                autoComplete="off"
                value={title}
                readOnly={readOnly}
                aria-invalid={titleInvalid}
                aria-describedby={titleInvalid ? 'page-title-error' : undefined}
                onChange={(event) => setTitle(event.target.value)}
              />
              {/* The field was marked invalid and said nothing, so the only
                  clue was a disabled Save button at the other end of the
                  dialog. */}
              {titleInvalid ? (
                <p id="page-title-error" className="text-xs text-destructive-text">
                  {t('titleMissing')}
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t('layout')}</Label>
            <div className="grid grid-cols-3 gap-2" role="group" aria-label={t('layout')}>
              {LAYOUTS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  disabled={readOnly}
                  aria-pressed={layout === option.value}
                  data-testid={`layout-${option.value}`}
                  className={cn(
                    'flex flex-col items-center gap-2 rounded-md border px-2 py-2 text-center transition-colors',
                    layout === option.value
                      ? 'border-primary bg-accent'
                      : 'border-border hover:border-border-strong',
                  )}
                  onClick={() => setLayout(option.value)}
                >
                  {/* Three lines of "text" at the width the option produces:
                      faster to grasp than the words schmal/breit/voll. */}
                  <span aria-hidden className="flex w-full flex-col items-center gap-1 py-1">
                    {option.bars.map((bar, index) => (
                      <span
                        key={index}
                        className={cn('h-1 rounded-full bg-muted-foreground/50', bar)}
                      />
                    ))}
                  </span>
                  <span className="text-sm font-medium">{t(`layouts.${option.value}.label`)}</span>
                  <span className="text-micro leading-tight text-muted-foreground">
                    {t(`layouts.${option.value}.hint`)}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5 border-t border-border pt-4">
            <Label htmlFor="page-overview-mode" className="gap-2">
              <Switch
                id="page-overview-mode"
                disabled={readOnly}
                data-testid="page-properties-overview"
                checked={overviewMode === 'auto'}
                onCheckedChange={(checked) => setOverviewMode(checked ? 'auto' : 'off')}
              />
              {t('overviewPage')}
            </Label>
            <p className="text-xs text-muted-foreground">{t('overviewHint')}</p>
          </div>

          <div className="flex flex-col gap-1.5 border-t border-border pt-4">
            <Label htmlFor="ai-rule-mode">{t('aiRule')}</Label>
            <p className="text-xs text-muted-foreground">{t('aiRuleHint')}</p>
            <Select
              value={mode}
              disabled={readOnly}
              onValueChange={(next) => next !== null && setMode(next as AiRuleMode)}
            >
              <SelectTrigger id="ai-rule-mode" className="w-full">
                <SelectValue>{() => tDocument(`aiRuleModes.${mode}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {AI_RULE_MODES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {tDocument(`aiRuleModes.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {mode !== 'off' ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ai-rule-trigger">{t('triggerLabel')}</Label>
                <Input
                  id="ai-rule-trigger"
                  value={trigger}
                  readOnly={readOnly}
                  aria-invalid={triggerInvalid}
                  // The refusal is the field's own description, or a screen
                  // reader reads an invalid field and never the reason.
                  aria-describedby={triggerInvalid ? 'ai-rule-trigger-error' : undefined}
                  onChange={(event) => setTrigger(event.target.value)}
                  placeholder={t('triggerPlaceholder')}
                />
                {triggerInvalid ? (
                  <p id="ai-rule-trigger-error" className="text-xs text-destructive-text">
                    {t('triggerMissing')}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ai-rule-priority">{t('priorityLabel')}</Label>
                <Input
                  id="ai-rule-priority"
                  type="number"
                  value={priority}
                  readOnly={readOnly}
                  onChange={(event) => setPriority(event.target.value)}
                />
              </div>
            </>
          ) : null}

          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 border-t border-border pt-4 text-xs text-muted-foreground">
            <dt>{t('type')}</dt>
            <dd>{tDocument(detail.type === 'COLLECTION' ? 'types.COLLECTION' : 'types.PAGE')}</dd>
            <dt>{t('created')}</dt>
            <dd>
              {format.dateTime(new Date(detail.createdAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </dd>
            <dt>{t('lastEdited')}</dt>
            <dd>
              {format.dateTime(new Date(detail.updatedAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </dd>
            <dt>{t('path')}</dt>
            <dd className="break-words">
              {detail.breadcrumb.length === 0
                ? t('topLevel')
                : detail.breadcrumb.map((entry) => entry.title).join(' / ')}
            </dd>
          </dl>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            data-testid="save-page-properties"
            disabled={
              readOnly ||
              titleInvalid ||
              triggerInvalid ||
              updateDocument.isPending ||
              setAiRule.isPending
            }
            onClick={() => void save()}
          >
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
