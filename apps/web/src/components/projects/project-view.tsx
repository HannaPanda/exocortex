'use client';

import { type ProjectFile } from '@exocortex/contracts';
import { EmptyState, ErrorState, LoadingState } from '@exocortex/ui';

import { type CollaborationConnectionState } from '@/components/editor/collaboration-connection';

import { ProjectBuildPanel } from './project-build-panel';
import { ProjectCodeEditor } from './project-code-editor';
import { ProjectFileTree } from './project-file-tree';
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

  if (workspace.notFound) return <ErrorState title="Projekt nicht gefunden" />;
  if (workspace.project === null) return <LoadingState label="Projekt wird geladen …" />;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="project-view">
      <ProjectToolbar
        project={workspace.project}
        files={workspace.files}
        running={workspace.running}
        buildPending={workspace.buildPending}
        onUpdate={workspace.actions.update}
        onUpload={workspace.actions.upload}
        onBuild={workspace.actions.build}
        onCancel={workspace.actions.cancel}
      />

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

        <div className="min-h-0 border-e border-border">
          <SourcePane
            connection={workspace.connection}
            selected={workspace.selected}
            focusLine={workspace.focusLine}
          />
        </div>

        <div className="min-h-0">
          <ProjectBuildPanel build={workspace.build} onOpenDiagnostic={workspace.openFile} />
        </div>
      </div>

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
}: {
  connection: CollaborationConnectionState;
  selected: ProjectFile | null;
  focusLine: number | null;
}) {
  if (connection.error !== null) {
    return <ErrorState title="Keine Verbindung" description={connection.error} />;
  }
  if (connection.connection === null) return <LoadingState label="Verbindung wird aufgebaut …" />;
  if (selected === null) {
    return <EmptyState title="Keine Datei gewählt" description="Links eine Datei anklicken." />;
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
    />
  );
}
