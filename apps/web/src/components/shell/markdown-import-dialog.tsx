'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Textarea,
} from '@exocortex/ui';

import { useImportMarkdown } from '@/lib/api/markdown-queries';

/**
 * Pasting Markdown in as a new page. The draft lives here, so closing and
 * reopening the dialog keeps it until an import succeeds (split out of
 * `document-view.tsx`, issue #97).
 */
export function MarkdownImportDialog({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('dialogs.markdownImport');
  const router = useRouter();
  const importMarkdown = useImportMarkdown(workspaceId);
  const [importText, setImportText] = React.useState('');

  const importAsNewPage = async (): Promise<void> => {
    const markdown = importText.trim();
    if (markdown.length === 0) return;
    const result = await importMarkdown.mutateAsync({ markdown, parentId: null });
    onOpenChange(false);
    setImportText('');
    router.push(`/arbeitsbereich/${workspaceId}/seite/${result.document.id}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <Textarea
          rows={12}
          value={importText}
          data-testid="import-textarea"
          onChange={(event) => setImportText(event.target.value)}
          // No `# Meine Seite` here: the title belongs in the frontmatter, and
          // an example that shows it twice is an example of the duplicate
          // heading this import strips out again.
          placeholder={t('placeholder')}
          className="font-mono text-xs"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            data-testid="import-submit"
            disabled={importMarkdown.isPending || importText.trim().length === 0}
            onClick={() => void importAsNewPage()}
          >
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
