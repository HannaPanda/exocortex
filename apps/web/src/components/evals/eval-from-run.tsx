'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { EVAL_REPLAY_MODES, type EvalReplayMode } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Button,
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

import { useEvalCaseFromRun } from '@/lib/api/eval-queries';

import { useEvalWording } from './eval-labels';

/**
 * Keeps a real run as an eval case (issue #146): its prompt, its page and its
 * profile. The person chooses how the replay stays harmless, because that is
 * a decision about the task, not something the run can tell.
 */
export function EvalFromRunButton({ workspaceId, runId }: { workspaceId: string; runId: string }) {
  const t = useTranslations('evals.fromRun');
  const wording = useEvalWording();
  const router = useRouter();
  const create = useEvalCaseFromRun(workspaceId);
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [mode, setMode] = React.useState<EvalReplayMode>('read_only');
  const [suite, setSuite] = React.useState('');

  const submit = async (): Promise<void> => {
    const created = await create.mutateAsync({
      runId,
      request: { name: name.trim(), replayMode: mode, suite: suite.trim() || null },
    });
    setOpen(false);
    router.push(`/arbeitsbereich/${workspaceId}/evals/faelle/${created.evalCase.id}`);
  };

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} data-testid="eval-from-run">
        {t('action')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-4">
              {create.error === null ? null : (
                <Alert variant="destructive">
                  <AlertDescription>{create.error.message}</AlertDescription>
                </Alert>
              )}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="eval-from-run-name">{t('name')}</Label>
                <Input
                  id="eval-from-run-name"
                  value={name}
                  maxLength={120}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="eval-from-run-mode">{t('mode')}</Label>
                <Select value={mode} onValueChange={(next) => setMode(next as EvalReplayMode)}>
                  <SelectTrigger id="eval-from-run-mode">
                    <SelectValue>{() => wording.mode(mode)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {EVAL_REPLAY_MODES.map((entry) => (
                      <SelectItem key={entry} value={entry}>
                        {wording.mode(entry)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {mode === 'fixture' ? t('fixtureHint') : wording.modeHint(mode)}
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="eval-from-run-suite">{t('suite')}</Label>
                <Input
                  id="eval-from-run-suite"
                  value={suite}
                  maxLength={60}
                  placeholder={t('suitePlaceholder')}
                  onChange={(event) => setSuite(event.target.value)}
                />
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={name.trim().length === 0 || create.isPending}
            >
              {t('submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
