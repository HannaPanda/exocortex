'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type EntityType } from '@exocortex/contracts';
import {
  Button,
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
  Textarea,
} from '@exocortex/ui';

import { useCreateEntity } from '@/lib/api/entity-queries';

import { ENTITY_TYPES, useEntityTypeLabel } from './entity-type-label';

/**
 * A new entity by hand (issue #47).
 *
 * The extraction pass finds names that are already written down somewhere; this
 * is for the ones that are not yet, which is most of them at the start. Aliases
 * are the field that matters: the matcher only ever finds a spelling it has
 * been told about, and typing them here is what makes the next page about this
 * thing attach itself.
 */
export function EntityDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('entities.dialog');
  const typeLabel = useEntityTypeLabel();
  const create = useCreateEntity();
  const [title, setTitle] = React.useState('');
  const [type, setType] = React.useState<EntityType>('other');
  const [aliases, setAliases] = React.useState('');
  const [summary, setSummary] = React.useState('');

  const submit = (): void => {
    const trimmed = title.trim();
    if (trimmed.length < 2) return;
    void create
      .mutateAsync({
        title: trimmed,
        type,
        // Comma-separated, because that is how anybody writes a handful of
        // spellings, and two that normalize alike are one alias anyway.
        aliases: aliases
          .split(',')
          .map((alias) => alias.trim())
          .filter((alias) => alias.length > 1),
        summary: summary.trim(),
      })
      .then(() => {
        setTitle('');
        setAliases('');
        setSummary('');
        setType('other');
        onOpenChange(false);
      });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entity-title">{t('name')}</Label>
            <Input
              id="entity-title"
              autoFocus
              value={title}
              data-testid="entity-title"
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entity-type">{t('type')}</Label>
            <Select value={type} onValueChange={(next) => setType(next as EntityType)}>
              <SelectTrigger id="entity-type" data-testid="entity-type">
                <SelectValue>{() => typeLabel(type)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ENTITY_TYPES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {typeLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entity-aliases">{t('aliases')}</Label>
            <Input
              id="entity-aliases"
              value={aliases}
              placeholder={t('aliasesPlaceholder')}
              data-testid="entity-aliases"
              onChange={(event) => setAliases(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('aliasesHint')}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entity-summary">{t('note')}</Label>
            <Textarea
              id="entity-summary"
              value={summary}
              rows={3}
              onChange={(event) => setSummary(event.target.value)}
            />
          </div>

          {create.isError ? (
            <p role="alert" className="text-xs text-destructive-text">
              {create.error.message}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            disabled={title.trim().length < 2 || create.isPending}
            onClick={submit}
            data-testid="entity-create"
          >
            {t('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
