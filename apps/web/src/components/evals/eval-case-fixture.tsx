'use client';

import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@exocortex/ui';

import { emptyPage, type PageDraft } from './eval-case-draft';

const NONE = '__none__';

/**
 * The pages a fixture case brings along (issue #146). Every attempt gets
 * fresh copies in a sandbox, so these are the pages as the task starts, not
 * pages anybody uses. A page can only hang under one listed before it, which
 * is the order they are created in.
 */
export function EvalCaseFixture({
  pages,
  startKey,
  onChange,
  onStartChange,
}: {
  pages: PageDraft[];
  startKey: string | null;
  onChange: (pages: PageDraft[]) => void;
  onStartChange: (startKey: string | null) => void;
}) {
  const t = useTranslations('evals.dialog');
  const update = (rowKey: string, patch: Partial<PageDraft>): void =>
    onChange(pages.map((page) => (page.rowKey === rowKey ? { ...page, ...patch } : page)));

  return (
    <fieldset className="flex flex-col gap-3" data-testid="eval-case-fixture">
      <legend className="mb-1 text-sm font-medium">{t('fixtureLabel')}</legend>
      <p className="text-xs text-muted-foreground">{t('fixtureHint')}</p>
      {pages.map((page, index) => {
        const prefix = `eval-page-${page.rowKey}`;
        const parents = pages.slice(0, index);
        return (
          <div
            key={page.rowKey}
            className="flex flex-col gap-2 rounded-md border border-border p-3"
          >
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex w-28 flex-col gap-1">
                <Label htmlFor={`${prefix}-key`} className="text-xs">
                  {t('pageKey')}
                </Label>
                <Input
                  id={`${prefix}-key`}
                  value={page.key}
                  maxLength={40}
                  onChange={(event) => update(page.rowKey, { key: event.target.value })}
                />
              </div>
              <div className="flex min-w-40 flex-1 flex-col gap-1">
                <Label htmlFor={`${prefix}-title`} className="text-xs">
                  {t('pageTitle')}
                </Label>
                <Input
                  id={`${prefix}-title`}
                  value={page.title}
                  maxLength={300}
                  onChange={(event) => update(page.rowKey, { title: event.target.value })}
                />
              </div>
              <div className="flex min-w-32 flex-col gap-1">
                <Label htmlFor={`${prefix}-parent`} className="text-xs">
                  {t('pageParent')}
                </Label>
                <Select
                  value={page.parentKey ?? NONE}
                  onValueChange={(next) =>
                    update(page.rowKey, { parentKey: next === NONE || next === null ? null : next })
                  }
                >
                  <SelectTrigger id={`${prefix}-parent`}>
                    <SelectValue>{() => page.parentKey ?? t('pageParentNone')}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('pageParentNone')}</SelectItem>
                    {parents.map((parent) => (
                      <SelectItem key={parent.rowKey} value={parent.key}>
                        {parent.key}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('removePage', { key: page.key })}
                onClick={() => {
                  onChange(pages.filter((entry) => entry.rowKey !== page.rowKey));
                  if (startKey === page.key) onStartChange(null);
                }}
              >
                <Trash2Icon className="size-4" />
              </Button>
            </div>
            <Label htmlFor={`${prefix}-markdown`} className="text-xs">
              {t('pageMarkdown')}
            </Label>
            <Textarea
              id={`${prefix}-markdown`}
              value={page.markdown}
              rows={5}
              className="font-mono text-xs"
              onChange={(event) => update(page.rowKey, { markdown: event.target.value })}
            />
          </div>
        );
      })}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange([...pages, emptyPage(pages.length)])}
          data-testid="eval-page-add"
        >
          <PlusIcon className="size-4" />
          {t('addPage')}
        </Button>
        <div className="flex min-w-40 flex-col gap-1">
          <Label htmlFor="eval-start-page" className="text-xs">
            {t('startPage')}
          </Label>
          <Select
            value={startKey ?? NONE}
            onValueChange={(next) => onStartChange(next === NONE || next === null ? null : next)}
          >
            <SelectTrigger id="eval-start-page">
              <SelectValue>{() => startKey ?? t('startPageSandbox')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('startPageSandbox')}</SelectItem>
              {pages.map((page) => (
                <SelectItem key={page.rowKey} value={page.key}>
                  {page.key}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </fieldset>
  );
}
