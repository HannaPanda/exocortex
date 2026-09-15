'use client';

import * as React from 'react';

import { ENTITY_TYPE_LABELS, type EntityType } from '@exocortex/contracts';
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
          <DialogTitle>Neue Entität</DialogTitle>
          <DialogDescription>
            Wird eine Zeile im Entitäten-Verzeichnis und damit eine ganz normale Seite.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entity-title">Name</Label>
            <Input
              id="entity-title"
              autoFocus
              value={title}
              data-testid="entity-title"
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entity-type">Typ</Label>
            <Select value={type} onValueChange={(next) => setType(next as EntityType)}>
              <SelectTrigger id="entity-type" data-testid="entity-type">
                <SelectValue>{() => ENTITY_TYPE_LABELS[type]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ENTITY_TYPE_LABELS) as EntityType[]).map((value) => (
                  <SelectItem key={value} value={value}>
                    {ENTITY_TYPE_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entity-aliases">Aliasse</Label>
            <Input
              id="entity-aliases"
              value={aliases}
              placeholder="fpb2, Flauschipanda 2"
              data-testid="entity-aliases"
              onChange={(event) => setAliases(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Mit Komma getrennt. Jede Schreibweise, die eine Seite benutzen könnte.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="entity-summary">Notiz</Label>
            <Textarea
              id="entity-summary"
              value={summary}
              rows={3}
              onChange={(event) => setSummary(event.target.value)}
            />
          </div>

          {create.isError ? (
            <p className="text-xs text-destructive-text">{create.error.message}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            disabled={title.trim().length < 2 || create.isPending}
            onClick={submit}
            data-testid="entity-create"
          >
            Anlegen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
