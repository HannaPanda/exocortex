'use client';

import { FolderTreeIcon } from 'lucide-react';
import * as React from 'react';

import { type ProjectFile } from '@exocortex/contracts';
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Sheet,
  SheetContent,
  SheetTitle,
} from '@exocortex/ui';

import { type CollaborationConnectionState } from '@/components/editor/collaboration-connection';

import { ProjectBuildPanel } from './project-build-panel';
import { ProjectCodeEditor } from './project-code-editor';
import { ProjectFileTree } from './project-file-tree';
import { ProjectImportDialog } from './project-import-dialog';
import { ProjectNewFileDialog } from './project-new-file-dialog';
import { ProjectToolbar } from './project-toolbar';
import { useProjectWorkspace } from './use-project-workspace';

/**
 * A project workspace: files on the left, the source in the middle, the result
 * on the right (issue #43, ADR-027).
 *
 * There is no save button and no dirty state, because there is nothing to save:
 * the editor writes into the project's Yjs document over the same socket the
 * page editor uses, and the collaboration server persists it. Everything else
 * on this screen -- creating a file, uploading a figure, starting a build --
 * goes to the REST API, which is the same API the built-in AI and MCP call
 * (ADR-025). No business logic lives in this file; it lives one file over, in
 * `use-project-workspace.ts`, and this one draws three columns.
 */

interface ProjectViewProps {
  workspaceId: string;
  projectId: string;
}

export function ProjectView({ workspaceId, projectId }: ProjectViewProps) {
  const workspace = useProjectWorkspace(workspaceId, projectId);
  // Below `lg` the three columns stack and the file tree has no room of its
  // own, so it opens as a sheet. Without it a file could not be opened on
  // anything narrower than 1024 px (issue #129).
  const [filesOpen, setFilesOpen] = React.useState(false);

  if (workspace.notFound) return <ErrorState title="Projekt nicht gefunden" />;
  if (workspace.project === null) return <LoadingState label="Projekt wird geladen …" />;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="project-view">
      <ProjectToolbar
        project={workspace.project}
        files={workspace.files}
        running={workspace.running}
        buildPending={workspace.buildPending}
        archivePending={workspace.archivePending}
        onUpdate={workspace.actions.update}
        onUpload={workspace.actions.upload}
        onImport={workspace.actions.importArchive}
        onExport={workspace.actions.exportArchive}
        onBuild={workspace.actions.build}
        onCancel={workspace.actions.cancel}
      />

      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 lg:hidden">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setFilesOpen(true)}
          data-testid="project-files-open"
        >
          <FolderTreeIcon /> Dateien
        </Button>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {workspace.selected?.path ?? 'Keine Datei gewählt'}
        </span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[14rem_1fr_1fr]">
        <div className="hidden min-h-0 border-e border-border lg:block">
          <ProjectFileTree
            files={workspace.files}
            rootFile={workspace.project.rootFile}
            selectedPath={workspace.selected?.path ?? null}
            readOnly={false}
            onSelect={(file: ProjectFile) => workspace.openFile(file.path, null)}
            onDelete={(file: ProjectFile) => workspace.actions.deleteFile(file.path)}
            onCreate={() => workspace.setCreateOpen(true)}
          />
        </div>

        <Sheet open={filesOpen} onOpenChange={setFilesOpen}>
          <SheetContent side="left" data-testid="project-files-sheet">
            <SheetTitle className="exocortex-sr-only">Dateien</SheetTitle>
            <ProjectFileTree
              files={workspace.files}
              rootFile={workspace.project.rootFile}
              selectedPath={workspace.selected?.path ?? null}
              readOnly={false}
              onSelect={(file: ProjectFile) => {
                workspace.openFile(file.path, null);
                setFilesOpen(false);
              }}
              onDelete={(file: ProjectFile) => workspace.actions.deleteFile(file.path)}
              onCreate={() => {
                setFilesOpen(false);
                workspace.setCreateOpen(true);
              }}
            />
          </SheetContent>
        </Sheet>

        <div className="min-h-0 border-e border-border">
          <SourcePane
            connection={workspace.connection}
            selected={workspace.selected}
            focusLine={workspace.focusLine}
            focusNonce={workspace.focusNonce}
            onCursorLine={workspace.sourceSync.reportCursor}
          />
        </div>

        <div className="min-h-0">
          <ProjectBuildPanel
            build={workspace.build}
            builds={workspace.builds}
            highlights={workspace.sourceSync.highlights}
            pickError={workspace.sourceSync.pickError}
            onOpenDiagnostic={workspace.openFile}
            onPickSource={workspace.sourceSync.pickSource}
            onSelectBuild={workspace.selectBuild}
            onDeleteBuild={workspace.actions.deleteBuild}
          />
        </div>
      </div>

      <ProjectImportDialog
        result={workspace.importResult}
        pending={workspace.archivePending}
        onOpenChange={(open) => {
          if (!open) workspace.actions.dismissImport();
        }}
        onOverwrite={workspace.actions.importOverwrite}
      />

      <ProjectNewFileDialog
        open={workspace.createOpen}
        pending={workspace.writePending}
        onOpenChange={workspace.setCreateOpen}
        onCreate={workspace.actions.createFile}
      />
    </div>
  );
}

/** The middle column: the connection's state, or the file that is open in it. */
function SourcePane({
  connection,
  selected,
  focusLine,
  focusNonce,
  onCursorLine,
}: {
  connection: CollaborationConnectionState;
  selected: ProjectFile | null;
  focusLine: number | null;
  focusNonce: number;
  onCursorLine: (line: number) => void;
}) {
  if (connection.error !== null) {
    return <ErrorState title="Keine Verbindung" description={connection.error} />;
  }
  // `ready` as well: a file tree is a Yjs document like any other, and an
  // editor built before it has arrived writes into an empty one.
  if (connection.connection === null || !connection.ready)
    return <LoadingState label="Verbindung wird aufgebaut …" />;
  if (selected === null) {
    return (
      <EmptyState title="Keine Datei gewählt" description="Wähle eine Datei aus dem Dateibaum." />
    );
  }
  if (selected.kind === 'ASSET') {
    return (
      <EmptyState
        title={selected.path}
        description="Eine hochgeladene Datei. Sie lässt sich im Projekt verwenden, aber nicht hier bearbeiten."
      />
    );
  }
  return (
    <ProjectCodeEditor
      key={selected.path}
      provider={connection.connection.provider}
      ydoc={connection.connection.ydoc}
      path={selected.path}
      readOnly={false}
      focusLine={focusLine}
      focusNonce={focusNonce}
      onCursorLine={onCursorLine}
    />
  );
}
