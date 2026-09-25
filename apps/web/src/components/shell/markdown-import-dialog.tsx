'use client';

import { useRouter } from 'next/navigation';
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
          <DialogTitle>Markdown importieren</DialogTitle>
          <DialogDescription>
            Der Inhalt wird als neue Seite angelegt. Frontmatter, Aufgabenlisten, Tabellen,
            Wiki-Links und Callouts werden übernommen.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          rows={12}
          value={importText}
          data-testid="import-textarea"
          onChange={(event) => setImportText(event.target.value)}
          // No `# Meine Seite` here: the title belongs in the frontmatter, and
          // an example that shows it twice is an example of the duplicate
          // heading this import strips out again.
          placeholder={'---\ntitle: Meine Seite\n---\n\nErster Absatz.\n'}
          className="font-mono text-xs"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            data-testid="import-submit"
            disabled={importMarkdown.isPending || importText.trim().length === 0}
            onClick={() => void importAsNewPage()}
          >
            Importieren
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
