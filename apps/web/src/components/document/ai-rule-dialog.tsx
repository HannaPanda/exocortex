'use client';

import * as React from 'react';

import { type AiRuleMode } from '@exocortex/contracts';
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
} from '@exocortex/ui';

import { useSetAiRule } from '@/lib/api/ai-queries';

const MODE_LABELS: Record<AiRuleMode, string> = {
  off: 'Keine Regel',
  always: 'Immer anwenden',
  on_demand: 'Auf Anfrage',
};

export interface AiRuleDialogProps {
  documentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialMode: AiRuleMode;
  initialTrigger: string | null;
  initialPriority: number;
}

/**
 * Marks a page as an AI rule page (D5): its content is either always appended
 * to the system prompt, or offered on demand behind a one-line trigger the
 * model reads before deciding to load the full page.
 */
export function AiRuleDialog({
  documentId,
  open,
  onOpenChange,
  initialMode,
  initialTrigger,
  initialPriority,
}: AiRuleDialogProps) {
  const setAiRule = useSetAiRule();
  const [mode, setMode] = React.useState<AiRuleMode>(initialMode);
  const [trigger, setTrigger] = React.useState(initialTrigger ?? '');
  const [priority, setPriority] = React.useState(String(initialPriority));

  // Re-sync the draft whenever the dialog opens. Adjusted during render
  // (React's documented reset-on-change pattern) instead of in an effect, so
  // there is no extra committed render showing the stale draft first.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setMode(initialMode);
      setTrigger(initialTrigger ?? '');
      setPriority(String(initialPriority));
    }
  }

  const triggerRequired = mode === 'on_demand';
  const triggerInvalid = triggerRequired && trigger.trim().length === 0;

  const save = async (): Promise<void> => {
    if (triggerInvalid) return;
    const parsedPriority = Number.parseInt(priority, 10);
    await setAiRule.mutateAsync({
      documentId,
      request: {
        aiRuleMode: mode,
        aiRuleTrigger: mode === 'off' ? null : trigger.trim() || null,
        aiRulePriority: Number.isFinite(parsedPriority) ? parsedPriority : initialPriority,
      },
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Als KI-Regel verwenden</DialogTitle>
          <DialogDescription>
            Regelseiten erweitern die Anweisungen der KI. &quot;Immer anwenden&quot; hängt den
            Seiteninhalt an jeden Systemprompt an. &quot;Auf Anfrage&quot; nennt der KI nur die
            Beschreibung; den Seiteninhalt lädt sie erst, wenn die Situation passt. Das hält den
            Kontext klein.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ai-rule-mode">Regelmodus</Label>
          <Select value={mode} onValueChange={(next) => next !== null && setMode(next as AiRuleMode)}>
            <SelectTrigger id="ai-rule-mode" className="w-full">
              <SelectValue>{() => MODE_LABELS[mode]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(MODE_LABELS) as AiRuleMode[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {MODE_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {mode !== 'off' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ai-rule-trigger">Wann gilt diese Regel?</Label>
            <Input
              id="ai-rule-trigger"
              value={trigger}
              onChange={(event) => setTrigger(event.target.value)}
              aria-invalid={triggerInvalid}
              placeholder="z. B. Beim Schreiben von Commit-Nachrichten"
            />
            {triggerInvalid ? (
              <p className="text-xs text-destructive-text">
                Für &quot;Auf Anfrage&quot; wird eine Beschreibung benötigt.
              </p>
            ) : null}
          </div>
        ) : null}

        {mode !== 'off' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ai-rule-priority">Reihenfolge (kleiner = früher)</Label>
            <Input
              id="ai-rule-priority"
              type="number"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button onClick={() => void save()} disabled={triggerInvalid || setAiRule.isPending}>
            Speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
