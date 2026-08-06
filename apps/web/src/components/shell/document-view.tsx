'use client';

import {
  ArchiveIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  SparklesIcon,
  UploadIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ErrorState,
  LoadingState,
  Textarea,
} from '@exocortex/ui';

import { DatabaseShell } from '@/components/database/database-shell';
import { AiRuleDialog } from '@/components/document/ai-rule-dialog';
import { CollaborativeEditor } from '@/components/editor/collaborative-editor';
import {
  useArchiveDocument,
  useDocument,
  useExportMarkdown,
  useImportMarkdown,
  useRestoreDocument,
  useSessionQuery,
  useUpdateDocument,
} from '@/lib/api/queries';

import { SaveIndicator } from './save-indicator';

const AI_RULE_BADGE_LABEL: Record<'always' | 'on_demand', string> = {
  always: 'KI-Regel',
  on_demand: 'KI-Regel (auf Anfrage)',
};

interface DocumentViewProps {
  workspaceId: string;
  documentId: string;
}

/**
 * Document surface: breadcrumb, editable title, actions and the collaborative
 * editor. No business logic lives here — every action calls an API endpoint.
 */
export function DocumentView({ workspaceId, documentId }: DocumentViewProps) {
  const router = useRouter();
  const session = useSessionQuery();
  const document = useDocument(documentId);
  const updateDocument = useUpdateDocument(workspaceId);
  const archiveDocument = useArchiveDocument(workspaceId);
  const restoreDocument = useRestoreDocument(workspaceId);
  const exportMarkdown = useExportMarkdown();
  const importMarkdown = useImportMarkdown(workspaceId);

  const [importOpen, setImportOpen] = React.useState(false);
  const [importText, setImportText] = React.useState('');
  const [aiRuleDialogOpen, setAiRuleDialogOpen] = React.useState(false);

  if (document.isPending || session.isPending) {
    return <LoadingState label="Seite wird geladen …" />;
  }
  if (document.isError) {
    return (
      <ErrorState
        title="Seite nicht verfügbar"
        description="Die Seite existiert nicht oder du hast keinen Zugriff darauf."
        onRetry={() => void document.refetch()}
      />
    );
  }

  const detail = document.data;
  const user = session.data?.user;
  const archived = detail.archivedAt !== null;

  const downloadMarkdown = async (): Promise<void> => {
    const result = await exportMarkdown.mutateAsync(documentId);
    const blob = new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = result.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importAsNewPage = async (): Promise<void> => {
    const markdown = importText.trim();
    if (markdown.length === 0) return;
    const result = await importMarkdown.mutateAsync({ markdown, parentId: null });
    setImportOpen(false);
    setImportText('');
    router.push(`/arbeitsbereich/${workspaceId}/seite/${result.document.id}`);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-6 py-2">
        <nav aria-label="Pfad" className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          {detail.breadcrumb.map((entry) => (
            <React.Fragment key={entry.id}>
              <Link
                href={`/arbeitsbereich/${workspaceId}/seite/${entry.id}`}
                className="max-w-32 truncate hover:text-foreground"
              >
                {entry.icon !== null ? `${entry.icon} ` : ''}
                {entry.title}
              </Link>
              <span aria-hidden>/</span>
            </React.Fragment>
          ))}
          <span className="max-w-40 truncate text-foreground">{detail.title}</span>
        </nav>

        {detail.aiRuleMode !== 'off' ? (
          <Badge variant="muted" data-testid="ai-rule-badge">
            {AI_RULE_BADGE_LABEL[detail.aiRuleMode]}
          </Badge>
        ) : null}

        <div className="ml-auto flex items-center gap-3">
          {!archived && detail.access === 'write' ? <SaveIndicator /> : null}

          {archived ? (
            <Button
              variant="outline"
              size="sm"
              data-testid="restore-document"
              onClick={() => void restoreDocument.mutateAsync(documentId)}
            >
              <RotateCcwIcon /> Wiederherstellen
            </Button>
          ) : null}

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label="Seitenaktionen" data-testid="document-actions">
                  <MoreHorizontalIcon />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                data-testid="export-markdown"
                onClick={() => void downloadMarkdown()}
              >
                <DownloadIcon /> Als Markdown exportieren
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="open-import"
                onClick={() => setImportOpen(true)}
              >
                <UploadIcon /> Markdown importieren
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-testid="open-ai-rule-dialog"
                onClick={() => setAiRuleDialogOpen(true)}
              >
                <SparklesIcon /> Als KI-Regel verwenden …
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={archived}
                data-testid="archive-document"
                onClick={() => {
                  void archiveDocument
                    .mutateAsync(documentId)
                    .then(() => router.push(`/arbeitsbereich/${workspaceId}`));
                }}
              >
                <ArchiveIcon /> Archivieren
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {archived ? (
        <p
          className="border-b border-warning/40 bg-warning/10 px-6 py-1.5 text-xs text-warning"
          data-testid="archived-banner"
        >
          Diese Seite ist archiviert und deshalb nur lesbar.
        </p>
      ) : null}

      {detail.type === 'COLLECTION' ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="px-6 pt-8 pb-2">
            <DocumentTitleInput
              key={`${detail.id}:${detail.title}`}
              initialTitle={detail.title}
              readOnly={archived || detail.access === 'read'}
              onCommit={(nextTitle) => {
                void updateDocument.mutateAsync({ documentId, request: { title: nextTitle } });
              }}
            />
          </div>
          <DatabaseShell
            workspaceId={workspaceId}
            documentId={documentId}
            readOnly={archived || detail.access === 'read'}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* 68ch is the reading measure from DESIGN.md; max-w-3xl ran ~85ch. */}
          <div className="mx-auto w-full max-w-[68ch] px-6 py-8">
            <DocumentTitleInput
              // Remounting on document change resets the field without an effect.
              key={`${detail.id}:${detail.title}`}
              initialTitle={detail.title}
              readOnly={archived || detail.access === 'read'}
              onCommit={(nextTitle) => {
                void updateDocument.mutateAsync({ documentId, request: { title: nextTitle } });
              }}
            />

            {user === undefined || user === null ? (
              <LoadingState label="Sitzung wird geprüft …" />
            ) : (
              <CollaborativeEditor
                workspaceId={workspaceId}
                documentId={documentId}
                documentTitle={detail.title}
                currentUser={{ id: user.id, name: user.name }}
                access={archived ? 'read' : detail.access}
                /* The breadcrumb block renders the ancestor path. The editor package
                   has no access to the page hierarchy, so the path it already
                   loaded is handed over as data. */
                breadcrumb={detail.breadcrumb.map((entry) => ({
                  id: entry.id,
                  title: entry.title,
                  href: `/arbeitsbereich/${workspaceId}/seite/${entry.id}`,
                }))}
              />
            )}
          </div>
        </div>
      )}

      <AiRuleDialog
        documentId={documentId}
        open={aiRuleDialogOpen}
        onOpenChange={setAiRuleDialogOpen}
        initialMode={detail.aiRuleMode}
        initialTrigger={detail.aiRuleTrigger}
        initialPriority={detail.aiRulePriority}
      />

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
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
            placeholder={'---\ntitle: Meine Seite\n---\n\n# Meine Seite\n'}
            className="font-mono text-xs"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>
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
    </div>
  );
}

interface DocumentTitleInputProps {
  initialTitle: string;
  readOnly: boolean;
  onCommit: (title: string) => void;
}

/**
 * The title field owns its draft value. It is remounted through its `key` when the
 * document changes, so no effect has to copy server state into local state.
 */
function DocumentTitleInput({ initialTitle, readOnly, onCommit }: DocumentTitleInputProps) {
  const [value, setValue] = React.useState(initialTitle);

  const commit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === initialTitle) {
      setValue(initialTitle);
      return;
    }
    onCommit(trimmed);
  };

  return (
    <input
      value={value}
      aria-label="Seitentitel"
      data-testid="document-title"
      readOnly={readOnly}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      className={cn(
        // The page title is the top of the ladder and must clear the editor's own
        // h1 (1.375rem); at the old text-2xl the two were identical.
        'mb-5 w-full bg-transparent text-[1.75rem] leading-tight font-semibold tracking-[-0.02em] outline-none',
        'placeholder:text-muted-foreground',
      )}
      placeholder="Unbenannte Seite"
    />
  );
}
