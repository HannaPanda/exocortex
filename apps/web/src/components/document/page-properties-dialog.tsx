'use client';

import * as React from 'react';

import {
  type AiRuleMode,
  type DocumentDetail,
  type DocumentIconColor,
  type DocumentLayout,
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
} from '@exocortex/ui';

import { useSetAiRule } from '@/lib/api/ai-queries';
import { useUpdateDocument } from '@/lib/api/queries';

import { DocumentIcon } from './document-icon';
import { PageIconPicker } from './page-icon-picker';

const AI_RULE_MODE_LABELS: Record<AiRuleMode, string> = {
  off: 'Keine Regel',
  always: 'Immer anwenden',
  on_demand: 'Auf Anfrage',
};

const LAYOUTS: { value: DocumentLayout; label: string; hint: string; bars: string[] }[] = [
  { value: 'narrow', label: 'Schmal', hint: 'Lesebreite, 68 Zeichen', bars: ['w-1/2', 'w-1/2', 'w-1/3'] },
  { value: 'wide', label: 'Breit', hint: 'Text mit Tabellen', bars: ['w-3/4', 'w-3/4', 'w-1/2'] },
  { value: 'full', label: 'Vollbreite', hint: 'Datenbanken, breite Tabellen', bars: ['w-full', 'w-full', 'w-2/3'] },
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
  const updateDocument = useUpdateDocument(workspaceId);
  const setAiRule = useSetAiRule();

  const [title, setTitle] = React.useState(detail.title);
  const [icon, setIcon] = React.useState<string | null>(detail.icon);
  const [iconColor, setIconColor] = React.useState<DocumentIconColor | null>(detail.iconColor);
  const [layout, setLayout] = React.useState<DocumentLayout>(detail.layout);
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
          <DialogTitle>Seiteneigenschaften</DialogTitle>
          <DialogDescription>
            Titel, Symbol, Breite der Seite und ob die KI diese Seite als Regel behandelt.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 overflow-y-auto">
          <div className="flex gap-2">
            <div className="flex flex-col gap-1.5">
              <Label>Symbol</Label>
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
                    aria-label="Symbol wählen"
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
              <Label htmlFor="page-title">Titel</Label>
              <Input
                id="page-title"
                value={title}
                readOnly={readOnly}
                aria-invalid={titleInvalid}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Layout</Label>
            <div className="grid grid-cols-3 gap-2" role="group" aria-label="Layout">
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
                      <span key={index} className={cn('h-1 rounded-full bg-muted-foreground/50', bar)} />
                    ))}
                  </span>
                  <span className="text-sm font-medium">{option.label}</span>
                  <span className="text-[0.6875rem] leading-tight text-muted-foreground">{option.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5 border-t border-border pt-4">
            <Label htmlFor="ai-rule-mode">KI-Regel</Label>
            <p className="text-xs text-muted-foreground">
              &quot;Immer anwenden&quot; hängt den Seiteninhalt an jeden Systemprompt an. &quot;Auf
              Anfrage&quot; nennt der KI nur die Beschreibung; den Inhalt lädt sie erst, wenn die
              Situation passt. Das hält den Kontext klein.
            </p>
            <Select
              value={mode}
              disabled={readOnly}
              onValueChange={(next) => next !== null && setMode(next as AiRuleMode)}
            >
              <SelectTrigger id="ai-rule-mode" className="w-full">
                <SelectValue>{() => AI_RULE_MODE_LABELS[mode]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(AI_RULE_MODE_LABELS) as AiRuleMode[]).map((value) => (
                  <SelectItem key={value} value={value}>
                    {AI_RULE_MODE_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {mode !== 'off' ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ai-rule-trigger">Wann gilt diese Regel?</Label>
                <Input
                  id="ai-rule-trigger"
                  value={trigger}
                  readOnly={readOnly}
                  aria-invalid={triggerInvalid}
                  onChange={(event) => setTrigger(event.target.value)}
                  placeholder="z. B. Beim Schreiben von Commit-Nachrichten"
                />
                {triggerInvalid ? (
                  <p className="text-xs text-destructive-text">
                    Für &quot;Auf Anfrage&quot; wird eine Beschreibung benötigt.
                  </p>
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ai-rule-priority">Reihenfolge (kleiner = früher)</Label>
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
            <dt>Typ</dt>
            <dd>{detail.type === 'COLLECTION' ? 'Datenbank' : 'Seite'}</dd>
            <dt>Erstellt</dt>
            <dd>{new Date(detail.createdAt).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}</dd>
            <dt>Zuletzt bearbeitet</dt>
            <dd>{new Date(detail.updatedAt).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}</dd>
            <dt>Pfad</dt>
            <dd className="break-words">
              {detail.breadcrumb.length === 0
                ? 'Oberste Ebene'
                : detail.breadcrumb.map((entry) => entry.title).join(' / ')}
            </dd>
          </dl>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            data-testid="save-page-properties"
            disabled={readOnly || titleInvalid || triggerInvalid || updateDocument.isPending || setAiRule.isPending}
            onClick={() => void save()}
          >
            Speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
