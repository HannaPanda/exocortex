'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { checkProjectPath, isProjectTextPath, PROJECT_MAX_PATH_CHARS } from '@exocortex/contracts';
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
} from '@exocortex/ui';

/**
 * Asking for a path (issue #43, ADR-027).
 *
 * The two checks it makes are the two the API makes, out of the same functions
 * in `@exocortex/contracts`: a path that the tree cannot hold, and a path whose
 * extension says binary. Doing them here as well means somebody typing a
 * filename is told before the request rather than after it -- the API still
 * refuses, so this is convenience and never the boundary.
 */
interface ProjectNewFileDialogProps {
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (path: string) => void;
}

export function ProjectNewFileDialog({
  open,
  pending,
  onOpenChange,
  onCreate,
}: ProjectNewFileDialogProps) {
  const t = useTranslations('projects.newFile');
  const [path, setPath] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const submit = (): void => {
    const problem = checkProjectPath(path);
    if (problem !== null) {
      setError(t(`pathProblems.${problem}`, { max: PROJECT_MAX_PATH_CHARS }));
      return;
    }
    if (!isProjectTextPath(path)) {
      setError(t('assetHint'));
      return;
    }
    onCreate(path);
    setPath('');
    setError(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t.rich('description', {
              example: t('examplePath'),
              code: (chunks) => <code>{chunks}</code>,
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-new-path">{t('path')}</Label>
          <Input
            id="project-new-path"
            value={path}
            data-testid="project-new-path"
            onChange={(event) => {
              setPath(event.target.value);
              setError(null);
            }}
            placeholder={t('examplePath')}
          />
          {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button disabled={path.trim().length === 0 || pending} onClick={submit}>
            {t('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
