'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type ImportProjectResponse } from '@exocortex/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@exocortex/ui';

/**
 * What an archive import actually did (issue #54).
 *
 * A dialog rather than a toast, because the interesting half is the list of
 * what did not come in: an import that swallows a third of a thesis in silence
 * fails much later, at a build, in a file nobody remembers packing.
 *
 * The one button that does something is the answer to the most common of those
 * reasons. A fresh project already holds the scaffolded `main.tex`, so the
 * archive's own main file is the first thing to be left alone -- and asking
 * again with `overwrite` is one click rather than a second trip through the
 * file picker.
 */

interface ProjectImportDialogProps {
  result: ImportProjectResponse | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onOverwrite: () => void;
}

/** How many skipped entries are listed before the rest is counted. */
const MAX_SHOWN_SKIPS = 25;

export function ProjectImportDialog({
  result,
  pending,
  onOpenChange,
  onOverwrite,
}: ProjectImportDialogProps) {
  const t = useTranslations('projects.importDialog');
  const shown = result?.skipped.slice(0, MAX_SHOWN_SKIPS) ?? [];
  const rest = (result?.skipped.length ?? 0) - shown.length;
  const blocked = result?.skipped.some((entry) => entry.reason === 'exists') ?? false;

  return (
    <Dialog open={result !== null} onOpenChange={onOpenChange}>
      <DialogContent data-testid="project-import-result">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {result === null ? null : t('imported', { count: result.imported.length })}
          </DialogDescription>
        </DialogHeader>

        {result === null ? null : (
          <div className="flex flex-col gap-2 text-sm">
            {result.strippedRoot === null ? null : (
              <p className="text-muted-foreground">
                {t.rich('strippedRoot', {
                  root: result.strippedRoot,
                  code: (chunks) => <code>{chunks}</code>,
                })}
              </p>
            )}
            {result.rootFileChanged ? (
              <p className="text-muted-foreground">
                {t.rich('rootFileChanged', {
                  file: result.rootFile,
                  code: (chunks) => <code>{chunks}</code>,
                })}
              </p>
            ) : null}

            {result.skipped.length === 0 ? null : (
              <div className="flex flex-col gap-1">
                <p className="font-medium">{t('skippedHeading')}</p>
                <ul className="max-h-56 overflow-y-auto text-xs text-muted-foreground">
                  {shown.map((entry) => (
                    <li key={entry.name} className="py-0.5">
                      <code>{entry.name}</code> {t(`skipReasons.${entry.reason}`)}
                    </li>
                  ))}
                </ul>
                {rest > 0 ? (
                  <p className="text-xs text-muted-foreground">{t('more', { count: rest })}</p>
                ) : null}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {blocked ? (
            <Button
              variant="outline"
              disabled={pending}
              data-testid="project-import-overwrite"
              onClick={onOverwrite}
            >
              {t('overwrite')}
            </Button>
          ) : null}
          <Button onClick={() => onOpenChange(false)}>{t('close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
